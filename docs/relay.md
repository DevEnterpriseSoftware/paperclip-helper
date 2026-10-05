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
| **A merge leaves another open PR with conflicts** | That PR's issue goes back to its agent to resolve them, and the PR gets a comment saying so (`RELAY_FIX_CONFLICTS`, [below](#prs-with-merge-conflicts)). |

Every delivery's response body says what the relay did, for example `{"identifier":"ACM-2","action":"approve","status":"done"}`. `status` is read back from Paperclip after the decision, and a `warning` says when the issue didn't land where it was sent. You can see it in GitHub's webhook **Recent Deliveries**, and **Redeliver** retries a delivery that failed.

**Several stages of yours.** Approving a stage that isn't the last one moves the issue to the next stage. That happens when a review reaches its round cap and Paperclip hands it to you, and the approval stage after it is yours too. A merge approves each consecutive stage that is waiting on you, up to three, with a short comment on each (the response lists them as `stages`), and stops at the first stage that is someone else's.

<a id="finding-the-issue"></a>**Finding the issue.** The relay collects every issue identifier (`ACM-12`) in the PR's title, branch name and body, and adds each issue's subtasks. It then acts on the one whose approval is waiting on you. A PR often names the *parent* issue, because its branch comes from the parent's workspace, while the review stages sit on a *subtask*. If none of those is waiting on you, it looks further: at the issues blocking them, and at subtasks of subtasks. That covers a PR that names a blocked issue while the work in review is the issue blocking it. The log line then says how it got there (`"via":"blocks ACM-12"`). If several are waiting, it prefers the one that lists this PR as a work product; if none does, it comments instead of guessing. If none is waiting on you, it only comments on the first issue named.

**Safety:**

- Only events signed with your webhook secret (HMAC-SHA256, compared in constant time) are accepted.
- Only repositories in `GITHUB_REPOS` are accepted.
- Only `GITHUB_OWNER_LOGIN` can approve or request changes. Anyone else's reviews and comments are ignored, and their merges only produce a comment.
- A decision is recorded only when Paperclip says it's waiting on *you*; otherwise the relay comments.
- The relay never merges, pushes, closes or deletes anything. Without `RELAY_FIX_CONFLICTS` it never calls GitHub at all; with it, it reads pull requests and comments on the ones it sends back.

**GitHub won't let you "Request changes" on your own PR.** If your agents open PRs with your own token, comment `/changes …` instead.

**Where to see what's waiting on you.** The Dashboard's "Pending Approvals" and the Approvals page list *formal* approval requests, such as agent hires and budget overrides, not review stages. To see reviews waiting on you, turn on **Instance settings → Experimental → Decisions**.

## PRs with merge conflicts

When agents open many small PRs, they overlap. Each one you merge can leave others conflicting with the base branch, and those then sit in your queue although you can't merge them. GitHub sends no event when that happens, so the relay asks. With `RELAY_FIX_CONFLICTS=true` it looks at the open PRs:

- **after every merge** into a branch, by anyone, at the other open PRs into that branch;
- **every `RELAY_CONFLICT_SWEEP_SEC`** (15 minutes) at all of them, in case a webhook was missed or the helper was down.

For each PR that GitHub says conflicts, it does what you would do with `/changes`:

1. It finds the PR's issue [the same way](#finding-the-issue) as for your own decisions.
2. If that issue's review is waiting on you, it **requests changes**: the issue goes back to its engineer, in your name, with a brief to bring the branch up to date with the base branch, resolve the conflicts, run the tests and push to the same branch. If the review isn't waiting on you, it **comments** with the same brief instead, which wakes the assignee and records no decision.
3. It **comments on the PR**, so you can see it was already sent back and how:

   > **Sent back for merge conflicts.** This PR conflicts with `main`, so ACM-12 was returned to its agent with changes requested. Attempt 1 of 2; nothing more is sent until the branch is pushed.

**What stops it from looping or wasting runs:**

- **Once per push.** A PR is not sent back again until its branch gets a new commit.
- **A cap.** After `RELAY_CONFLICT_MAX_ATTEMPTS` (2) pushes that still conflict, it stops and says on the PR that it needs you. A PR that merges cleanly again starts from zero.
- **Skipped:** drafts, PRs that name no Paperclip issue, and PRs whose issue is done or cancelled.
- **`DRY_RUN=true`** logs what it would send back and touches nothing.

Every look is one log line, `relay: conflict sweep`, listing each PR it acted on or left alone and why. `pch status` shows how many were sent back and when it last looked.

**Good to know:**

- If five PRs touch the same file, every merge sends the remaining ones back again. That is one agent run per PR per merge; the relay saves you the manual step, not the runs.
- Right after a merge GitHub needs a few seconds to work out which PRs conflict. The relay waits and asks again; a PR GitHub is still unsure about is picked up by the next look.
- The relay's own PR comments end with a hidden marker, so they are not copied back to the issue as if you had written them.

### The GitHub token

The relay needs a token to read pull requests and comment on them. A **fine-grained personal access token** limited to your repositories is the safest:

1. Open **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → [Generate new token](https://github.com/settings/personal-access-tokens/new)**.
2. **Token name:** `paperclip-helper`. **Expiration:** your choice; when it expires the log says `GitHub rejected GITHUB_TOKEN`, and you create a new one.
3. **Resource owner:** the account or organization that owns the repositories. An organization may have to approve the token first.
4. **Repository access:** **Only select repositories**, and pick the ones in `GITHUB_REPOS`.
5. **Permissions → Repository permissions → Pull requests: Read and write.** GitHub adds **Metadata: Read-only** by itself. Nothing else is needed. With `RELAY_CONFLICT_PR_COMMENT=false`, **Read-only** is enough.
6. **Generate token**, and copy it (`github_pat_…`). GitHub shows it once.
7. Re-run the installer and answer yes to "Send PRs with merge conflicts back to their agents automatically?", or put it in `.env` yourself and run `docker compose up -d`:

   ```
   RELAY_FIX_CONFLICTS=true
   GITHUB_TOKEN=github_pat_…
   ```

8. Run `pch check`. It prints `GitHub: GITHUB_TOKEN reads owner/repo (3 open PRs)` for each repository, or what GitHub refused.

A **classic** token works too: [generate one](https://github.com/settings/tokens/new) with the `repo` scope (`public_repo` for public repositories only). It reaches every repository you can, so prefer the fine-grained one.

The PR comments are written by the token's account. With your own token they appear under your name; a token from a separate bot account that can read the repositories makes them stand out.

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
| `RELAY_FIX_CONFLICTS` | `false` | Send PRs with merge conflicts back to their agents. Needs `GITHUB_TOKEN`. |
| `GITHUB_TOKEN` | none | The [token](#the-github-token) the relay reads pull requests and comments with. |
| `RELAY_CONFLICT_MAX_ATTEMPTS` | `2` | Send-backs per PR while it keeps conflicting, one per push, before it is left to you. |
| `RELAY_CONFLICT_PR_COMMENT` | `true` | Say on the PR that it was sent back. |
| `RELAY_CONFLICT_SWEEP_SEC` | `900` | Also look at every open PR this often. `0`: only after a merge. Otherwise at least 60. |
| `GITHUB_API` | `https://api.github.com` | For GitHub Enterprise Server: `https://<host>/api/v3`. |
| `RELAY_HOST`, `RELAY_PORT`, `RELAY_PATH` | `127.0.0.1`, `3110`, `/hooks/github` | Where the relay listens. |

**The GitHub webhook:**

- **Payload URL:** your public URL plus `RELAY_PATH`.
- **Content type:** `application/json`.
- **Secret:** `GITHUB_WEBHOOK_SECRET`.
- **Events:** **Pull requests**, **Pull request reviews** and **Issue comments**. "Pull requests" already includes opened, reopened and ready-for-review.

The installer can create it with `gh`. If `gh` answers 404, run `gh auth refresh -h github.com -s admin:repo_hook`.

---

[← Back to the README](../README.md)
