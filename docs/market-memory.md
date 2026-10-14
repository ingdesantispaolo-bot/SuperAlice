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

## Schema v2 writes and legacy replay

New events use schemaVersion 2. The existing research/market-memory/v1 path is
the archive namespace, not a claim that every event uses schema 1. Readers
accept both versions and verify the original byte hashes and chain; there is
no rewrite, invented author or backdated origin for legacy events.
market-memory-schema.ts owns the wire shapes; market-memory-validation.ts
owns the additional reference, clock and activation rules.

An asset catalog entry uses entityId, label, assetClass and role: asset. It has
no source, sourceSeriesId, method or parent assetId. New numeric series retain
their source/method/unit fields and require assetId referring to a registered
economic asset of the same assetClass. Legacy series remain unchanged. Numeric
observations cite series; an asset thesis may cite observations from its series.

Every thesis, signal, judgment and lesson requires author
{type: superai|user|monitor-analyst, agent?: string}. The host supplies event
origin {kind: session|issue|user-surface, workspaceId, resumeId?, issueId?}.
Entry JSON cannot provide origin. For an Issue, the tool verifies the running
registry task, its exact origin and the same Workspace's trigger. Review
authority also requires a live Issue with a schedule, read through the board.
A missing, completed, mismatched or unscheduled run cannot grant review authority.

Thesis conditions refer to economic assets and the current Workspace's
research/market-assistant/global-map/measures.json (superai.measures/1).
The registry accepts producer runId/asOf metadata and monthly measures (1M),
which cannot be used in the 1D/1W/1H conditions. The source-series link must
resolve in the catalog, and completedBarsOnly must be true. Measure units come
from the registry, independently of the base series price unit: RSI uses score,
returns use percent. Cited observations may use those registered derived units;
unregistered unit changes are rejected. Relative thresholds validate both
measures and require matching units. Retrieval never reads this
live registry or re-evaluates historical conditions. A changed registry affects
new writes, not old event hashes or historical query results.

An active thesis requires activationBasis and an invalidation condition or a
review condition with expiresAt. A chat cannot activate, even with an approval.
A scheduled-review basis must name the host's scheduled Issue; author: user
always requires a user-approval basis. User approval must target the exact
current candidate, and the activating revision must preserve its content.
The newest decision for that candidate wins; rejection revokes earlier consent.
Approval records consent; the scheduled review writes the activating revision.

check records one runId/evaluatedAt/metricsEvidenceId event for a control,
with unique thesisEventId/conditionId results. Unknown references, future
clocks, repeated runIds and unexplained not-evaluable results fail explicitly.
The 256 KB event/JSON budget supports up to 500 results in one nightly event;
larger payloads fail explicitly. Event-count and total scan limits stay unchanged.
signal requires confirmation and expiry at most seven days apart, cited
observations or evidence, and related thesis event IDs; signalId is immutable
and cannot be recorded twice. judgment cites a metrics evidence event and
relevant observations; its reviewRunId/assetId/horizon combination is unique.

lesson requires at least three distinct supporting event IDs, distinct counter
examples and versioned previousEventId. Approved/retired revisions require the
latest user approval of the exact preceding proposed/approved version, preserving
statement, scope and supporting/counter examples. A changed rule is proposed
again. Evidence referenced by new checks, signals and judgments is hash-verified
before the event is committed.

## Context v2 selection

The reader returns superai.market-context/2. Requesting an economic asset
includes its registered series; requesting a series also resolves its economic
asset and sibling series. Legacy identities with no asset link remain distinct.
Theses include author/origin and latestCheck for their exact event version,
selected by evaluatedAt then recording sequence within knownAsOf. A new version
does not inherit a prior version's checks. The derivedState uses recorded results:
invalidation met wins; otherwise missing/not-evaluable conditions produce
non-valutabile, then target met gives obiettivo-raggiunto, trigger met attivata,
and all conditions not-met integra. No conditions/check means non-valutabile.
This never changes thesis.status or grants activation authority. No live measure
registry, condition calculation, monitor, source or model participates.

Signals are ordered by confirmation time/sequence and excluded at expiresAt;
includeExpired opts into expired entries, labeled expiredAtQuery. Historical
queries apply expiry at their knowledge date. Only the latest approved lesson
version is eligible. Restricted asset scopes must intersect resolved assets;
setupType/regime scopes require the same supplied query value. An omitted
selector does not imply a match. Global scopes match every requested asset.

judgments contains the latest asset/horizon entries. judgmentGroups contains
the latest reviewRunId batch for each relevant group/horizon, with its recorded
member judgments and their authors. It does not invent an aggregate judgment
or attest that the group batch covered every intended member. Supporting and
counter-example references are recursively retained in observations/evidence
and referencedEvents, including outside the ordinary window/observation limit.
Selected evidence bytes are hash-verified, including check-only metric inputs.
Interpretation/group result overflow and output overflow fail explicitly;
ordinary observation truncation remains labeled in coverage.

The 10,000-event cap remains; indexing and incremental verification are X4.

## User approval surface and isolation limit

From the user's terminal, outside an Agent Session:

```bash
openalice exec --project <project-key> alice memory approve --workspace-id <desk-id> --target-event-id <candidate-event-hash> --decision approve --note "Reviewed this candidate"
```

Use decision reject to reject/revoke consent. The command records an immutable
approval; it does not place orders, automatically activate a thesis or retire a
lesson. The returned eventId is the activationBasis.approvalEventId for the
scheduled review. Only current candidate theses and proposed/approved lessons
are eligible. A superseded interpretation cannot be approved.

The shim uses a dedicated /cli/:wsId/memory/approval route with server-resolved
Workspace and user-surface origin. It is absent from all MCP tools, tool-center
registrations and CLI tool manifests. market_memory_record rejects approval
JSON. The user command and route reject Agent Session/run env/header carriers;
the request cannot declare origin or a different write root. The explicit
Project command resolves its local endpoint and the route checks its identity.

These are behavior and workflow rules, not an OS security boundary. Agents and
the user currently run with the same Windows user. An agent could clear its
environment, send a bare local request, or edit files with that user's rights.
Agents must never invoke the user approval surface or manufacture consent.
Stronger enforcement requires a separately authenticated user surface or
process/filesystem isolation, outside this increment.
