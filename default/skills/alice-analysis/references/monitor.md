# IbIvMonitor research procedure

Producer references, reviewed 2026-10-14 (`toolsVersion: 1`, 24 tools):
`IbIvMonitor.App/docs/MCP_GUIDA_ESTERNI.md` owns external-client setup, tool/data
semantics, limits and errors; `IbIvMonitor.App/docs/MCP_SUPERAI.md` owns the
SuperAI integration contract, evidence and GEX rules. Resolve them in the
operator's monitor checkout. Use live CLI help for the actual schema.

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
   use `--asset-kind etf` for ETFs. Resolving a delivery future needs its expiry;
   monitor IDs themselves omit expiry, while returned contracts/bars carry it.
   These IDs differ from UTA aliceIds and from vendor barIds; never invent them.
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

CONTFUT is ratio-adjusted to the current delivery contract and rebased at each
roll. The producer documents local archive rebasing from 2026-10-14. Refresh
working copies after a roll before comparing levels or combining new bars with
old ones; preserve immutable old evidence and attach new evidence separately.
Adjusted historical levels are not the original transaction prices. Intraday
bars belong to the actual delivery contract. Inspect fetchedAt/finality; a new
download does not prove that the data was known on its historical session date.

Bound reads with from/to/limit: daily <=10,000 bars; intraday <=20,000 bars,
<=31 days at step 1 or <=120 days at step 5 per call. The producer allows eight
concurrent calls per session, 1 MiB incoming messages and 8 MiB results. Remote
timeouts are normally 60 s, 120 s for data-status/correlation-matrix. Preserve
isError:true failures as failures; inspect their error code and next step.
Protocol error -32003 means the monitor was lost during a call and carries no
canonical payload proof. Check status before any considered acquisition retry.

alerts-recent also reports the 0DTE expected-move decay alert (emdecay:S&P or
emdecay:Nasdaq); retain the reported actual/theoretical move, anchor and ratio.
Treat it as the monitor's deterministic observation with its original timing.

market_data.db migration/double writes do not expose a new MCP archive API yet.
bars, coverage, rolls, instruments, export, acquire/acquire_status and --data-mcp
are planned capabilities. Use current history-daily/history-intraday and report
unavailable coverage. history-daily has no as-known-at selector; a stored revision
does not create one. With the monitor stopped only status answers over MCP;
use preserved local memory/file evidence for offline research.

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
