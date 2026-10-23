// The relay's notes about an issue's pull requests ("PR #12 opened by @carla",
// "closed without merging", "merged by someone else"), kept in an issue document
// instead of comments: a board comment wakes the issue's agent, and these need no
// action from it. Paperclip still links the PRs named in a document
// (externalObjectsSvc.syncDocumentSafely), and updating one wakes nobody.

const NOTES_KEY = "pull-requests";
const MARK = "_Kept by Paperclip Helper's relay";
const HEADER = `# Pull requests\n\n${MARK}: what happened to this issue's pull requests, newest last. Updating it wakes nobody._\n`;
const MAX_LINES = 200;

// Appends one line to the issue's notes document, creating it if needed. Anything
// a person added to it is kept; a document of that name the relay didn't start is
// left alone (an error, so the relay comments instead). Paperclip refuses an update whose baseRevisionId
// isn't the latest (409): read and try once more. A locked document isn't retried.
export async function appendNote(api, issueRef, line, { now = Date.now() } = {}) {
  const path = `/api/issues/${encodeURIComponent(issueRef)}/documents/${NOTES_KEY}`;
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  const entry = `- ${stamp} UTC: ${line}`;
  for (let attempt = 0; ; attempt += 1) {
    let doc = null;
    try {
      doc = await api.request("GET", path);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (doc && !String(doc.body ?? "").includes(MARK)) throw new Error(`the issue's "${NOTES_KEY}" document isn't the relay's`);
    try {
      await api.request("PUT", path, {
        title: doc?.title ?? "Pull requests",
        format: "markdown",
        body: doc ? withEntry(doc.body, entry) : `${HEADER}\n${entry}\n`,
        changeSummary: line.slice(0, 200),
        baseRevisionId: doc?.latestRevisionId ?? null,
      });
      return;
    } catch (err) {
      if (err.status !== 409 || /locked/i.test(err.message) || attempt >= 1) throw err;
    }
  }
}

// The body with the entry added at the end, dropping the oldest entries past MAX_LINES.
function withEntry(body, entry) {
  const lines = String(body).trimEnd().split("\n");
  lines.push(entry);
  let extra = lines.filter((l) => l.startsWith("- ")).length - MAX_LINES;
  const kept = lines.filter((l) => !(extra > 0 && l.startsWith("- ") && extra-- > 0));
  return `${kept.join("\n")}\n`;
}

// The PR links in an issue's notes document, for the watchdog: its text, or "".
export async function notesText(api, issueId) {
  const doc = await api.request("GET", `/api/issues/${issueId}/documents/${NOTES_KEY}`).catch(() => null);
  return String(doc?.body ?? "");
}
