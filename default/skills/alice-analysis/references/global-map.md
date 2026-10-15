# Global market map: collection and measures

The global market map is the stable "where are we" reference for SuperAI. This
reference covers its data steps: collecting the 50-asset universe and computing
repeatable measures. Report writing, judgments and theses build on these files;
numbers in any report come from them, never typed by hand.

## Universe

`references/global-map-universe.json` is the default universe (schema
`superai.global-map.universe/2`): 50 assets in ten groups. A desk copy at
`research/market-assistant/global-map/universe.json` takes precedence when
present; the user reviews and edits that copy. Asset ids (`asset.*`) are economic
identities; series ids (`series.*`) name one source for one asset.

Each asset has:

- `primary`: the instrument the map follows, an IBKR future, else an ETF (or
  IDEALPRO FX, Paxos crypto), kept by IbIvMonitor (`source: "monitor"`, real time).
  46 of 50 assets have one; SOFR, euro HY and EM corporate spreads and MOVE stay
  end-of-day until an accessible instrument exists.
- `history`: an older series of the same exposure (Yahoo, official sources), used
  only before the primary starts.
- `extras`: official levels shown as prefixed measures of their own series:
  `yld_` government yields, `oas_` credit spreads, `fix_` published fixings,
  `idx_` spot volatility indices.

## Step 1: collect (network, no calculation)

Run inside the owning desk shell:

```bash
node .agents/skills/alice-analysis/scripts/global-map-collect.mjs [--start YYYY-MM-DD] [--run-id <id>]
```

It reads settled IBKR daily bars of every primary from IbIvMonitor (`alice monitor`),
then a live quote of each real-time primary through UTA (read-only; conIds from the
monitor catalogue or its read-only `instrument-resolve`; a continuous future with no
current contract quotes the most traded of the next months). It also reads Yahoo,
FRED/TraderHub, Bundesbank, Japan MOF, STOXX and issuer pages for history, levels
and valuations. The default window is six years. It creates
`research/market-assistant/runs/<runId>/` exclusively with a copy of the universe
and `global-map.manifest.json` (the quotes are one more payload, `uta:quotes`).

Original payloads go to `research/market-assistant/global-map/cache/payloads/<sha256>.txt.gz`
(gzip; the hash is of the uncompressed payload), a temporary cache excluded from
Workspace Git. Identical payloads are stored once. Only the payloads of the five
latest runs and of pinned runs are kept; other runs keep their metrics but can no
longer be recalculated. Pin every run whose metrics support a report, judgment or
thesis:

```bash
node .agents/skills/alice-analysis/scripts/global-map-pin.mjs --run-id <id> --reason "weekly review"
```

The cache disappears when IbIvMonitor persists external series
(SUPERAI-EXTERNAL-SERIES-01); IbIvMonitor owns long-term persistence. Exit code 2
means some payloads failed: the run is still valid and the failures are listed; do
not retry in a loop. It never opens its own IBKR connection and never starts
monitor history jobs.

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

- Returns use calendar windows (7 days, 1/3/12 months, year to date) on settled
  IBKR daily bars of the primary. Their basis differs by instrument and is stated:
  a continuous future (ratio-adjusted at each roll) earns the return in excess of
  cash, so it includes carry (interest minus dividends for equity indices, roll
  yield for commodities): the S&P 500 future trails the index by roughly the US
  rate minus the dividend yield, and a backwardated Brent future outruns the front
  month. ETFs and FX are price returns without distributions. Compare within a
  group, where the basis is shared.
- History before the primary starts is joined only after a check: at least 100
  common sessions and weekly-return correlation of at least 0.97, then ratio-scaled
  at the first common session (`splice` in the metrics, "storico raccordato fino
  al …" in the table). History uses unadjusted closes, the same basis as IBKR bars.
  While a new primary is still being collected, the row reads the declared history
  and says so (`historyOnly`); its live quote is shown without a change figure.
- `live`: the IBKR quote at collection time (last trade, else bid/ask mid), with
  its timestamp and `live`/`delayed` type, compared with the last settlement only
  when it is newer. Live values are never measures: conditions and judgments use
  settled bars.
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
- Bond futures are prices: their `ret_*` move against yields. The yield level and
  its changes come from the official series (`yld_*`); Bundesbank yields come from
  the Federal securities term structure, not the on-the-run Bund, and the Italian
  yield level is monthly (the BTP future itself is daily and live). STIR futures
  (EUR STR) are shown as implied rates (100 − price).

## Valuations

`valuations` in the universe maps equity assets to the issuer page of a reference
fund: iShares for areas, styles and small caps (P/E on trailing earnings, P/B),
SPDR for US sectors and the S&P 500 (P/E on next fiscal year earnings, P/B).
They are free, updated daily or weekly by the issuer, and computed with each
issuer's own method: compare like with like (an iShares trailing P/E with
another iShares trailing P/E). The reference fund is not always the price
index of the row (Japan: Nikkei price, MSCI Japan valuation via EWJ); the
table names the fund. The collector keeps the page hash and the verbatim
value fragments, not the 2 MB page. Values older than 10 days are `stale`.
Only current values exist so far: comparisons with each market's own
valuation history need the monitor to persist these series over time.

For the report itself (structure, judgments, theses, cadence) read `global-map-report.md`.

Measures are descriptive. An RSI extreme, a ranking or a trend state is not a
buy/sell signal, and this procedure authorizes research only, never orders.

## Step 3: register the map in market memory (once per universe revision)

```bash
node .agents/skills/alice-analysis/scripts/global-map-register.mjs --dry-run
node .agents/skills/alice-analysis/scripts/global-map-register.mjs
```

It derives catalog events from the universe (economic assets first, then their
series with source, unit, method and yield type) and records only the missing
ids through `alice memory`. Catalog identities are immutable: a changed source
or method needs a new series id in the universe, never a rewrite.

## Step 4: nightly thesis check

```bash
node .agents/skills/alice-analysis/scripts/global-map-check.mjs --run-id <id> [--dry-run]
```

Run after `global-map-calc.mjs` on the evening (after US close) run. It reads every
active thesis with conditions through `get_market_context`, evaluates each
condition on the run's verified payloads and records one `check` event (at most
500 results). A condition with `consecutive: N` must hold on each of the asset's
last N sessions; earlier sessions are recomputed as known at their own date, so
the result does not depend on previous checks. Only `1D` conditions are computed;
others, missing measures, inactive or expired conditions are `not-evaluable` with
a reason. Valuation measures exist only at the issuer's publication date.

The script pins the run, registers its metrics once as evidence (the id is kept
in `global-map.evidence.json` of the run) and sends an Inbox note only for
invalidations newly met on that thesis version. A failed delivery is reported,
never counted as sent (exit code 3). The check never changes a thesis status:
the scheduled review or the user decides.
