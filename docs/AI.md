# AI models

A process can ask an AI model a **predefined question** with context from earlier steps – Checkmk data, other platforms, Steward datasets – and use the answer in later steps, for example in a report, a check message or an e-mail and Teams notification. Every call is limited, logged and can be reported.

**The AI does not act on its own.** It answers; actions stay explicit process steps, and an answer can wait for a person's approval before it leaves Steward. There are no tool calls from the model to platforms and no chat. The other direction – an AI assistant using Steward – is the [MCP server](MCP.md).

| What                                            | Where in Steward                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| The gateway, its models and what it may be sent | Platform of kind `llm-gateway`: tabs _AI models_ and _AI usage_                    |
| The question, its context, the answer's shape   | Process step _Ask an AI model_ (`type: ai`)                                        |
| Limits per call and budgets per day and month   | The model and the step (per call); _AI usage_ tab (installation, gateway, process) |
| What was called, by whom, how many tokens       | Usage log, built-in dataset _AI usage_, dashboard template _AI usage_              |
| The monthly report                              | A report schedule with the section _AI usage_                                      |
| Budget changes and refused calls                | Audit log (`ai.budget_changed`, `ai.call_refused`)                                 |

## Set-up

_Platforms → Add platform → LLM gateway (AI models)_ (group _AI models_ in the setup wizard).

- **Base URL**: the gateway's root, without `/v1` – e.g. `https://llm-gateway.example.com`. A second region (an EU endpoint) is a second platform with its own base URL, or a variable in the base URL (`https://{{ vars.region }}.llm-gateway.example.com`).
- **Sign-in**: an API key in a header – `x-api-key` by default (sign-in type _API key_, header name editable: `api-key`, `Authorization` …), or a bearer token. Every sign-in type of [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md) works; the key is stored in the vault like every credential and only sent to the gateway's origin.
- **Time-out**: the preset waits up to 5 minutes for an answer (_Settings → HTTP → time-out_). Steward never streams, so endpoints without streaming work the same.
- The **outbound policy** must allow the gateway's host.

**Test connection** reads the model list (`GET /v1/models`) and sends one minimal request to every model that is set up (_Reply with OK._, at most 16 output tokens). These are real calls: they appear in the usage log as _connection tests_ and count against the budgets – a model whose budget is used up is not asked. Without models yet, the test passes when the gateway lists its models. A periodic connection test (platform health) asks the models each time it runs.

### Models

_Platform → AI models_: **Read models from the gateway** lists what `GET /v1/models` (OpenAI list format, `{ "data": [{ "id": … }] }`) returns, with a suggested format; **Add model** enters one by hand. Per model:

| Setting                | Meaning                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Model id               | As the gateway expects it in the request (`model`), or in the path for the Converse format           |
| Request format         | Which endpoint of the gateway the model is asked through ([formats](#formats))                       |
| Path (optional)        | Another path than the format's, relative to the base URL; `{modelId}` is replaced (URL-encoded)      |
| Context window         | Input and output together, in tokens                                                                 |
| Most output            | Default and ceiling of the output of one call                                                        |
| Most input (optional)  | Ceiling of the input of one call; default: the context window minus the most output                  |
| Characters per token   | For the [estimate](#limits) before a call (default 3.5)                                              |
| Price per 1,000 tokens | Input and output, optional, in the installation's currency – the usage log and reports show the cost |

The models and the allowed data are part of the platform's sealed connection settings (like the base URL, they are signed with the vault's integrity key): they change only on the _AI models_ tab (`PUT /api/platforms/:id/ai`, the platform's _manage_ right), and every change is audited (`platform.ai_changed`, with the models and the allowed data before and after). The general settings form keeps them.

### Formats

One gateway can expose several request formats on one base URL, so **the format belongs to the model**, not to the vendor. Steward builds one question – instructions (system part) and the user part, no conversation, no tools – in the model's format and reads the answer, the token counts and why it ended:

| Format                  | Request                                                                                                                                                    | Answer and token counts                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OpenAI Chat Completions | `POST /v1/chat/completions` – `model`, `messages` (system, user), `max_tokens`, `temperature`, `stream: false`                                             | `choices[0].message.content`; `usage.prompt_tokens` / `completion_tokens`; `finish_reason`              |
| OpenAI Responses        | `POST /v1/responses` – `model`, `instructions`, `input` (instead of `messages`), `max_output_tokens`, `store: false`                                       | `output` items of type `message` (or `output_text`); `usage.input_tokens` / `output_tokens`; `status`   |
| Anthropic Messages      | `POST /v1/messages` with `anthropic-version: 2023-06-01` – `model`, `system`, `messages`, `max_tokens` (required)                                          | `content` blocks of type `text`; `usage.input_tokens` (+ cached parts) / `output_tokens`; `stop_reason` |
| Bedrock Converse        | `POST /v1/bedrock/model/{modelId}/invoke` – model id in the path, `system` and `messages` as typed blocks (`[{ "text": … }]`), `inferenceConfig.maxTokens` | `output.message.content`; `usage.inputTokens` / `outputTokens`; `stopReason`                            |

- **Chat Completions** is also the format of every OpenAI-compatible API: local models, Azure OpenAI behind a gateway, and other providers a gateway translates (for example models with a provider prefix such as `provider/model`). An API that puts the model into the path takes a path override with `{modelId}`.
- The `anthropic-version` header can be changed under _AI models → Advanced_, as can the path of the model list.
- A gateway's native Gemini endpoint (`/v1beta`) is not used; Gemini models through the gateway's Chat Completions endpoint work.
- Answers in other formats are refused with the gateway's text (`AI_GATEWAY_ERROR`). The translation layer is `server/src/ai/formats.ts`: one adapter per format behind one interface, no vendor SDK.

### Allowed data

_AI models → Allowed data_ says what processes may send to this gateway. **Nothing is allowed until an administrator (or whoever manages the platform) allows it**:

- **Data of platforms** – the platforms whose answers may be sent, or _data of every platform_.
- **Datasets** – keys or patterns (`checkmk.*`; `*` for every dataset the run may read). A dataset is read with the rights of the person (or schedule owner) the run runs as.
- **Inputs of a run** – values people or triggers give when a run starts.

**What is checked is the value sent, not the step named.** Variables are one namespace that any later step can write, so the run records, for every variable, where what was written to it comes from (`server/src/ai/provenance.ts`):

- a value an **API call or a browser step** wrote comes from that step's platform;
- an **earlier AI answer** comes from its gateway and from everything its context could carry;
- a value **any other step** wrote – set variables, the item of a for each, a sub-process's outputs, a user task – is computed from the run, and Steward cannot know what it contains, so it assumes the most: the data of **every platform bound to the run**, the run's **inputs** (when it has any; a person's entries in a user task always count as inputs) and **every dataset the process may read** – those of its AI steps, those named in `$trend()` and `$daysUntil()`, and those of its sub-processes; `$systems()` (the system inventory) and a `$trend()` whose dataset is not written out count as every dataset (`*`).
- A variable keeps every source ever written to it in the run, so a later step or a parallel loop item writing the same name only adds to it. The inputs of a **sub-process run** are computed in its parent run: they carry everything of the parent run too. When a run resumes after a restart, the finished steps are replayed from its journal in their order, and the sources with them.
- A process is **refused when saved** if a context step's variable (its _Save result as_, or a key of a _Set variables_ step) is also written by another step (`aiContextOverwritten`) – give the result its own name.

A step that would send something else fails before anything is sent: `AI_DATA_NOT_ALLOWED`, naming the source and where to allow it.

## The step "Ask an AI model"

```yaml
- id: summary
  type: ai
  connection: llm # a connection slot of kind llm-gateway
  model: demo-chat-small # a model set up on the gateway
  system: You summarise monitoring data for the service team. Be brief.
  prompt: |
    Which of these series need attention this week?

    {{ trends }}
  context:
    - name: trends
      from: dataset # step | dataset | input
      dataset: checkmk.trends
      columns: [series, latest, unit, daysToCrit]
      maxChars: 20000
  answer: json # text (default) or json
  schema: { type: object, properties: { headline: { type: string } }, required: [headline] }
  temperature: 0.2
  maxOutputTokens: 800
  maxInputTokens: 6000
  sampleAnswer: '{"headline":"Sample"}' # dry runs and test runs
  saveAs: summary
```

- **Prompt:** a template saved with the process, in two parts – instructions (system) and the question (user). `{{ name }}` inserts a context source; **nothing else is filled in at run time** – no expressions, no inputs typed when the run starts. The template is versioned with the process – every saved version of a process is kept and each run names its version; the usage log carries a fingerprint (SHA-256) of the template and of the filled-in input, so a report can tell which version of a prompt was used.
- **Context:** explicitly chosen sources, each with a name:
  - `step` – the result of an earlier step: its _Save result as_ variable (the step needs one), or the values of a _Set variables_ step;
  - `dataset` – the rows of a dataset (optionally only some `columns`; the status of each row is kept);
  - `input` – an input of the run.
  - `path` (optional) is an expression on the value (JSONata, e.g. `body.items[status != 'OK']`); `maxChars` caps what one source sends (default 20,000 characters, at most 500,000) – more is cut off, and the run says so. Only the sources the prompt uses are read and sent.
  - **Secrets are removed** before anything is sent: the run's known secrets (platform credentials, secret inputs, tokens seen in answers) in their usual encodings, values under keys that name credentials (`password`, `apiKey`, `authorization`, `token` …), and strings that look like credentials (bearer and basic values, JSON Web Tokens, private keys, Steward API tokens, well-known token formats, credentials in URLs, `key=value` secrets). They become `[removed]`; the run's log says how many. E-mail and IP addresses stay – they are data the question may be about; leave them out with a `path` or `columns` where they must not leave.
- **Answer:** `text`, or `json` – Steward adds the schema to the instructions (_Answer with JSON only … that matches this JSON Schema_), reads the JSON (a code fence or text around it is tolerated) and checks it against the step's **JSON Schema** (draft 2020-12 keywords that zod's `fromJSONSchema` supports; no external `$ref`, and no regular expressions – `pattern` and `patternProperties` are refused, since an expression could take very long on a model's answer; check the text in a later step instead). An answer that does not match fails the step with `AI_ANSWER_INVALID` – later steps and checks can rely on its shape. The schema is checked when the process is saved.
- **Settings:** a fixed model, temperature (0–2; empty: the model's default) and the most output tokens.
- **Result** (`vars.<saveAs>`): `answer` (the text or the checked JSON), `text`, `model`, `modelLabel`, `aiGenerated: true`, `marking` (_AI-generated with … – check it before you rely on it_), `usage` (`inputTokens`, `outputTokens`, `estimatedInputTokens`, `cost`), `durationMs`, `finishReason`, `truncated` (the answer stopped at the output limit), `promptFingerprint`, `inputFingerprint`, `removedSecrets`. The step's input in the run shows the filled-in prompt, the context sizes and the limits. Prompts and answers stay in the run like every step's data.
- **Errors:** every refusal and failure names its reason code first (`AI_BUDGET_EXHAUSTED: …`). Connect the step's **error** output to handle it, or let the run fail.
- **Dry runs and test runs never call the model.** A dry run uses the step's _sample answer_ (or says _the model was not asked_), a test run a [recorded response](PLATFORMS.md#recorded-responses-and-test-runs) of the gateway for `POST <the model's path>` (in the model's format; else the sample answer). Both still check the input size and the allowed data; nothing is logged as a call.

### Marking and approval

Text an AI model wrote is **marked as AI-generated** where it leaves the run: a _report_ step whose title, text or rows carry an answer says _AI-generated (model)_ in the run, its report and the PDF; a check message (headline, items, message) that carries one gets the fact _AI-generated: written with … – check it before you rely on it_ in the in-app, e-mail, Teams and webhook messages (`data.aiGenerated` names the models). Steward recognises an answer by its text (12 characters or more, also strings inside a JSON answer). For an API call that posts an answer somewhere, add `{{ vars.<saveAs>.marking }}` to the body.

**An optional approval before an AI-written message leaves Steward** is a user task of mode _approve_ with _four-eyes_ (the run's starter may not decide) right after the AI step – see the example _Checkmk – AI summary of the trends_. It uses the existing four-eyes approvals and the control point `run.decide` of the [assurance policy](ASSURANCE.md).

## Limits

**Per call** – checked before anything is sent:

- **Input:** Steward estimates the input's tokens **before** sending, without a tokenizer: characters (Unicode code points) divided by 3.5, rounded up, plus 8 tokens per message and 16 per call (`server/src/ai/estimate.ts`). Real tokenizers average about 4 characters per token for English and German prose and JSON, so the estimate is a little high: a call is refused rather than sent too large. For scripts with few characters per token (Chinese, Japanese) set a lower _characters per token_ on the model. An estimate above the step's _most input tokens_ (default and ceiling: the model's) fails the step without a call: `AI_INPUT_TOO_LARGE`. The estimate plus the most output must also fit into the context window (`AI_OUTPUT_TOO_LARGE`).
- **Output:** the step's _most output tokens_ (default and ceiling: the model's) is sent as the format's output limit.

**Budgets** – tokens (input and output together) **per day and per month**, for the **installation**, a **gateway** and a **process** (all gateways), on the gateway's _AI usage_ tab. A process's budget **covers its sub-processes**: a call of a sub-process run counts against its own process and against every process above it in the chain of runs. Periods are calendar days and months in **UTC**.

- Before a call, its **worst case** – the estimated input plus the most output – must fit into what is left of every budget that applies (installation, gateway, process; day and month). It is reserved in the same database transaction as the check, so parallel steps cannot together go past a budget; when the answer comes, the reservation becomes the counts the gateway reported (the estimate when it reports none). A call that does not fit is **refused before it is sent** with `AI_BUDGET_EXHAUSTED`, naming the budget, what is left and what the call may need – until the period ends or an administrator raises the budget.
- **At 80 %** of a budget, and when it is **used up**, a notification goes out once per budget and period (event `ai.budget`, in the app and by e-mail by default): to the administrators, for a gateway's budget also its managers, for a process's budget its owner. The dataset _AI usage_ has the installation's budgets as the limits of its metrics, so dashboards forecast when a budget runs out.
- **Changing a budget** is for administrators (`PUT /api/ai/budgets`) and audited (`ai.budget_changed`, before and after, the comment). **Raising** one – more tokens, or no limit any more – needs a **step-up**: the control point `ai.budget` of the [assurance policy](ASSURANCE.md) (on by default; lowering a budget never asks). A call that never got its answer (the server stopped while waiting) keeps its worst case and counts as failed after an hour (`AI_CALL_INTERRUPTED`).
- **Token counts come from the answer** – each format reports usage differently ([formats](#formats)); Steward reads all of them, cached prompt parts included.

## Reporting

- **Usage log** (`ai_usage`, `GET /api/ai/usage` for administrators and auditors): one entry per call with time, process, its version, run, step, gateway, model, format, input and output tokens, the estimate, duration, result (`ok`, `failed`, `invalid`, `refused`) and reason, cost, and the fingerprints of the prompt template and of the filled-in input. **It holds no content** – prompts and answers stay in the run. Kept for `SM_AI_USAGE_RETENTION_DAYS` (default 400 days, [CONFIGURATION.md](CONFIGURATION.md)).
- **Gateway page → AI usage:** the budgets of the installation and the gateway with their use today and this month, the totals, the processes and models that used the most, the budgets of single processes (administrators and auditors) and the latest calls. Whoever may use the platform sees it; names of processes they may not view are left out (_Processes you may not see_).
- **Built-in dataset _AI usage_** (`ai.usage`): one row per gateway, model and process with this month's calls, refused and failed calls, tokens and cost; metrics `tokensToday`, `tokensThisMonth`, `callsToday`, `refusedToday`, `costThisMonth`. Steward publishes it itself (the job `ai-usage`, after calls and at least hourly); administrators and auditors see it, also through `/api/v1/datasets/ai.usage`. The **dashboard template _AI usage_** reads it.
- **Monthly report:** a [report schedule](REPORTS.md) with the preset _monthly_ and the section _AI usage_ – calls and tokens per gateway and model, the processes with the most tokens, refused and failed calls, the budgets. The section is collected with the owner's rights: only administrators and auditors see the usage.
- **Costs:** a gateway's costs go into the cost model (hourly, per day, model and process, in the gateway's currency) and appear under _Costs_ with the other platforms ([COSTS.md](COSTS.md#sources)).
- **Audit:** `platform.ai_changed`, `ai.budget_changed` (with the step-up proof), `ai.call_refused` (every refusal: reason, gateway, model, process, run, the estimate) and `platform.tested`. The run record names the model and the token counts of every call.

## Demo and tests

The demo (`npm run demo` → _Load demo data_) has the platform _LLM gateway (demo)_: a simulated multi-format gateway (`server/src/mock/mockLlmGateway.ts`) at `/mock/llm` with one model per format – `demo-chat-small` (Chat Completions), `demo-responses-small` (Responses), `demo-messages-small` (Messages), `demo.converse-small-v1:0` (Converse) – and an API key in `x-api-key`. Its answers are made up from the question (JSON that matches the requested schema); no real model is asked. It may be sent the Checkmk demo platform's data and the datasets `checkmk.*`. The example process _Checkmk – AI summary of the trends_ (`examples/processes/95-checkmk-ai-summary.yaml`) uses it, the dashboard _AI usage_ shows the result.

`server/test/ai-formats.test.ts` covers the translation both ways and the usage fields per format, the estimate, secret removal, placeholders and JSON answers; `server/test/ai-step.test.ts` runs the step against the simulated gateway in every format – refusals before sending, budgets with the 80 % notice and period roll-over, the step-up for raising budgets, dry runs and test runs, marking, the usage page, the dataset and the report section; `e2e/ai.spec.ts` the set-up wizard, the step editor and the usage tab on a desktop and a phone.

## Not in scope

Autonomous agents, tool calls from the model to platforms, chat in the UI, embeddings, vector stores and fine-tuning.
