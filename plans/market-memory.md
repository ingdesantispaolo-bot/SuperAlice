# Market memory and offline context

Status: first local increment delivered 2026-10-14; producer contract follow-up in progress.
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
no upstream publishing or source-repository commits in this local iteration.
