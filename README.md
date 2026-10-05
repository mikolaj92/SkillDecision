# SkillDecision

An experimental resource selector for **Pi 1.0.0**. It selects local skills and tool recommendations before Pi answers each user task.

**It extends Pi. It does not replace Pi, execute the task, or restrict Pi's tools.** No fork, separate service, or Pi Durable dependency.

```text
User task → isolated decision → validate IDs → load selected skills → ordinary Pi
                               failure ──────────────────────────→ ordinary Pi
```

Pi already advertises skills and can load them itself. This extension tests whether proactively loading relevant instructions reduces missed skills. **No improvement in task success or cost has been demonstrated.**

## Install

Requires Pi 1.0.0. Development tests use Node 22.19+ or Node 24.

```sh
pi install git:github.com/mikolaj92/SkillDecision
pi
```

Or try the checked-out package for one invocation, without changing Pi settings:

```sh
git clone https://github.com/mikolaj92/SkillDecision.git
pi -e ./SkillDecision/src/pi.ts
```

The package has no runtime dependencies. Pi supplies authentication and its model libraries. Review the source before installing any extension.

## Choose a decision model

By default, `auto` uses the currently selected **physical chat model** in a separate, tool-free request. It does not reuse the main agent's system prompt or conversation wholesale.

Choose a smaller chat model or a registered classifier explicitly:

```sh
pi --decide-model '<provider>/<model-id>'
```

Use an exact ID from your Pi registry, not a fuzzy name or a thinking-level suffix. Set up that provider through Pi first. SkillDecision does not store credentials.

The main model may still use Bedrock or virtual routing. Choose a different, physical decision model in those cases.

| Decision backend | Behavior |
| --- | --- |
| Physical chat model | One isolated `streamSimple()` call, SSE, `maxRetries: 0`, output limit 1,024 tokens |
| Classifier | One `classify()` call with one boolean question per catalog resource; probability ≥ 0.5 selects it |
| `llama-cpp-classify` | Rejected: Pi 1.0 sends a separate request for every question |
| `bedrock-converse-stream` | Rejected: its AWS client does not honor Pi's zero-retry option |
| `pi-virtual` | Rejected before routing: the public extension registry cannot safely inspect the routed decision transport |

Unsupported backends produce a named fallback. The main Pi task still runs. Other custom provider implementations are responsible for honoring cancellation and zero retries; one API invocation cannot guarantee their internal network behavior.

## Controls

```text
/decide on
/decide off
/decide status
/decide stats
```

Disable selection at startup:

```sh
pi --decide-disabled
```

`--decide-disabled` takes precedence over `/decide on`. On/off controls last for the loaded extension instance; they are not saved to configuration.

## What changes

- `before_agent_start` captures Pi's discovered skill catalog, excluding manual-only skills.
- The cancellable `context` hook performs selection before the first main-model request for each accepted user message.
- The input contains the task, up to four recent text messages or summaries, and resource IDs/descriptions.
- Selected skill files are loaded in full. Their frontmatter is removed. File paths and base directories accompany the instructions.
- A hidden, request-local context message supplies the selected resources. Relative skill references resolve from the supplied `baseDir`.
- Pi's original user messages, system prompt, and active tools remain unchanged. Tool selections are recommendations, not permissions.
- Decisions attach to source message IDs on the active session branch. Steering and follow-up messages get their own decisions.
- Tool continuations, main-model retries, reloads, and compaction reuse the saved decision rather than calling the selector again.

A batch of several queued user messages can require several decisions before one main-model request. This is one decision per message, not one decision per tool call. Blank tasks and empty catalogs skip selection.

## JSON contract v1

The portable core is `src/decision.ts`. Only `src/pi.ts` knows about Pi.

Schemas live in [`contracts/decision-input.v1.schema.json`](contracts/decision-input.v1.schema.json) and [`contracts/decision-output.v1.schema.json`](contracts/decision-output.v1.schema.json). Their filenames and `$id` identify the version; no version key is added to the model output.

Example input:

```json
{
  "task": "Extract obligations from the PDF",
  "context": [],
  "skills": [{"id": "pdf", "description": "Process PDF documents"}],
  "tools": [{"id": "read", "description": "Read files"}]
}
```

Exactly one output object:

```json
{"skills":["pdf"],"tools":["read"]}
```

Both arrays may be empty. Unknown IDs, duplicate IDs within an array, wrong types, additional keys, prose, and Markdown fences are rejected. Schema validation describes the shape; runtime validation additionally checks IDs against the supplied catalog. Classifier results normalize to the same object.

No Hermes or other harness adapter is included.

## Failure behavior and limits

The entire decision and selected-file loading operation has a **15-second deadline per user message**. Aborting Pi cancels selection and prevents the main-model request for that aborted run. A late provider or filesystem result cannot inject context or append a second audit entry.

| Limit | Value |
| --- | --- |
| Recent context | 4 items, 2,000 characters each; summaries carry an explicit label |
| Serialized decision input | 131,072 characters |
| One selected skill file | 65,536 bytes, regular files only |
| Combined enrichment | 131,072 characters |

There are no selector retries. Malformed output, provider failure, unknown models, oversized catalogs, and unreadable files leave ordinary Pi behavior intact. Loading is all-or-nothing: one failed selected file discards the enrichment.

Audits use named reasons such as `INVALID_DECISION`, `INVALID_DECISION_JSON`, `DECISION_MODEL_FAILED`, `CLASSIFIER_FAILED`, `INVALID_CLASSIFIER_RESULT`, `DECISION_TIMEOUT`, `ABORTED`, `CATALOG_TOO_LARGE`, `SKILL_TOO_LARGE`, `ENRICHMENT_TOO_LARGE`, `MODEL_UNAVAILABLE`, `INVALID_MODEL_ADDRESS`, `CLASSIFIER_FANOUT_UNSUPPORTED`, `DECISION_TRANSPORT_UNSUPPORTED`, and `VIRTUAL_DECISION_MODEL_UNSUPPORTED`. Unexpected exceptions use `DECISION_FAILED`; raw provider errors are not copied into the audit.

Fallback is saved for that message too. Continuing the same message does not silently attempt selection again.

## Counters, cost, and privacy

**Pi's footer and `/session` totals exclude the isolated selector.** Use `/decide stats` for its separate active-branch totals:

- `decisions`, `selected`, `fallback`, `unknownUsage`;
- `usage.input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`;
- `usage.cost` and `footerIncludesDecisionCost: false`.

Missing usage is unknown, not evidence of a free request. `unknownUsage` includes local fallbacks that made no model request. Costs depend on provider reporting and Pi's configured model prices. Tool continuations can resend enrichment, which may also increase the main model's token use.

Each `skill-decision` custom session entry records its target message ID, outcome, actual response provider/model when available, elapsed `durationMs`, reported usage, and successful decision/enrichment. The enrichment includes loaded skill text and local file paths; it persists with the session. Treat session files as private.

The chosen decision provider receives task text, bounded recent text/summaries, and resource IDs/descriptions. Selected full skill instructions go to the main model, not to the selector. Attachments, images, tool results, and repository files are not independently inspected by the selector. Skill and tool catalogs reflect Pi's registered resources; MCP tools that have not connected yet may be missing.

Skill instructions remain trusted local code-adjacent inputs, not a security sandbox. Resource selection is not an operating-system permission boundary.

## Development and verification

```sh
npm ci
npm run verify
npm audit --omit=dev
npm pack --dry-run
```

`verify` runs strict TypeScript checking and the complete Node test suite. Integration tests run real Pi SDK sessions with a localhost SSE provider and an in-process classifier fixture. They exercise cancellation, queued tasks, tool continuations, retries, branch usage, compaction, reloads, file limits, validation, and fallback. They do not need provider credentials.

The suite is not a live-provider benchmark. Task success, omitted relevant resources, and baseline-versus-extension total cost still require a paired evaluation. Audit latency and reported usage alone do not establish a quality improvement.

## License

[MIT](LICENSE).
