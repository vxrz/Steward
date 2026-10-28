"""Steward data in Streamlit – an example app on Steward's read-only API.

Run:  streamlit run app.py   (settings in .streamlit/secrets.toml, see README.md)
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

import steward

st.set_page_config(page_title="Steward data", layout="wide")


# ---------- optional sign-in (Streamlit's OIDC login, configured in [auth] of secrets.toml) ----------


def require_login() -> None:
    if not steward.auth_configured():
        return  # no [auth] section: protect the app at the proxy, or keep it local
    if not st.user.is_logged_in:
        st.title("Steward data")
        st.write("Sign in to see the dashboards.")
        st.button("Sign in", on_click=st.login, type="primary")
        st.stop()
    # Optional allow-list on top of the identity provider ([access] in secrets.toml).
    allowed = [e.lower() for e in st.secrets.get("access", {}).get("allowed_emails", [])]
    email = str(st.user.get("email", "")).lower()
    if allowed and email not in allowed:
        st.error(f"{email or 'This account'} may not use this app.")
        st.button("Sign out", on_click=st.logout)
        st.stop()


require_login()


# ---------- overview page ----------


def overview() -> None:
    st.title("Steward data")
    st.write(
        "Datasets published by Steward processes, read through the read-only API. "
        "This app only shows what the token's user may see in Steward."
    )
    try:
        items = steward.datasets()
    except steward.StewardError as e:
        steward.stop_with(e)
    if not items:
        st.info("The token's user cannot see any dataset. Run a process that publishes one, or check its rights in Steward.")
        return
    table = pd.DataFrame(
        [
            {
                "Dataset": d["key"],
                "Title": d["title"],
                "Process": d["processName"],
                "Updated (UTC)": pd.Timestamp(d["updatedAt"]).tz_convert(None),
                "Rows": d["rowCount"],
                "Critical": d["statusCounts"].get("critical", 0),
                "Warning": d["statusCounts"].get("warning", 0),
                "Stale": d["stale"],
                "Dry run": d["dryRun"],
            }
            for d in items
        ]
    )
    st.dataframe(
        table,
        hide_index=True,
        column_config={"Updated (UTC)": st.column_config.DatetimeColumn(format="YYYY-MM-DD HH:mm")},
    )


# ---------- navigation and sidebar ----------

pages = st.navigation(
    [
        st.Page(overview, title="Overview", icon=":material/table:", default=True),
        st.Page("pages/uptime.py", title="Uptime", icon=":material/monitor_heart:"),
        st.Page("pages/access_review.py", title="Privileged access", icon=":material/admin_panel_settings:"),
    ]
)

with st.sidebar:
    try:
        who = steward.me()
        expires = who["token"]["expiresAt"]
        st.caption(
            f"Steward user **{who['user']['username']}** ({', '.join(who['user']['roles'])}), "
            f"token *{who['token']['name']}* ({who['token']['scope']}"
            f"{', expires ' + expires[:10] if expires else ', no expiry'})"
        )
        if who["token"]["scope"] != "read":
            st.warning("Use a token with the scope Read only for this app.")
    except steward.StewardError as e:
        st.error(str(e))
    st.caption(f"Data is cached for {steward.CACHE_TTL // 60} minutes.")
    if st.button("Reload from Steward"):
        st.cache_data.clear()
        st.rerun()
    if steward.auth_configured() and st.user.is_logged_in:
        st.caption(f"Signed in as {st.user.get('email') or st.user.get('name')}")
        st.button("Sign out", on_click=st.logout)

pages.run()
