// Watchdog 22: execution holds left by runs that never started.
//
// Paperclip's dispatch gates cancel a queued run, or a scheduled retry, before it is
// claimed when the issue has moved on: its assignee changed a second earlier
// (issue_assignee_changed: a wake from an answered card, say), or a scheduled
// disposition repair is no longer needed (issue_disposition_repair_superseded). Up to
// 2026.1023.0 Paperclip holds the issue for reconciliation behind such a run
// (executionBlocker, cause legacy_execution_requires_reconciliation) as if it had
// run: "Recovery needed. Execution was cancelled; its source was not recorded." Its
// automatic recovery settles the hold without replay, the UI offers only "Inspect
// run", and every comment and status change after that is saved behind it ("no
// verified stop record") for good. When the held run is the current assignee's, that
// agent never gets another run on the issue to supersede it. Paperclip's own fix
// (paperclipai/paperclip#18838) covers refused queued runs, not suppressed retries.
//
// The hold scan (paused-holds.mjs, once per stall window) hands every other
// reconciliation hold here. For one whose run never started (release.mjs
// neverStarted: a dispatch gate's code, and no start, process, session, controller,
// stage, usage, lease or execution event), with WATCHDOG_RELEASE_HOLDS on, once the
// run ended a stall window ago and the assignee (the run's own agent) is available,
// the watchdog records the board's reconciliation with the outcome "not performed"
// and delivers the saved messages once, as `pch release --apply` does. If there were
// none, Paperclip starts its own continuation for the hold's owner; if no run of the
// assignee has started 45 seconds later, one comment tells it to continue. The board
// is told what was done. Once per held run.
//
// A run Paperclip claimed and a reassignment cancelled while it was still preparing,
// before it reached its adapter (issue_reassigned), counts as never started.
//
// A held review (the run is its reviewer's, and the reviewer has
// the issue) is released by a route release.mjs heldReviewRoute describes: kept as it
// was when Paperclip has parked it in blocked (or todo); started again at the same
// first stage, with the same reviewer and implementer, when it is still in review and
// nothing in it is lost. An issue that belongs to another agent (given on after the
// run, or the held reviewer's review ended) is handed on (release.mjs handOnRoute): the
// held run's agent gets it a moment if needed and is asked to reassign it, and if it
// hasn't HAND_ON_CHECK_MS later and nothing of its runs there, the watchdog does. It
// never releases a hold on any other pending review (Paperclip's release would refuse
// or end it), while another run on the issue is active, or while other issues block
// it: the board is told once why, and what lifts it.
//
// A hold from a run that did execute (it started, or recorded usage) is the board's:
// it is reported once, an hour after the run ended, unless it is one 7 releases by
// itself (no process record and no usage, WATCHDOG_RELEASE_HOLDS on, nothing in the way).

import { asleep, ts, WATCHDOG_SIGNATURE } from "./util.mjs";
import { noteToBoard } from "./board-note.mjs";
import {
  actsAsUser, claimedOnly, handOnRoute, handOnText, heldReviewRoute, neverStarted, ranWork, releaseHandedOn, releaseHeldReview, releaseHold, releaseProblems,
  releaseRebuiltReview, reviewPending, unprovable, UPSTREAM_RELEASED_CODES,
} from "./release.mjs";
import { ACTIVE_RUN } from "./util.mjs";
import { describeWakes, waitingWakes } from "./paused-holds.mjs";

const EXECUTED_REPORT_AFTER_MS = 60 * 60_000;
// Two of Paperclip's delivery sweeps (EXECUTION_RECONCILIATION_INTERVAL_MS, 15 s) and some.
const FOLLOW_UP_AFTER_MS = 45_000;
const DAY_MS = 24 * 60 * 60_000;
const FOLLOW_UP = "unstarted-follow-up:";
const HAND_ON = "unstarted-hand-on:";
// How long the held run's agent has to hand the issue on before the board's watchdog
// does it for them (only once nothing of theirs runs on the issue).
export const HAND_ON_CHECK_MS = 15 * 60_000;
const short = (id) => String(id ?? "?").slice(0, 8);

// "Alice's run 1a2b3c4d, which Paperclip cancelled before it started (issue_assignee_changed)"
export function unstartedHoldWhy({ ownerName, runId, errorCode, claimed = false }) {
  const cancelled = claimed
    ? `was cancelled while it was still preparing, before it reached its adapter (${errorCode})`
    : `its dispatch cancelled before it started (${errorCode})`;
  return (
    `Paperclip holds every wake on this issue behind ${ownerName ?? "an agent"}'s run ${short(runId)}, which ${cancelled}, ` +
    "and never releases that hold by itself (legacy_execution_requires_reconciliation)"
  );
}

// What lifts it when the watchdog won't: for the board's note and `pch why`.
export function unstartedHoldRemedy({ problems, errorCode, identifier, ownerName = null, returnName = null, claimed = false }) {
  const review = problems.some((p) => /review stage is pending/.test(p));
  const upstream = claimed
    ? "Paperclip's own fix (paperclipai/paperclip#18838) doesn't cover a run cancelled after it was claimed."
    : UPSTREAM_RELEASED_CODES.has(errorCode)
      ? "A Paperclip with paperclipai/paperclip#18838 releases this hold by itself"
      : "Paperclip's own fix (paperclipai/paperclip#18838) doesn't cover a run with this code.";
  if (review) {
    const kept = upstream.endsWith("itself") ? `${upstream} and leaves the review as it is.` : upstream;
    return (
      `${kept} Short of that, the only release Paperclip offers moves the issue to todo and ends its review: if you accept ` +
      `that, move it to todo yourself${ownerName ? `, still assigned to ${ownerName}` : ""}, and on its next scan the watchdog releases the hold` +
      `${ownerName ? ` and asks ${ownerName}` : ""} to give the issue back to ${returnName ?? "its implementer"}, rather than handing ${ownerName ?? "the reviewer"} the saved messages.`
    );
  }
  if (problems.some((p) => /another run on the issue is active/.test(p))) {
    return (
      "Don't reassign the issue while that run is queued or starting: the reassignment cancels it, and Paperclip holds the issue behind that run too. " +
      `Once it has run, the watchdog releases the hold on its next scan; \`pch release ${identifier}\` shows the hold.`
    );
  }
  return `Once that is out of the way the watchdog releases it on its next scan; \`pch release ${identifier}\` shows the hold.`;
}

// From the watchdog: its records, `record` keys, `agentFor` and `nudge`.
export function createUnstartedHoldCheck({ ctx, records, state, stats, dryRunSeen, record, agentFor, nudge }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;

  // Told once per hold and reason; a dry run only logs, once.
  const tell = async (key, reason, companyId, text, extra) => {
    const prior = records.get(key);
    if (prior?.told === reason || dryRunSeen.has(`${key}:${reason}`)) return;
    if (config.dryRun) dryRunSeen.add(`${key}:${reason}`);
    else {
      records.set(key, { count: 1, at: now(), told: reason });
      state.touch();
    }
    await noteToBoard(ctx, companyId, text, extra);
  };

  // A hold from a run that executed: the board's, told once.
  async function reportExecuted(facts, companyId, agents) {
    const { issue, hold, run } = facts;
    const endedAt = ts(run?.finishedAt);
    if (!endedAt || now() - endedAt < EXECUTED_REPORT_AFTER_MS) return;
    // 7 releases one Paperclip can never check by itself, when nothing is in the way.
    if (config.watchdogReleaseHolds && unprovable(facts) && !ranWork(run) && !releaseProblems(facts).length) return;
    const who = issue.identifier ?? issue.id;
    const owner = facts.agent ?? (hold.agentId ? await agentFor(hold.agentId, agents).catch(() => null) : null);
    const ranMin = ts(run.startedAt) ? Math.max(1, Math.round((endedAt - ts(run.startedAt)) / 60_000)) : null;
    await tell(
      record.executedHold(issue, hold.runId),
      "executed",
      companyId,
      `${who}: Paperclip holds execution on this issue behind ${owner?.name ?? "an agent"}'s run ${short(hold.runId)}, ` +
        `which ${ranMin ? `ran for ${ranMin} min and ` : ""}ended ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""} ` +
        "without a record of what it did. That is for a person to judge, so the watchdog leaves it: inspect the run and the branch, then " +
        `\`pch release ${who} --apply\` (with \`--outcome completed\` or \`--outcome not_performed\` once you know).`,
      { issue: who, sourceRun: hold.runId, sourceRunStatus: run.status, errorCode: run.errorCode ?? null },
    );
  }

  // Called by the hold scan for a reconciliation hold that isn't a pause's (18's).
  async function check(facts, companyId, agents) {
    const { issue, hold, run } = facts;
    if (!hold?.runId || !run) return;
    if (!neverStarted(facts)) return reportExecuted(facts, companyId, agents);

    const who = issue.identifier ?? issue.id;
    const key = record.release(issue, hold.runId); // shared with 7: one release per held run
    const prior = records.get(key);
    if (prior && !prior.failed) {
      // Released once and held again for the same run: the board's, told once.
      const back = record.releaseReported(issue, hold.runId);
      if (now() - prior.at >= stallMs && !records.has(back)) {
        records.set(back, { count: 1, at: now() });
        state.touch();
        await noteToBoard(ctx, companyId, `${who}: the watchdog released a hold behind run ${short(hold.runId)}, which never started, and Paperclip holds the issue behind it again. See \`pch why ${who}\`.`, { issue: who, sourceRun: hold.runId });
      }
      return;
    }
    // A release Paperclip refused before (this check's, or 7's before 1.16, which tried
    // reviews: "Safe recovery hand-back cannot bypass a pending execution review or
    // approval stage"): the board still hears why below, and once the issue has changed
    // since (a person moved it out of review, say; or a refusal from before 1.16, which
    // recorded nothing to compare) and nothing is in the way, it is tried once more.
    const retry = Boolean(prior?.failed);
    if (retry && (prior.retried || (prior.issueUpdatedAt !== undefined && prior.issueUpdatedAt === issue.updatedAt))) return;
    const owner = facts.agent ?? (await agentFor(hold.agentId, agents).catch(() => null));
    const assignee = issue.assigneeAgentId ? await agentFor(issue.assigneeAgentId, agents).catch(() => null) : null;
    const nameOf = (id) => (id && agents.get(id)?.name) ?? (id === owner?.id ? owner?.name : id === assignee?.id ? assignee?.name : null);
    const wakes = await waitingWakes(api, issue.id);
    const claimed = claimedOnly(run);
    const why = unstartedHoldWhy({ ownerName: owner?.name, runId: hold.runId, errorCode: run.errorCode, claimed });
    const held = wakes.length ? `: ${describeWakes(wakes, nameOf)} won't start` : "";
    const saved = facts.queue?.entries?.length ?? hold.savedMessageCount ?? 0;
    const logExtra = { issue: who, sourceRun: hold.runId, errorCode: run.errorCode, waiting: wakes.length, saved };

    if (now() - ts(run.finishedAt) < stallMs) return; // Paperclip's own sweep first
    // A held review: released keeping it when Paperclip has it in blocked or todo, or
    // its first stage started again when nothing in it is lost (release.mjs heldReviewRoute).
    const route = heldReviewRoute(facts);
    // The issue belongs elsewhere: the held run's agent is asked to hand it on (release.mjs handOnRoute).
    const handOn = route ? null : handOnRoute(facts);
    const target = handOn ? await agentFor(handOn.targetAgentId, agents).catch(() => null) : null;
    let problems = releaseProblems(facts, { heldReview: true, handOn: Boolean(handOn) });
    if (route === "lossless" && issue.status === "blocked" && !actsAsUser(await ctx.identity().catch(() => null))) {
      problems = [...problems, "only a board user's comment moves a blocked review to todo with its stage kept, and the helper's Paperclip key isn't a user's"];
    }
    if (handOn && (!target || target.status === "terminated")) {
      problems = [...problems, `the issue is to go to ${target?.name ?? "an agent"} that ${target ? "is terminated" : "couldn't be read"}`];
    }
    if (problems.length) {
      return tell(
        record.unstartedLeft(issue, hold.runId),
        `problems:${problems.join("|")}`,
        companyId,
        `${who}: ${why}${held}. The watchdog won't release it: ${problems.join("; ")}. ` +
          unstartedHoldRemedy({ problems, errorCode: run.errorCode, identifier: who, ownerName: owner?.name, returnName: nameOf(issue.executionState?.returnAssignee?.agentId), claimed }),
        { ...logExtra, problems, reviewPending: reviewPending(issue) },
      );
    }
    if (!config.watchdogReleaseHolds) {
      return tell(record.unstartedLeft(issue, hold.runId), "off", companyId,
        `${who}: ${why}${held}. \`pch release ${who} --apply\` releases it (WATCHDOG_RELEASE_HOLDS is off).`, logExtra);
    }
    // Delivering a message to an agent Paperclip can't invoke only strands it again. On a
    // hand-on route the run that matters is the held run's agent's.
    const runner = handOn ? owner : assignee;
    if (!runner || asleep(runner)) return;
    if (config.dryRun) {
      if (!dryRunSeen.has(key)) {
        dryRunSeen.add(key);
        log("watchdog: would release a hold behind a run that never started (dry run)", logExtra);
      }
      return;
    }
    records.set(key, { count: 1, at: now(), ...(retry ? { retried: true } : {}) });
    state.touch();
    const options = {
      note:
        `Released by Paperclip Helper's watchdog: run ${hold.runId} was cancelled before it started (${run.errorCode}), ` +
        "so there was nothing to reconcile and Paperclip could never release this hold by itself.",
      signature: `\n\n${WATCHDOG_SIGNATURE}`,
      comment:
        `Paperclip held this review behind a run of yours it cancelled before it started (${run.errorCode}), so nothing reached you. ` +
        "The watchdog is releasing it now and keeping the review as it is: please carry on with your review. " +
        "If a message here asks for changes to the work (merge conflicts, say), those are for the implementer: request changes rather than making them yourself." +
        `\n\n${WATCHDOG_SIGNATURE}`,
    };
    if (handOn) options.comment = handOnText({ route: handOn, holdAgent: owner, target, errorCode: run.errorCode, signature: `\n\n${WATCHDOG_SIGNATURE}` });
    const stage = issue.executionState;
    const reviewer = nameOf(stage?.currentParticipant?.agentId) ?? "its reviewer";
    const back = stage?.returnAssignee?.agentId ? `, returning to ${nameOf(stage.returnAssignee.agentId) ?? "its implementer"}` : "";
    const stageText = route === "lossless"
      ? ` without ending the review (${stage.currentStageType ?? "review"} stage ${(stage.currentStageIndex ?? 0) + 1} with ${reviewer}${back}, as it was)`
      : route === "rebuild"
        ? `, starting its review again at the same first stage with ${reviewer}${back} (nothing in it had been completed; the saved messages stay on the issue for ${reviewer}'s review run)`
        : "";
    const handOnStep = handOn
      ? handOn.kind === "owner-moved"
        ? `, giving the issue back to ${owner?.name ?? "the run's agent"} a moment (Paperclip releases it only while it is theirs) and asking them to reassign it to ${target.name}`
        : `, asking ${owner?.name ?? "the run's agent"} to give the issue back to ${target.name}: their review had ended, and the saved messages are ${target.name}'s work`
      : "";
    let result;
    try {
      result = route === "lossless" ? await releaseHeldReview(api, facts, options)
        : route === "rebuild" ? await releaseRebuiltReview(api, facts, options)
        : handOn ? await releaseHandedOn(api, facts, { ...options, route: handOn })
        : await releaseHold(api, facts, options);
    } catch (err) {
      if (err.reviewChanged) {
        // Released, but the review isn't as it was: the board's to look at.
        stats.releases += 1;
        stats.unstartedHolds = (stats.unstartedHolds ?? 0) + 1;
        await noteToBoard(ctx, companyId, `${who}: ${why}. The watchdog released it, but ${err.message.replace(/^the hold is released, but /, "")}.`, { ...logExtra, error: err.message });
        return;
      }
      records.set(key, { count: 1, at: now(), failed: true, retried: retry, issueUpdatedAt: issue.updatedAt ?? null });
      state.touch();
      await noteToBoard(ctx, companyId, `${who}: ${why}${held}. The watchdog couldn't release it (${err.message}); see \`pch release ${who}\`.`, { ...logExtra, error: err.message });
      return;
    }
    stats.releases += 1;
    stats.unstartedHolds = (stats.unstartedHolds ?? 0) + 1;
    const plural = (n) => `${n} saved message${n === 1 ? "" : "s"}`;
    const delivered = result.delivered
      ? `delivered ${plural(result.delivered)} to ${runner.name}`
      : result.byPaperclip
        ? `Paperclip started the ${plural(result.byPaperclip)} itself`
      : result.waiting
        ? `${result.waiting} saved message${result.waiting === 1 ? "" : "s"} start with ${runner.name}'s next run`
        : null;
    // Nothing saved: Paperclip starts its own continuation for the hold's owner
    // (issue_recovery_action_restored, from a sweep every 15 s, when that owner still has
    // the issue). followUp() comments only if no run has started a while later.
    if (handOn) {
      // handOnFollowUp() checks that it reached the target, and moves it on itself once
      // nothing of theirs runs there any more.
      records.set(record.unstartedHandOn(issue, hold.runId), {
        count: 0, at: now(), companyId, issueId: issue.id, holdAgentId: hold.agentId, targetId: target.id, kind: handOn.kind,
      });
      state.touch();
    } else if (!delivered && !result.review) {
      records.set(record.unstartedFollowUp(issue, hold.runId), { count: 0, at: now(), companyId, issueId: issue.id, assigneeId: assignee.id, errorCode: run.errorCode });
      state.touch();
    }
    await noteToBoard(
      ctx,
      companyId,
      `${who}: ${why}${held}. The watchdog released it${stageText}${handOnStep}, recording that the run performed nothing` +
        `${delivered ? `, and ${delivered}` : ""}${result.monitorRestored ? ". Its monitor, cleared by Paperclip on the way, is set again" : ""}. Status now ${result.status}.`,
      { ...logExtra, level: "info", released: true, delivered: result.delivered, status: result.status, review: Boolean(result.review), handOn: handOn?.kind ?? null },
    );
  }

  // After a hand-on release: the held run's agent was asked to reassign the issue to its
  // target. Once HAND_ON_CHECK_MS has passed: given on, or moved elsewhere, is done; still
  // theirs with a run of theirs queued or running there, wait (a reassignment now would
  // cancel it and hold the issue again); still theirs and nothing running, the watchdog reassigns
  // it itself, which is safe then, and says so on the issue. Every tick.
  async function handOnFollowUp(companyId, agents) {
    for (const [key, r] of [...records.entries()]) {
      if (!key.startsWith(HAND_ON) || r?.companyId !== companyId) continue;
      if (now() - r.at < HAND_ON_CHECK_MS) continue;
      const done = () => {
        records.delete(key);
        state.touch();
      };
      const issue = await api.request("GET", `/api/issues/${r.issueId}`).catch(() => null);
      if (!issue) continue;
      const who = issue.identifier ?? issue.id;
      const target = await agentFor(r.targetId, agents).catch(() => null);
      const holder = await agentFor(r.holdAgentId, agents).catch(() => null);
      if (issue.assigneeAgentId !== r.holdAgentId || ["done", "cancelled"].includes(issue.status)) {
        done();
        continue;
      }
      if (issue.executionBlocker || reviewPending(issue)) {
        // Held again, or in a review now: the scan's, or the board's.
        done();
        continue;
      }
      const runs = await api.request("GET", `/api/issues/${r.issueId}/runs`).catch(() => null);
      if (!Array.isArray(runs)) continue;
      if (runs.some((x) => ACTIVE_RUN.has(x.status))) {
        if (now() - r.at > DAY_MS) {
          done();
          await noteToBoard(ctx, companyId, `${who}: the watchdog asked ${holder?.name ?? "the held run's agent"} to give this issue to ${target?.name ?? "its owner"} a day ago, and a run is still active on it. See \`pch why ${who}\`.`, { issue: who });
        }
        continue;
      }
      if (!target || target.status === "terminated") {
        done();
        await noteToBoard(ctx, companyId, `${who}: ${holder?.name ?? "the held run's agent"} didn't give this issue to ${target?.name ?? "its owner"}, who can't take it now. It is yours to assign.`, { issue: who });
        continue;
      }
      done();
      try {
        await api.request("PATCH", `/api/issues/${r.issueId}`, {
          assigneeAgentId: r.targetId,
          comment:
            `[@${target.name}](agent://${target.id}) this issue is yours again: Paperclip had held it behind a run of ${holder?.name ?? "another agent"}'s that never ran, ` +
            `and the watchdog released that hold. ${holder?.name ?? "That agent"} was asked to hand it back to you and didn't, so the watchdog has. ` +
            `Please continue from the messages above.\n\n${WATCHDOG_SIGNATURE}`,
        });
        await noteToBoard(ctx, companyId, `${who}: ${holder?.name ?? "the held run's agent"} didn't give the issue to ${target.name} after the watchdog's release, so the watchdog did, with nothing of theirs running there any more.`, { issue: who, level: "info" });
      } catch (err) {
        await noteToBoard(ctx, companyId, `${who}: ${holder?.name ?? "the held run's agent"} didn't give the issue to ${target.name}, and the watchdog couldn't either (${err.message}). Assign it to ${target.name} yourself.`, { issue: who, error: err.message });
      }
    }
  }

  // After a release with nothing saved to deliver: once Paperclip has had two of its
  // delivery sweeps, the assignee is told to continue unless a run of its has started
  // since. Every tick, for the company's releases waiting on that.
  async function followUp(companyId, agents) {
    await handOnFollowUp(companyId, agents);
    for (const [key, r] of [...records.entries()]) {
      if (!key.startsWith(FOLLOW_UP) || r?.companyId !== companyId) continue;
      if (now() - r.at < FOLLOW_UP_AFTER_MS) continue;
      const done = () => {
        records.delete(key);
        state.touch();
      };
      if (now() - r.at > DAY_MS) {
        done();
        continue;
      }
      const runs = await api.request("GET", `/api/issues/${r.issueId}/runs`).catch(() => null);
      if (!Array.isArray(runs)) continue; // a later tick
      if (runs.some((x) => x.agentId === r.assigneeId && ts(x.createdAt) >= r.at - 1000)) {
        done();
        continue;
      }
      const issue = await api.request("GET", `/api/issues/${r.issueId}`).catch(() => null);
      if (!issue) continue;
      // Moved on meanwhile (another owner, finished, held again): nothing to say.
      if (issue.assigneeAgentId !== r.assigneeId || ["done", "cancelled"].includes(issue.status) || issue.executionBlocker) {
        done();
        continue;
      }
      const agent = await agentFor(r.assigneeId, agents).catch(() => null);
      if (!agent || asleep(agent)) continue;
      const runId = key.slice(key.lastIndexOf(":") + 1);
      await nudge(
        issue,
        record.releaseNudge(issue, runId),
        agent,
        `Paperclip held this issue behind a run of yours it had cancelled before it started (${r.errorCode}), and couldn't release the hold by itself. ` +
          "The watchdog has released it. That run did nothing, so there is nothing of it to check: please continue this issue.",
        { reason: "released unstarted hold" },
      );
      done();
    }
  }

  return { check, followUp };
}
