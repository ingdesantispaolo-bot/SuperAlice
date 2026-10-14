# Global market map: writing the report

The map answers five questions: where are we in the cycle, which markets confirm
or contradict that reading, what is relatively attractive and against what, what
changed since the previous version, and what would invalidate the reading. Write
it in the user's language (Italian). Follow `global-map.md` for the data steps.

## Inputs, in this order

1. The latest map run: `global-map.tables.md` (numbers to quote) and
   `global-map.metrics.json` (statuses, dates, rankings, valuations).
2. The previous accepted map and `get_market_context` for the assets you discuss:
   active theses per horizon, their latest checks, judgments and contrary evidence.
3. What happened since the previous map: monitor news and analyst actions, the
   RSS archive, scheduled releases and central-bank decisions. Separate facts,
   expectations priced by markets and your interpretation.

Numbers come only from the generated files. Quote them; never compute a new
figure by hand. If a number you need is missing, say so and name the gap.

## Output files

- `research/market-assistant/runs/<runId>/global-map.md`: the report of this run,
  never edited afterwards.
- `research/market-assistant/global-map/current.md`: a regenerable view of the
  latest accepted report. If it diverges from the run, the run wins.
- `research/market-assistant/global-map/latest.json`: `{ runId, asOf, reportPath,
  metricsPath, kind: "weekly" | "daily" | "morning" }`, replaced atomically.

## Structure

**First page, "Dove siamo"** (at most about 600 words, read by every agent):

- one line with as-of date, kind of update and coverage (ok/stale/gaps);
- the regime by area (growth, inflation, central banks, financial conditions,
  risk appetite): a map, not a single risk-on/risk-off label;
- a status per block (monetary, FX, government bonds, credit, volatility,
  equities, commodities, crypto) with one sentence each;
- five main conclusions, each with a confidence label (alta / media / bassa);
- what changed since the previous version;
- divergences between markets;
- the next decisive events.

**Then one section per block**, from macro to detail: the generated table, then
two or three sentences that explain the measures. A favourable trend with a high
valuation is said as such; a rising spread or volatility is deterioration.

**Relative attractiveness** inside homogeneous groups only (areas, styles,
sectors, government bonds, credit, FX, commodities). For each asset discussed,
four separate judgments (valuation, fundamentals, technical, risk) and a
confidence; never one universal score across asset classes. Between asset
classes give only conditional preferences ("duration preferable to cash if …").

**Scenarios**: central, favourable, adverse, each with observable conditions,
confirming markets, effects per horizon and what would invalidate it. No
numeric probabilities without a calibrated method.

**Appendix**: sources actually read, gaps, data quality notes, method version.
Caveats belong here, not on the first page.

## Memory

On a scheduled weekly review:

1. Pin the run (`global-map-pin.mjs`) so its raw inputs survive pruning, then
   register its `global-map.metrics.json` as evidence (`alice memory record`,
   kind `evidence`) and use its event id as `metricsEvidenceId`.
2. Record one `judgment` per asset and horizon you assess, with the group id of
   the universe and the observations you cite.
3. Revise theses: new versions name the exact previous event. Every active
   thesis needs at least one machine-checkable `invalidation` condition built
   from `measures.json` keys, or a dated `review` condition.

From a chat session, theses are always `candidate`; activation happens only in
the scheduled review or with the user's approval. A user opinion is recorded as
a candidate thesis with `author.type = "user"`.

## Cadence

| Kind | When | Content |
|---|---|---|
| weekly | Saturday morning, on Friday closes | The full report, judgments and theses revised freely |
| daily | After the US close | Regenerated tables; prose only for sections with new data or crossed thresholds; other sections say "verificato, invariato" |
| morning | 08:40 Europe/Rome on weekdays | Asian close, overnight news, today's events, what to watch, in a few lines |

Intraday checks read the first page; they never rewrite structural sections. A
missed weekly review shows its delay; the next run recovers it once, without a
burst of late briefings. This procedure authorizes research and notifications,
never orders.
