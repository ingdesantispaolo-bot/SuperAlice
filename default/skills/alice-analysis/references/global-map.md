# Global market map: collection and measures

The global market map is the stable "where are we" reference for SuperAI. This
reference covers its data steps: collecting the 50-asset universe and computing
repeatable measures. Report writing, judgments and theses build on these files;
numbers in any report come from them, never typed by hand.

## Universe

`references/global-map-universe.json` is the default universe (schema
`superai.global-map.universe/1`): 50 assets in ten groups, auxiliary FX for EUR
conversion, a small macro register and derived spreads/ratios. A desk copy at
`research/market-assistant/global-map/universe.json` takes precedence when
present; the user reviews and edits that copy. Asset ids (`asset.*`) are economic
identities; series ids (`series.*`) name one source for one asset. Known gaps are
explicit (`source: "none"`) and stay visible in the map.

## Step 1: collect (network, no calculation)

Run inside the owning desk shell:

```bash
node .agents/skills/alice-analysis/scripts/global-map-collect.mjs [--start 2004-01-01] [--run-id <id>]
```

It reads Yahoo bars and FRED/TraderHub data through this Workspace's own CLI
gateway, and Bundesbank, Japan MOF and STOXX files from their official URLs. It
creates `research/market-assistant/runs/<runId>/` exclusively and saves every
original payload under `evidence/` with its SHA-256, a copy of the universe, and
`global-map.manifest.json`. Exit code 2 means some payloads failed: the run is
still valid and the failures are listed; do not retry in a loop. It never opens
an IBKR connection and never starts monitor history jobs.

## Step 2: calculate (offline, deterministic)

```bash
node .agents/skills/alice-analysis/scripts/global-map-calc.mjs --run-id <id> --as-of YYYY-MM-DD [--publish-measures]
```

`--as-of` is the inclusive cutoff: the last completed session the map
describes (Friday for the Saturday review; the current day only after the US
close). For 24/7 markets the collection day (UTC) is excluded as still forming.
The script verifies every payload hash, then writes, without overwriting:

- `global-map.metrics.json`: per-asset status, last observation date, staleness
  and measures; derived spreads/ratios; macro register; group rankings.
- `global-map.measures.json`: the measure catalog (`superai.measures/1`).
  `--publish-measures` also replaces `research/market-assistant/global-map/measures.json`,
  which memory uses to validate thesis conditions.
- `global-map.tables.md`: the generated tables for the report.

The same run and cutoff always produce byte-identical files. To change a method,
the library's `METHOD_VERSION` changes and comparisons restart from a new baseline.

## Reading the measures

- Returns use calendar windows (7 days, 1/3/12 months, year to date) on Yahoo
  adjusted closes, so ETF returns include dividends; indices are price only.
- `_eur` returns convert through EUR/USD and USD crosses at the same dates;
  EUR assets repeat the local return so groups compare in one currency.
- Trend states are +1 up, -1 down, 0 mixed: short = 20-observation mean and
  1-month change; medium = 50 and 3 months; long = 200 and 12 months.
- Yields and rates are in %, their changes in basis points; credit spreads in
  basis points; volatility indices in points. A rising spread or volatility is
  deterioration, not a favourable trend.
- `level_pctile_5y` uses at most five years; `history_years` tells how much
  history exists (ICE BofA spreads on FRED have about three years).
- `status`: `ok`, `stale` (older than the source's normal lag), `missing`
  (collection or parsing failed) or `gap` (no source). A stale or missing value
  is never presented as current, and a gap is never filled with an estimate.
- Front-month futures (gold, Brent, gas, copper) include roll effects; Brent is
  the future, not Dated Brent spot. Bundesbank yields come from the Federal
  securities term structure, not the on-the-run Bund. Italy 10Y is monthly only.

Measures are descriptive. An RSI extreme, a ranking or a trend state is not a
buy/sell signal, and this procedure authorizes research only, never orders.
