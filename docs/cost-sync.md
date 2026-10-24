# Cost sync: what your subscription runs would have cost

Paperclip deliberately records **$0** for runs billed to a subscription (`billingType: subscription_included`). If your agents use a Claude or ChatGPT plan, the Costs page stays empty.

For each finished subscription run, cost sync posts one extra cost event with the run's API-equivalent cost:

- **Claude Code** (`claude_local`) reports that figure itself, and Paperclip keeps it on the run. Cost sync also prices the run's tokens at Anthropic's list price, and doesn't post much less than that:
  - A reported cost more than 10% below the token price is raised to it. With the ACP engine (Paperclip's default for Claude), a run's cost is the growth of its session's running cost; when the agent process restarted, its running cost restarted too, and the growth understates the run.
  - A run that stopped before Claude reported a cost (killed, timed out) is priced from its tokens, at its model's price.
  - A run Paperclip split by model (`usageByModel`) is priced model by model. A run that used several models without the split (`mixed`) keeps its reported cost, and isn't priced if it reported none: pricing a cheaper subagent model's tokens at the main model's price would overstate it.
  - Raised and token-priced events are posted as `estimated`.
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
  - If `data/` is lost, it checks Paperclip's activity log for earlier posts. If it finds any, it syncs only runs that finish from then on.
- **Paperclip stores whole cents,** and a run on a cheap model can cost a fraction of one. Fractions are carried per agent and model until they add up to a cent, so totals stay within a cent of the exact sum.
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
