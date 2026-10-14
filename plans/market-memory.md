# Market memory and offline context

Status: first local increment and X1/X2 delivered 2026-10-14; context v2, indexing and producer follow-up remain in progress.
Related coordination: SUPERAI-MEMORY-READONLY-01 in the monitor owner's shared
coordination document. No C# source or acquisition changes in this increment.
Owner guides: docs/market-data-architecture.md, docs/workspace-agent-guidance.md,
docs/alice-harness.md, docs/conversation-provenance.md, docs/testing.md.
User design: ../../SuperAI-Memoria-Mercati-Progetto-2026-10-14.md.

Scope: workspace-owned instrument/series catalog, immutable evidence capture,
append-only observation/thesis/reconciliation events, first get_market_context
through scoped CLI/MCP; offline from cached evidence, no model or broker loop.

Decisions: do not backdate knowledge coverage on historical imports; distinguish
observed, published, acquired and recorded clocks. Preserve original report
bytes. Keep fitted BTP yield series distinct from benchmark-tenor yields.
File-backed authority and reconstructible indexes; one IBKR collection owner.

Checklist:
- [x] Inspect source persistence/version semantics and document its limits.
- [x] Add the owner coordination request, separating read-only exposure,
  source extensions and producer code/contract changes.
- [x] Implement bounded scoped catalog/evidence/event/thesis/context APIs.
- [x] Verify cross-horizon coexistence, knowledge cutoffs, offline reads,
  immutable reconciliations, BTP identity and real CLI boundary.
- [x] Align local runtime source and managed Skill guidance; exercise real
  preserved artifacts without changing their bytes or historical attribution.

Local acceptance: 13 domain tests, 15 command-map checks, two registered real
CLI/filesystem/Git integration tests. Source app/test typechecks; actual private
baseline imported with seven catalog entries (two unresolved BTP plans), five
observations, three imported candidate interpretations, six exact-byte evidence
copies and 21 events. knowledge before import is explicitly insufficient-history.
Git restore with autocrlf on preserves all 27 hashed event/evidence files and
replays the same context. Old report/state hashes unchanged; private commit
2ea180e0e9fd6a1777a5aaa87ee3c35ee9c000f2. Bundle 1.0.8 adopted in three desks.
Receipts: ../../dev/evidence/market-memory (local-only metadata).
- [ ] Integrate producer replies/vintage evidence and scaled indexing after
  the first local acceptance; keep wider multi-resolution work separate.

Completion: local consumer acceptance plus the producer contract reconciliation
needed for source-backed histories. A local pilot alone does not complete the
whole memory/market-data initiative. Preserve existing dirty/local initiatives;
Source increments are now saved on superai/hardening as explicitly requested
on 2026-10-14. No upstream publishing is authorized.

## Coordinated 2026-10-14 plan

Canonical user plan in the surrounding SuperAi workspace:
SuperAI-Mappa-Memoria-Piano-di-Lavoro-2026-10-14.md. Append-only coordination:
dev/coordinamento-superai.md in that workspace. Codex owns X0-X7; Claude owns
the map, outcomes and setup scanner.
Shared-file changes and contract clarifications are announced there first.

- X0 source preservation: fifteen coherent commits through 6da30896 save the
  hardening WIP and real additional changes from openalice, ignoring CRLF-only
  differences and retaining the hardening trading-permission correction.
  Root/test/UTA/UI typechecks and relevant memory/monitor/budget/badge tests pass.
  The complete hermetic audit had 7,751 passes, 38 failures, 157 skips; its
  memory-suite inventory regression was fixed. Targeted failure recheck has
  427 passes, 24 failures, 7 skips, outside memory (Windows symlink privileges,
  paths/pnpm behavior, unrelated UI/update assertions and timeouts). This is
  not a claim of a wholly green repository backstop; receipts remain local.
- [x] X1: mixed immutable v1/v2 replay, economic assets/series, required authors,
  host origin, registered closed-bar conditions, controlled activation,
  approvals, checks, signals, judgments and lessons. Chat cannot activate;
  user theses and approved/retired lessons require exact current user consent.
  Approval preserves candidate content and cannot be reused after rejection
  or a new interpretation version. Thesis author type cannot be changed to
  bypass consent. C2 metadata, monthly registry coverage and derived units are
  accepted without treating monthly values as daily conditions.
- [x] X2: user terminal command and dedicated approval route, excluded from
  agent tool catalogs and record JSON; Agent identity env/headers are refused.
  Document the shared-Windows-user behavior boundary without claiming isolation.
- [x] X3: context v2 with exact-version latest recorded check/derived state,
  expiring signals, scoped latest approved lessons and latest asset/horizon and
  group review member judgments. Recursive support/counter-example evidence is
  retained/verified; result/output overflow fails explicitly. Source verification:
  38 memory/domain/tool tests, three CLI/HTTP/Git tests, app/test typechecks. Receipts: ../../dev/evidence/market-memory/x3-context.json and x3-cli.json.
- [x] X4: derived SQLite index, incremental checkpoints/anchor and ordered
  filename inventory; full audit/rebuild and same-machine dead-PID recovery.
  50,000-event context proof: 272/292/295 ms; rebuild about 29 s. Earlier
  1.2-2.2 s failures are retained in local receipts; selective observation
  projection/reference closure resolved them. Cap is now 100,000 events/512 MB.
  Five index assertions pass, including corruption and reconstruction equality;
  context/CLI regressions and app/test typechecks accompany the commit.
- [ ] X5 real-control acceptance: source publication/idempotency is implemented
  and verified (41 domain/tool assertions, three real CLI/HTTP/Git tests including
  two identical helper publications). Stable episode identities preserve original
  confirmation/expiry/source references. Candidates are refused. Real native
  scheduled-control recording and legacy confirmation reconciliation remain.
- [ ] X6 managed rollout: source bundle 1.0.10 and Chat 1.8.14 require context
  before interpretation, candidate chat theses and explicit user attribution.
  Ten existing harness/template assertions and app/test typechecks pass. Three
  desk adoption and three Issue What updates are prepared; schedules/owner stay.
- [ ] X7 producer dependency: SUPERAI-EXTERNAL-SERIES-01 was forwarded verbatim
  to the monitor coordination file on G:, extending SUPERAI-MEMORY-READONLY-01.
  The owner has a historical archive study, but the requested external-series
  and monitor-analyst read-only contracts are not yet delivered. No direct DB
  access or C# change is performed. Receipt external-series-forwarded.json.

X1/X2 verification: 32 domain/tool assertions including one 500-result nightly
check; 97 targeted CLI/export/catalog assertions before the final C2 additions;
three real CLI/HTTP/Git memory tests; ten existing CLI-shim tests; app and
registered-suite typechecks. critical-local passes outside the Windows sandbox
(19 assertions and all 15 required evidence items), after sandbox process
termination/cleanup failures. The existing private 27-file archive restores
with identical bytes/context using the mixed reader and no monitor access.
Direct synthetic compatibility with Claude's C2 measureCatalog passes.

Every check stays one event (up to 500 results and 256 KB); larger payloads fail
explicitly. X4 subsequently replaces full scans with the derived index and raises the cap
to 100,000 events/512 MB only after the load proof. Derived C2 source
expressions need stable catalog series identifiers before being referenced by
conditions; ordinary measures are not blocked by unused unresolved definitions.
No Claude-owned sources or C# code were changed. No production approvals, thesis
activations, orders, schedule changes, managed-desk rollout or public push were
performed by these acceptance tests.
