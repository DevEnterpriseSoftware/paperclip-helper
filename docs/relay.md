# The relay: GitHub → your decisions in Paperclip

In Paperclip, the current participant of a review or approval stage records a decision by changing the issue's status **with a comment in the same request**. `done` approves. Any other status, typically `in_progress`, requests changes and returns the issue to the engineer. The issue page has no button for that, and Paperclip's own Approve button appears only on stalled reviews. The relay receives signed GitHub webhooks and records that decision for you:

| On GitHub | In Paperclip |
|---|---|
| **You merge** the PR | The issue is **approved**: `done`, with a comment naming the PR and merge commit. |
| **You merge** a PR that is only one step of its issue (its hand-off or description carries the marker, or, optionally, it has open child issues) | **Changes requested** instead: back to its implementer for the rest of the work, with a comment that the PR merged ([below](#keeping-an-issue-open-after-a-merge)). |
| **You merge** the PR of an issue whose review stages an agent's update wiped | Closed as `done` with the merge comment, as the approval would have (`RELAY_DONE_WITHOUT_STAGES`, [below](#merging-an-issue-whose-review-stages-were-wiped)). |
| **You "Request changes"** in a review | **Changes requested**: `in_progress` and back to the engineer, with your review text as the brief. |
| **You comment `/changes …`** on the PR, or start a review with it | Same as Request changes. |
| Your `/changes`, `/approve` or Request changes **isn't recorded** (the issue isn't waiting on you, several are, or the PR names no issue) | Your text goes to the issue as a comment, as before, and the relay **replies on the PR** with where it went and why (`RELAY_PR_NOTES`, [below](#when-a-decision-isnt-recorded)). |
| **You comment `/approve …`** on the PR, or start a review with it | Approved without merging. |
| **You approve** the PR in a GitHub review | Nothing. Merging is the approval. |
| **You comment** or review anything else | Your text is copied to the issue as a comment, which wakes the assignee. |
| **Someone else merges**, or the PR is **closed** without merging | A note on the issue only ([quiet](#quiet-notes)). |
| **The PR is opened, reopened or marked ready for review** | Its URL is noted on the PR's own issue (the first one its title, branch or body names, or that issue's subtask waiting on you), so Paperclip links the PR (`RELAY_LINK_PRS`). Never on a blocker or another issue it mentions: a link there would show the PR as that issue's. |
| **A merge leaves another open PR with conflicts** (only with `RELAY_FIX_CONFLICTS`) | That PR's issue goes back to its agent to resolve them, and the PR gets a comment saying so ([below](#prs-with-merge-conflicts)). |
| **The merge queue drops a PR** without a conflict | A failed check: back to its agent with the failure. A cancelled run or the queue's timeout: the board is told (`RELAY_MERGE_QUEUE`, [below](#prs-the-merge-queue-drops-without-a-conflict)). |

<a id="quiet-notes"></a>**Quiet notes.** A comment from a board user wakes the issue's assigned agent, and Paperclip has no way to comment without waking anyone. The notes above need nothing from the agent, so with `RELAY_QUIET_NOTES` on (the default) they go in the issue's **Pull requests** document (key `pull-requests`) instead, one dated line each: *"2026-10-23 08:12 UTC: PR #12 opened by @carla: https://github.com/…"*. Updating a document wakes nobody, and Paperclip still links the PRs it names. Anything you add to the document is kept. If Paperclip won't take the document (it is locked, say), or an issue already has a `pull-requests` document the relay didn't start, the note is a comment, as before. Your own comments and decisions are still comments: those are meant to wake the agent.

Every delivery's response body says what the relay did, for example `{"identifier":"ACM-2","action":"approve","status":"done"}`. `status` is read back from Paperclip after the decision, and a `warning` says when the issue didn't land where it was sent. You can see it in GitHub's webhook **Recent Deliveries**, and **Redeliver** retries a delivery that failed. A delivery fails (502) whenever Paperclip couldn't be read or written, including while looking for the PR's issues, so a decision is never lost as "no issue found" while Paperclip is down; only an issue Paperclip says doesn't exist counts as not found.

GitHub waits 10 seconds for an answer. A delivery that takes longer (a PR naming several issues with subtasks and blockers, a slow Paperclip, a merge-queue drop's GitHub reads) is answered after 8 seconds with `202` and `{"accepted": "<delivery id>", …}`, and the relay carries on; what it did then goes to the log (`relay: handled`, or `relay: failed`). A delivery is remembered only once it has succeeded, so one that fails after that answer, or that a restart cut short, can be redelivered; a **Redeliver** while the first is still going is answered `409` (`inProgress`) and changes nothing.

**Several stages of yours.** Approving a stage that isn't the last one moves the issue to the next stage. That happens when a review reaches its round cap and Paperclip hands it to you, and the approval stage after it is yours too. A merge approves each consecutive stage that is waiting on you, up to three, with a short comment on each (the response lists them as `stages`), and stops at the first stage that is someone else's.

<a id="finding-the-issue"></a>**Finding the issue.** The relay collects every issue identifier (`ACM-12`) in the PR's title, branch name and body, and adds each issue's subtasks. It then acts on the one whose approval is waiting on you. A PR often names the *parent* issue, because its branch comes from the parent's workspace, while the review stages sit on a *subtask*. If none of those is waiting on you, it looks further: at the issues blocking them, and at subtasks of subtasks. That covers a PR that names a blocked issue while the work in review is the issue blocking it. The log line then says how it got there (`"via":"blocks ACM-12"`). If several are waiting, it prefers the one that lists this PR as a work product; if none does, it comments instead of guessing. If none is waiting on you, it only comments on the first issue named, and the comment ends "_Not recorded as a decision: …_" with why, so a merge note doesn't read as an approval.

**Safety:**

- Only events signed with your webhook secret (HMAC-SHA256, compared in constant time) are accepted.
- Only repositories in `GITHUB_REPOS` are accepted.
- Only `GITHUB_OWNER_LOGIN` can approve or request changes. Anyone else's reviews and comments are ignored, and their merges only produce a comment.
- A decision is recorded only when Paperclip says it's waiting on *you*; otherwise the relay comments.
- The relay never merges, pushes, closes or deletes anything on GitHub. Without a GitHub token it never calls GitHub at all. With one, it comments on PRs to say a decision wasn't recorded; with `RELAY_FIX_CONFLICTS` or `RELAY_MERGE_QUEUE` it also reads pull requests (and the merge queue's runs) and comments on the ones it sends back. Only with `RELAY_REQUEUE_ON_INFRA_DROP` (off by default) does it put a PR a person queued back in the merge queue.

<a id="when-a-decision-isnt-recorded"></a>**When a decision isn't recorded.** A `/changes` on a PR whose issue isn't waiting on you can't be a decision, so the relay copies your text to the first issue the PR names instead. That issue may not be the one you were looking at: a PR opened from a parent's workspace names the parent. With a GitHub token (`GITHUB_TOKEN` or `GITHUB_TOKEN_FILE`, "Pull requests: Read and write"), the relay replies on the PR:

> **Your `/changes` was not recorded as a decision.**
>
> This PR names DIR-251, DIR-419. None of those issues, their subtasks or their blockers has a decision waiting on you, so the relay used the first one, DIR-251 (blocked, review stage).
>
> Your text was added to DIR-251 as a comment. Nothing else changed.
>
> To decide on the issue you meant, run `pch changes <issue> "…"` (`pch check <issue>` shows who its decision is waiting on).

A decision that is recorded gets no reply. For comments, GitHub doesn't send the PR's branch, so only its title and body are searched for issue identifiers; the reply says so when it finds none. `RELAY_PR_NOTES=false` turns the replies off.

**GitHub won't let you "Request changes" on your own PR.** If your agents open PRs with your own token, comment `/changes …` instead.

**Where to see what's waiting on you.** The Dashboard's "Pending Approvals" and the Approvals page list *formal* approval requests, such as agent hires and budget overrides, not review stages. To see reviews waiting on you, turn on **Instance settings → Experimental → Decisions**.

## Merging an issue whose review stages were wiped

When an agent's update wipes an issue's review stages (a Paperclip bug: [watchdog 17](watchdog.md#17-issues-whose-review-stages-were-wiped)), your merge has no approval stage to record, so the issue stayed open and its dependants couldn't start. With `RELAY_DONE_WITHOUT_STAGES` on (the default), when you merge a PR and its own issue (the first one it names) is in todo, in progress or in review, has no stage pending, and Paperclip's activity log shows an agent's update removed its stages, the relay closes it as done with the merge comment, as the approval would have. An issue that never had stages, a blocked issue (it waits on a blocker or a recovery decision the merge doesn't settle), a PR that only mentions the issue, a merge by someone else and a `/approve` on a PR not yet merged are handled as before.

## Keeping an issue open after a merge

Approving an issue's last stage closes it as `done`, and Paperclip starts its dependants. Paperclip has no way to approve a stage and hand the work back to its implementer ([paperclipai/paperclip#10360](https://github.com/paperclipai/paperclip/issues/10360)), so a PR that is only one step of an issue (a fix found halfway through a verification, one slice of several) would close the issue with the rest of its work never done, and wake nobody.

So before approve-on-merge, the relay asks whether the merge finishes the issue:

- **The marker.** The issue's description, its review request, or the hand-off that sent it to review contains `RELAY_MERGE_KEEP_OPEN_MARKER` (default `Merge does not complete this issue`, matched in any case). The hand-off is the implementer's comments since the implementer last moved the issue to `in_review`, as Paperclip's activity log shows it (a board move back to review isn't a hand-off; without the log, the implementer's latest comment). A marker in an earlier round's hand-off doesn't count.
- **Open child issues,** with `RELAY_MERGE_KEEP_OPEN_CHILDREN=true` (off by default): any child issue that isn't `done` or `cancelled`.

Either way, the merge is still relayed, but as your **changes requested** (`in_progress` with a comment, in one request): Paperclip returns the issue to its implementer and wakes them. The comment: *"PR #12 merged (`abcdef123456`). This issue says the merge doesn't complete it, so it's back with you for the rest of the work."* (or names the open child issues). When they hand it back, it comes to the same stage. Without the marker or open children, nothing changes: approved and closed. An issue already `done` or `cancelled`, and a merge by someone else, are handled as before. The same check applies when the relay would close an issue whose stages were wiped ([above](#merging-an-issue-whose-review-stages-were-wiped)). If Paperclip refuses to hand the issue back (its stage has no implementer recorded, say), the relay comments instead and leaves the issue as it was: it never closes it.

**A close that may be early.** When the merge does close the issue, with no marker, but the issue's description still lists work to do (open checklist items, `- [ ]`, or a section whose heading says it is still to do: To do, Remaining, Outstanding, Next steps, Follow-ups, Pending; or a proofs or verification section whose text says something is pending, to do or not yet done), the merge comment ends with one line: *"Closed on merge, though the description still lists 2 open checklist items. If this PR was only a step, reopen the issue and add the marker ("Merge does not complete this issue")."* The close itself doesn't change. Checklists inside code blocks don't count, and an approval that only moves the issue to a later stage adds nothing.

**Hand-off or description.** The hand-off is the place for the marker: it is read afresh each round, so the final PR's hand-off, without it, closes the issue as usual. A marker in the **description** stays there, so every merge hands the issue back, the last one too. To finish such an issue, approve it yourself: comment `/approve` on the final PR before you merge it (the merge then finds the issue done), or approve it in Paperclip, or run `pch approve ISSUE`.

**Tell your agents.** It only works if the agents write the marker. Add a line like this to your team's agent template or agent instructions:

> When your pull request merges, the Paperclip Helper records the board's approval and Paperclip closes the issue. If the pull request is only one step of the issue's work (a fix along the way, one slice of several), write `Merge does not complete this issue` in the hand-off comment that sends the issue to review. The Helper then reports the merge and hands the issue back to you.

The line must quote the same phrase as `RELAY_MERGE_KEEP_OPEN_MARKER`: if you change the setting, change the line to match. Setting it to an empty value (`RELAY_MERGE_KEEP_OPEN_MARKER=`) turns the check off.

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

## PRs the merge queue drops without a conflict

GitHub's merge queue tests each queued PR combined with the base branch and the PRs ahead of it, on a temporary branch (`gh-readonly-queue/<base>/pr-<n>-…`, workflow runs with event `merge_group`), and removes it when that goes wrong (`pull_request.dequeued`, from `github-merge-queue[bot]`, with a `reason`). A drop for a conflict was always sent back; anything else left the PR sitting unmerged until someone noticed.

With `RELAY_MERGE_QUEUE` on (the default) and a GitHub token with **Actions: Read** (without a token it stays off, and the log says so once at start), the relay goes by GitHub's reason and the runs of the PR's latest merge group:

| Reason | What it finds | What it does |
|---|---|---|
| `CI_FAILURE` | A job failed (a test, a check that only fails on the combined change), or timed out. | Sends the PR back [like a conflict](#prs-with-merge-conflicts), with the run, the failed jobs and the first failure annotation (that needs **Checks: Read**; without it the brief has none), and a note on the PR (`RELAY_CONFLICT_PR_COMMENT`). |
| `CI_FAILURE` | Every failed job failed setting up its runner, before checkout (GitHub's "Set up runner" or "Set up job" step: a self-hosted runner's job-started hook, say). None of the PR's code ran. | Tells the board the runner is at fault: fix it, then queue the PR again. Never sent back, and never queued again by the relay: it would fail the same way. |
| `CI_FAILURE` | Only a cancelled job (a runner restarted mid-run). | Tells the board the PR isn't at fault: queue it again. |
| `CI_FAILURE` | No failed or cancelled job to show. | Tells the board it couldn't tell why, rather than guess. |
| `CI_TIMEOUT` | (not looked at) | The queue's status-check timeout ran out while the checks waited for a runner. Tells the board to queue it again; never sent back. |
| `MERGE_CONFLICT` | The PR conflicts with its base. | The [conflict sweep](#prs-with-merge-conflicts) sends it back, as before (with `RELAY_FIX_CONFLICTS`). |
| `MERGE_CONFLICT` | It conflicts only with a PR ahead of it. | Tells the board to queue it again once that PR has merged. |
| anything else | | Nothing: removed by hand, branch protections, the queue cleared. |

A job that **timed out** counts as the PR's: it ran past its own `timeout-minutes`, which is usually the change (a slow or hanging test). On a single self-hosted runner a timeout can also be the runner; the agent's brief names the job, so it can say so. A job **cancelled** by a runner restart isn't the PR's.

Without a reason (an older GitHub Enterprise Server), the runs decide the same way; with no merge-group run found, nothing is done.

**Telling the board without waking the implementer:** a board comment wakes the issue's assigned agent. So the note goes on the issue only while no agent is assigned (the issue waits on a person, as it does while its PR is in the queue for your approval); otherwise it goes on the PR and in the [board notes](watchdog.md#notes-for-the-board) (`WATCHDOG_NOTIFY_ISSUE`, and the log).

**Queue it again yourself:** with `RELAY_REQUEUE_ON_INFRA_DROP=true` (off by default), the relay re-queues a PR dropped by a cancelled run or the timeout with GitHub's `enqueuePullRequest`, once per head commit, and only if a person queued it (the relay remembers who did, from `pull_request.enqueued`, in its state file). Never after a failed check. The token must be allowed to merge into the base branch; if it isn't, the board note still goes out and the log says why.

Once per merge group. Merged PRs, PRs that name no issue, and issues that are done or cancelled are left alone. If the work fails part-way (GitHub didn't answer), the delivery fails naming the PR, and GitHub's **Redeliver** tries again. The webhook's **Pull requests** events already include `enqueued` and `dequeued`.

### The GitHub token

The relay needs a token to read pull requests and comment on them. A **fine-grained personal access token** limited to your repositories is the safest:

1. Open **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → [Generate new token](https://github.com/settings/personal-access-tokens/new)**.
2. **Token name:** `paperclip-helper`. **Expiration:** your choice; when it expires the log says `GitHub rejected GITHUB_TOKEN`, and you create a new one.
3. **Resource owner:** the account or organization that owns the repositories. An organization may have to approve the token first.
4. **Repository access:** **Only select repositories**, and pick the ones in `GITHUB_REPOS`.
5. **Permissions → Repository permissions → Pull requests: Read and write.** GitHub adds **Metadata: Read-only** by itself. With `RELAY_CONFLICT_PR_COMMENT=false`, **Read-only** is enough. The watchdog uses the same token to read the CI runs agents wait on ([`WATCHDOG_CI_RUNS`](watchdog.md#11-ci-runs-an-agent-waits-on)): add **Actions: Read-only** for that, or **Read and write** if you set `WATCHDOG_CI_RERUN_JOBS` to re-run flaky jobs. [Merge-queue drops](#prs-the-merge-queue-drops-without-a-conflict) need **Actions: Read-only** too, and **Checks: Read-only** to quote the failure annotation.
6. **Generate token**, and copy it (`github_pat_…`). GitHub shows it once.
7. Re-run the installer and answer yes to "Send PRs with merge conflicts back to their agents automatically?", or put it in `.env` yourself and run `docker compose up -d`:

   ```
   RELAY_FIX_CONFLICTS=true
   GITHUB_TOKEN=github_pat_…
   ```

8. Run `pch check`. It prints `GitHub: GITHUB_TOKEN reads owner/repo (3 open PRs; PR #12 read on its own too)` for each repository, or what GitHub refused. It lists the open PRs and reads the oldest on its own, the two calls the conflict sweep makes.

A **classic** token works too: [generate one](https://github.com/settings/tokens/new) with the `repo` scope (`public_repo` for public repositories only). It reaches every repository you can, so prefer the fine-grained one.

### A token file (GitHub App)

If your agents reach GitHub through a **GitHub App** rather than a person's or machine account's token, there is no long-lived token to paste: an App's installation token lasts an hour, and some program on the host mints a new one before it runs out and writes it to a file. Give the relay that file instead of `GITHUB_TOKEN`:

- **`GITHUB_TOKEN_FILE`**: the file's path *inside the container*. The relay reads it again for every GitHub request, so a renewed token is used at once, without a restart.
- **Mount its folder, read-only, not the file.** Programs that renew a file usually write a new one and rename it over the old one, and a mount of a single file keeps showing the old one.
- **The helper's user (`PCH_UID`) must be able to read it.** That is normally the user who installed the helper, which is also the one whose program writes the file.

The installer does all of it: answer **2** at "Token source" and give the file's path on the host. It writes `GITHUB_TOKEN_FILE=/run/github-token/<name>`, keeps the host path in `GITHUB_TOKEN_HOST_FILE` for the next run, and adds the mount to `compose.yml`:

```yaml
    volumes:
      - ./data:/data
      - "/home/you/.cache/paperclip-github-app:/run/github-token:ro"
```

A token file at `~/.cache/paperclip-github-app/token`, where the `paperclip-github-app` timer keeps one, is found and offered by itself. Any other program works as well, as long as it writes a file holding only the token.

- **The App needs Pull requests: Read and write** on the repositories in `GITHUB_REPOS` (Read-only with `RELAY_CONFLICT_PR_COMMENT=false`), and the token mustn't be limited to fewer of them. For the watchdog's CI-run check it also needs **Actions: Read** (Read and write to re-run flaky jobs).
- **The PR comments are written by the App** (`your-app[bot]`), so they stand apart from yours.
- **`pch check`** prints `GitHub: the token in GITHUB_TOKEN_FILE (/run/github-token/token) reads owner/repo (3 open PRs; PR #12 read on its own too)`. It runs in the helper's container, so the path is the one inside it; on the host the file is wherever `GITHUB_TOKEN_HOST_FILE` says. If the program that renews the file stops, the log says how many minutes ago the file was written.
- **A 404 isn't always a permission.** GitHub answers 404 both for what isn't there and for what the token can't see, so the message says both and, with a token file, how long ago it was written. A 403 names the permission. When the conflict sweep has just listed a PR with the same token, a 404 on reading it on its own can't be a permission: the sweep asks again a few times, and if it still fails it says so and checks the PR on the next sweep.
- Set one of `GITHUB_TOKEN` and `GITHUB_TOKEN_FILE`, not both: the helper refuses to start with both.

The PR comments are written by the token's account. With your own token they appear under your name; a token from a separate bot account that can read the repositories makes them stand out.

## Why an issue can show the wrong PRs

Paperclip builds an issue's "GitHub Pull Request" rows from full `github.com/<owner>/<repo>/pull/<n>` URLs anywhere in the issue's text. Agents usually write "PR #16", which links nothing, and a PR URL quoted from another issue shows up as if it belonged to this one. The relay notes the real PR's URL when the PR opens, so **the latest "PR #N opened" line in the issue's Pull requests document** (a comment, with `RELAY_QUIET_NOTES=false`) **is the one to trust.** The rows only appear with **Instance settings → Experimental → External Objects** turned on.

## Relay settings

| Setting | Default | Meaning |
|---|---|---|
| `RELAY` | unset | Unset: on when any of the three GitHub settings is set, and then all three are needed. `true`: required. `false`: off. |
| `GITHUB_WEBHOOK_SECRET` | none | The secret the GitHub webhook signs with. **Required.** |
| `GITHUB_OWNER_LOGIN` | none | Your GitHub login. **Required.** |
| `GITHUB_REPOS` | none | Comma-separated `owner/repo` list. **Required.** |
| `ISSUE_PREFIXES` | every company's own | Prefixes to look for, such as `ACM,OPS`. |
| `RELAY_LINK_PRS` | `true` | Note a newly opened PR's URL on its issue. |
| `RELAY_QUIET_NOTES` | `true` | Put the notes that need nothing from the agent (PR opened, closed, merged by someone else) in the issue's `pull-requests` document, which wakes nobody. `false`: comments, which wake the assignee. |
| `RELAY_PR_NOTES` | `true` | Reply on the PR when a `/changes`, `/approve` or Request changes isn't recorded as a decision. Needs `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE`. |
| `RELAY_FIX_CONFLICTS` | `false` | Send PRs with merge conflicts back to their agents. Needs `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE`. |
| `GITHUB_TOKEN` | none | The [token](#the-github-token) the relay reads pull requests and comments with (conflict send-backs, merge-queue drops and `RELAY_PR_NOTES`); the watchdog uses it too (CI runs, wiped stages). |
| `GITHUB_TOKEN_FILE` | none | Instead of `GITHUB_TOKEN`: [a file](#a-token-file-github-app) holding the token, read for every request (a GitHub App's hourly token). |
| `GITHUB_TOKEN_HOST_FILE` | none | That file's path on the host. Only the installer reads it, to write the mount. |
| `RELAY_CONFLICT_MAX_ATTEMPTS` | `2` | Send-backs per PR while it keeps conflicting, one per push, before it is left to you. |
| `RELAY_CONFLICT_PR_COMMENT` | `true` | Say on the PR that it was sent back. |
| `RELAY_DONE_WITHOUT_STAGES` | `true` | When you merge an issue's own PR and its review stages were wiped, close it as done. |
| `RELAY_MERGE_KEEP_OPEN_MARKER` | `Merge does not complete this issue` | A merge doesn't finish an issue whose hand-off or description contains this phrase (any case): [changes requested](#keeping-an-issue-open-after-a-merge) instead of approve. Empty: the check is off. Your agents' instructions must quote the same phrase. |
| `RELAY_MERGE_KEEP_OPEN_CHILDREN` | `false` | Nor does it finish an issue with open child issues. |
| `RELAY_MERGE_QUEUE` | `true` | When the merge queue drops a PR without a conflict: send it back if a check failed, or tell the board if a run was cancelled or the queue timed out. Needs a GitHub token with **Actions: Read** (and **Checks: Read** for the failure annotation); without one it is off, and the log says so once. |
| `RELAY_REQUEUE_ON_INFRA_DROP` | `false` | Also queue such a PR again (not after a failed check), once per head commit, if a person queued it. Needs a token allowed to merge. |
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
