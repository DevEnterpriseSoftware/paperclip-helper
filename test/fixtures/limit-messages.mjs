// Failure messages the usage-limit recognisers (src/limits.mjs) must tell apart,
// word for word from where they come from. A run's `error` is the adapter's own
// message, so these are what Paperclip stores.
//
// Codex: openai/codex at 970111f (2026-10-23), codex-rs/protocol/src/error.rs
// (UsageLimitReachedError's Display and the CodexErr messages) and its tests
// (error_tests.rs), and codex-rs/codex-api/src/sse/responses.rs for the API's own
// quota message. Codex writes the reset time with format_retry_timestamp: "3:45 PM"
// when it is today, else "Oct 13th, 2026 3:45 PM", in its machine's local time.
//
// Each entry: [name, message, expected], expected being
//   { kind: "limit", scope: "account" | "agent", reset: "today" | "dated" | null }
//   ("today": 3:45 PM on the day of the failure; "dated": the date Codex gave)
//   { kind: "transient" }
//   null (neither: left alone).

export const CODEX_MESSAGES = [
  // The ChatGPT plan's 5-hour and weekly limits: the wording is the same for both;
  // only the reset differs.
  ["Plus plan", "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.", { kind: "limit", scope: "account", reset: "today" }],
  ["Plus plan, no reset known", "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again later.", { kind: "limit", scope: "account", reset: null }],
  ["Team or Business plan", "You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 3:45 PM.", { kind: "limit", scope: "account", reset: "today" }],
  ["Free or Go plan", "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:45 PM.", { kind: "limit", scope: "account", reset: "today" }],
  ["Pro plan, weekly limit (another day)", "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 13th, 2026 3:45 PM.", { kind: "limit", scope: "account", reset: "dated" }],
  ["Enterprise, Edu or unknown plan", "You’ve hit your usage limit. Try again at 3:45 PM.", { kind: "limit", scope: "account", reset: "today" }],
  ["Enterprise, no reset known", "You’ve hit your usage limit. Try again later.", { kind: "limit", scope: "account", reset: null }],
  ["Promotion", "You’ve hit your usage limit. To continue using Codex, start a free trial of Plus today, or try again at 3:45 PM.", { kind: "limit", scope: "account", reset: "today" }],
  ["Straight apostrophe (a log that re-encoded it)", "You've hit your usage limit. Try again at 3:45 PM.", { kind: "limit", scope: "account", reset: "today" }],
  // One model's own limit: another model works, so only the agent that hit it waits.
  ["One model's limit", "You’ve hit your usage limit for codex_other. Switch to another model now, or try again at 3:45 PM.", { kind: "limit", scope: "agent", reset: "today" }],
  ["One model's limit, dotted name", "You’ve hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again later.", { kind: "limit", scope: "agent", reset: null }],
  // API key quota and billing (CodexErr::QuotaExceeded), and a workspace's credits or spend cap.
  ["API quota (Codex's message)", "Quota exceeded. Check your plan and billing details.", { kind: "limit", scope: "account", reset: null }],
  ["API quota (the API's own message)", "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.", { kind: "limit", scope: "account", reset: null }],
  ["API quota (error code in a raw response)", 'unexpected status 429 Too Many Requests: {"error":{"type":"insufficient_quota","code":"insufficient_quota"}}', { kind: "limit", scope: "account", reset: null }],
  ["Organisation spend limit (error code)", 'unexpected status 429: {"error":{"code":"organization_spend_limit_exceeded"}}', { kind: "limit", scope: "account", reset: null }],
  ["Workspace out of credits (owner)", "Your workspace is out of credits. Add credits to continue.", { kind: "limit", scope: "account", reset: null }],
  ["Workspace out of credits (member)", "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.", { kind: "limit", scope: "account", reset: null }],
  ["Workspace spend cap (owner)", "You hit your spend cap set in your workspace. Increase your spend cap to continue.", { kind: "limit", scope: "account", reset: null }],
  ["Workspace spend cap (member)", "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.", { kind: "limit", scope: "account", reset: null }],
  // Capacity: Paperclip's retries handle it (its CLI path files it as provider_quota).
  ["Model at capacity", "Selected model is at capacity. Please try a different model.", { kind: "transient" }],
  ["High demand", "We’re currently experiencing high demand, which may cause temporary errors.", { kind: "transient" }],
  // Neither: not a limit that resets.
  ["Plan without Codex", "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.", null],
  ["Rate limited after retries", "exceeded retry limit, last status: 429 Too Many Requests, request id: req_1", null],
  ["Plain exit", "Codex exited with code 1", null],
];

// Claude (as in test/watchdog-limits.test.mjs): Paperclip's claude-local adapter
// stores the CLI's message with error code claude_transient_upstream or provider_quota.
export const CLAUDE_MESSAGES = [
  ["Weekly limit", "Claude run failed: subtype=success: You've hit your org's monthly spend limit · ask your admin to raise it, or switch to extra usage · your weekly limit resets Oct 12, 4pm (Europe/London)", { kind: "limit", scope: "account" }],
  ["5-hour limit", "Claude AI usage limit reached|1760281200", { kind: "limit", scope: "account" }],
  ["Transient", "Claude exited with code 143", { kind: "transient" }],
];
