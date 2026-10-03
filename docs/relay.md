# The relay: GitHub → your decisions in Paperclip

In Paperclip, the current participant of a review or approval stage records a decision by changing the issue's status **with a comment in the same request**. `done` approves. Any other status, typically `in_progress`, requests changes and returns the issue to the engineer. The issue page has no button for that, and Paperclip's own Approve button appears only on stalled reviews. The relay receives signed GitHub webhooks and records that decision for you:

| On GitHub | In Paperclip |
|---|---|
| **You merge** the PR | The issue is **approved**: `done`, with a comment naming the PR and merge commit. |
| **You "Request changes"** in a review | **Changes requested**: `in_progress` and back to the engineer, with your review text as the brief. |
| **You comment `/changes …`** on the PR, or start a review with it | Same as Request changes. |
| **You comment `/approve …`** on the PR, or start a review with it | Approved without merging. |
| **You approve** the PR in a GitHub review | Nothing. Merging is the approval. |
| **You comment** or review anything else | Your text is copied to the issue as a comment, which wakes the assignee. |
| **Someone else merges**, or the PR is **closed** without merging | A comment only. |
| **The PR is opened, reopened or marked ready for review** | Its URL is posted on the issue, so Paperclip links the PR (`RELAY_LINK_PRS`). |

Every delivery's response body says what the relay did, for example `{"identifier":"ACM-2","action":"approve","status":"done"}`. `status` is read back from Paperclip after the decision, and a `warning` says when the issue didn't land where it was sent. You can see it in GitHub's webhook **Recent Deliveries**, and **Redeliver** retries a delivery that failed.

**Several stages of yours.** Approving a stage that isn't the last one moves the issue to the next stage. That happens when a review reaches its round cap and Paperclip hands it to you, and the approval stage after it is yours too. A merge approves each consecutive stage that is waiting on you, up to three, with a short comment on each (the response lists them as `stages`), and stops at the first stage that is someone else's.

**Finding the issue.** The relay collects every issue identifier (`ACM-12`) in the PR's title, branch name and body, and adds each issue's subtasks. It then acts on the one whose approval is waiting on you. A PR often names the *parent* issue, because its branch comes from the parent's workspace, while the review stages sit on a *subtask*. If none of those is waiting on you, it looks further: at the issues blocking them, and at subtasks of subtasks. That covers a PR that names a blocked issue while the work in review is the issue blocking it. The log line then says how it got there (`"via":"blocks ACM-12"`). If several are waiting, it prefers the one that lists this PR as a work product; if none does, it comments instead of guessing. If none is waiting on you, it only comments on the first issue named.

**Safety:**

- Only events signed with your webhook secret (HMAC-SHA256, compared in constant time) are accepted.
- Only repositories in `GITHUB_REPOS` are accepted.
- Only `GITHUB_OWNER_LOGIN` can approve or request changes. Anyone else's reviews and comments are ignored, and their merges only produce a comment.
- A decision is recorded only when Paperclip says it's waiting on *you*; otherwise the relay comments.
- The relay never merges, pushes or deletes anything.

**GitHub won't let you "Request changes" on your own PR.** If your agents open PRs with your own token, comment `/changes …` instead.

**Where to see what's waiting on you.** The Dashboard's "Pending Approvals" and the Approvals page list *formal* approval requests, such as agent hires and budget overrides, not review stages. To see reviews waiting on you, turn on **Instance settings → Experimental → Decisions**.

## Why an issue can show the wrong PRs

Paperclip builds an issue's "GitHub Pull Request" rows from full `github.com/<owner>/<repo>/pull/<n>` URLs anywhere in the issue's text. Agents usually write "PR #16", which links nothing, and a PR URL quoted from another issue shows up as if it belonged to this one. The relay posts the real PR's URL when the PR opens, so **the issue's latest "PR #N opened" comment is the one to trust.** The rows only appear with **Instance settings → Experimental → External Objects** turned on.

## Relay settings

| Setting | Default | Meaning |
|---|---|---|
| `RELAY` | unset | Unset: on when any of the three GitHub settings is set, and then all three are needed. `true`: required. `false`: off. |
| `GITHUB_WEBHOOK_SECRET` | none | The secret the GitHub webhook signs with. **Required.** |
| `GITHUB_OWNER_LOGIN` | none | Your GitHub login. **Required.** |
| `GITHUB_REPOS` | none | Comma-separated `owner/repo` list. **Required.** |
| `ISSUE_PREFIXES` | every company's own | Prefixes to look for, such as `ACM,OPS`. |
| `RELAY_LINK_PRS` | `true` | Post a newly opened PR's URL on its issue. |
| `RELAY_HOST`, `RELAY_PORT`, `RELAY_PATH` | `127.0.0.1`, `3110`, `/hooks/github` | Where the relay listens. |

**The GitHub webhook:**

- **Payload URL:** your public URL plus `RELAY_PATH`.
- **Content type:** `application/json`.
- **Secret:** `GITHUB_WEBHOOK_SECRET`.
- **Events:** **Pull requests**, **Pull request reviews** and **Issue comments**. "Pull requests" already includes opened, reopened and ready-for-review.

The installer can create it with `gh`. If `gh` answers 404, run `gh auth refresh -h github.com -s admin:repo_hook`.

---

[← Back to the README](../README.md)
