// Relay: send pull requests with merge conflicts back to their agents.
//
// Many small PRs overlap, so each merge can leave other open PRs conflicting
// with the base branch. They then sit in your review queue although you can't
// merge them. After every merge (and every RELAY_CONFLICT_SWEEP_SEC as a safety
// net) this looks at the open PRs and, for each one GitHub says conflicts:
//
//   * finds the issue that owns it (decisions.resolveOwner: the issue listing it as
//     a work product, else the one its title starts with, else the one whose
//     workspace branch is its head branch), never just an issue waiting on you;
//   * requests changes on it when its review is waiting on you, or else leaves a
//     comment, either of which wakes the agent with a brief to merge the base
//     branch, resolve the conflicts and push;
//   * says so in a comment on the PR, so you can see it was already sent back.
//
// Guards: one notice per PR, head commit and conflict state, remembered across a
// clean spell (nothing more until the agent pushes); after
// RELAY_CONFLICT_MAX_ATTEMPTS pushes that still conflict it is left to you, with a
// note on the PR; drafts, PRs that name no Paperclip issue and PRs whose issue is
// done or cancelled are skipped. With no single owner, nothing goes to any issue:
// the board is told once per head commit. The owner is looked up again for every
// notice. A PR that merges cleanly again starts its count from zero.

import { CLOSED_STATUSES, prLabel, RELAYED_SIGNATURE, signed } from "./util.mjs";
import { findIdentifiers } from "./identifiers.mjs";
import { noteToBoard } from "./board-note.mjs";

// GitHub works out `mergeable` in the background: null means "ask again".
const MERGEABLE_TRIES = 5;
const MERGEABLE_WAIT_MS = 3000;
// After a merge, give GitHub a moment to notice the base branch moved.
const AFTER_MERGE_WAIT_MS = 5000;
const CLOSED = CLOSED_STATUSES;
// Notices remembered per PR, so one isn't sent twice for the same commit.
const SENT_KEPT = 10;

// What one notice is for: the PR's head commit and how it conflicts. GitHub's
// mergeable_state for a conflict is "dirty"; anything else it says is kept apart.
const noticeKey = (pr) => `${pr.head?.sha ?? "?"}:${pr.mergeable_state && pr.mergeable_state !== "unknown" ? pr.mergeable_state : "dirty"}`;

export function createConflictSweep({ ctx, state, github, decisions, sleep }) {
  const { config, log, api } = ctx;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const records = state.conflicts;
  const stats = { sweeps: 0, sentBack: 0, lastSweepAt: null, lastError: null };

  // The PR in full once GitHub knows whether it merges; null if it never said.
  // The PR was just listed with the same token, and a PR can't be deleted, so a
  // 404 here is GitHub not answering for it yet: it is asked again like a null.
  async function settled(repo, number) {
    for (let i = 0; i < MERGEABLE_TRIES; i += 1) {
      let full;
      try {
        full = await github.pull(repo, number);
      } catch (err) {
        if (err?.status !== 404 || i === MERGEABLE_TRIES - 1) throw err;
        log.debug?.("relay: a listed PR answered 404, asking again", { repo, pr: number });
        await wait(MERGEABLE_WAIT_MS);
        continue;
      }
      if (typeof full?.mergeable === "boolean") return full;
      if (full?.state && full.state !== "open") return full;
      if (i < MERGEABLE_TRIES - 1) await wait(MERGEABLE_WAIT_MS);
    }
    return null;
  }

  // A listed PR that still answers 404 can't be a missing permission: the same token
  // has just listed it. Say that, rather than the 404's usual guess.
  function failure(err) {
    if (err?.status !== 404 || !/\/pulls\/\d+$/.test(err.path ?? "")) return err.message;
    const age = err.tokenAge ? ` (the token file was written ${err.tokenAge} ago)` : "";
    return `${err.summary} ${MERGEABLE_TRIES} times, though the same token${age} listed this PR moments before, so it isn't a missing permission. The PR is checked again on the next sweep.`;
  }

  function brief(pr, after) {
    const base = pr.base?.ref ?? "the base branch";
    const branch = pr.head?.ref ?? "its branch";
    const cause = after ? ` since ${prLabel(after)} was merged` : "";
    return signed([
      `Changes requested on ${prLabel(pr)}: merge conflicts with \`${base}\``,
      "",
      `${prLabel(pr)} can't be merged: it conflicts with \`${base}\`${cause}. ${pr.html_url}`,
      "",
      `Bring \`${branch}\` up to date with the latest \`origin/${base}\`, resolve the conflicts so that both sides' changes are kept as intended, run the tests, and push to the same branch. Don't open a new pull request. Nothing else about the work was reviewed or needs to change.`,
    ].join("\n"));
  }

  async function commentOnPr(repo, pr, text) {
    if (!config.conflictPrComment) return false;
    try {
      await github.helperComment(repo, pr.number, text);
      return true;
    } catch (err) {
      // The send-back itself worked; a missing note isn't worth failing over.
      log.warn("relay: could not comment on the PR", { repo, pr: pr.number, error: err.message });
      return false;
    }
  }

  // No single issue owns the PR: nothing goes to any issue (a change request on the
  // wrong one would send its work back), and the board is told, once per head
  // commit, with what each source said.
  async function unowned(repo, pr, rec, companyId, reason) {
    const out = { pr: pr.number, action: "board note", reason: `no single issue owns it: ${reason}` };
    if (config.dryRun) return { ...out, action: "board note (dry run)" };
    records.set(`${repo}#${pr.number}`, { ...rec, head: pr.head?.sha ?? null, unowned: true, gaveUp: false, at: ctx.now() });
    state.touch();
    const text = `${prLabel(pr)} conflicts with \`${pr.base?.ref ?? "its base branch"}\`, but it wasn't sent back: no single Paperclip issue owns it (${reason}). Send it back to the right issue yourself (\`pch changes <issue> "…"\`), or record the PR as a work product on its issue; the next push is looked at again.\n\n${pr.html_url}`;
    if (companyId) await noteToBoard({ api, config, log }, companyId, text, { source: "relay", signature: RELAYED_SIGNATURE, repo, pr: pr.number });
    else log.warn("relay: a note for the board", { text, repo, pr: pr.number });
    return out;
  }

  async function checkPull(repo, listed, after) {
    const number = listed.number;
    const key = `${repo}#${number}`;
    const skip = (reason) => ({ pr: number, action: "skip", reason });
    if (listed.draft) return skip("draft");
    const identifiers = findIdentifiers(listed, ctx.prefixes());
    if (!identifiers.length) return skip("names no Paperclip issue");

    const pr = await settled(repo, number);
    if (!pr) return skip("GitHub hasn't worked out yet whether it merges");
    if (pr.state && pr.state !== "open") return skip(`now ${pr.state}`);
    if (pr.draft) return skip("draft");
    const rec = records.get(key);
    if (pr.mergeable) {
      // Resolved: the next conflict is a new one, but not on a commit already sent back.
      if (rec?.head || rec?.gaveUp || rec?.unowned) {
        if (rec.sent?.length) records.set(key, { sent: rec.sent, at: ctx.now() });
        else records.delete(key);
        state.touch();
      }
      return { pr: number, action: "clean" };
    }

    const head = pr.head?.sha ?? null;
    const notice = noticeKey(pr);
    if (rec && rec.head === head) {
      if (rec.unowned) return skip("no issue owns it; the board was told");
      return skip(rec.gaveUp ? "left to you after the attempts ran out" : "already sent back, waiting for a push");
    }
    if (rec?.sent?.includes(notice)) return skip("already sent back for this commit");
    const attempts = rec?.attempts ?? 0;
    const max = config.conflictMaxAttempts;
    const base = pr.base?.ref ?? "the base branch";

    if (attempts >= max) {
      if (config.dryRun) return { pr: number, action: "give up (dry run)", attempts };
      const first = !rec?.gaveUp;
      records.set(key, { ...rec, head, gaveUp: true, unowned: false, at: ctx.now() });
      state.touch();
      if (first) {
        log.warn("relay: PR still conflicts after every attempt, leaving it to you", { repo, pr: number, attempts });
        await commentOnPr(
          repo,
          pr,
          `**Still conflicts with \`${base}\` after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.** Paperclip Helper won't send this PR back again: it needs you. Comment \`/changes …\` to send it back yourself.`,
        );
      }
      return { pr: number, action: "give up", attempts };
    }

    // Looked up again for every notice: never taken from an earlier one.
    const target = await decisions.resolveOwner(pr, identifiers);
    if (!target) return skip(`no Paperclip issue found for ${identifiers.join(", ")}`);
    if (!target.issue) return unowned(repo, pr, rec, target.companyId, target.reason);
    const issueLabel = target.issue.identifier ?? target.issue.id;
    if (!target.waiting && CLOSED.has(target.issue.status)) return skip(`${issueLabel} is ${target.issue.status}`);

    const result = await decisions.decide({ pr, identifiers, kind: "changes", comment: brief(pr, after), target, automatic: true });
    if (result.code === "not-owner") return unowned(repo, pr, rec, target.companyId, result.reason);
    const out = { pr: number, attempt: attempts + 1, identifier: result.identifier, action: result.action };
    if (result.reason) out.reason = result.reason;
    if (config.dryRun) return out;

    const sent = [...(rec?.sent ?? []), notice].slice(-SENT_KEPT);
    records.set(key, { head, attempts: attempts + 1, at: ctx.now(), issue: result.identifier, sent });
    state.touch();
    stats.sentBack += 1;
    const how =
      result.action === "changes"
        ? `${result.identifier} was returned to its agent with changes requested`
        : `a comment on ${result.identifier} asked its agent to resolve them (its review wasn't waiting on you, so no decision was recorded)`;
    await commentOnPr(
      repo,
      pr,
      `**Sent back for merge conflicts.** This PR conflicts with \`${base}\`, so ${how}. Attempt ${attempts + 1} of ${max}; nothing more is sent until the branch is pushed.`,
    );
    return out;
  }

  // One pass over a repository's open PRs: all of them, or those into `base`.
  async function sweepRepo(repo, { base, after } = {}) {
    await ctx.identity(); // loads the issue prefixes
    if (after) await wait(AFTER_MERGE_WAIT_MS);
    const pulls = await github.openPulls(repo, base);
    const results = [];
    for (const pr of pulls) {
      if (after && pr.number === after.number) continue;
      try {
        results.push(await checkPull(repo, pr, after));
      } catch (err) {
        const error = failure(err);
        stats.lastError = error;
        results.push({ pr: pr.number, action: "error", error });
        log.error("relay: conflict check failed", { repo, pr: pr.number, error });
      }
    }
    if (!base) {
      // A full pass saw every open PR: forget the ones that are gone.
      const open = new Set(pulls.map((pr) => `${repo}#${pr.number}`));
      for (const [key] of records.entries()) {
        if (key.startsWith(`${repo}#`) && !open.has(key)) {
          records.delete(key);
          state.touch();
        }
      }
    }
    stats.sweeps += 1;
    stats.lastSweepAt = new Date(ctx.now()).toISOString();
    try {
      state.save();
    } catch (err) {
      log.error("relay: could not save state", { error: err.message });
    }
    const notable = results.filter((r) => r.action !== "clean" && r.reason !== "draft" && r.reason !== "names no Paperclip issue");
    log(notable.length ? "relay: conflict sweep" : "relay: conflict sweep, nothing to do", {
      repo,
      ...(base ? { base } : {}),
      ...(after ? { after: after.number } : {}),
      open: pulls.length,
      ...(notable.length ? { results: notable } : {}),
    });
    return results;
  }

  // Sweeps never overlap: a merge and the timer could otherwise send one PR twice.
  let chain = Promise.resolve();
  function sweep(repo, options) {
    const run = chain.then(() => sweepRepo(repo, options));
    chain = run.catch((err) => {
      stats.lastError = err.message;
    });
    return run;
  }

  return { sweep, stats, idle: () => chain };
}
