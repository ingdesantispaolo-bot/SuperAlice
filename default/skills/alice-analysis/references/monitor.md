# IbIvMonitor research procedure

Workspace shells expose `alice monitor`; use its live help for flags. The MCP
relay runs under the same Windows user and data configuration as the monitor.
It reconnects when the monitor starts. It never reads accounts or places orders.

1. Run `alice monitor status`. If unavailable, report it; file evidence may still
   be readable with `alice analysis monitor-context`. Do not call archived data live.
2. Read `alice monitor metric-catalog` before interpreting unfamiliar units,
   sign conventions, price spaces, algorithms or correlation windows.
3. For current macro/GEX use `alice monitor context`; for an exact archived
   publication use `alice analysis monitor-context --as-of <ISO-with-offset>` or
   `--snapshot-id <SHA-256>`. MCP freshness is evaluated now; archive hash reads
   are historical. SPX multi-chain levels use ES prices, NDX levels NQ prices.
4. For a research universe, use `alice monitor instruments-list` and copy exact
   monitor IDs. If needed use `instrument-track` with broker contract fields;
   use `--asset-kind etf` for ETFs. Futures need an explicit expiry. These IDs
   differ from UTA aliceIds and from vendor barIds.
5. When the monitor is running, request missing daily history with
   `history-request`, retain its job ID, then inspect `history-request-status`.
   Reuse its cache, pacing and incremental acquisition. Do not run the separate
   client-22 history script alongside it. Acquisition changes the data catalogue
   and queues broker reads; it does not authorize trading.
6. Read `history-daily` or `history-intraday`; inspect coverage, contract,
   currency, bar dates, fetchedAt and finality. A queued job is not a finished
   dataset; partial, retry-later and maintained-by-macro need actual bar checks.
   Daily futures can use CONTFUT while intraday uses a current delivery contract.
   Source-native history does not promise adjusted total returns. history_request
   builds daily history only; it cannot backfill arbitrary intraday requests.
7. Use `data-status`, `correlation-matrix`, `relation-pair`, `alerts-recent` and
   `market-state-history` when relevant. Get available variants/windows from the
   catalog and report those used. A correlation is not an executable hedge.

For GEX detail, list `alice monitor gex-monitors`, then read `gex-profile
--underlying SPX` (ES price space), NDX (NQ) or a monitored single chain (its
underlying's price space). Use live help for source, expiry, range-pct, max-bars,
top-n, layout and include-curve. Preserve aligned strike vectors, units,
algorithm, coverage and sourceAt; GEX estimates dealer positioning from model
assumptions. A stopped profile is degraded and an uncomputed profile is
insufficient_data, even if generatedAt is current.

For a needed research chain, `gex-monitor-start --symbol AAPL --sec-type STK`
requests acquisition inside the existing monitor (STK/IND/FUT, USD). Start is
idempotent and follows operator/manual priority, the research GEX windows and
McpAllowDataRequests; the operator cap defaults to four concurrent MCP chains.
It creates no broker client, OS process, account access or order. Inspect the
returned state: waiting-acquisition/scheduled does not prove a usable profile.
Release your request with `gex-monitor-stop --symbol AAPL`; user-owned monitors
and SPX/NDX families are protected. Temporary MCP rows disappear on restart.
After a transport error inspect gex-monitors before deciding whether to retry;
the client never automatically replays an acquisition request.

Examples (arrays accept repeated flags; discover exact schemas with --help):

```bash
alice monitor instrument-track --symbol ASML --sec-type STK --exchange SMART --currency USD
alice monitor history-request --ids 'STK:ASML:SMART:USD::' --years 5
alice monitor history-request-status --job-id '<returned-job-id>'
alice monitor history-daily --id 'STK:ASML:SMART:USD::' --from 2021-10-13T00:00:00Z --output asml-history.mcp.json
```

MCP reads return a JSON envelope with content[0].text, structuredContent and
_meta["ibivmonitor/sha256"]. Preserve the complete envelope via --output for
durable research. Hash the original UTF-8 text, not a parsed/reformatted JSON
object or the envelope file. The client verifies the hash before delivery.
generatedAt is response time; sourceAt is the observation time. Only usable
metrics are current evidence. Explain stale/degraded/missing metrics and gaps;
do not let a fresh response timestamp refresh old observations.

Use alice-uta for account state and executable quotes. If another research
provider is needed because monitor coverage is absent, name it and keep its
adjustment, contract and dates separate. Never silently create a second IBKR
research collector as a fallback.
