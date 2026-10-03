# Cost sync: what your subscription runs would have cost

Paperclip deliberately records **$0** for runs billed to a subscription (`billingType: subscription_included`). If your agents use a Claude or ChatGPT plan, the Costs page stays empty.

For each finished subscription run, cost sync posts one extra cost event with the run's API-equivalent cost:

- **Claude Code** (`claude_local`) reports that figure itself, and Paperclip keeps it on the run.
- **Codex** (`codex_local`) reports only tokens. The cost is estimated from the run's model and OpenAI's list prices, with cached input at the cached rate and fast mode doubled. The price table ([`src/prices.mjs`](../src/prices.mjs)) was checked on 2026-09-30.
  - Add or override models with a `prices.json` in the data directory.
  - Codex runs on the default model have no recorded model. Set `CODEX_DEFAULT_MODEL` to price them; otherwise they're skipped.

**What it never touches:** runs billed to an API key (`metered_api`), which already carry their real cost, and adapters not listed in `COST_SYNC_ADAPTERS`.

Each event has zero tokens (the run's own event counted them), the run's id, provider, biller and model, and the run's finish time. Token totals, run counts, project attribution and monthly totals therefore stay right.

## Before you turn it on

- **The amounts count toward budgets.** A company or agent budget with a hard stop pauses work once the synced amounts reach it. `pch costs` shows each budget before and after.
- **Cost events can't be deleted** through Paperclip's API. The helper records every run it posts in `data/cost-synced.json`, and never posts a run twice, even across crashes.
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
