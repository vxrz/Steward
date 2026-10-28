"""A small read-only client for Steward's public API (/api/v1).

Only the dataset endpoints are used:

    GET /api/v1/me                         who the token belongs to
    GET /api/v1/datasets                   datasets the token's user may see
    GET /api/v1/datasets/{key}             metadata: columns, latest metrics, staleness
    GET /api/v1/datasets/{key}/rows        rows of the current snapshot (paged)
    GET /api/v1/datasets/{key}/metrics     metric history

Settings come from .streamlit/secrets.toml (see secrets.toml.example):

    [steward]
    base_url = "https://steward.corp.example"   # with the base path if Steward runs under one
    token = "smt_..."                            # read-only API token

Answers are cached with st.cache_data for CACHE_TTL seconds. The cache is shared
by everyone who uses the app: every viewer sees what the token's user sees.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import pandas as pd
import requests
import streamlit as st

CACHE_TTL = 300  # seconds; datasets change when a process publishes them, usually every few minutes or less often
TIMEOUT = (5, 30)  # seconds: connect, read
ROW_PAGE_SIZE = 1000  # the API allows 1-1000 rows per page
MAX_ROWS = 50_000  # stop paging after this many rows
STATUS_ORDER = ["critical", "serious", "warning", "unknown", "good"]


class StewardError(Exception):
    """A request to Steward failed. The message is meant for the person using the app."""

    def __init__(self, message: str, status: int | None = None, problem_type: str | None = None):
        super().__init__(message)
        self.status = status
        self.problem_type = problem_type


# ---------- settings ----------


def _settings() -> tuple[str, str, bool | str]:
    try:
        section = st.secrets["steward"]
    except (KeyError, FileNotFoundError):
        raise StewardError(
            "No [steward] section in .streamlit/secrets.toml. Copy .streamlit/secrets.toml.example and fill in base_url and token."
        ) from None
    base_url = str(section.get("base_url", "")).strip().rstrip("/")
    token = str(section.get("token", "")).strip()
    if not base_url.startswith(("http://", "https://")):
        raise StewardError('steward.base_url must start with http:// or https://, e.g. "https://apps.corp.example/steward".')
    if not token:
        raise StewardError("steward.token is empty. Create a read-only API token in Steward (Profile → API tokens).")
    if base_url.endswith("/api/v1"):
        base_url = base_url[: -len("/api/v1")]
    # Optional: a CA bundle (PEM) for a company CA. Never turn certificate checks off.
    verify: bool | str = str(section.get("ca_bundle", "")).strip() or True
    return base_url, token, verify


def auth_configured() -> bool:
    """True when secrets.toml has an [auth] section, i.e. Streamlit's OIDC sign-in is set up."""
    try:
        return "auth" in st.secrets
    except FileNotFoundError:
        return False


# ---------- HTTP ----------


def _problem(r: requests.Response) -> tuple[str, str]:
    """(type, detail) of an RFC 9457 problem answer; empty strings when the body is something else."""
    try:
        body = r.json()
    except ValueError:
        return "", ""
    if not isinstance(body, dict):
        return "", ""
    return str(body.get("type", "")).rsplit("#", 1)[-1], str(body.get("detail", ""))


def _error(r: requests.Response, base_url: str) -> StewardError:
    kind, detail = _problem(r)
    status = r.status_code
    if status == 401:
        msg = "Steward did not accept the API token"
        if kind == "invalid-token":
            msg += " – it is unknown, revoked or expired. Create a new read-only token and update secrets.toml."
        else:
            msg += f": {detail or 'no token sent'}"
    elif status == 403:
        if detail == "Host not allowed":
            host = base_url.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0]
            msg = f'Steward refuses the host name "{host}". Add it to SM_ALLOWED_HOSTS (comma-separated, no spaces) or use the public URL.'
        elif kind == "owner-disabled":
            msg = "The user who owns the token is deactivated in Steward."
        elif kind == "password-change-required":
            msg = "The user who owns the token has to change their password in Steward first."
        elif kind == "token-scope":
            msg = "This is an MCP client token. The REST API needs a token with the scope Read only."
        else:
            msg = f"Steward refused the request: {detail or 'forbidden'}"
    elif status == 404:
        if kind == "not-found":
            msg = (
                "Not found. The dataset does not exist, or the token's user may not view the process that publishes it. "
                f"({detail})"
            )
        else:
            msg = (
                f"{r.url} answered 404 without an API error. Check base_url: under a path it must include the base path, "
                'e.g. "https://apps.corp.example/steward". The public API may also be turned off (SM_API_V1=off).'
            )
    elif status == 409:
        msg = "The dataset was published again while it was being read. Reload the page."
    elif status == 429:
        msg = f"Too many requests for this token. Try again in {r.headers.get('Retry-After', 'a few')} seconds."
    elif status == 503 and kind == "vault-locked":
        msg = "Steward was restarted and its vault is still locked. An administrator has to unlock it."
    else:
        msg = f"Steward answered {status}: {detail or r.reason}"
    return StewardError(msg, status, kind or None)


def _get(path: str, params: dict[str, Any] | list[tuple[str, Any]] | None = None) -> Any:
    base_url, token, verify = _settings()
    url = f"{base_url}/api/v1{path}"
    try:
        r = requests.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=TIMEOUT,
            verify=verify,
            allow_redirects=False,  # a redirect means a wrong base_url; do not send the token on
        )
    except requests.exceptions.SSLError as e:
        raise StewardError(f"TLS error talking to {base_url}: {e}. For a company CA set steward.ca_bundle.") from None
    except requests.exceptions.RequestException as e:
        raise StewardError(f"Cannot reach Steward at {base_url}: {e.__class__.__name__}. Check base_url and the network.") from None
    if 300 <= r.status_code < 400:
        raise StewardError(
            f"{url} redirects to {r.headers.get('Location', '?')}. Check base_url (https, base path).", r.status_code
        )
    if r.status_code != 200:
        raise _error(r, base_url)
    try:
        return r.json()
    except ValueError:
        raise StewardError(f"{url} did not answer with JSON. Is base_url pointing at Steward?") from None


def _key(dataset_key: str) -> str:
    return quote(dataset_key, safe="")


# ---------- cached API calls ----------


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def me() -> dict:
    """Owner of the token: user (username, roles, teams), token (name, scope, expiresAt)."""
    return _get("/me")


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def datasets() -> list[dict]:
    """Metadata of every dataset the token's user may see, ordered by key."""
    items: list[dict] = []
    cursor = None
    while True:
        page = _get("/datasets", {"limit": 200, **({"cursor": cursor} if cursor else {})})
        items.extend(page["items"])
        cursor = page.get("nextCursor")
        if not cursor:
            return items


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def dataset(key: str) -> dict:
    """Metadata of one dataset: title, processName, updatedAt, rowCount, columns, statusCounts, metrics, stale."""
    return _get(f"/datasets/{_key(key)}")


@st.cache_data(ttl=CACHE_TTL, show_spinner="Loading rows from Steward …")
def rows(key: str, statuses: tuple[str, ...] = ()) -> pd.DataFrame:
    """All rows of the current snapshot as a DataFrame.

    Columns are the dataset's column labels (e.g. "Endpoint", "Uptime (%)") plus the
    reserved fields _key, _status (good, warning, serious, critical, unknown) and _statusText.
    """
    for _attempt in range(3):
        items: list[dict] = []
        cursor = None
        try:
            while True:
                params: list[tuple[str, Any]] = [("limit", ROW_PAGE_SIZE)] + [("status", s) for s in statuses]
                if cursor:
                    params.append(("cursor", cursor))
                page = _get(f"/datasets/{_key(key)}/rows", params)
                items.extend(page["items"])
                cursor = page.get("nextCursor")
                if not cursor or len(items) >= MAX_ROWS:
                    return pd.DataFrame(items)
        except StewardError as e:
            if e.problem_type != "dataset-changed":
                raise
            # re-published while paging: start again without a cursor
    raise StewardError(f"Dataset {key} kept changing while it was read. Try again later.")


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def metrics(key: str, names: tuple[str, ...] = (), days: int = 30, points: int = 1000) -> pd.DataFrame:
    """Metric history in long form: columns ts (UTC), metric, value.

    days: 1-400. points: at most this many points per metric (2-2000); longer
    histories are thinned out by taking every n-th value, not averaged.
    """
    params: list[tuple[str, Any]] = [("days", days), ("points", points)] + [("names", n) for n in names]
    body = _get(f"/datasets/{_key(key)}/metrics", params)
    records = [{"ts": p["ts"], "metric": s["name"], "value": p["value"]} for s in body["series"] for p in s["points"]]
    df = pd.DataFrame(records, columns=["ts", "metric", "value"])
    df["ts"] = pd.to_datetime(df["ts"], utc=True, format="ISO8601")
    return df


# ---------- small helpers for the pages ----------


def visible(*keys: str) -> list[dict]:
    """Metadata of those of `keys` the token can see, in the given order."""
    by_key = {d["key"]: d for d in datasets()}
    return [by_key[k] for k in keys if k in by_key]


def by_status(df: pd.DataFrame) -> pd.DataFrame:
    """Problems first: critical, serious, warning, unknown, good."""
    if "_status" not in df.columns:
        return df
    order = {s: i for i, s in enumerate(STATUS_ORDER)}
    return df.sort_values("_status", key=lambda s: s.map(order).fillna(len(order)), kind="stable")


def freshness(meta: dict) -> None:
    """One line about the age of a dataset; a warning when Steward marks it stale."""
    updated = pd.Timestamp(meta["updatedAt"])
    age = pd.Timestamp.now(tz="UTC") - updated
    text = f"Published by **{meta['processName']}** at {updated:%Y-%m-%d %H:%M} UTC ({_age(age)} ago)"
    if meta.get("dryRun"):
        text += " – from a **dry run**"
    if meta.get("stale"):
        st.warning(
            f"{text}. The dataset is **stale**: older than {meta['staleAfterMinutes']} minutes. "
            "Check the schedule of the process in Steward."
        )
    else:
        st.caption(text)


def _age(delta: pd.Timedelta) -> str:
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return f"{minutes} min"
    if minutes < 48 * 60:
        return f"{minutes // 60} h"
    return f"{minutes // 1440} days"


def stop_with(e: StewardError) -> None:
    st.error(str(e))
    st.stop()
