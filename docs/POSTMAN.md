# Postman export

Steward exports its API calls for people who work in [Postman](https://www.postman.com/): to debug a failing step, to reproduce a call for a vendor or support, or to try an API by hand. Steward knows its own model, so the export is exact where it can be, and it states what it left out. **It never contains a secret.**

- **A platform** becomes a Postman _environment_ (base URL, variables, every secret as an empty variable) and a _collection_ of the operations of its API descriptions (OpenAPI), signed in like Steward signs in.
- **A process** becomes a collection with one folder: its requests in step order, the values that flow between steps, its checks as tests – and an environment for its connections.

Both are Postman's own formats (Collection v2.1, environment), ready for Postman's _Import_ and for `newman run`. Importing Postman collections into Steward is planned separately (#204).

## Where

| What       | In the web app                                             | API                                     |
| ---------- | ---------------------------------------------------------- | --------------------------------------- |
| A process  | process editor → actions menu (⋯) → **Export for Postman** | `GET /api/processes/:id/export/postman` |
| A platform | platform page → **More** (⋯) → **Export for Postman**      | `GET /api/platforms/:id/export/postman` |

The download is a ZIP with two files, `<name>.postman_collection.json` and `<name>.postman_environment.json`: unpack it and import both into Postman (_Import_ takes several files at once), or run them with `newman run <name>.postman_collection.json -e <name>.postman_environment.json`. A ZIP keeps the two files as Postman expects them – one JSON with both inside would be neither format. `?file=collection` or `?file=environment` returns one of them as JSON (for scripts and CI).

- **Who may:** whoever may view the process, or has a right on the platform (whoever sees its page) – the export holds what these pages show, without the secrets. There is no extra export right.
- **Audited** as `process.exported_postman` (with the version and the platforms used) and `platform.exported_postman` (with the number of operations).
- **Process options:** `version=<n>` exports an earlier version. `bindings=<slot>:<platformId>,…` names the platform for each connection; the process editor passes the platforms last chosen in the run dialog. Without one, a connection whose kind has exactly one platform you can see gets that one; otherwise it is exported without a platform (enter its base URL and sign-in by hand). A platform you cannot see is never used.

## Secrets

Nothing secret is exported. Every secret becomes an environment variable of type `secret` with an empty value, which you fill in in Postman:

- the platform's stored credentials (client id and secret, tokens, passwords, keys …) and the variables the sign-in needs,
- platform variables and default headers whose name looks like a credential (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `signature`, `assertion` …),
- secret process inputs (type `secret`) and constants with such a name,
- `$secret('slot', 'key')` in headers, query parameters and bodies (of a step on that same slot: a request on another slot that carries it fails, since 0.9.0),
- a credential written literally into a definition or sign-in settings – a value under such a name, or a value like `Bearer …`, `Basic …`, `Token …` – as `secret.<step>.<where>.<name>` (process) or `login.<name>` / `header.<name>` (platform).

The export never reads the vault: it only knows the _names_ of the stored secrets. Tokens the collection fetches are kept in collection variables at run time (their exported value is empty).

## Platforms

The environment holds `baseUrl` (with `{{variable}}` parts where the base URL uses `{{ vars.x }}`), each platform variable and each secret. The collection has a **Connection test** request (Steward's _Test connection_) and one folder per tag of the platform's API operations: path parameters as Postman path variables (`:id`), query and header parameters (optional ones disabled), an example body from the request schema, and a test for the documented success status codes.

### Sign-in

| Steward sign-in               | In Postman                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None                          | No auth                                                                                                                                                                                                                              |
| Basic                         | Basic auth (`{{username}}`, `{{password}}`; a Kafka platform's Schema Registry key and secret)                                                                                                                                       |
| Bearer token                  | Bearer token; with another header name (GitLab `PRIVATE-TOKEN`) an API key header                                                                                                                                                    |
| API key                       | API key in the header or the query, with the platform's parameter name                                                                                                                                                               |
| AWS SigV4                     | AWS Signature (access key, secret key, session token, region, service). With an assumed role a note: enter the role's temporary credentials                                                                                          |
| OAuth 2.0 client credentials  | A **collection pre-request script** that requests a token from the token URL (client credentials in the Basic header or the body, scope, extra parameters) and keeps it with its expiry in collection variables; bearer auth uses it |
| Login request (token request) | The same, with the platform's login request (method, URL, headers, body); the token is read with the token path (plain JavaScript for a path, else JSONata – see below)                                                              |
| Key-pair JWT (Snowflake)      | The Postman sandbox cannot sign it: a note and an empty secret variable `{{accessToken}}` to paste a token into (e.g. from `snowsql --generate-jwt`)                                                                                 |

The script fetches a token only when there is none or it expires within 30 seconds. A custom header (`headerName`, `headerValue: 'Token {{ token }}'`) becomes an API key header with that value.

Settings Postman has no field for are notes in the collection description: a proxy, an own CA certificate, further trusted origins. _Accept self-signed certificates_ turns off SSL verification on the requests (`strictSSL: false`).

## Processes

The collection has one folder, named after the process. Its description says what was exported for which platform and lists everything the export could not do; each request's description says when Steward runs it (a branch, a loop, the error path, _Only run when_) and what Postman does differently (pagination, retries).

### Requests in step order

The requests follow the wires from the start node – the first port of a node first (`true` before `false`, `each` before `done`, `out` before `error`, `approved` before `rejected`). The requests of both branches of an _if_ are exported, and the requests in a loop once.

### Variables

| Name                                  | Where                                 | What                                                                                                          |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `<slot>.baseUrl`, `<slot>.<variable>` | environment                           | the platform of the connection slot, its variables and secrets (`<slot>.clientSecret` …)                      |
| `inputs.<name>`                       | collection (secret ones: environment) | the input with its default (lists as JSON)                                                                    |
| `const.<name>`                        | collection                            | constants of the process                                                                                      |
| `vars.<name>.<path>`                  | collection                            | a value of an earlier step                                                                                    |
| `expr.<step>.<n>`                     | collection                            | an expression the export cannot compute – **set by hand** (the folder description says what Steward computes) |
| `<slot>.accessToken`                  | collection                            | the token the pre-request script fetched                                                                      |

Templates (`{{ expression }}`) become Postman variables: `inputs.x`, `const.x`, `conn.<slot>.baseUrl`, `conn.<slot>.vars.x`, `$pvar('slot', 'name', 'fallback')` (the platform variable, or the fallback), `$secret('slot', 'key')` and paths into earlier results.

### Values that flow between steps

When a later step reads the answer of an earlier request (`{{ vars.users.body.resources[0].id }}`), the producing request's **test script** stores that value in a collection variable of the same name. A _set_ step with a literal value or a template of the forms above becomes a collection variable with that value. What the export cannot compute – a loop's item, a person's decision, the result of a sub-process or a browser step, an expression outside the subset below – is a variable **set by hand**, listed in the folder description with what Steward computes there.

### Checks → `pm.test(...)`

Each request gets a test for its accepted status codes (2xx, or the step's _Expected status codes_). A check step becomes a `pm.test` in the test script of the request before it, with its _Only run when_ condition, its name, and its severity as a prefix (`[warning] …`).

**Plain JavaScript** – this subset of JSONata is translated, with JSONata's semantics (paths over lists, truthiness, equality and comparison rules):

- paths: names, `` `names with spaces` ``, numeric indexes `[0]`, `[-1]`; the variables `$inputs`, `$vars`, `$const`
- literals: strings, numbers, `true`, `false`, `null`
- `=`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`, parentheses
- `$count()`, `$exists()`, `$length()`, `$not()`; and `$pvar()`, `$secret()` (read from the environment)

Examples: `vars.idm.status = 200`, `$count(vars.unknown) = 0`, `$exists(vars.res.status) and vars.res.durationMs <= $inputs.maxLatencyMs`.

**Everything else** (filters like `items[active = false]`, `&`, `? :`, arithmetic, other functions) runs **unchanged as JSONata** in Postman: the test loads `pm.require('npm:jsonata@2.2.2')` – the version Steward uses – and evaluates the same expression against the same values (Steward's `$daysSince`, `$daysAgo`, `$ts` and `$uuid` included). This works in the **Postman app and the Postman CLI, not in Newman**; the folder description lists these checks. Checks that read Steward's own data (`$systems()`, `$trend()`, `$daysUntil()`) are not exported and listed as such.

Nothing is evaluated when exporting: the export only reads the expressions.

### What does not map

These steps have no request; the folder description lists each of them (with its branch or loop), so the export states exactly what it left out:

| Step                                       | Note in the export                                                 |
| ------------------------------------------ | ------------------------------------------------------------------ |
| User task: approval (four-eyes), selection | who decides, and the four-eyes rule                                |
| Manual step                                | checklist, verification by a second person                         |
| Browser step                               | the number of actions; values it reads are set by hand             |
| Publish (dataset)                          | the dataset key                                                    |
| Access change                              | the kind of change                                                 |
| Sub-process                                | the process to export separately                                   |
| For each (loop)                            | the items; the requests inside are exported once                   |
| If (branch)                                | the condition; both branches are exported, each request says which |
| Wait, report, log, stop                    | what Steward does there                                            |

Steps not connected to the start and the notes on the canvas are listed too.

## Newman or the Postman app

| Runs with                              | Plain-JavaScript checks, sign-in scripts, values between steps | JSONata checks (`pm.require`) |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------- |
| Postman app                            | yes                                                            | yes                           |
| Postman CLI (`postman collection run`) | yes                                                            | yes                           |
| Newman                                 | yes                                                            | no – these tests fail         |

Steward's tests check every exported collection – of each example process and of the platforms – against the official Postman Collection v2.1 JSON Schema (vendored in `server/test/fixtures/postman`, Apache License 2.0, see NOTICE), and that every generated script compiles. They do not run Newman: Newman 6.2.3 brings 148 packages with known advisories (node-forge, lodash, handlebars …) that the dependency scans would refuse, and a home-made Postman sandbox would test the copy, not Postman.

## Not included

- An export to `.http` files (VS Code / JetBrains HTTP client) or Bruno – an open question in #204.
- The texts the export writes (descriptions, notes) are in English.
