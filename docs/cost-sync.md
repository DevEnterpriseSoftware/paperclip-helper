# Cost sync: what your subscription runs would have cost

Paperclip deliberately records **$0** for runs billed to a subscription (`billingType: subscription_included`). If your agents use a Claude or ChatGPT plan, the Costs page stays empty.

For each finished subscription run, cost sync posts one extra cost event with the run's API-equivalent cost:

- **Claude Code** (`claude_local`) reports that figure itself, and Paperclip keeps it on the run. Cost sync also prices the run's tokens at Anthropic's list price, and doesn't post much less than that:
  - A reported cost more than 10% below the token price is raised to it. With the ACP engine (Paperclip's default for Claude), a run's cost is the growth of its session's running cost; when the agent process restarted, its running cost restarted too, and the growth understates the run.
  - A run that stopped before Claude reported a cost (killed, timed out) is priced from its tokens, at its model's price.
  - A run Paperclip split by model (`usageByModel`) is priced model by model. A run that used several models without the split (`mixed`) keeps its reported cost, and isn't priced if it reported none: pricing a cheaper subagent model's tokens at the main model's price would overstate it.
  - Raised and token-priced events are posted as `estimated`. A Paperclip that has no such status (it came with Paperclip's durable accounting; 2026.1012.0 and the stable releases before it take only `reported` and `unpriced`) refuses that with a `400`; cost sync then posts the event again as `reported`, and keeps doing so until it restarts. `unpriced` would say no cost is known.
- **Codex** (`codex_local`) reports only tokens. The cost is estimated from the run's model and OpenAI's list prices: fresh input, cache reads at the cached rate, cache writes (when the ACP engine reports them) at the write rate, output, and fast mode doubled.
  - Paperclip 2026.10 and later store Codex's input net of cache reads and mark such runs (`rawInputIncludesCached: false`); older runs, without the mark, included them. Both are handled.
- The price table ([`src/prices.mjs`](../src/prices.mjs)) was checked on 2026-10-24 against [OpenAI's](https://developers.openai.com/api/docs/pricing) and [Anthropic's](https://platform.claude.com/docs/en/about-claude/pricing) published prices.
  - Add or override models with a `prices.json` in the data directory.
  - A run with no recorded model (or Claude's `mixed`) is priced with the agent's configured model. Codex runs on the default model with no model configured either: set `CODEX_DEFAULT_MODEL` to price them; otherwise they're skipped.

**What it never touches:** runs billed to an API key (`metered_api`), which already carry their real cost, and adapters not listed in `COST_SYNC_ADAPTERS`.

Each event has zero tokens (the run's own event counted them), the run's id, provider, biller and model, the run's finish time, and the idempotency key `pch-cost-sync:<run id>`. Token totals, run counts, project attribution and monthly totals therefore stay right.

## Before you turn it on

- **The amounts count toward budgets.** A company or agent budget with a hard stop pauses work once the synced amounts reach it. `pch costs` shows each budget before and after.
- **Cost events can't be deleted** through Paperclip's API. The helper records every run it posts in `data/cost-synced.json`, and never posts a run twice, even across crashes.
  - Paperclip 2026.10 and later also record each idempotency key once. While the latest post shows that, a post whose answer was lost is posted again with the same key on the next pass (up to 5 times) rather than given up, and a lost state file can't cause double posts; on an older Paperclip such a run is never posted again.
  - If `data/` is lost (or its state file is unreadable), it reads your earlier cost posts from Paperclip's activity log and counts the runs they name as synced. The log shows the latest 500 posts, so when it is full, runs that finished before its oldest entry are left alone; when the posts don't name their runs, or the log can't be read, only runs that finish from then on are synced. This holds whatever `COST_SYNC_SINCE` says.
- **It posts whole cents,** which every Paperclip version stores (2026.10 and later take fractions too), and a run on a cheap model can cost a fraction of one. Fractions are carried per agent and model until they add up to a cent, so totals stay within a cent of the exact sum.
- Only the most recent 1,000 runs per company are visible to it. Runs that were stopped before recording any usage can't be synced.
- The figures are estimates of API list price, not what you pay.

Preview it any time. It changes nothing:

```text
$ pch costs
Acme: not yet synced (412 runs already synced)
  Reviewer                38 runs   $    61.20
  Engineer                22 runs   $    54.87   (22 estimated from tokens)
  Total                   60 runs   $   116.07
  not synced: 3 runs, model unknown (set CODEX_DEFAULT_MODEL to price it)
  budget "Engineer" (agent, calendar_month_utc): $0.00 → $54.87 of $50.00. WARNING: this reaches the hard stop, so Paperclip would pause the agent.
```

## Checking the figures

`pch costs --audit [--days N]` goes through every subscription run of the last N days (default 7). It changes nothing.

```text
$ pch costs --audit
Acme: subscription runs that finished in the last 7 days (412 runs)
  Agent                   runs    input   c.read  c.write   output   reported     tokens        now
  Architect                 61     3.1M   410.2M     9.8M     2.0M    $187.40    $171.02    $196.80   4 no cost reported, 6 raised
  Engineer                 120     5.0M   300.1M     0.0M     4.4M      $0.00     $91.10     $91.10
  anthropic: 230 runs; reported $412.80; their tokens at list price $371.15; cost sync would post $431.60 for them now.
    9 runs reported no cost (stopped before Claude reported one); priced from their tokens.
    7 runs reported more than 10% less than their tokens cost at list price; raised to the token price.
  openai: 182 runs; reported $0.00; their tokens at list price $96.40; cost sync would post $96.40 for them now.
  Sync state: 405 synced, 7 not yet.
  Idempotency keys: honoured by this Paperclip.
  Duplicates: no run listed twice; 500 recent cost posts by you cover 500 runs; none twice (Paperclip's activity log shows the latest 500 cost events, so this covers only recent posts).
```

- **tokens** is the runs' tokens at list price. With the ACP engine, Paperclip records the main loop's tokens only, so a reported cost above it is normal (subagents, compaction).
- **now** is what cost sync would post for those runs with today's logic and prices. Runs synced earlier keep what was posted for them, so this isn't what's on the Costs page.
- Paperclip lists only the latest 1,000 runs per company; the audit says when that cuts the period short.
- Already-synced runs keep what was posted for them; the audit shows what they would get now.

## Comparing two periods

1.12 changed how runs are costed (Claude runs priced from their tokens when they report no cost or clearly less; Codex runs Paperclip stores net of cache reads priced in full), so a week-on-week change on the Costs page mixes that change with real usage. `pch costs --compare-days N` costs the last N days and the N days before them twice each, as cost sync posts them now and as it did before 1.12, and splits the change. It changes nothing.

```text
$ pch costs --compare-days 7
Acme: subscription runs, 2026-10-10 to 2026-10-17 against 2026-10-17 to 2026-10-24 (7 days each)
  anthropic:
    earlier: 212 runs, 4.2M input, 610.0M cache reads, 3.9M output; costed as before 1.12 $380.10, as now $401.75
    later:   230 runs, 4.6M input, 660.4M cache reads, 4.1M output; costed as before 1.12 $412.80, as now $431.60
  openai:
    earlier: 170 runs, 18.0M input, 140.2M cache reads, 2.1M output; costed as before 1.12 $51.20, as now $87.30
    later:   182 runs, 19.9M input, 151.0M cache reads, 2.3M output; costed as before 1.12 $56.40, as now $96.40
  If the earlier period was posted before 1.12 and the later one with it, the Costs page moves +$96.70 ($431.30 → $528.00):
    usage:   +$38.95   (the change at today's costing, $489.05 → $528.00)
    costing: +$57.75   (what today's costing adds to the earlier period's runs)
  If both periods were posted with 1.12, the whole change is usage: +$38.95.
```

- **usage** is the change with both periods costed the same way, today's: the part a different costing can't explain.
- **costing** is what today's costing adds to the earlier period's runs. It is part of the change on the Costs page only for the runs that were posted before you upgraded: if 1.12 came in mid-period, the true split lies between the two lines.
- "As before 1.12" is a reconstruction: Claude runs at their reported cost (nothing for one that reported none), Codex runs with the cache reads subtracted from their input a second time and cache writes as input, at today's prices.
- Paperclip lists only the latest 1,000 runs per company; when that cuts the earlier period short, it says so, and fewer days help. `--audit --compare-days N` prints the audit, then the comparison.

## When Paperclip rejects a cost event

A post Paperclip refuses because of the event itself (`400`, `404`, `422`) wasn't recorded, and posting the same event again won't help, so cost sync skips that run rather than retrying it every pass. The log says what was wrong, once per run:

```text
{"level":"warn","msg":"cost sync: Paperclip's answer to a rejected cost event","run":"60e17fd8-…","status":400,
 "response":{"error":"Validation error","details":[{"code":"invalid_value","values":["reported","unpriced"],"path":["costStatus"],"message":"Invalid option: expected one of \"reported\"|\"unpriced\""}]},
 "fields":["idempotencyKey","agentId","heartbeatRunId","issueId","provider","biller","billingType","costStatus","model","inputTokens","cachedInputTokens","outputTokens","costCents","occurredAt"]}
{"level":"error","msg":"cost sync: Paperclip rejected a cost event; skipping that run (`pch costs --retry-skipped` posts it again)","run":"60e17fd8-…",
 "error":"POST /api/companies/…/cost-events → 400: Validation error (costStatus: Invalid option: expected one of \"reported\"|\"unpriced\")"}
```

`response` is Paperclip's answer as it came: for a `400`, Zod's issues, each with the path of the field it refused. `fields` names what the post carried, without the values. `pch status` lists the error among the latest problems.

Once the cause is fixed (a Helper update, a price, Paperclip itself), post those runs again:

```text
$ pch costs --retry-skipped
8 skipped runs are queued to be posted again:
  60e17fd8-bbeb-4f13-9a6d-e5107c3436de   rejected: POST /api/companies/…/cost-events → 400: Validation error
  …
The service posts them on its next cost-sync pass (every 15 min); `pch status` shows the posts, and the log any rejection again.
```

- The command only leaves the list in `data/cost-retry.json`; the service, which keeps `data/cost-synced.json`, takes it at the start of its next pass and posts the runs as usual, with today's prices and the carried fractions. Nothing is posted by the command itself, so it can't race the service into posting a run twice.
- A run Paperclip's run list no longer shows (it lists the latest 1,000) is read by its id, and `COST_SYNC_SINCE` doesn't hold back a run that was already looked at once.
- A run skipped because its post's outcome was unknown (a timeout, a dropped connection) may have been recorded. It stays skipped unless Paperclip has shown it keeps idempotency keys, which make a second post of it harmless.
- A run rejected again is skipped again, and the log says why.

## Cost sync settings

| Setting | Default | Meaning |
|---|---|---|
| `COST_SYNC` | `true` | `false` turns it off. The installer asks after showing `pch costs`. The manual install's `.env.example` ships it as `false`, so you preview first. |
| `COST_SYNC_INTERVAL_SEC` | `900` | How often it posts (at least 60). |
| `COST_SYNC_SINCE` | none | Only runs that finished after this ISO 8601 time. |
| `COST_SYNC_ADAPTERS` | `claude_local,codex_local` | Agent adapters whose subscription runs are synced. |
| `CODEX_DEFAULT_MODEL` | none | The model to price Codex runs with when none was recorded. |
| `COST_PRICES_FILE` | `/data/prices.json` | Your own prices; the format is in `src/prices.mjs`. |

---

[← Back to the README](../README.md)
