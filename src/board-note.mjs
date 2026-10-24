// Notes for the board: something the watchdog did, or found, that a person should
// know about. Always a warning in the log; also a comment on WATCHDOG_NOTIFY_ISSUE
// when that issue is in the same company (a board comment wakes the issue's
// assignee, so it should be assigned to a person or to nobody).

import { WATCHDOG_SIGNATURE } from "./util.mjs";

export async function noteToBoard({ api, config, log }, companyId, text, { source = "watchdog", signature = WATCHDOG_SIGNATURE, ...logExtra } = {}) {
  log.warn(`${source}: a note for the board`, { text, ...logExtra });
  const ref = config.watchdogNotifyIssue;
  if (!ref || config.dryRun) return false;
  const issue = await api.request("GET", `/api/issues/${encodeURIComponent(ref)}`).catch(() => null);
  if (!issue || issue.companyId !== companyId) return false; // another company's issue (or none): the log has it
  try {
    await api.request("POST", `/api/issues/${issue.id}/comments`, { body: `${text}\n\n${signature}` });
    return true;
  } catch (err) {
    log.warn(`${source}: couldn't post a note for the board`, { issue: ref, error: err.message });
    return false;
  }
}
