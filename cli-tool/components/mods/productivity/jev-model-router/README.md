# jev-model-router

Picks the model and the reasoning effort of each **subagent** with [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's System One decision model: unstructured state in, a typed choice with a probability distribution out, no free-form text.

> Version `0.5.0-hartmanfrost.1` is a fork of 0.4.2. See [What changed](#what-changed-from-042).

What it does, in one paragraph: when the Agent tool or a Workflow `agent()` starts a subagent, the router asks Jev how hard the task is, then names the subagent's model (`haiku`, `sonnet` or `opus`, nothing else) at `agent.spawn` and its effort (`low`, `medium`, `high` or `xhigh`, never `max`) at that agent's `turn.step`. The model the caller passed is overridden: callers pass `sonnet` as a default, and Jev decides. Your own typed prompts are **not** routed and **never leave the machine** unless you switch main-loop routing on.

## Backends

| Backend | Endpoint | Model | Confidence |
|---|---|---|---|
| `typesafe` | `POST api.typesafe.ai/v1/systemone` | `jev-latest` | reported per answer |
| `gateway` | `POST ai-gateway.vercel.sh/v4/ai/evaluation-model` | `typesafe-ai/jev` | derived from an optional distribution |

TypeSafe's own API wins when both keys are set: it is the only one that reports a calibrated confidence. Set `provider` to force one. Each backend keeps its own URL and model option, so an override written for one is never sent to the other. Base URLs must be `https` (plain `http` only for `localhost`/`127.x`/`[::1]`) and carry no credentials; anything else is ignored, with a visible warning, and the default host is used.

**No key means no call.** With `provider` left on `auto` and neither key set, nothing is sent anywhere: every subagent runs on the fallback model and effort, and you get one notice saying so. The engine's own `$.model.classify` (which burns tokens and reports no confidence) is used only if you explicitly choose `provider: "builtin"`.

## What it routes

| Switch | What it sets | Default |
|---|---|---|
| `routeSubagentModel` | the model of each subagent, at `agent.spawn` | **on** |
| `routeSubagentEffort` | the effort of each subagent, at its `turn.step` | **on** |
| `routeMainEffort` | the reasoning effort of the main conversation | **off** |
| `routeMainModel` | the model of the main conversation (invalidates the prompt cache) | **off** |

With both main-loop switches off, the `prompt.submit` hook returns immediately: **no Jev call, no classifier call, nothing hashed, no prompt of yours leaves the machine.**

### How a subagent gets its model and effort

1. `agent.spawn` fires. Forks, teammates and resumes are skipped with no call; a workflow agent with a withheld prompt gets the fallback, loudly (see [Limitations](#limitations)).
2. The router redacts and truncates the subagent's prompt, description and type (see [Privacy](#privacy)), and asks Jev. Two identical spawns in a session cost one call (a decision cache keyed by a hash of type, description and prompt).
3. The decision is measured against the **fallback** (`fallbackModel`/`fallbackEffort`, default `opus`/`medium`), the configured default. It applies in both directions: a task Jev reads as mechanical goes below the fallback, one it reads as hard goes above. The bars differ because the mistakes do:
   - spending **more** than the fallback needs `minUpgradeConfidence` (0.3);
   - spending **less** needs `minDowngradeConfidence` (0.6);
   - a backend that reports no confidence (the Gateway without a distribution, the built-in classifier) may only go **up**;
   - `risky` above 0.7 takes the deep tier and at least `high` effort, past both bars, never below the fallback.
   A decision that agrees with the fallback or misses its bar yields the fallback. The model is **always named explicitly** (`next({...e, model})`), whatever the caller passed and whatever the parent runs; the earlier "compare against `e.model ?? e.parentModel`" logic made "deep" look like no change when the parent was `opus[1m]` and the subagent actually ran on `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`.
4. `agent.spawn` hands back the new agent's `agentId`. The effort is filed under that id and, because the agent's own `turn.start` can be raised before the spawn returns, also under a hash of its prompt; whichever arrives first binds it. Every `turn.step` of that agent is then rewritten to the effort, and `turn.complete` drops the entry.

Observed by hand on Claude Code 2.1.305, headless (a one-off probe, not reproducible from this repo; `tests/hook.test.ts` covers the router's side of it against engine stand-ins, including the `turn.start`-before-spawn-returns ordering): a spawn hook's model rewrite wins even with `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` set; `turn.step` fires for Agent-tool subagents and Workflow agents with the same `agentId` that `agent.spawn` returned; the rewritten effort reaches the request (haiku, sonnet and opus all accepted `low` through `xhigh`). If a future build lets the session force the subagent model over a hook, the router notices that the spawn came back on a different tier and tells you once.

## Failure is loud

When Jev cannot decide, the subagent is **not** left to whatever the caller passed. It runs on `fallbackModel`/`fallbackEffort`, both applied explicitly, and you are told:

| Kind | Cause |
|---|---|
| `timeout` | no answer within `timeoutMs` |
| `auth` | 401/403: the key was rejected |
| `rate-limit` / `server` / `http` | 429 / 5xx / other non-2xx |
| `malformed` | a 200 whose body could not be read, or had an out-of-range probability |
| `network` | the request threw |
| `circuit-open` | calls paused after 3 failures in a row (30 s; 5 min after a 401/403) so a dead backend costs the timeout three times, not on every spawn |
| `no-key` | no key for the chosen provider |
| `config` | invalid options, including invalid `redactPatterns` |
| `override` | the session forced a different tier than the router chose |

Each kind is shown with a **toast** (interactive sessions) **and a transcript line**, the first time, and again at the 5th, 25th, 100th... occurrence with the running count; `no-key`, `config` and `override` are shown once. A status row (`jev · fallback ×N (kind)`) keeps the count on screen. In `claude -p` there is no toast or status row; the transcript line goes to `ui_log` and the debug log (`~/.claude/debug/<session>.txt`). Failures are shown whatever `logDecisions` says; the key is never in any of these lines, and error text is scrubbed before it is logged.

A request that outlives `timeoutMs` is **not cancelled**: the engine's `$.http.fetch` takes no abort signal, so the response is simply dropped. The circuit breaker is what limits the cost of a slow backend.

## What it asks

One request, three questions evaluated in parallel:

- `tier`: a `choice` between three descriptions of the *work* (mechanical and local / ordinary engineering / hard or high-stakes). The decision model never sees a model name.
- `effort`: a `score` on a four-level rubric (0..3), mapped to `low`, `medium`, `high`, `xhigh`.
- `risky`: whether *carrying out* the task would change production, move real money or alter unrecoverable data. A `noul` on TypeSafe's API, a `boolean` on the Gateway.

Probabilities are checked to lie in 0..1 and scores are clamped to 0..3; a response failing the check reads as `malformed`.

## Privacy

What leaves the machine, and only with a key set and `provider` not `builtin`:

- **Subagent path** (default): the subagent's `prompt` (cut to `maxPromptChars`, default 4000), its `description` (500 chars) and its agent type (100 chars). Nothing else: no cwd, env, file contents the router read, or other conversation.
- **Main-loop path** (only if you switch it on): the prompt you typed, for prompts that came from you (not notifications, peer or scheduled prompts, commands with arguments, or a bare `/command`), cut and redacted the same way.
- The API key goes in the `Authorization` header to the configured host only.

### Redaction (`redactSensitive`, on by default)

Before anything is sent, every text field is scrubbed and **then** truncated, so a cut can never expose half a secret and a placeholder is never cut in half. Matches become typed placeholders such as `[REDACTED:github-token]`. Matched values are never logged; with `logDecisions` on you see only counts per type (`2 redacted (github-token ×1, email ×1)`).

| Type | What it catches |
|---|---|
| `private-key` | `-----BEGIN ... PRIVATE KEY-----` blocks to their END marker (to the end of the text if cut off) |
| `armored-block` | age (`AGE ENCRYPTED FILE`) and PGP (`PGP MESSAGE`) armored blocks |
| `age-secret-key`, `sops-secret` | `AGE-SECRET-KEY-1...`, sops `ENC[AES256_GCM,...]` values |
| `anthropic-key`, `openai-key`, `typesafe-key` | `sk-ant-...`, `sk-...` (must contain a digit), `apikey_...` |
| `github-token` | `ghp_ gho_ ghu_ ghs_ ghr_` and `github_pat_` |
| `aws-access-key`, `aws-secret` | `AKIA`/`ASIA` ids, `aws_secret_access_key` assignments |
| `slack-token`, `google-api-key`, `jwt` | `xox[abprs]-`/`xapp-`, `AIza...`, `eyJ...eyJ...sig` |
| `bearer-token` | `Bearer`/`Basic` header values of 8+ characters with a digit, `+/=` or an interior capital (`Basic dXNlcjpwYXNz`); prose like "Bearer token authentication" or "Basic Configuration" is left |
| `stripe-key`, `npm-token`, `gitlab-token`, `huggingface-token`, `vercel-key` | `sk_live_`/`rk_test_...`, `npm_...`, `glpat-...`, `hf_...`, `vck_...` (the Gateway's own key shape) |
| `url-credentials` | `scheme://user:pass@host` (the host is kept); the password runs to the LAST `@`, so an unencoded `@` or `/` in it does not leak its tail |
| `cli-secret` | `--password`, `--token`, `--secret`, `--api-key`, `--access-key` values |
| `secret-assignment` | `NAME=value`, `NAME: value`, `"name": "value"`, `export NAME=...` where the name ends in key/token/secret/password/passwd/pwd/credential(s) (optionally followed by `_base`/`_value`/`_string`/`_data`/`_content`/`_text`, so `SECRET_KEY_BASE` counts). Short values (4+ characters) and values containing `, ; ) } ]` are covered; `$VAR`, `${X}`, `{{ x }}`, `<x>` references and UI-label prose (`"Enter your password"`) are not, while `"$ecretPass1"`, `"#Abc1234"` and `"correct horse battery staple"` are |
| `high-entropy-hex`, `high-entropy-base64` | hex of 64+ characters and base64-like runs of 40+ characters with mixed case, digits and high entropy |

Optional, **off by default**, each its own switch: `redactEmails` (`email`), `redactIps` (`ipv4`, `ipv6`), `redactHomePaths` (`/home/<user>`, `/Users/<user>`, `C:\Users\<user>` become `~`). `redactPatterns` adds your own regular expressions, one per line (or a JSON array of strings); matches become `[REDACTED:custom]`. A pattern that is invalid, longer than 200 characters, has a backreference or a repeated group holding a quantifier or an alternation such as `(a+)+` or `(?:a|aa)+` (backtracking risk; this check errs shut: an alternation of plain literals with distinct first characters such as `(?:foo|bar)+`, or one repeated at most 10 times such as `(a|b){2}`, is accepted, but `(?:a{1,5})+` is still refused) or matches the empty string is skipped and reported once, by position, never by its text.

Ordinary code is deliberately left alone: `const token = getToken()`, `password: string`, `max_tokens: 4096`, `tokenizer: "..."`, `sortKey: "name"`, `password: ${PASSWORD}`, git hashes, lockfile hashes, UUIDs and file paths are not redacted.

**This is best effort, not a guarantee.** A pattern list cannot know every secret; a secret written as prose in free text (only `NAME = "words"` assignments are caught), a short or low-entropy password in free text, an unquoted bare-word password (`password: hunter` has no digit and is read as a type or identifier), a key in an unusual format, or sensitive business content that has no secret shape will go through. Redaction only protects what it recognises. If a prompt may carry something you cannot afford to send, switch the router off or keep `routeSubagentModel`/`routeSubagentEffort` off for that session.

Linear time: built-in detectors use literal prefixes and bounded, non-overlapping classes (and plain `indexOf` for armored blocks), and each field is cut to 100 000 characters before any pattern runs. Your own patterns cannot be proven linear in JavaScript; the input bound and the backtracking check (a heuristic, not a proof) are the only guards, so keep them simple.

## Limitations

- **Hidden-script workflow agents.** Some Workflow runs keep their script out of hooks and give every agent the fixed prompt `(withheld: this workflow run does not share its script)`. Jev cannot read the task, so such an agent runs on the fallback model and effort and the router reports it. Only that text counts; a repeated or short prompt is routed normally.
- **Skipped spawns, no call, no change:** forks (they inherit the parent), teammates (the engine ignores a model rewrite for them), resumed agents (their content is pinned), and spawns the router recognises as placeholders. A **resumed agent runs at the default effort**: its entry was dropped when it first ended.
- **Effort on a model without effort.** If a request carries no effort, none is written onto it. All three families reported one in testing.
- **Effort is checked, not guaranteed.** `effort` is rewritable per the declarations and the rewritten value was seen on the request; whether the model honours `xhigh` the way it does `high` is the API's concern.
- **Session-forced models.** If the session ever forces the subagent model over a hook, the router cannot choose; it says so once (`override`).
- **Timeouts do not cancel the request** (no abort signal on `$.http.fetch`); a late answer is dropped.
- **Toasts** only exist in an interactive terminal; `claude -p` and the SDK get the transcript line and the debug log.
- **Main-loop routing**, if switched on, is fail-open: on any failure the turn runs unchanged (it has no fallback to apply), and the failure is shown the same way.

## What changed in 0.5.0-hartmanfrost.5

- **Status file for an external status line (`statusFile`, default on).** The router keeps `<config dir>/state/jev-model-router/<session id>.json` (`$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`; one file per session, so profiles and concurrent sessions never mix) listing the subagents it routed that are running right now:

  ```json
  {"v":1,"sessionId":"<uuid>","updatedAt":1792557303476,
   "active":[{"agentId":"a1b2","model":"haiku","effort":"low","fallback":false,"startedAt":1792557301000}]}
  ```

  `model` is what the agent actually runs on (the spawn result's, so a forced `CLAUDE_CODE_SUBAGENT_MODEL` shows as it is): `haiku`, `sonnet`, `opus`, or the raw id if unknown. `effort` is `low|medium|high|xhigh`, or `null` when effort is not routed. `fallback` is true when Jev gave no decision and the fallback applied. Times are epoch ms.
- **What counts.** An agent enters at its `turn.start` (or at the spawn's bind, if its loop started first) and leaves at `turn.complete`, whatever the reason; a resumed agent is active again at its new `turn.start`. Forks, teammates and resumes of agents the router never routed are **not** counted. Agents of several concurrent Workflow runs aggregate in the one file.
- **Cheap.** Written only when the set changes (a burst of spawns is coalesced into a few writes; `turn.step` only refreshes liveness in memory), plus a heartbeat rewrite every 5 s while anything is active so a reader can tell a live router from a dead one (`updatedAt` older than ~20 s means stale). The heartbeat also drops agents the engine lists as completed/failed/killed, and any agent silent for 20 minutes. `session.start` and `session.end` write `active: []`. No prompt text is ever written. The mod cannot delete files, so old session files stay (a few hundred bytes each); a reader may remove ones older than a week.
- **Reader contract.** Accept the file only if `v` is 1, `sessionId` equals the session's, and `updatedAt` is fresh; otherwise fall back to the normal rendering. A torn or empty read (the write is not atomic) should be retried next tick. `claude plugin validate` now also lists `$.fs.write`, `$.session.id`, `$.env.get` (`CLAUDE_CONFIG_DIR`, `HOME`) and `$.agent.list`. Set `statusFile: false` to turn it all off.

## What changed in 0.5.0-hartmanfrost.4

- **Identical prompts are never skipped.** The "same short prompt on three agents of one run" heuristic is gone: a fan-out of N verifiers with one prompt is N real tasks, all routed, and identical concurrent spawns share one Jev call (in-flight dedup plus the decision cache). A hidden-script placeholder is recognised only by its literal text, `(withheld: this workflow run does not share its script)` (Claude Code 2.1.305/2.1.306 spawn site).
- **A withheld prompt is no longer a silent skip.** The agent runs on `fallbackModel`/`fallbackEffort` and the router says so (toast + transcript line, rate-limited like other failures). Forks, teammates and resumes stay unrouted but are now logged once per session per kind at normal level, not debug.

## What changed in 0.5.0-hartmanfrost.3

- **Secret redaction is fail-closed for `scheme://user:NNNN...@`.** Only `localhost`, an IPv4 or a dotted host with a valid port, a `/`, and a later `?`/`#` is read as `host:port/path?query`; `http://admin:1234?x@host/` and `http://u:123#frag@h` are redacted.
- **No stale effort entries.** A spawn that settles without an agent id (or is denied or throws) removes its own entry at once, and unclaimed entries expire after 60 s, so a later spawn with the same prompt cannot claim a stale effort.

## What changed after 0.5.0-hartmanfrost.2

- **Effort cannot cross to another spawn.** Every spawn that reaches `agent.spawn`'s `next` (routed or skipped) files an entry under its prompt, a skipped one as "no effort", so an unrouted agent whose prompt equals a routed spawn's takes its own entry at `turn.start`.
- **`host:port` URLs are not credentials.** `http://localhost:3000/a?e=me@x.com` is left alone; `user:12345@host` is still redacted.
- **Status line** follows the real fallback count.
- **Custom-pattern check** accepts forced literal alternations and short bounded alternation repeats.

## What changed in 0.5.0-hartmanfrost.2

Fixes from review of `.1`:

- **Keyless / `no-key` notice is once.** The scope-prefixed class (`subagent:no-key`) was escalating at 1, 5, 25 ... ; it is now shown once, and the status line follows every subagent fallback (`fallback ×N`), written once for keyless.
- **Risk never lowers the main-loop model** (`routeMainModel`), matching the subagent path and the effort path.
- **Effort plans:** an agent that already claimed its entry no longer takes a second spawn's entry for the same prompt.
- **Redaction:** URL passwords with `@` or `/`; an unterminated `BEGIN ... PRIVATE KEY` marker takes the key body, not the prose after it; values that merely start with `options`/`env`/`config`...; short and delimiter-containing passwords; quoted passwords starting with `$ # % @`; `SECRET_KEY_BASE`-style names; short `Basic`/`Bearer` values; prose passphrases; Stripe, npm, GitLab, HuggingFace and Vercel keys; the custom-pattern guard now sees alternation and nesting. Custom patterns remain a heuristic.
- `tests/hook.test.ts` (engine-driven), an icon, and a root `.claude-plugin/marketplace.json` for installing this fork.

## What changed from 0.4.2

- Routes only subagents by default. `routeMainEffort` is now **off**; with both main switches off, `prompt.submit` makes no call.
- Candidates are `haiku`, `sonnet`, `opus` only (tier options are pickers; anything else, including `fable`, is rejected with a warning). The effort ladder never reaches `max`.
- Sets subagent effort per agent (new): `agent.spawn` records `agentId`, `turn.step` applies it, `turn.complete` cleans up.
- Overrides an explicitly given model; always names the model explicitly. Fixes the `e.model ?? e.parentModel` baseline.
- Loud failure with `fallbackModel`/`fallbackEffort`, toast plus transcript, escalating counts, a circuit breaker; keyless mode uses the fallback and one notice instead of `$.model.classify`.
- Ranks, not strings: a forced-risk decision no longer rewrites `claude-opus-5-5[1m]` to `opus` (the `[1m]` suffix is never stripped); a model the router cannot place (`fable`) is never touched.
- `pendingDecisions` slot desync fixed: main-loop decisions are tied to the prompt's text and claimed at `turn.start`, not counted.
- Skips resumes, forks, teammates and non-person prompts (`isMeta`, commands, notifications, peers, schedules).
- https-only base URLs (loopback excepted), option range validation with visible warnings, classifier-label validation, decision cache, `maxPromptChars`.
- New: secret redaction before anything is sent.
- Alias ids for the main loop updated to the ids Claude Code 2.1.305 reports (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`).
- The default `timeoutMs` is 1500 (was 800), since a miss now costs a visible fallback.

## Options

```
  typesafeApiKey:         string  TypeSafe API key (sensitive)
  gatewayApiKey:          string  Vercel AI Gateway key (sensitive)
  provider:               string  "auto" | "typesafe" | "gateway" | "builtin"
  typesafeBaseUrl:        string  empty uses https://api.typesafe.ai
  typesafeModel:          string  empty uses jev-latest
  gatewayBaseUrl:         string  empty uses https://ai-gateway.vercel.sh/v4/ai
  gatewayModel:           string  empty uses typesafe-ai/jev
  fastModel:              string  haiku | sonnet | opus (default haiku)
  balancedModel:          string  haiku | sonnet | opus (default sonnet)
  deepModel:              string  haiku | sonnet | opus (default opus)
  minUpgradeConfidence:   number  0..1, bar to go above the fallback (0.3)
  minDowngradeConfidence: number  0..1, bar to go below the fallback (0.6)
  fallbackModel:          string  haiku | sonnet | opus (default opus)
  fallbackEffort:         string  low | medium | high | xhigh (default medium)
  routeSubagentModel:     boolean (default true)
  routeSubagentEffort:    boolean (default true)
  routeMainEffort:        boolean (default false)
  routeMainModel:         boolean (default false)
  timeoutMs:              number  100..30000 (default 1500)
  maxPromptChars:         number  200..20000 (default 4000)
  redactSensitive:        boolean (default true)
  redactEmails:           boolean (default false)
  redactIps:              boolean (default false)
  redactHomePaths:        boolean (default false)
  redactPatterns:         string  your regexes, one per line or a JSON array
  logDecisions:           boolean log each decision (default true; failures always show)
  statusFile:             boolean write the running-subagents state file for a status line (default true)
```

Declared in `.claude-plugin/plugin.json` (`userConfig`). The two keys are `sensitive`: set them with `/plugin configure` or, non-interactively, `echo '{"typesafeApiKey":"..."}' | claude plugin configure jev-model-router@<marketplace> --values-stdin`; they are stored in secure storage and never written to `settings.json`. Other options go in user settings (`~/.claude/settings.json`, not project settings), `--settings <file>` or managed settings:

```json
{ "pluginConfigs": { "jev-model-router@skills-dir": { "options": { "fallbackModel": "sonnet", "fallbackEffort": "high" } } } }
```

The entry's key is the plugin's id, which follows how it was loaded: `"jev-model-router@skills-dir"` when auto-loaded from `.claude/skills/` (the `--mod` install), `"jev-model-router"` with `--plugin-dir`. Under the wrong key every option stays at its default.

## Install

```sh
npx claude-code-templates@latest --mod productivity/jev-model-router
claude
```

`--mod` writes the plugin to `.claude/skills/jev-model-router/` in the project, and Claude Code auto-loads it as `jev-model-router@skills-dir` **in a trusted project** (accept the trust prompt on the first interactive `claude` there; `claude -p` never asks). For one session, or a folder you do not trust, name it instead:

```sh
claude --plugin-dir .claude/skills/jev-model-router
```

From this fork's marketplace: `/plugin marketplace add hartmanfrost/claude-code-templates`, then `/plugin install jev-model-router --marketplace hartmanfrost/claude-code-templates`.

`claude plugin validate .claude/skills/jev-model-router` prints every event it hooks and every `$` call it makes.

## Tests

```sh
claude plugin test cli-tool/components/mods/productivity/jev-model-router
```

Pure logic (`tests/policy.test.ts`, `tests/router.test.ts`, `tests/redact.test.ts`, and the status-file tracker and serializer in `tests/statusfile.test.ts`: no network, no `$`) plus engine-driven hook tests (`tests/hook.test.ts`), which load the real hooks over stand-ins for the network and the UI: routing off makes no call, the caller's model is overridden, effort is bound by `agentId`, applied at `turn.step` and dropped at `turn.complete`, every failure kind falls back with a toast, keyless gives one notice and never calls the classifier, resumes/forks/teammates/placeholders make no call, and a secret never reaches the request body. The status file has hook tests too (enter at `turn.start`, leave at `turn.complete`, bind after an early `turn.start`, unrouted agents not counted, fallback flag, actual model, config-dir resolution, heartbeat and prune, no write per step, session reset). Redaction has positive and negative cases per detector, placeholder format, truncation after redaction, custom patterns and an adversarial-input timing check.

**Requirements.** Mods are on by default in Claude Code 2.1.287+. A mod runs without `node_modules`, so both backends are spoken to over HTTP through `$.http.fetch`. The TypeSafe wire shape was read from `@typesafe-ai/sdk` v0.6.0; the Gateway's, which is `experimental` in the AI SDK and not documented publicly, from `@ai-sdk/gateway` v4.0.86 and `@ai-sdk/provider` v4.0.17. Either may change.
