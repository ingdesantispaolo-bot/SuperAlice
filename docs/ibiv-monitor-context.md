# IbIvMonitor context bridge

## Producer references (reviewed 2026-10-14)

The producer owns both documents under `IbIvMonitor.App/docs/` in its checkout:

- `MCP_GUIDA_ESTERNI.md`: client connection, instrument identities, data semantics,
  the complete tool catalog, limits/errors and the archive roadmap. The current
  guide declares `toolsVersion: 1` and 24 tools.
- `MCP_SUPERAI.md`: SuperAI's integration contract, canonical evidence, bridge
  coexistence and GEX acquisition/price-space rules.

Use these together with live `tools/list` schemas and `alice monitor --help`.
The guide's direct stdio/pipe examples are for external clients; Workspace
agents use the Project-managed `alice monitor` relay. Executable and data paths
remain operator configuration. Producer changes are coordinated in
`IbIvMonitor.App/docs/COORDINAMENTO_CLAUDE_CODEX.md`.

The 14 October archive increment writes `market_data.db` alongside existing
stores; current MCP readers still use the existing archives. Proposed `bars`,
`coverage`, `rolls`, `instruments`, `export`, `acquire`/`acquire_status` and
`--data-mcp` are roadmap capabilities, not part of the reviewed 24-tool contract.
Current offline MCP returns status only; local retained memory/file evidence
remains separately readable. Producer revisions do not yet give `history_daily`
an as-known-at query or expose the requested external-series archive.

## MCP research dialogue

The optional client starts the operator-configured monitor executable with
`--mcp --wait-seconds 2` over the official SDK stdio transport. It inherits the
bridge directory and optional `IBIVMONITOR_CONFIG_DIR`/`IBIVMONITOR_MCP`, without
forwarding unrelated provider keys. The lightweight relay can answer while the
monitor is stopped and reconnects to its same-data-directory pipe on subsequent
calls. Both processes must run as the same Windows user at the same elevation:
the pipe is CurrentUserOnly. Acquisition lifecycle stays with MonitorService.

The reviewed 24-tool catalog appears in ToolCenter as `ibiv_<remote_name>` and
under `alice monitor`. Schemas and descriptions come from tools/list; new or
missing tool names fail contract discovery. Unknown arguments and numeric limits
are validated; the monitor remains the final authority for its schema. Transport
loss never automatically replays an acquisition request. A later call can start
a fresh relay after the relay process exits. Shutdown closes the relay.

Every result, including a remote tool error, retains content[0].text and
_meta["ibivmonitor/sha256"]. Alice verifies SHA-256 over the original UTF-8 text,
checks structuredContent agrees, and preserves the envelope through its MCP,
Workspace CLI and Project CLI surfaces. `--output` stores the entire envelope;
the envelope file hash is different from the canonical payload hash. Protocol
errors have no remote payload proof. Missing/mismatching evidence fails closed.

Use `alice monitor status`, `metric-catalog`, `context`, `instruments-list`,
`instrument-track`, `history-request`, `history-request-status`, `history-daily`
and `history-intraday` for research. When running, the monitor owns IBKR research
data collection; do not use the separate client-22 snapshot collector alongside
it. That legacy script now refuses to open the broker when the configured MCP
reports a running monitor, and refuses on indeterminate configured MCP status.
History requests build daily only; source-native daily/CONTFUT conventions do
not promise the old script's ADJUSTED_LAST or a current execution quote.
The updated guide documents ratio-adjusted CONTFUT history, rebased at each
roll to the current delivery contract. Refresh working copies after a roll
before comparing price levels; preserve the original immutable evidence and
record the new source version separately. Historical adjusted levels are not
the prices paid on those dates. Intraday uses the actual delivery contract.

Producer limits are eight concurrent calls per MCP session, 1 MiB incoming
messages and 8 MiB results. Remote timeouts are normally 60 seconds, 120 for
`data_status`/`correlation_matrix`; Alice's call budgets are 65/125 seconds.
Use bounded ranges: daily at most 10,000 bars; intraday at most 20,000 bars,
31 days at one minute or 120 days at five minutes per call. Tool failures retain
`isError:true` and their hashed error payload; protocol loss `-32003` has no
remote evidence and does not replay acquisition. Read live help for exact flags.

The five news commands are `news-search`, `news-latest`, `news-article`,
`news-stats` and `analyst-actions`. They read the monitor's permanent IBKR archive;
only a missing article may trigger a provider fetch through the monitor. The
alice-analysis monitor-news reference owns coverage, chronology and deduplication.
Its bounded read-monitor-news.mjs utility persists verified full pages before
atomically advancing a per-project/workspace/filter cursor. It has no model
loop. Collection and analyzed-page watermarks remain separate; arrival order
includes historical backfill, so receivedAt never refreshes publication at.
RSS is an independent collected-feed source. Live quotes do not prove live
news entitlements; current observed status overrides older diagnostic notes.

The file monitorContext remains available for immutable hash/as-of evidence;
MCP current context re-evaluates observation quality and links the bridge
snapshot. UTA still owns account reads and orders. The producer references above
own the external MCP contract; SuperAI's memory schema remains independent.

Native acceptance: `scripts/verify-ibiv-mcp.mts`, registered system integration,
uses actual SDK, WPF executable, controller and Project CLI under one OS user,
isolated databases, closed port 1/client 991, no orders or model calls. It checks
all 24 tools, canonical evidence, stopped→running→stopped reconnection, numeric
CLI flags and evidence file delivery. Set `IBIV_MONITOR_PROBE_EXE` to the built
MCP executable. This does not certify live IBKR coverage or research usefulness.

The four GEX commands are `gex-profile`, `gex-monitors`, `gex-monitor-start`
and `gex-monitor-stop`. Start/stop manage research option-chain subscriptions
inside the existing monitor, not OS processes or trading. They respect
`McpAllowDataRequests`, the operator's `McpMaxGexMonitors` limit (default four),
manual priority and the controller's periodic GEX windows. MCP-created rows are
temporary; stop only releases MCP-requested chains and cannot stop user-owned
monitors or the SPX/NDX families. A repeated start is idempotent. Alice never
replays an in-flight start/stop on transport loss. Native acceptance also checks
idempotency, the configured limit, protected family and profile/schema bounds
with TWS unreachable; live Greek coverage remains a separate acceptance.

Acquisition control added 2026-10-13: Alice can supervise the existing IbIvMonitor executable in background with an operator-owned executable path and a bounded file lease. `alice analysis monitor-service-status`, `monitor-service-set` and `monitor-history` expose acquisition status, research-only policy and hash-verified exported daily cache. This adds data collection writes; the original `monitor-context` remains file-only read. UTA authority is unchanged.

The main monitor power switch starts/stops shared SPX/NDX GEX and Global Macro. Manual power takes priority over every Alice policy, including `off`. Power off hands acquisition to a valid Alice controller; without one it stops. The approved research profile sweeps macro on up to three polling lines and samples GEX for 75 seconds every 300 seconds; polling subscriptions are released between windows. Up to eight eligible selected instruments may remain continuous. Daily backfill uses the existing finality/cache/catalogue/pacing journal, at most six requests per cycle on selected macro instruments, initially two years. Empty daily selection means the current macro universe. Broad atlas/minute automatic jobs and watched-pair lines are suspended outside manual mode without deleting saved preferences; separately opened rates/chart views keep their own references.

Research macro computation runs after its initial sweep, then every five minutes; first meaningful publication can therefore take over a minute. Partial GEX discovery is reported by coverage and metric quality, not converted into complete data. During a scheduled sampling pause the acquisition module retains the last observations as degraded with `periodic-collection-paused-original-observation`; their source timestamps and five-minute expiry are preserved. A true stop or expired controller lease invalidates modules.

The controller heartbeat is renewed every 30 seconds and expires after 90. C# polls it every two seconds and refuses invalid modes, parameters or catalogue IDs. Executable/paths stay in operator configuration; agent arguments contain only data policy. A data-directory mutex prevents duplicate monitor/TWS instances. Opening the normal application recalls the shell of a background instance; closing the shell returns collection to Alice when active. The background host exits after controller relinquishment. No model is started by power or research policy.

The environment helper now also enables `SUPERAI_MONITOR_SERVICE_ENABLED=1` and selects the updated G: executable via `SUPERAI_MONITOR_SERVICE_EXE`. Permanent Alice installs can instead use `<OPENALICE_HOME>/data/config/monitor-service.json` with exactly `{ "enabled": true, "executable": "absolute path" }`. Management is otherwise disabled, and a second Alice runtime cannot acquire the controller lock. The requested profile persists in `service-policy.json`; malformed persisted policy keeps collection off.

`monitor-history` lists exports or selects an instrument ID and count, never an arbitrary path. Producer-owned SQLite stays private; immutable byte files under `history/` are SHA-verified. Bars preserve source session time, fetch time, currency, actual daily contract and source-native adjustment. Future history may be CONTFUT; this is not a current-contract execution price. `lineageComplete=false` exposes legacy unknown fetch times. Export time does not certify current coverage or a different adjustment/roll convention.

The concurrently delivered monitor security increment is preserved: SkiaSharp patch updates, CSV bounds, wall CSP and snapshot pruning. `MonitorBridgeRetentionDays` defaults to seven days (zero keeps all) for the minute snapshot/manifests archive; older hash/as-of reads can become unavailable. SQLite and collector-owned evidence copies are independent of this retention.

```powershell
alice analysis monitor-service-status
alice analysis monitor-service-set --mode research --plan '{"refreshSeconds":300,"gexWindowSeconds":75,"backfillDaily":true,"realtimeIds":["ES","NQ"],"dailyIds":["ES","NQ","XLK"]}'
alice analysis monitor-service-set --mode off
alice analysis monitor-history --instrument-id ES --limit 300
```

Owner: research data / `alice analysis`. Related guides: [market data](market-data-architecture.md), [UTA acceptance](uta-live-testing.md), [testing](testing.md).

## Contract and ownership

`alice analysis monitor-context` calls the global `monitorContext` tool. It reads an operator-configured file archive, without IBKR, a model, an order route, staging or allocation changes. UTA retains execution, account state and secrets. The producer owns its SQLite archives and never exports AI prose or credentials.

The producer writes every minute: immutable `snapshots/<sha256>.json`, immutable `manifests/<UTC timestamp>-<sha256>.json`, and atomic `latest.json`. Version 1 has producer identity, publication time, connection health, active modules and numeric metrics. Each metric carries IBKR source, instrument identity, native/reference price space, unit, source observation time, horizon, completed daily session, actual feed mode, algorithm/version/numeric parameters, coverage and quality reason. The original parsed snapshot and SHA-256 are returned as research evidence; the collector additionally preserves the original byte file. Do not reserialize a snapshot and claim the original hash for the new bytes.

Price/model observation timestamps are separate from volume publication and derived-state recomputation. A new heartbeat does not renew them. Unknown observation times are missing, live intraday observations older than five minutes are stale, delayed/frozen/unknown feeds are degraded, and daily values require a completed session. The producer uses its exchange calendar to detect missing daily sessions. A producer heartbeat older than five minutes also makes current daily reads stale. Closed modules are unavailable; a graceful app shutdown publishes all modules inactive. Recovery starts a new producer instance.

`--as-of` selects a publication at or before a timezone-qualified ISO timestamp; `--snapshot-id` pins an immutable manifest and assesses at its original publication. The latter is explicitly historical, never a current execution quote. The selectors are alternatives. Archive schema, hashes, size limits and contained paths are validated; malformed or unreadable archives fail closed without raw exception/secret output.

GEX metrics use the monitor's confirmed level view. A stability-held view is degraded. The SPX multi-chain family is in **ES price space**, and NDX is in **NQ price space**; neither may silently become an index/ETF execution price. GEX remains a model estimate under its call/put positioning assumptions. Macro aggregate provenance uses the oldest required source; incomplete lineage is intentionally unavailable rather than assigned the publication clock.

## Activation

Set the same `SUPERAI_MONITOR_CONTEXT_DIR` environment variable in the processes starting the two applications. Alternatively, IbIvMonitor accepts `MonitorBridgeEnabled`/`MonitorBridgeDirectory` in its existing config; Alice reads `<OPENALICE_HOME>/data/config/monitor-context.json` with exactly `{ "enabled": true, "directory": "absolute archive path" }`. Tool callers cannot supply an arbitrary directory. An environment directory enables the producer; otherwise export is opt-in.

For the current Windows workspace, dot-source `dev/scripts/monitor_bridge_environment.ps1` in each launching shell. The bridge directory is `dev/data/ibiv-bridge`. Restart/use a build containing this increment; an already-loaded old binary does not acquire the feature. Do not run duplicate monitor instances on client ID 67. Publisher leases refuse a second writer to the same archive.

The helper also sets `OPENALICE_BROKER_PACK_PREFER_WORKSPACE=1`, honored only by development/test runtimes. This makes `pnpm dev` load the updated source adapter when an older downloaded IBKR pack exists, without changing activated pack pointers. Production needs a pack built with this increment. Intraday `sourceAt` is the original feed-observation receipt time, not an exchange execution timestamp; daily lineage uses the stored completed bar session.

The current development home's bridge/service settings can be installed by `dev/scripts/configure_monitor_acquisition.py`, which changes only the public monitor bridge fields and the two Alice monitor configuration files. It preserves broker/account/AI settings and never exports or prints the rest of the monitor configuration. Source activation still requires restarting an already-running Alice/monitor build.

The monitor coexistence profile reserves at least 30% for TWS/other clients and 10% safety margin, leaving 60 of 100 lines to the monitor. Set `MarketDataAccountLines` to the actual entitlement; when bridge mode is active and it is unset, the approved default is 100 rather than the higher cap learned from delayed requests. This is a local allocation, not a global TWS capacity measurement. Snapshot requests in UTA share a ten-line budget per TWS endpoint across broker clients and option overlays. Explicit cancellation precedes slot release; queue overflow/timeout is an error. Historical pacing remains separate.

Research snapshot scripts default to client ID 22. Preserve the existing executor ID 21 and monitor ID 67. Other client IDs and orders outside the executor still require operator reconciliation; this bridge does not fix external-order attribution or the pre-existing AI/operator authority findings.

## Workspace use and observation

```powershell
alice analysis monitor-context
alice analysis monitor-context --as-of 2026-10-12T14:00:00Z
alice analysis monitor-context --snapshot-id <64-character-sha256>
```

Redirect the returned JSON into the research workspace to retain evidence, or run `dev/scripts/collect_monitor_context.mts` through the development tsx runner. The file-only collector archives original snapshot bytes, projected context and a numerical briefing template; it makes no model or trading calls. Its `progress.json` keeps incomplete sessions separate. A completed observation session needs at least 350 distinct regular-session minute samples, starting no later than 09:35 and ending no earlier than 15:55 New York time; five such sessions finish collection. Operator review of usefulness remains required.

Disabling the exporter/tool does not alter trading. No future allocation autonomy is granted by this capability. Shared-TWS reconnect/load acceptance and economic utility require real-session evidence, independently of synthetic tests.

Each counted sample needs a usable live intraday source observation from that regular session. Daily-only heartbeat publications cannot complete a paper observation day. Briefings name unavailable modules and partial coverage; repeated hashes/minutes do not increase coverage after resume.
