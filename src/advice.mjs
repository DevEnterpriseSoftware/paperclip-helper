// What to do about a stalled issue: `pch why` prints this under its diagnostics.
//
// advise() is a pure function of facts already fetched from Paperclip. It
// returns the first rule that matches:
//
//   { what, steps: [...], watchdog }
//
// `what` says what is going on in one sentence, `steps` what you can do about it
// (commands are written out, ready to paste), and `watchdog` whether the
// watchdog deals with it by itself ("auto"), will not ("manual"), or the
// question doesn't arise (null); `autoNote`, when set, says how it does. Each
// rule mirrors a situation in watchdog.mjs or one the watchdog deliberately
// leaves to the board, so keep the two in step.

import { ACTIVE_RUN, approvalWaitingOn, ts } from "./util.mjs";
import { cardText, strandedCard } from "./questions.mjs";
import { escalatedReview } from "./board-held.mjs";
import { PARTICIPANT_RECOVERY_CAUSE } from "./resume.mjs";
import { pausedHoldWhy } from "./paused-holds.mjs";
import { CONVERSATION_ADAPTERS } from "./release.mjs";
import { extensionAdvice, validationAdvice } from "./worktree-links.mjs";

const ASLEEP = new Set(["paused", "terminated", "pending_approval"]);
const QUEUED_TOO_LONG_MS = 10 * 60_000;
const LOOP_WINDOW_MS = 45 * 60_000;
const LOOP_RUNS = 3;

const mins = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
};

// One line of a comment, for quoting.
export function excerpt(text, max = 220) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function advise(facts) {
  const {
    identifier,
    issue = {},
    me = null,
    assignee = null, // { name, status }
    nameOf = () => null, // agentId → name, for agents already looked up
    blockers = null, // /diagnostics/blockers
    recovery = null, // the active recovery action, if any
    queue = null, // /queued-comments
    lastComment = null, // { body, author }
    link = null, // workspace.mjs linkFacts
    deadLinkRun = null, // { runId, workspaceId }: the assignee's last run failed restoring a linked workspace
    cards = [], // the issue's pending question cards (questions.mjs)
    routed = {}, // card id → the issue the watchdog routed it to
    limitPause = null, // the watchdog paused the assignee at a usage limit: { label, what, resetAt, resumeAt } (labels)
    lastFailure = null, // the assignee's latest run failed on its provider: { kind: "limit" | "transient", label, what, resetAt }
    participant = null, // the agent a pending review stage waits on: { name, status }
    stagesWipedBy = null, // in review with no stage: who removed its stages (watchdog 17), when the activity log shows it
    ciRun = null, // the CI run the assignee's latest comments say it waits on: "repo#id" or the bare id
    ciBackstop = null, // the watchdog's backstop monitor for that wait stands: { nextCheckAt }
    selfWake = null, // an agent keeps waking itself with its runs' posted final messages (self-wakes.mjs): { name, count }
    pauseHold = null, // the hold is from a run a pause cancelled (watchdog 18): { ownerName, runId, waiting, held }
    workspaceValidation = null, // Paperclip refused the assignee's runs at setup on the workspace (worktree-links.mjs): { reason, reasonCode, paths, repoUrl, nextAction }
    extensionError = null, // an agent's build fails on extensions.relativeWorktrees (worktree-links.mjs): { paths, in }
    config = {},
    now = Date.now(),
  } = facts;

  // Newest first, whatever order they arrived in.
  const byNewest = (list, key) => [...list].sort((x, y) => ts(y[key]) - ts(x[key]));
  const runs = byNewest(facts.runs ?? [], "createdAt");
  const wakes = byNewest(facts.wakes ?? [], "requestedAt");
  const who = assignee?.name ?? "the assignee";
  const comment = (text) => `pch comment ${identifier} "${text}"`;
  const auto = config.watchdog === false ? "manual" : "auto";
  const runId = (r) => r.runId ?? r.id;
  const refused = (r) => r.status === "cancelled" && r.errorCode === "execution_reconciliation_required";
  const linked = Array.isArray(blockers?.blockers) ? blockers.blockers : [];
  const mine = (r) => r.agentId && r.agentId === issue.assigneeAgentId;
  const note = lastComment?.body ? ` Its last note: "${excerpt(lastComment.body)}"` : "";

  if (issue.status === "done" || issue.status === "cancelled") {
    return { what: `The issue is ${issue.status}: nothing to do.`, steps: [], watchdog: null };
  }
  if (!issue.assigneeAgentId) {
    return {
      what: issue.assigneeUserId ? "The issue is assigned to a person, not an agent." : "Nobody is assigned.",
      steps: ["Assign it to the agent that should work on it; the assignment wakes the agent."],
      watchdog: "manual",
    };
  }
  const sweep = config.watchdog !== false && config.watchdogResumeSweep !== false;
  if (assignee?.status === "paused" && limitPause) {
    return {
      what:
        `The watchdog paused ${who} because its ${limitPause.label} ${limitPause.what} was reached` +
        `${limitPause.resetAt ? `; it resets ${limitPause.resetAt}` : ""}. It resumes ${who} at ${limitPause.resumeAt}.`,
      steps: [
        "Nothing to do but wait: every run before the reset would fail the same way.",
        `To resume ${who} sooner (the limit was raised, say), resume it in Paperclip; its issues blocked during the pause are restored after that too.`,
      ],
      watchdog: "auto",
      autoNote: "The watchdog resumes exactly the agents it paused, a few minutes after the reset, and then restores the issues Paperclip blocked meanwhile.",
    };
  }
  if (ASLEEP.has(assignee?.status)) {
    return {
      what: `${who} is ${assignee.status.replace("_", " ")}, so Paperclip won't run it.`,
      steps: [
        `Resume ${who} in Paperclip (or approve it, or reassign the issue).`,
        sweep
          ? `Once ${who} is resumed, the watchdog restores the issues Paperclip blocked during the pause and wakes them; others wait for you.`
          : `If nothing starts a few minutes later: ${comment(`${who}, please continue this issue.`)}`,
      ],
      watchdog: "manual",
    };
  }

  // An agent waking itself: whatever it is doing now, the next run follows the same way.
  if (selfWake) {
    return {
      what:
        `${selfWake.name} keeps waking itself: ${selfWake.count} of its runs here in the last hour ended without a comment of its own, ` +
        "Paperclip posted each run's final message as its comment, and that comment started its next run within seconds.",
      steps: [
        "Pause the issue (or the agent) to stop the loop.",
        `Tell ${selfWake.name} (its instructions) to end every run with a comment of its own: what it did, and what it waits on, if anything.`,
        `Then resume, and if it should carry on: ${comment(`${selfWake.name}, please continue this issue.`)}`,
      ],
      watchdog: "manual",
    };
  }

  const active = runs.filter((r) => ACTIVE_RUN.has(r.status));
  const myActive = active.find(mine);
  if (myActive) {
    if (myActive.status === "running") {
      return { what: `${who} is working on it now (running for ${mins(now - ts(myActive.createdAt))}).`, steps: [], watchdog: null };
    }
    const waited = now - ts(myActive.createdAt);
    if (waited < QUEUED_TOO_LONG_MS) {
      return { what: `${who} has a run queued (${mins(waited)}); it should start shortly.`, steps: [], watchdog: null };
    }
    return {
      what: `${who}'s run has been queued for ${mins(waited)} without starting.`,
      steps: [
        `Open ${who}'s agent page. If it is running another issue, this run starts when that one ends.`,
        `If ${who} is idle, the queue is stuck: press Interrupt on the queued message in the issue's chat, or cancel the queued run and ${comment(`${who}, please continue this issue.`)}`,
      ],
      watchdog: "manual",
    };
  }
  if (active.length) {
    const other = nameOf(active[0].agentId) ?? "Another agent";
    return {
      what: `${other} still has a ${active[0].status} run on this issue; ${who} starts after it.`,
      steps: [`Wait for it to finish. If it has been ${active[0].status} for long, check ${other}'s agent page.`],
      watchdog: null,
    };
  }

  // A link to a closed workspace: Paperclip fails every run at setup, so no
  // retry, comment or nudge helps until the link is cleared.
  const ws = (id) => String(id ?? "").slice(0, 8);
  const ownerName = link?.owner ? link.owner.identifier ?? ws(link.owner.id) : null;
  const fixed = comment(`${who}, the workspace is fixed: you have a new isolated workspace. Please continue this issue.`);
  if (link?.state === "dead" || (deadLinkRun && link?.state === "unknown" && link.workspaceId === deadLinkRun.workspaceId)) {
    return {
      what:
        `${who}'s runs can't start: the issue reuses ${ownerName ? `${ownerName}'s workspace` : "workspace"} ${ws(link.workspaceId)}, ` +
        `which ${link.missing ? "no longer exists" : "is closed"}, so Paperclip fails every run at setup (setup_failed). Retries and comments fail the same way.`,
      steps: [
        `pch workspace ${identifier}   (shows the link, and other open issues linked to the same workspace)`,
        `pch workspace ${identifier} --apply   (gives them a new isolated workspace, like "New isolated workspace" in the Workspace picker)`,
        `Then: ${fixed}`,
      ],
      watchdog: config.watchdog === false || config.watchdogClearDeadLinks === false ? "manual" : "auto",
      autoNote:
        "The watchdog clears the link by itself within a minute, and restarts the agent if the issue is todo or in progress. " +
        'It can\'t while Instance settings → Experimental → "Enable Isolated Workspaces" is off.',
    };
  }
  if (deadLinkRun && link?.state === "none") {
    return {
      what: `${who}'s last run failed because the issue was linked to a closed workspace (${ws(deadLinkRun.workspaceId)}). The link has been cleared since, but nothing has restarted ${who}.`,
      steps: [fixed],
      // The watchdog restarts an assignee only right after clearing the link itself.
      watchdog: "manual",
    };
  }

  if (escalatedReview(issue, me)) {
    const rounds = issue.executionState?.changesRequestedCount;
    const back = config.watchdog !== false && config.watchdogReturnEscalatedReviews === true;
    return {
      what:
        `Paperclip handed this review to you after ${rounds ? `${rounds} agent change requests` : "the agents' change requests"} in a row on its review stage ` +
        "(its review-round limit, maxReviewRounds), instead of back to the implementer.",
      steps: [
        `Decide it: pch approve ${identifier} "<note>"   or   pch changes ${identifier} "<what to change>"   (changes go back to the implementer, and give the agents more rounds)`,
        "To let the agents settle more reviews themselves, raise maxReviewRounds in the execution policy.",
      ],
      watchdog: back ? "auto" : "manual",
      autoNote: `The watchdog returns it to the implementer with the reviewer's latest request (WATCHDOG_RETURN_ESCALATED_REVIEWS), at most ${config.watchdogMaxNudges ?? 2} times per issue.`,
    };
  }
  if (approvalWaitingOn(issue, me)) {
    const stage = issue.executionState?.currentStageType ?? "decision";
    return {
      what: `The ${stage} is waiting on you.`,
      steps: [
        "Merge the PR on GitHub (the relay approves), or comment `/changes <brief>` on the PR to send it back.",
        `From here: pch approve ${identifier} "<note>"   or   pch changes ${identifier} "<what to change>"`,
      ],
      watchdog: "manual",
    };
  }

  // Paperclip refuses every run at setup until it can verify the workspace's git
  // checkout: no retry, comment or hold release helps before that is fixed on the host.
  if (workspaceValidation) {
    return validationAdvice(workspaceValidation, {
      identifier,
      who,
      comment,
      nextAction: workspaceValidation.nextAction ?? issue.executionBlocker?.nextAction ?? null,
      paths: workspaceValidation.paths ?? {},
      repoUrl: workspaceValidation.repoUrl ?? null,
    });
  }

  // Builds that fail on the repository extension git left behind after relative
  // worktree links: whatever else holds the issue, its agent can't build until it's gone.
  if (extensionError) return extensionAdvice({ who, comment, paths: extensionError.paths ?? {} });

  const hold = issue.executionBlocker;
  // A run a pause cancelled holds every agent's wakes on the issue (watchdog 18).
  // Paperclip lifts it only on a board user's comment while the issue is assigned
  // to that run's agent, and that agent isn't paused.
  if (hold && pauseHold) {
    const owner = pauseHold.ownerName ?? "the paused agent";
    const paused = pauseHold.ownerStatus === "paused";
    const conversation = !pauseHold.ownerAdapter || CONVERSATION_ADAPTERS.has(pauseHold.ownerAdapter);
    const what =
      `${pausedHoldWhy(pauseHold)}: ${pauseHold.held ? `${pauseHold.held} won't start` : "no run starts here"}. ` +
      "A status change, a reassignment on its own, an agent's comment, a comment while someone else has the issue, and Interrupt all leave it.";
    if (!conversation) {
      return {
        what: `${what} Paperclip continues only an agent on a conversation adapter, and ${owner} is on ${pauseHold.ownerAdapter}.`,
        steps: [`pch release ${identifier}   (shows the held run; a reconciliation is what's left)`],
        watchdog: "manual",
      };
    }
    return {
      what,
      steps: [
        ...(paused ? [`Resume ${owner} first: nothing lifts the hold while ${owner} is paused.`] : []),
        `${pauseHold.assigneeName && pauseHold.assigneeName !== owner ? `Assign the issue back to ${owner} (it is with ${pauseHold.assigneeName} now).` : `Keep the issue assigned to ${owner}.`}`,
        `Then, as the board: ${comment(`${owner}, your run was cancelled by a pause. Please continue from where it cut you off and hand the issue on as usual.`)}`,
        `pch release ${identifier} --apply   (does both${paused ? ", once it is resumed" : ""})`,
      ],
      watchdog: config.watchdog === false || config.watchdogReleaseHolds === false ? "manual" : "auto",
      autoNote:
        `The watchdog does both by itself once ${owner} is resumed and the resume has settled (WATCHDOG_RELEASE_HOLDS), ` +
        "paced by the agent's run limit, and tells the board.",
    };
  }
  // A run that recorded no process id or stop can never prove it stopped: a
  // message or Interrupt is saved again behind it, every time.
  const unprovable = hold && (queue?.executionWait?.reason === "process_identity_missing" ||
    /no verified stop record/i.test(queue?.executionWait?.message ?? ""));
  if (hold && (unprovable || hold.cause === "legacy_execution_requires_reconciliation") && hold.recoveryActionId && !hold.workspaceRepairRequired) {
    return {
      what:
        `Paperclip is holding execution on this issue (${hold.cause ?? "unknown cause"}) until the board confirms its last run stopped.` +
        (unprovable ? " That run recorded no process or stop, so messages and Interrupt can't release it." : ""),
      steps: [
        ...(hold.nextAction ? [`Paperclip's own next action: ${hold.nextAction}`] : []),
        `pch release ${identifier}   (shows the held run and what releasing it does)`,
        `pch release ${identifier} --apply   (records that the run stopped, with its outcome unverified, and delivers the saved messages)`,
        `Then make sure ${who} checks the branch before building on it: the stopped run may have done part of its work.`,
      ],
      watchdog: config.watchdog === false || config.watchdogReleaseHolds === false ? "manual" : "auto",
    };
  }
  if (hold) {
    return {
      what: `Paperclip is holding execution on this issue (${hold.cause ?? "unknown cause"}) and refuses new runs until it's released.`,
      steps: [
        ...(hold.nextAction ? [`Paperclip's own next action: ${hold.nextAction}`] : []),
        `Message ${who} in the issue's chat with what to do next. If it shows "Your message is saved", press Interrupt on it.`,
        "A hold from a run that was still doing something clears on its own within minutes; one that stays needs that message.",
      ],
      watchdog: "manual",
    };
  }

  // A run that hit its plan's usage limit: every run before the reset fails the same way.
  if (lastFailure?.kind === "limit") {
    const pauseOn = config.watchdog !== false && config.watchdogLimitPause !== false;
    return {
      what: `${who}'s last run hit its ${lastFailure.label} ${lastFailure.what}${lastFailure.resetAt ? `, which resets ${lastFailure.resetAt}` : ""}. Every run before then fails the same way.`,
      steps: [
        "Wait for the reset (or raise the plan's limit); nothing on the issue helps before then.",
        `After the reset: ${comment(`${who}, the usage limit has reset. Please continue this issue.`)}`,
      ],
      watchdog: pauseOn ? "auto" : "manual",
      autoNote:
        "The watchdog pauses the agents on that account as each goes idle, so Paperclip stops retrying them, resumes them a few minutes after the reset, " +
        "and then restores the issues Paperclip blocked meanwhile.",
    };
  }

  if (recovery?.cause === PARTICIPANT_RECOVERY_CAUSE) {
    const reviewer = participant?.name ?? "the reviewer";
    const asleep = ASLEEP.has(participant?.status);
    return {
      what:
        `Paperclip's recovery blocked this review because it couldn't wake ${reviewer}, the agent its pending review stage waits on` +
        `${asleep ? ` (${reviewer} is ${participant.status.replace("_", " ")})` : ""}.${note}`,
      steps: [
        ...(asleep ? [`Resume ${reviewer} in Paperclip.`] : []),
        `${asleep ? "Then set" : "Set"} the issue's status back to In review: Paperclip re-pends the stage and wakes ${reviewer}.`,
      ],
      watchdog: asleep && sweep ? "auto" : "manual",
      autoNote: `Once ${reviewer} is resumed and the resume has settled, the watchdog puts the issue back in review by itself, if Paperclip blocked it while ${reviewer} was paused.`,
    };
  }

  if (recovery) {
    const stranded = recovery.kind === "stranded_assigned_issue" && recovery.ownerType === "board";
    if (stranded) {
      return {
        what:
          `Paperclip's recovery parked this issue for a board decision: it couldn't run ${who} when it looked ` +
          `(the agent was paused, or the issue had just changed hands). ${who} is available now.`,
        steps: [
          comment(`${who}, please continue this issue.`),
          "A plain comment is the decision Paperclip is waiting for: it moves the issue out of blocked and wakes the agent.",
        ],
        watchdog: auto,
      };
    }
    return {
      what: `Paperclip's recovery parked this issue for a board decision (${recovery.kind ?? recovery.cause ?? "unknown kind"}).${note}`,
      steps: [
        ...(recovery.nextAction ? [`Paperclip's own next action: ${recovery.nextAction}`] : []),
        `Decide who continues, then say so on the issue: ${comment("<who should do what next>")}`,
        `If the comment shows "Your message is saved", press Interrupt on it. If the wrong agent holds the issue, reassign it first.`,
      ],
      watchdog: "manual",
    };
  }

  if (queue?.queueId && queue.state === "deferred" && queue.entries?.length) {
    return {
      what: `${queue.entries.length} saved message(s) for ${who} are waiting behind an earlier run that still holds execution.`,
      steps: [
        "Press Interrupt on the saved message in the issue's chat (\"send queued messages now\").",
        "If it comes back saved again, the earlier run's process or environment lease is still alive: see the runs above.",
      ],
      watchdog: config.watchdogRetryDeferred === false ? "manual" : auto,
    };
  }

  // A question card addressed to a teammate who isn't the assignee: Paperclip
  // cancels the teammate's wake before it starts, so the asker waits for good.
  const stranded = cards.filter((c) => strandedCard(c, issue));
  if (stranded.length) {
    const c = stranded[0];
    const to = nameOf(c.addresseeAgentId) ?? "the addressee";
    const from = nameOf(c.createdByAgentId) ?? who;
    const relay = routed[c.id];
    const more = stranded.length > 1 ? ` (and ${stranded.length - 1} more card${stranded.length > 2 ? "s" : ""} like it)` : "";
    const off = config.watchdog === false || config.watchdogRouteQuestions === false;
    return {
      what:
        `${from} is waiting on a question card addressed to ${to}, asked ${mins(now - ts(c.createdAt))} ago${more}: "${cardText(c, 160)}" ` +
        `Paperclip never delivers it: ${to} isn't the assignee, so the wake the card sends is cancelled before it starts (issue_assignee_changed).`,
      steps: relay
        ? [`The watchdog gave ${to} ${relay} to answer it. pch why ${relay} if nothing is happening there.`]
        : [
            `Answer the card yourself in the issue's thread, if it's your call; answering wakes ${from}.`,
            `Or create an issue assigned to ${to}: "Answer the question card on ${identifier}". Any run of ${to} can answer it, and answering wakes ${from}.`,
          ],
      watchdog: relay ? null : off ? "manual" : "auto",
      autoNote: `The watchdog does the second by itself once the card has waited ${config.watchdogStallSec ?? 180}s, and closes that issue once the card is answered.`,
    };
  }
  // A card for you, a person, or anyone: Paperclip's own waiting path, so nothing is stalled but you.
  const forPeople = cards.filter((c) => !c.addresseeAgentId);
  if (forPeople.length && (issue.status === "in_review" || issue.status === "blocked")) {
    const c = forPeople[0];
    const forYou = c.addresseeUserId && c.addresseeUserId === me;
    return {
      what:
        `${nameOf(c.createdByAgentId) ?? who} is waiting on a question card ${forYou ? "addressed to you" : c.addresseeUserId ? "addressed to a board user" : "anyone may answer"}, ` +
        `asked ${mins(now - ts(c.createdAt))} ago: "${cardText(c, 160)}"`,
      steps: ["Answer the card in the issue's thread; answering wakes the agent."],
      watchdog: "manual",
    };
  }

  if (issue.status === "blocked") {
    const finalizing = linked.filter((b) => b.isPendingFinalize);
    const open = linked.filter((b) => b.status !== "done" && b.status !== "cancelled");
    // Paperclip never counts a cancelled blocker as resolved: the issue stays blocked.
    const cancelled = linked.filter((b) => b.status === "cancelled");
    if (open.length) {
      return {
        what: `It is waiting on ${open.map((b) => `${b.identifier ?? b.id} (${b.status})`).join(", ")}.`,
        steps: [...open.slice(0, 3).map((b) => `pch why ${b.identifier ?? b.id}`), "pch blocked   (follows every chain of blocked issues to the issue it ends at, and says what that one waits on)"],
        watchdog: null,
      };
    }
    if (finalizing.length) {
      const names = finalizing.map((b) => b.identifier ?? b.id).join(", ");
      return {
        what: `${names} is done, but its workspace clean-up hasn't finished, so Paperclip still counts it as a blocker.`,
        steps: [
          "If the clean-up above shows failed: remove it from \"Blocked by\", move this issue to todo, and tell the agent to pull the branch first.",
          "If it is still running, wait: Paperclip unblocks the issue when it succeeds.",
        ],
        watchdog: config.watchdogHealFailedFinalize === false ? "manual" : auto,
      };
    }
    if (cancelled.length) {
      const names = cancelled.map((b) => b.identifier ?? b.id).join(", ");
      return {
        what: `It is blocked by ${names}, which ${cancelled.length === 1 ? "was" : "were"} cancelled. Paperclip never counts a cancelled blocker as resolved, so the issue stays blocked.`,
        steps: [
          `If the work landed elsewhere or isn't needed: remove ${names} from "Blocked by" (and link what replaced it). That releases the issue.`,
          "If it is still needed: say so on the issue and create a replacement to block on.",
        ],
        watchdog: config.watchdog === false || config.watchdogCancelledBlockers === false ? "manual" : "auto",
        autoNote: `The watchdog tells ${who} once, quoting why the blocker was cancelled, so it can remove or replace the blocker itself.`,
      };
    }
    if (linked.length) {
      return {
        what: "Every blocker is done, but the wake that should have restarted the issue was dropped.",
        steps: [comment(`${who}, every blocker is done. Please continue this issue.`)],
        watchdog: auto,
      };
    }
    // Linked to another issue's live workspace: an agent that notices blocks the
    // issue and asks for a ruling on the workspace or branch.
    if (link?.state === "foreign" && /workspace|branch|worktree/i.test(lastComment?.body ?? "")) {
      const branch = link.workspace?.branchName ? ` (branch ${link.workspace.branchName})` : "";
      return {
        what:
          `${who} blocked this issue over its workspace: it is linked to ${ownerName ?? "another issue"}'s live workspace${branch}, ` +
          `so its commits would land on that issue's branch.${note}`,
        steps: [
          `If it should have its own branch and PR: pch workspace ${identifier} --apply   (a new isolated workspace from the base branch)`,
          `Then give the ruling: ${comment(`${who}, workspace ruling: you have your own isolated workspace now. Don't commit to ${ownerName ?? "the other issue"}'s branch. Please continue.`)}`,
          `If it should build on ${ownerName ?? "that issue"}'s branch after all, say so in a comment instead.`,
        ],
        watchdog: "manual",
      };
    }
    const recentRuns = runs.filter((r) => mine(r) && now - ts(r.createdAt) < LOOP_WINDOW_MS);
    if (recentRuns.length >= LOOP_RUNS) {
      return {
        what: `${who} has run ${recentRuns.length} times in the last ${mins(LOOP_WINDOW_MS)} and blocks the issue again each time: it is waiting on something only you can provide.${note}`,
        steps: [
          "Give it what the note asks for: decide the approval (Approvals page), grant the permission, or do the step yourself and say so in a comment.",
          "Until you can, pause the issue: every lap costs a run.",
        ],
        watchdog: "manual",
      };
    }
    return {
      what: `${who} blocked this issue with a note of its own; no blocking issue is linked.${note}`,
      steps: [
        "Read the note and answer it in a comment on the issue; the comment moves it out of blocked and wakes the agent.",
        `If the note names another issue, link it under "Blocked by" so Paperclip tracks it.`,
      ],
      watchdog: "manual",
    };
  }

  // In review with no stage pending: nothing will wake a reviewer.
  if (issue.status === "in_review" && issue.executionState?.status !== "pending") {
    return {
      what:
        "It is in review, but no review stage is pending, so no reviewer is woken: it waits for someone to move it." +
        (stagesWipedBy ? ` Its review stages were removed by ${stagesWipedBy} (an update that sent executionPolicy.stages: [], a Paperclip bug).` : ""),
      steps: [
        "If it needs a review: restore the stages in its execution policy, then set it back to In review.",
        "If it doesn't: merge its PR (the relay closes an issue whose stages were removed) or set it to done.",
      ],
      watchdog: "manual",
    };
  }

  const worked = runs.filter((r) => !refused(r));
  const latest = worked[0] ?? null;
  const quietFor = runs[0] ? mins(now - (ts(runs[0].finishedAt) || ts(runs[0].createdAt))) : null;
  if (runs.length && runs.some(refused) && (!latest || !mine(latest))) {
    return {
      what: `Paperclip refused ${who}'s runs while the issue was held after a hand-off. The hold is gone, but nothing woke ${who} again.`,
      steps: [comment(`${who}, please pick this issue up.`)],
      watchdog: auto,
    };
  }
  if (latest && !mine(latest)) {
    const previous = nameOf(latest.agentId) ?? "the previous owner";
    const myPending = wakes.find((w) => w.agentId === issue.assigneeAgentId && ["queued", "claimed"].includes(w.status));
    if (myPending) {
      return { what: `${who} has a wake ${myPending.status}; it should start shortly.`, steps: [], watchdog: null };
    }
    return {
      what: `The issue was handed from ${previous} to ${who} ${quietFor} ago, and ${who} never started: Paperclip dropped the hand-off wake.`,
      steps: [comment(`${who}, this issue is yours now. Please pick it up.`)],
      watchdog: auto,
    };
  }
  if (!runs.length) {
    return {
      what: `No run has ever started on this issue.`,
      steps: [comment(`${who}, please start this issue.`), `If that doesn't start a run, check ${who}'s agent page for errors.`],
      watchdog: "manual",
    };
  }
  if (latest && latest.status === "failed" && lastFailure?.kind === "transient" && mine(latest)) {
    return {
      what: `${who}'s last run failed on ${lastFailure.label}'s capacity ${quietFor} ago (the model was busy, not a usage limit).`,
      steps: [`Paperclip retries it by itself. If no retry comes: ${comment(`${who}, please retry this issue.`)}`],
      watchdog: null,
    };
  }
  if (latest && ["failed", "timed_out"].includes(latest.status)) {
    return {
      what: `${who}'s last run ${latest.status === "failed" ? "failed" : "timed out"}${latest.errorCode ? ` (${latest.errorCode})` : ""} ${quietFor} ago.`,
      steps: [
        `Open run ${String(runId(latest)).slice(0, 8)} in Paperclip for the error.`,
        `Once the cause is fixed: ${comment(`${who}, please retry this issue.`)}`,
      ],
      watchdog: "manual",
    };
  }
  if (latest && latest.status === "succeeded" && ciRun) {
    const reports = config.watchdog !== false && config.watchdogCiRuns !== false && Boolean(config.githubToken || config.githubTokenFile);
    return {
      what:
        `${who}'s last run finished ${quietFor} ago, waiting on CI run ${ciRun}.` +
        `${ciBackstop ? ` The Helper's backstop monitor holds the wait (next check ${ciBackstop.nextCheckAt}), so Paperclip doesn't count it as stalled.` : ""}${note}`,
      steps: [
        "Wait for the run to finish.",
        `If it has finished and ${who} hasn't heard: ${comment(`${who}, CI run ${ciRun} has finished. Please check its result and continue.`)}`,
      ],
      watchdog: reports ? "auto" : "manual",
      autoNote: `Once the run has finished and ${who} hasn't run since, the watchdog comments with its result and the failed jobs, which wakes ${who} (needs a GitHub token with Actions: Read).`,
    };
  }
  if (latest && latest.status === "succeeded") {
    return {
      what: `${who}'s last run finished ${quietFor} ago and left the issue ${issue.status}.${note}`,
      steps: [
        "Read its last note: it usually says what it is waiting for.",
        `To have it carry on: ${comment(`${who}, please continue this issue.`)}`,
      ],
      watchdog: "manual",
    };
  }
  return {
    what: "Nothing here looks stuck.",
    steps: [`If it should be moving: ${comment(`${who}, please continue this issue.`)}`],
    watchdog: null,
  };
}

// The same facts as a prompt for an LLM chat, for the cases the rules don't settle.
export function llmPrompt({ identifier, report, advice, lastComments = [] }) {
  const notes = lastComments.length
    ? lastComments.map((c) => `- ${c.author ?? "someone"}${c.createdAt ? ` (${c.createdAt})` : ""}: ${excerpt(c.body, 600)}`).join("\n")
    : "(none read)";
  return [
    "I run a self-hosted Paperclip (the AI-agent task manager) with Paperclip Helper beside it.",
    `Issue ${identifier} is not moving. Below are Paperclip's own diagnostics, as printed by \`pch why ${identifier}\`,`,
    "the helper's rule-based recommendation, and the issue's latest comments.",
    "",
    "Tell me, briefly: (1) what is most likely holding the issue, (2) the smallest action that gets it moving,",
    "as a Paperclip UI step or a `pch` command, and (3) what you would need to see if you can't tell.",
    "Things worth knowing: a comment from me (a board user) wakes the issue's assignee; a wake marked",
    "`deferred_issue_execution` is parked behind an earlier run; a run cancelled with `issue_reassigned` was",
    "cut off by a hand-off; `execution_reconciliation_required` means Paperclip refused the run before it started;",
    "a run cancelled with `agent_paused` was stopped by a pause; Paperclip never counts a cancelled blocker as resolved;",
    "a run that failed on a usage limit fails again on every retry until the limit resets;",
    "and `workspace_validation_failed` means Paperclip refused the run before the agent started because it couldn't verify",
    "the workspace's git checkout: its `reasonCode` says what it couldn't prove (`source_registration_unproven` is most often",
    "worktree links git wrote as relative paths, `worktree.useRelativePaths`), and every retry fails the same way until it's fixed on the host.",
    "A build that fails with \"Unsupported repository extension 'relativeworktrees'\" is the `extensions.relativeWorktrees` git leaves",
    "in the checkout's config after those links are repaired: .NET SourceLink and libgit2 refuse it, and unsetting it fixes the build.",
    "",
    "## pch why",
    report,
    "",
    "## Helper's recommendation",
    advice.what,
    ...advice.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Latest comments (newest first)",
    notes,
  ].join("\n");
}
