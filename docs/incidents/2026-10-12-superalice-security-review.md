# SuperAlice security review — 2026-10-12

This is a dated review of the SuperAlice fork, not an owner guide or a release
certification. It records the dependency update, runtime recheck, and remaining
security boundaries. Current contracts remain in the
[remote access](../remote-access.md),
[model/runtime injection](../model-semantics-and-runtime-injection.md),
[data locations](../data-locations.md), and
[UTA testing](../uta-live-testing.md) guides.

Reviewed source: `6e154e97bc39ea948986703bf03173539549d1e9`, branch
`superai/phase2`, clean checkout. Runtime recheck: 2026-10-12, approximately
17:00–17:14 Europe/Rome. Runtime probes used GET and OPTIONS only. Trading tests
used isolated fixtures and mock brokers; no real orders were submitted or
cancelled during the review.

## Dependency findings and their origin

The initial npm audit on `d663e4bb` reported 122 occurrences: 3 critical,
60 high, 51 moderate, and 8 low, across 29 package families. These counts include
transitive packages, development/build tools, and repeated affected versions;
they are not 122 demonstrated application exploits.

The lockfile and all workspace package manifests were unchanged between the
OpenAlice baseline `87bc415260aaac92a072d89a1c6440268a3efdf1` (v0.95.0-beta) and
the initial audited fork. The affected dependency versions therefore came from
that baseline, rather than new packages introduced by the fork. This comparison
does not assess the current upstream repository or establish when upstream
maintainers learned of each advisory.

Commit `6e154e97` updates the affected dependency families, removes unused shadcn
CLI dependencies while retaining its licensed CSS, and preserves the distinct
Undici APIs required by Slack and Discord. It also adds Alpaca codec coverage
and fixes the review panel's display when unresolved broker outcomes exist.

Fresh `pnpm audit --json` with pnpm 11.7.0 returned exit 0 and **zero known
vulnerabilities in every severity**, with 922 total dependencies reported by
npm. `pnpm peers check` reported no peer dependency issues. No advisory ignore
rules or severity exclusions were added.

## Browser and local HTTP boundaries

Commit `8e472f87` introduced Host/Origin guards for local tool surfaces and UTA,
and validated Host before the backend's localhost authentication bypass.
The recheck confirmed these behaviors on the running services:

| Surface | Normal local GET | Foreign Origin | Foreign Host | Null Origin | Foreign preflight |
|---|---:|---:|---:|---:|---:|
| Relay, trading status | 200 | 403 | 403 | 403 | 403 |
| Backend, trading status | 200 | 401 | 401 | 401 | 204 |
| CLI, nonexistent Workspace manifest | 404 | 403 | 403 | 403 | 403 |
| UTA health | 200 | 403 | 403 | 403 | 403 |

The CLI's local 404 is expected for the deliberately nonexistent Workspace.
Its 403 responses show that guards run before Workspace resolution. Backend
preflight remains permitted by CORS; protected reads with a foreign Origin or
Host require authentication. Guard tests also reject non-JSON mutation bodies.

Trusted local UI origins and native callers remain accepted. These browser
guards do not authenticate individual local processes. Backend and UTA had
started after the dependency commit, and their guard behavior was checked
directly. The review did not introspect every package version resident in each
process; the audit describes the current dependency graph.

## Remaining application findings

**AI credential exposure:** the configured AI vault contained one nonempty,
unmasked key in plaintext JSON. A loopback GET to `/api/config/credentials`
returned that key without a session cookie, through the localhost bypass.
Only presence/count metadata was recorded; key values were not printed,
persisted in review artifacts, or tested against a provider. The broker account
configuration was sealed, but that encryption does not cover the AI vault.
Relevant source: [credential persistence](../../src/core/config.ts),
[credential route](../../src/webui/routes/config.ts), and
[authentication middleware](../../src/webui/middleware/auth.ts).

**AI versus operator authority:** the inspected profile had `allowAiTrading`
disabled. The [trading tool](../../src/tool/trading.ts) enforces this setting,
but native loopback UTA routes do not authenticate a distinct human approval
authority. Expected proposal hashes, read-only checks, risk guards, replay
protection, and unresolved-outcome blocking protect different invariants.
The native AI launch configuration requests broad permissions. A local process
can potentially use HTTP instead of the gated tool; this finding follows from
the code paths, not a real order submitted to demonstrate bypass.
Relevant source: [UTA entry point](../../services/uta/src/main.ts),
[wallet routes](../../services/uta/src/http/routes-trading.ts), and
[Codex launcher](../../src/workspaces/adapters/codex.ts).

These paths were present in the original architecture. New fork UTA routes
inherit the same local trust boundary and also require authority isolation.
Remediation requires credential protection and metadata-only reads, plus an
operator approval capability and OS/network permissions that AI processes
cannot obtain or bypass. This review does not claim those changes are complete.

## Environment-specific observations

The current audit sandbox could not open the sealing key, broker account file,
or AI vault directly: each attempt returned EPERM. The previously observed
named sandbox group ACE no longer appeared. ACLs remained inherited and had
unresolved additional principals with Modify rights; access by every native AI
runtime was not verified. Filesystem denial in the audit sandbox does not close
the credential API exposure or establish native runtime isolation.

A scan of 3,660 tracked text files found no candidates for the selected known
token/private-key prefixes; 205 binary files were excluded. Four development
logs did not contain the current AI vault key. These checks do not cover all
secret formats, Git history, conversations, or runtime copies.

TWS had a wildcard listener on port 7497. Windows Firewall was enabled on all
three profiles with effective BlockInbound/AllowOutbound policy. No applicable
allow exception for TWS/7497 was identified; 24 broad-looking candidate rules
were restricted to other Windows package families. TWS localhost-only/Trusted
IPs settings and reachability from another host were not verified. The
[IBKR configuration documentation](https://www.interactivebrokers.com/campus/ibkr-quant-news/getting-started-with-the-interactive-brokers-native-api/)
describes these application-level controls. Firewall, TWS, and OS ACL settings
were not changed during the audit.

## Validation and limits

The security recheck executed 198 assertions: **197 passed, 1 failed, 0 skipped**.

- 132 hermetic auth, session/token, sealing, local guard, trading permission,
  and risk guard assertions passed.
- 7 isolated HTTP approval integration assertions passed.
- 55 relay, connector file, wallet/hash, unknown-outcome, and mocked IBKR
  assertions passed.
- 3 HTML report sanitization/sandbox/CSP assertions passed.
- `src/server/workspace-files.spec.ts` failed while creating its symlink fixture
  with Windows EPERM, before its containment assertions. That group has an
  unaccepted receipt; this specific coverage remains unverified.

The dependency update also had successful builds, applicable typechecks,
critical-local acceptance, and an isolated Electron demo smoke. Its complete
suite run was not green: it included baseline Windows/environment failures and
cases subsequently fixed or checked separately. Neither those targeted results
nor this recheck certify a complete green suite or a production release.

Detailed audit JSON, local run receipts, HTTP metadata, ACL inventories, and
logs are retained in the operator's local evidence directory. They are not
bundled into this public record. Documentation link checks apply to this
record; it introduces no executable code or runtime configuration changes.
