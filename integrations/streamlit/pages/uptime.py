"""Uptime from the Gatus datasets: current status per endpoint and the metric history.

Datasets (examples/processes):
  gatus-uptime          71 "Gatus – uptime overview"
  gatus-uptime-metrics  74 "Gatus – uptime overview (from /metrics)"
Both publish the metrics endpoints, down and avgUptime on every run.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

import steward

UPTIME_DATASETS = ("gatus-uptime", "gatus-uptime-metrics")
METRICS = ("avgUptime", "down", "endpoints")

st.title("Uptime")

try:
    available = steward.visible(*UPTIME_DATASETS)
except steward.StewardError as e:
    steward.stop_with(e)
if not available:
    st.info(
        "No uptime dataset is visible to the token's user. Import and schedule the process "
        '"Gatus – uptime overview" (71) or "… (from /metrics)" (74), and check that the user may view it.'
    )
    st.stop()

process_of = {d["key"]: d["processName"] for d in available}
left, right = st.columns([2, 1])
key = left.selectbox("Dataset", list(process_of), format_func=lambda k: f"{k} ({process_of[k]})")
days = right.select_slider("History", options=[1, 7, 30, 90, 180, 365], value=30, format_func=lambda d: f"{d} days")

try:
    meta = steward.dataset(key)
    history = steward.metrics(key, METRICS, days)
    current = steward.rows(key)
except steward.StewardError as e:
    steward.stop_with(e)

steward.freshness(meta)

# Latest values, as published by the last run
latest = meta["metrics"]
a, b, c = st.columns(3)
a.metric("Endpoints", latest.get("endpoints", "–"))
b.metric("Down", latest.get("down", "–"))
c.metric("Average uptime", f"{latest['avgUptime']:.2f} %" if "avgUptime" in latest else "–")

# History: one point per run of the process
if history.empty:
    st.info(f"No metric history in the last {days} days.")
else:
    wide = history.pivot_table(index="ts", columns="metric", values="value", aggfunc="last")
    if "avgUptime" in wide:
        st.subheader("Average uptime (%)")
        st.line_chart(wide[["avgUptime"]])
    if "down" in wide:
        st.subheader("Endpoints down")
        st.line_chart(wide[["down"]])
        # Derived figure: share of runs per day in which no endpoint was down.
        daily = (wide["down"] == 0).resample("D").mean().mul(100).round(1).rename("Runs without outage (%)")
        st.subheader("Runs without outage per day")
        st.bar_chart(daily)
        st.caption("Computed here from the 'down' history; Steward stores one value per run.")

# Current snapshot, problems first
st.subheader("Endpoints now")
if current.empty:
    st.info("The current snapshot has no rows.")
else:
    table = steward.by_status(current)
    for col in ("Uptime (%)", "Avg response (ms)", "Last response (ms)", "Certificate expires in (days)"):
        if col in table:
            # process 74 writes "–" for missing values; make the column numeric
            table[col] = pd.to_numeric(table[col], errors="coerce")
    columns = [
        c
        for c in (
            "_status",
            "Endpoint",
            "Group",
            "Healthy",
            "Uptime (%)",
            "Avg response (ms)",
            "Last response (ms)",
            "Certificate expires in (days)",
            "Last check (UTC)",
            "_statusText",
            "Last error",
        )
        if c in table
    ]
    st.dataframe(
        table[columns],
        hide_index=True,
        column_config={
            "_status": st.column_config.TextColumn("Status"),
            "_statusText": st.column_config.TextColumn("Why"),
            "Uptime (%)": st.column_config.NumberColumn(format="%.2f"),
        },
    )
