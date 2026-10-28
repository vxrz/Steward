"""Privileged access and who has which right, from the Insights Hub access datasets.

Datasets (examples/processes):
  ih.privileged        12 "Insights Hub – Privileged access review": one row per privileged
                       assignment with the review result; metrics privileged, stale90, removed
  ih.access-snapshot   16 "Insights Hub – Access snapshot": one row per assignment
                       (subjectId, subjectName, subjectType, right); metrics users, assignments

The rows hold user names. Everyone who can open this app sees them: protect it (README.md).
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

import steward

PRIVILEGED = "ih.privileged"
SNAPSHOT = "ih.access-snapshot"


# ---------- join point: another data source ----------


def other_source() -> pd.DataFrame | None:
    """Data from outside Steward, joined to the access snapshot by user name.

    Return a DataFrame with a column "subjectName" (the platform's user name, usually
    the e-mail address) and the columns you want to show, e.g. department, manager or
    the leaving date from an HR export. Return None to skip the join.

    Examples – keep credentials in secrets.toml, never in this file:

        # a CSV export mounted read-only into the container
        return pd.read_csv("/data/hr-export.csv").rename(columns={"email": "subjectName"})

        # a database (add SQLAlchemy and a driver to requirements.in; [connections.hr] in secrets.toml)
        conn = st.connection("hr", type="sql")
        return conn.query("SELECT email AS subjectName, department, leaving_date FROM staff", ttl=3600)
    """
    return None


# ---------- page ----------

st.title("Privileged access")

try:
    available = {d["key"]: d for d in steward.visible(PRIVILEGED, SNAPSHOT)}
except steward.StewardError as e:
    steward.stop_with(e)
if not available:
    st.info(
        f"Neither {PRIVILEGED} nor {SNAPSHOT} is visible to the token's user. Run the processes "
        '"Insights Hub – Privileged access review" (12) or "Insights Hub – Access snapshot" (16) in Steward, '
        "and check that the user may view them."
    )
    st.stop()

# --- privileged access review (process 12, usually monthly) ---
if PRIVILEGED in available:
    try:
        meta = steward.dataset(PRIVILEGED)
        review = steward.rows(PRIVILEGED)
        history = steward.metrics(PRIVILEGED, ("privileged", "stale90", "removed"), days=400)
    except steward.StewardError as e:
        steward.stop_with(e)

    st.header("Last review")
    steward.freshness(meta)
    latest = meta["metrics"]
    a, b, c = st.columns(3)
    a.metric("Privileged assignments", latest.get("privileged", "–"))
    b.metric("No login for 90+ days", latest.get("stale90", "–"))
    c.metric("Removed in the review", latest.get("removed", "–"))

    if not review.empty:
        if "Review" in review:
            st.subheader("Review result")
            st.bar_chart(review["Review"].value_counts().rename("Assignments"), horizontal=True)
        if "Days" in review:
            review["Days"] = pd.to_numeric(review["Days"], errors="coerce")  # "–" when never signed in
        columns = [c for c in ("_status", "User", "Role", "Last login", "Days", "Review", "_statusText") if c in review]
        st.dataframe(
            steward.by_status(review)[columns],
            hide_index=True,
            column_config={
                "_status": st.column_config.TextColumn("Status"),
                "_statusText": st.column_config.TextColumn("Why"),
                "Days": st.column_config.NumberColumn("Days since login"),
            },
        )

    if not history.empty:
        st.subheader("Privileged assignments over time")
        st.line_chart(history.pivot_table(index="ts", columns="metric", values="value", aggfunc="last"))

# --- access snapshot (process 16, usually daily) ---
if SNAPSHOT in available:
    try:
        meta = steward.dataset(SNAPSHOT)
        snapshot = steward.rows(SNAPSHOT)
    except steward.StewardError as e:
        steward.stop_with(e)

    st.header("Who has which right")
    steward.freshness(meta)
    if snapshot.empty:
        st.info("The access snapshot has no rows.")
    else:
        users = snapshot[snapshot["subjectType"] == "user"]
        without = users.groupby("subjectName")["right"].apply(lambda r: r.isna().all())
        a, b, c = st.columns(3)
        a.metric("Users", users["subjectName"].nunique())
        b.metric("Assignments", int(snapshot["right"].notna().sum()))
        c.metric("Users without any group", int(without.sum()))

        per_right = snapshot.dropna(subset=["right"]).groupby("right")["subjectName"].nunique().sort_values(ascending=False)
        st.subheader("Users per group or role")
        st.bar_chart(per_right.head(25).rename("Users"), horizontal=True)

        extra = other_source()
        if extra is not None:
            joined = snapshot.merge(extra, on="subjectName", how="left", indicator="match")
            unknown = joined[joined["match"] == "left_only"]["subjectName"].drop_duplicates()
            st.subheader("Accounts without an entry in the other source")
            st.caption("Candidates for the access review: leavers, external or technical accounts.")
            st.dataframe(unknown.to_frame(), hide_index=True)
            st.subheader("Access snapshot with the other source")
            st.dataframe(joined.drop(columns=["match"]), hide_index=True)
        else:
            with st.expander("All assignments"):
                st.dataframe(snapshot[["subjectName", "subjectType", "right"]], hide_index=True)
