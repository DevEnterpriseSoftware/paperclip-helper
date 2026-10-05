// Relay: send pull requests with merge conflicts back to their agents.
//
// Many small PRs overlap, so each merge can leave other open PRs conflicting
// with the base branch. They then sit in your review queue although you can't
// merge them. After every merge (and every RELAY_CONFLICT_SWEEP_SEC as a safety
// net) this looks at the open PRs and, for each one GitHub says conflicts:
//
//   * finds its Paperclip issue the way the relay does for your own decisions;
//   * requests changes on it when its review is waiting on you, or else leaves a
//     comment, either of which wakes the agent with a brief to merge the base
//     branch, resolve the conflicts and push;
//   * says so in a comment on the PR, so you can see it was already sent back.
//
// Guards: a PR is sent back once per head commit (nothing more until the agent
// pushes); after RELAY_CONFLICT_MAX_ATTEMPTS pushes that still conflict it is
// left to you, with a note on the PR; drafts, PRs that name no Paperclip issue
// and PRs whose issue is done or cancelled are skipped. A PR that merges cleanly
// again starts from zero.

// Ends every comment the helper writes on a PR, so the relay doesn't copy its
// own comments back to Paperclip when GitHub delivers them as webhooks.
import { signed } from "./util.mjs";

export const HELPER_MARK = "<!-- paperclip-helper -->";

// GitHub works out `mergeable` in the background: null means "ask again".
const MERGEABLE_TRIES = 5;
const MERGEABLE_WAIT_MS = 3000;
// After a merge, give GitHub a moment to notice the base branch moved.
const AFTER_MERGE_WAIT_MS = 5000;
const CLOSED = new Set(["done", "cancelled"]);

export function createConflictSweep({ ctx, state, github, identifiersOf, resolveTarget, decide, sleep }) {
  const { config, log } = ctx;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const records = state.conflicts;
  const stats = { sweeps: 0, sentBack: 0, lastSweepAt: null, lastError: null };
  const prLabel = (pr) => `PR #${pr.number}`;

  // The PR in full once GitHub knows whether it merges; null if it never said.
  async function settled(repo, number) {
    for (let i = 0; i < MERGEABLE_TRIES; i += 1) {
      const full = await github.pull(repo, number);
      if (typeof full?.mergeable === "boolean") return full;
      if (full?.state && full.state !== "open") return full;
      if (i < MERGEABLE_TRIES - 1) await wait(MERGEABLE_WAIT_MS);
    }
    return null;
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
      await github.comment(repo, pr.number, `${signed(text)}\n\n${HELPER_MARK}`);
      return true;
    } catch (err) {
      // The send-back itself worked; a missing note isn't worth failing over.
      log.warn("relay: could not comment on the PR", { repo, pr: pr.number, error: err.message });
      return false;
    }
  }

  async function checkPull(repo, listed, after) {
    const number = listed.number;
    const key = `${repo}#${number}`;
    const skip = (reason) => ({ pr: number, action: "skip", reason });
    if (listed.draft) return skip("draft");
    const identifiers = identifiersOf(listed);
    if (!identifiers.length) return skip("names no Paperclip issue");

    const pr = await settled(repo, number);
    if (!pr) return skip("GitHub hasn't worked out yet whether it merges");
    if (pr.state && pr.state !== "open") return skip(`now ${pr.state}`);
    if (pr.draft) return skip("draft");
    if (pr.mergeable) {
      // Resolved: the next conflict is a new one.
      if (records.delete(key)) state.touch();
      return { pr: number, action: "clean" };
    }

    const head = pr.head?.sha ?? null;
    const rec = records.get(key);
    if (rec && rec.head === head) {
      return skip(rec.gaveUp ? "left to you after the attempts ran out" : "already sent back, waiting for a push");
    }
    const attempts = rec?.attempts ?? 0;
    const max = config.conflictMaxAttempts;
    const base = pr.base?.ref ?? "the base branch";

    if (attempts >= max) {
      if (config.dryRun) return { pr: number, action: "give up (dry run)", attempts };
      const first = !rec?.gaveUp;
      records.set(key, { ...rec, head, gaveUp: true, at: ctx.now() });
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

    const target = await resolveTarget(pr, identifiers);
    if (!target) return skip(`no Paperclip issue found for ${identifiers.join(", ")}`);
    const issueLabel = target.issue.identifier ?? target.issue.id;
    if (!target.waiting && CLOSED.has(target.issue.status)) return skip(`${issueLabel} is ${target.issue.status}`);

    const result = await decide(pr, identifiers, "changes", brief(pr, after), target);
    const out = { pr: number, attempt: attempts + 1, identifier: result.identifier, action: result.action };
    if (result.reason) out.reason = result.reason;
    if (config.dryRun) return out;

    records.set(key, { head, attempts: attempts + 1, at: ctx.now(), issue: result.identifier });
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
        stats.lastError = err.message;
        results.push({ pr: pr.number, action: "error", error: err.message });
        log.error("relay: conflict check failed", { repo, pr: pr.number, error: err.message });
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
