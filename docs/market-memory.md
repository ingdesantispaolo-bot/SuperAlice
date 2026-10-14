# Workspace market memory and offline context

This guide owns scoped alice memory CLI/MCP, immutable catalog identities,
exact-byte evidence capture, temporal events and bounded get_market_context.
Acquisition/export stays with [[docs/ibiv-monitor-context.md]]. Native CLIs
own reasoning; the module calls no monitor, broker, provider or model.

src/domain/analysis/market-memory.ts uses files under the owning Workspace's
research/market-memory/v1. A future database is only a rebuildable index.
src/tool/market-memory.ts binds writes to the current Workspace and resolves
read-only owner selection within the same Project registry. No arbitrary roots
or Project-scope memory tools. JSON text supports CLI file-backed entry flags.
The injected alice-analysis market-memory reference owns the entry shapes.

Observed period, optional source publication, acquisition and host recording
are distinct. knownAsOf filters recorded events; imports never backdate knowledge.
Full source-vintage coverage is not attested. Before first recording the packet
says insufficient-history, not absence of economic events. Old report attribution
is retained without certifying everything the original analyst knew.

Evidence hashes/exact bytes and MCP canonical/structured agreement are verified.
Corrections/reconciliations append events. Thesis versions name their current
prior event and preserve entity/horizon. Supporting/contrary observations remain
pinned, even older versions; superseded/expired/non-final evidence is labeled
unusable for a fresh evaluation. BTP fitted tenor/benchmark equivalence is never
inferred from a shared name. Attribution does not independently ground a number.

The writer owns namespace .gitattributes with events/** and evidence/** -text.
Git must preserve the exact hashed bytes, including CRLF originals. Unexpected
archive attributes reject writes rather than silently changing a user's rules.
The registered integration suite verifies a real Git restore with autocrlf on.
Unknown expiry is unknown freshness, not unlimited validity for re-evaluation.

Local reads survive source/monitor shutdown. Context does not itself evaluate
a thesis or attest current source availability. Budgets do not silently remove
mandatory evidence; overflow and corruption fail explicitly. Workspace and
source coverage remain distinct, and no credentials belong in the memory.

Verification: market-memory.spec.ts tests temporal/horizon coexistence, imports,
offline copies, reconciliation, BTP identity, corruption/locks and budgets.
Registered market-memory-cli uses production HTTP/CLI/file modules and isolated
state; no monitor, broker, model or production-source readiness claim. It verifies
default scope, same-Project read-only owner and no Project memory commands.
