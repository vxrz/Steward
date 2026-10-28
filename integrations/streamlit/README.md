# Streamlit example: Steward data in your own app

A small [Streamlit](https://streamlit.io) app that reads Steward's published datasets through the read-only API (`/api/v1`). Use it as a starting point when you want to combine Steward data with other sources or build views that Steward's own dashboards do not offer. Background, the API calls and security notes for both this app and the Grafana example: [docs/EXTERNAL-DASHBOARDS.md](../../docs/EXTERNAL-DASHBOARDS.md).

| Page              | Shows                                                                                                       | Datasets (process)                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Overview          | Every dataset the token can see: process, age, rows, problems, stale                                        | all                                                |
| Uptime            | Endpoints, down, average uptime; their history; runs without outage per day; endpoints now, problems first  | `gatus-uptime` (71) or `gatus-uptime-metrics` (74) |
| Privileged access | Last privileged access review with its result and history; users per group; a join with another data source | `ih.privileged` (12), `ih.access-snapshot` (16)    |

Files:

| File                                  | Purpose                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `app.py`                              | Sign-in (optional), navigation, overview page                                             |
| `pages/uptime.py`                     | Uptime page                                                                               |
| `pages/access_review.py`              | Privileged access page; `other_source()` is the place to join other data                  |
| `steward.py`                          | API client: token, timeouts, paging, caching (`st.cache_data`, 5 minutes), error messages |
| `.streamlit/secrets.toml.example`     | Settings template. The real `secrets.toml` is ignored by Git and Docker                   |
| `.streamlit/config.toml`              | Streamlit settings: headless, no usage statistics, no tracebacks for viewers              |
| `requirements.in`, `requirements.txt` | Direct dependencies, and all dependencies with exact versions                             |
| `Dockerfile`, `compose.snippet.yml`   | Container image and a compose service next to Steward                                     |

## 1. A token for the app

The app reads with one API token. A token acts as its owner and sees exactly what that user sees in Steward, so create a **dedicated technical user** for it:

1. _Users & teams_: create a user, e.g. `svc-dashboards`, with the role **viewer**. No other role.
2. Restrict what it sees if needed. A viewer may view every process without an access list; give the processes whose data must not appear in the app an access list without this user (see [What the token can see](../../docs/EXTERNAL-DASHBOARDS.md#what-the-token-can-see)).
3. Sign in as that user, open **Profile → API tokens → New token**, choose **Read only** and an expiry (e.g. one year). Copy the token: it is shown once.

## 2. Run it locally

Python 3.11 or newer.

```bash
cd integrations/streamlit
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml
# edit .streamlit/secrets.toml: base_url and token
streamlit run app.py
```

Open <http://localhost:8501>. For a local Steward, `base_url = "http://127.0.0.1:4310"`. With `npm run demo` → _Load demo data_ the Gatus datasets are filled at once; `ih.privileged` appears after a run of process 12.

`base_url` is Steward's address **with its base path** and without `/api/v1`: `https://apps.corp.example/steward` when Steward runs under `/steward` (`SM_PUBLIC_URL`, `SM_BASE_PATH`). The client adds `/api/v1/…`.

## 3. Run it in Docker next to Steward

`compose.snippet.yml` adds the service `steward-streamlit` to the setup from [docs/INSTALL.md → Steward in Docker](../../docs/INSTALL.md#steward-in-docker): Caddy on the network `caddy-bridge` serves Steward under `/steward` and the app under `/dashboards`.

1. Put the settings in a file next to the compose file. It must be readable by the container user (uid 10001):
   ```bash
   sudo install -m 400 -o 10001 -g 10001 /dev/null streamlit-secrets.toml && sudoedit streamlit-secrets.toml
   ```
   In it, `base_url = "http://steward:4310/steward"`: the app talks to Steward on the Docker network, not through the proxy.
2. Add `steward` to Steward's host allow-list, comma-separated without spaces: `SM_ALLOWED_HOSTS=apps.corp.example,steward`. Without it Steward answers `403 Host not allowed`. (Or use the public URL as `base_url` and leave the list alone.)
3. Add the service from `compose.snippet.yml`, adjust `build:` to where this folder is, and `docker compose up -d --build steward-streamlit`.
4. Add the `/dashboards` block to the Caddyfile.

The path is set with `STREAMLIT_SERVER_BASE_URL_PATH` (Streamlit's `server.baseUrlPath`). Like Steward, the app expects the proxy to **keep** the prefix (Caddy `handle`, not `handle_path`). Streamlit uses a WebSocket (`/dashboards/_stcore/stream`); Caddy and Traefik pass it on by themselves, nginx needs:

```nginx
location /dashboards/ {
  proxy_pass http://127.0.0.1:8501;          # no trailing slash: the prefix stays
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 1h;
}
```

**Prefer an own host name** such as `reports.corp.example` over a path on Steward's host. Applications on one host name share an origin in the browser: a flaw in any of them can act inside Steward with the signed-in user's session (see [INSTALL.md → Under a path](../../docs/INSTALL.md#under-a-path-httpsappscorpexamplesteward)). With an own host name, drop `STREAMLIT_SERVER_BASE_URL_PATH` and route the host to `steward-streamlit:8501`.

The container runs as a non-root user with a read-only file system, and the image holds no settings: `secrets.toml` is mounted at run time and excluded by `.dockerignore`.

## 4. Protect the app

The app shows Steward data to everyone who can open it, with the rights of the token, not of the viewer. Never publish it without a sign-in.

**Streamlit's OpenID Connect login.** Add an `[auth]` section to `secrets.toml` (template in `secrets.toml.example`) and the app asks for a sign-in before anything else ([`st.login`](https://docs.streamlit.io/develop/api-reference/user/st.login)):

```toml
[auth]
redirect_uri = "https://apps.corp.example/dashboards/oauth2callback"
cookie_secret = "<random string>"
client_id = "<client id>"
client_secret = "<client secret>"
server_metadata_url = "https://login.corp.example/.well-known/openid-configuration"
```

- Register `redirect_uri` at your identity provider (Entra ID, Keycloak, Okta, …). It is the app's public address plus `/oauth2callback`, with the path.
- Restrict who may sign in **at the identity provider** (assign the app to a group). Without that, everyone in your directory gets in.
- `[access] allowed_emails` adds a short allow-list in the app (checked after the sign-in).
- The sign-in needs `Authlib`, which `requirements.txt` includes (`streamlit[auth]`).

**Or at the proxy.** An authenticating proxy (oauth2-proxy, Traefik ForwardAuth, Caddy `forward_auth`) in front of `/dashboards` works as well. Then leave `[auth]` out.

Either way, the viewers' own Steward rights play no role: whoever gets into the app sees what the technical user sees.

## What the token can see

In short (details in [docs/EXTERNAL-DASHBOARDS.md](../../docs/EXTERNAL-DASHBOARDS.md#what-the-token-can-see)):

- Datasets of processes (and monitors) its user may **view**. Others answer `404` and are left out of `/datasets`.
- A read-only token cannot change anything. It can read everything else its user can read too, through `/api/v1` (runs, logs, audit log for auditors) and the GET endpoints of the internal API. A viewer is therefore the right role; never use an administrator's token.
- The token sits in `secrets.toml` on the server, never in the browser. Revoke it on the profile page when it may have leaked.

## Add a page or another data source

- **New page:** add a file to `pages/` and register it in `st.navigation([...])` in `app.py`. Read data with `steward.rows(key)`, `steward.metrics(key, names, days)` and `steward.dataset(key)`; catch `steward.StewardError`.
- **Other sources:** `other_source()` in `pages/access_review.py` shows where a CSV export or a database joins the access snapshot by user name. Keep credentials for those sources in `secrets.toml` as well (`st.connection`).
- **Caching:** answers are cached for `CACHE_TTL` (300 s) in `steward.py`, for all viewers together. _Reload from Steward_ in the sidebar clears the cache. The API allows 600 requests per minute and token.

## Update the dependencies

`requirements.txt` pins every package, generated from `requirements.in`:

```bash
uv pip compile requirements.in --universal --python-version 3.11 -o requirements.txt
```

Change the versions in `requirements.in` first. The pinned versions were current on 2026-10-14 (pandas 3.0.6, requests 2.34.2; image `python:3.13.15-slim-trixie`), except Streamlit 1.66.1, Pillow 13.0.0, Authlib 1.9.1 and certifi 2026.10.18, which fix security advisories.
