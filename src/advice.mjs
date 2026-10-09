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
// question doesn't arise (null). Each rule mirrors a situation in watchdog.mjs or
// one the watchdog deliberately leaves to the board, so keep the two in step.

import { approvalWaitingOn, ts } from "./util.mjs";

const ACTIVE_RUN = new Set(["queued", "scheduled_retry", "running"]);
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
  if (ASLEEP.has(assignee?.status)) {
    return {
      what: `${who} is ${assignee.status.replace("_", " ")}, so Paperclip won't run it.`,
      steps: [
        `Resume ${who} in Paperclip (or approve it, or reassign the issue).`,
        `If nothing starts a few minutes later: ${comment(`${who}, please continue this issue.`)}`,
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

  const hold = issue.executionBlocker;
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

  if (issue.status === "blocked") {
    const finalizing = linked.filter((b) => b.isPendingFinalize);
    const open = linked.filter((b) => b.status !== "done" && b.status !== "cancelled");
    if (open.length) {
      return {
        what: `It is waiting on ${open.map((b) => `${b.identifier ?? b.id} (${b.status})`).join(", ")}.`,
        steps: open.slice(0, 3).map((b) => `pch why ${b.identifier ?? b.id}`),
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
    if (linked.length) {
      return {
        what: "Every blocker is done, but the wake that should have restarted the issue was dropped.",
        steps: [comment(`${who}, every blocker is done. Please continue this issue.`)],
        watchdog: auto,
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
    "cut off by a hand-off; `execution_reconciliation_required` means Paperclip refused the run before it started.",
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
