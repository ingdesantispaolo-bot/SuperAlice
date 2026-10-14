# Continuing market assistant

Use this procedure for the user's market overview and follow-up across three
horizons. Answer in the user's language. Its purpose is to explain changes and
their implications using inspected evidence, with a recoverable research trail.
It does not run by itself: unattended checks belong to scheduled Issues using
the self-scheduling Skill. Native Agent runtimes still own analysis and reasoning.

## Read the desk before reading the market

Before forming a market interpretation, consult the owning desk's
`alice memory catalog/context` (see market-memory.md), alongside run/latest
evidence. Resolve economic assets and relevant horizons; inspect recorded check
outcomes, unexpired signals, applicable approved lessons and latest asset/group
judgments. Supply setupType/regime only when established. If the archive is empty
or an identity is unknown, state that coverage gap and establish it from evidence.
Never infer that the market has no events.
Keep imported interpretations dated and separate by horizon; retrieval does
not re-evaluate them. Check stale/superseded/partial evidence and knownAsOf
coverage before applying a cached thesis to a current question. Preserve the
original report and add later reconciliations rather than rewriting its inputs.

1. Read `research/market-assistant/profile.json` if present, the latest accepted
   state and relevant previous reports. Inspect the relevant holdings/watchlist,
   tracked topics, Inbox and Issues when they add context. Old conversations
   can explain intent; their prices and conclusions must be refreshed.
2. If no profile exists, use [the example](market-assistant-profile.example.json)
   as research defaults and create a local copy. Do not overwrite a customized
   profile or assume a financial objective, benchmark, risk budget or account
   selection the user has not specified. In that case assess observable risk
   and mark personal suitability/target allocation as undetermined.
3. Discover actual availability. Use the monitor procedure for macro/GEX,
   archived market states, alerts and IBKR history; alice-uta for read-only
   accounts, holdings and executable quotes; monitor news and alice RSS;
   traderhub for available calendars/fundamentals; authoritative web sources
   for coverage gaps. A browser's pinned watchlist is local UI state, not proof
   of an agent-readable watchlist. Use the local profile or resolved catalog.
4. The working universe starts with actual holdings, explicit profile symbols
   and relevant monitor instruments. Include supported representatives of
   equities/indices, rates/bonds, currencies, volatility and commodities.
   A missing asset class remains a coverage gap. An empty profile symbol list
   means discover that universe, not scan every listed security. Label proxies,
   contract currencies, futures deliveries and continuous-future roll effects.
5. Read the metric catalog before interpreting method identities and units.
   Retrieve only useful bounded windows and representative pairs. Inspect
   `data-status` before requesting history; track/request missing daily history
   through the monitor, reuse pending jobs and respect its catalog limits.
   Never start the second IBKR research client while the monitor owns collection.

## Three horizons in one market picture

| Horizon | Evidence and comparison | Decision context |
|---|---|---|
| Intraday | Actual current-session observations; last accepted update, session open, previous close, captured intraday states and news since the last check | Trend/range, volatility/liquidity, cross-market confirmation, event windows, relevant levels and what invalidates the current reading |
| Swing, several sessions | Completed daily bars, recent sessions versus the medium-term baseline, sector/asset rotation, catalysts and changing correlation | Whether the multi-day thesis improves or deteriorates, extension versus the broader trend, scenario/invalidation and risks of holding overnight |
| Long term | Verified account holdings and currency exposure, sufficiently long history, fundamentals, macro regime and persisted thesis | Concentration, factor/sector/currency overlap, diversification, drawdowns and thesis changes; compare with user targets only when known |

Do not turn a short-term extreme into a long-term valuation conclusion. A
portfolio may have sound long-term theses while its positions are extended
intraday. Show that distinction and explain which exposure a market change affects.

## Regime changes

Use the monitor's measured states and history where available, then make your
own interpretation explicit. Evaluate trend versus range, volatility expansion
versus compression, risk appetite, rates/FX conditions, breadth/rotation when
supported and the available GEX state. A market can change independently of
another; report a map, not one universal risk-on/risk-off label.

Compare equivalent methods and sessions. For a new interpretation, name the
prior state, current evidence, start/observation time and affected horizon.
Mark a first observation `candidate`; confirm only with the profile's repeated
fresh observations or independent corroboration. Monitor alerts retain their
producer severity separately from your assessment. Report reversals/resolutions.
If history is missing, report the current condition and establish a baseline.

## Temporary and persistent relationships

Use `correlation-matrix` for supported windows/methods and `relation-pair` for
its documented regression/relationship variants. Compare short, intermediate
and long windows available in the catalog. Retain paired observations, coverage,
stability/reliability and algorithm parameters, not just a coefficient.

For local calculations, align sessions/timestamps and calculate correlations of
returns or economically appropriate changes, not drifting price levels. Do not
forward-fill an overnight-closed market into a synchronous intraday comparison.
Rate/yield differences, price returns and FX returns have different meanings;
state the transformation and lag. Check both Pearson and rank relationships
when available. Describe changes in sign/strength and whether they are local to
an event or persist across windows and dates. Sparse/unstable results remain
tentative. Screening many pairs creates chance discoveries; prioritize holdings
and representative exposures and seek independent confirmation.

Correlation is descriptive, does not establish causation and does not validate
an executable hedge. A strong price-level relation alone is not diversification
evidence; a fitted spread or hedge needs its own stationarity/out-of-sample checks.

## Anomalies and technical extremes

Check price/return versus recent volatility, gaps, range/ATR expansion, volume
where reliable, divergent performance across normally related assets, correlation
breaks and price-versus-news discrepancies. Exclude stale prints, asynchronous
sessions, splits/dividends, futures rolls, changed methods and data discontinuities
before interpreting an economic anomaly. Keep a data-quality finding separate.

For overbought/oversold, use explicit interval, lookback and source: RSI plus
distance from a suitable mean/Bollinger bands or a standardized extension;
use ATR to make distances comparable. Add volume or session-reset VWAP only
where the feed supports it. `alice analysis quant` is optional; source-native
monitor history can be processed with an inspectable local script. Never route
monitor IDs into a vendor barId API or silently reacquire the same IB history.

The example profile's RSI/standardized-extension thresholds are screening
parameters, not probabilities or automatic buy/sell signals. Report the exact
value, interval and trend context. Strong trends may stay extended; explain
continuation versus reversal scenarios, confirmation and invalidation rather
than predicting reversal from a threshold crossing. A calculation using only
completed bars cannot claim to have detected an unclosed-bar event.

## News as a timeline

Follow monitor-news.md for IBKR news/analyst actions and the alice news reference
for subscribed RSS. Save verified monitor pages before advancing nextCursor;
retain an independent analyzed-page watermark and RSS watermark. Backfilled
old headlines arriving now are historical evidence, not new market events.
Read pending saved pages, not just the latest fetch. Read RSS since its watermark
with a small overlap to handle late ingestion. Use stable item IDs/canonical
links for deduplication and preserve publication time separately from receipt
time. Include scheduled and unscheduled catalysts and material revisions.
Verify consequential headlines with the original publication when possible.
Distinguish a reported cause, a plausible hypothesis and a coincident move.
Do not invent causation, a consensus expectation or a complete news coverage claim.

## Portfolio evaluation

Read actual account/position state through alice-uta; distinguish paper/live and
do not combine accounts without labeling them. Inspect cash, gross/net exposure
where supported, sector/asset/currency concentration, correlated holdings,
derivatives leverage and known expiry/event risks. For options, avoid assigning
underlying notional or delta exposure without contract/multiplier/Greek evidence.
Use consistent currencies/valuation times. Broker account values are separate
from monitor market metrics. Compute performance/drawdown only with adequate
portfolio value/cash-flow history; holdings today are not a historic portfolio.
Unknown goals, benchmark, cost basis, tax constraints or liabilities remain unknown.

Tie market changes back to actual exposures and persisted theses. Explain what
supports or weakens each material thesis, expected catalysts and unresolved risks.
Suggestions to reduce concentration or rebalance remain proposals. This procedure
and its timers authorize research/notifications, not broker mutations or orders.

## Persist evidence and comparisons

Use this layout in the owning desk:

```text
research/market-assistant/profile.json
research/market-assistant/runs/<UTC-stamp>/evidence/*.mcp.json
research/market-assistant/runs/<UTC-stamp>/state.json
research/market-assistant/runs/<UTC-stamp>/report.md
research/market-assistant/latest.json
```

Keep complete monitor MCP envelopes, including original text and SHA-256
metadata; do not hash a reformatted payload. Other evidence records retain
provider, instrument identity, observation time, fetched time, units and quality.
Do not store credentials. Save only the account detail required for the research
in the private desk; reports must not reproduce unnecessary identifiers.

`state.json` records `schemaVersion`, `runId`, `observedAt`, `previousRunId`,
profile/method revision, `marketSessions`, evidence file references, coverage
gaps, three horizon summaries, measured relationships, active findings and a
news watermark. Each finding records stable `key` (kind/instrument/horizon/method),
`kind`, `horizon`, `status` (candidate/confirmed/resolved), `firstSeenAt`,
`lastSeenAt`, supporting evidence, material measurements, confirmation count,
severity, invalidation and last notified status/time. Keep subjective judgments
distinct from measured fields. A new method starts a new comparison baseline.

### Every confirmed signal belongs in memory

For every confirmed finding in intraday or swing, preserve an immutable signal
draft and record it before accepting the new state/report. Notification cooldown
does not suppress memory recording. Candidates, missing quotes and unresolved
coverage gaps cannot become confirmed economic signals. Keep data-quality findings
separate from market reversals and upcoming events separate from released results.
If a finding spans intraday/swing, record one episode per horizon. Use economic
asset IDs and exact related thesis event IDs from context; an empty
relatedThesisIds means no relevant thesis was recorded. Register original source
evidence first and cite its returned memory event IDs.

Read [market-memory.md](market-memory.md#confirmed-signal-publication) for the
draft/helper protocol. Persist confirmedAt, expiresAt, signalId, entryPath and
eventId in the finding's memory fields. confirmedAt is the original documented
confirmation, not this control's lastSeenAt or HTTP response time. expiresAt is
explicit, suitable to the horizon and at most seven days after confirmation.
Intraday episodes normally end within the relevant session/event window, selected
from the session calendar. Swing episodes need an explicit review/expiry.
Repeating a finding retains its immutable draft and event reference; do not
extend expiry or change sourceRunId on every control. A resolution/new confirmation
or changed method is a new episode with a new documented confirmation timestamp.

For legacy confirmed findings, locate the earliest preserved accepted state/report
documenting confirmation and its original evidence. Record historical attribution
with that confirmation and a past expiry when appropriate; never resurrect it as
current. If the original time, asset scope or evidence is unavailable, retain an
explicit memory coverage gap until reconciled. Do not substitute firstSeenAt for
an unknown confirmation time. Expired signals are history, not current alerts.

The helper publishes deterministically; it does not analyze or schedule:

```bash
node .agents/skills/alice-analysis/scripts/market-memory-signal.mjs --draft research/market-assistant/runs/<run>/signals/<episode>.json --record
```

Save eventId only after accepted: true. Retry an identical draft after a crash;
deduplicateSignal preserves the existing event and expiry. Different content under
the same identity is an error. Failed recording stays pending and must be retried
or reported as incomplete memory coverage; never silently advance its receipt.
Commit only this control's drafts, memory events/evidence, state and report.
The derived SQLite index stays excluded.

Write an immutable run directory first. Advance `latest.json` atomically only
to a valid completed run; its pointer contains runId, state/report paths and
observedAt. Use unique run names and serialize state publication with an atomic
exclusive-create lock; if another check owns it, skip/defer rather than clobbering
its baseline. Release only your own lock. After a crash inspect provenance and
process liveness before recovering a lock; never break one on age alone.
Follow the Workspace commit contract for recoverable reports and exact Inbox
revisions. Preserve unrelated edits; do not sweep another Session's work into a commit.

Unavailable fresh data must not reset confirmation counts, clear active economic
findings or advance a successful observation watermark. Record a failed/partial
check separately; emit a data-outage notification once and a recovery notification
when fresh coverage returns. A new response timestamp is not a new market print.

## Briefings and alerts

Lead with as-of/session and what changed, then the cross-market context and
separate intraday, swing and portfolio implications. For each material finding
give evidence, previous/current state, confidence/coverage, relevant exposures,
what to watch and invalidation. Finish with actual sources and important gaps.
Prioritize a few meaningful findings; do not manufacture a trade on every check.

Scheduled checks explicitly publish through `alice inbox push --body-file ...`
after committing the report. Notify for a newly confirmed finding, meaningful
severity/state change, resolution, independently evidenced critical event or a
planned briefing. Repeated unchanged findings are silent; apply the profile's
cooldown to repeated notifications, not to a new critical event or reversal.
Record successful delivery after the tool confirms it; a failed delivery remains
pending. An Inbox outage must not be represented as a successful user notification.

Use self-scheduling for calendar/interval execution with an explicit timezone,
market hours and catch-up policy. A calendar clock alone does not know exchange
holidays; on each run consult the available session/calendar status. An unavailable
calendar is a gap, not permission to infer that stale prices are current. Keep
intraday checks bounded; close/weekend runs update the broader/portfolio picture
without pretending closed markets are trading. The runtime, relevant data source
and Agent login must be available; no running observer exists while Alice is off.
