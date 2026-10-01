# 15 — Quality gates and delivery sequence

No application code is part of the present architecture task. This is the plan for subsequent implementation. A stage is complete only with its acceptance evidence; visual polish does not substitute for data safety.

## Implementation stages

| Stage | Deliverable | Dependencies / exit gate |
| --- | --- | --- |
| 0 — Risk validation | Minimal cross-platform host, local transaction, scene/export/input/durability spikes; dependency/version/license decision record | Pass the six gates in [Decisions](../architecture/14-decisions.md), or revise architecture before scaling implementation |
| 1 — Data foundation | Domain entities, invariants, repositories, command/query contracts, asset staging, migrations, portable archive, recovery UI | Headless round trip and fault-injection suite; no feature data stored ad hoc in frontend |
| 2 — Shell and usable library | Tabs, persistent docking, compact shell, themes, shortcuts, vocabulary editors, entry editor, three list modes, search/filter/details | Full keyboard/text-only workflow; multi-tab conflict tests; safe export available |
| 3 — Canonical ranking | Fractional ordering, filtered insertion, cross-group moves, rank projections, undo, basic tier list | Randomized order invariants; 10,000 repeated gap insertions; filter/hidden-entry fixtures |
| 4 — Home and universe | Profile, guidelines, explicit/derived chart, recommendation prompt, all group scenes and fallbacks | Palette/label/picking QA; performance and reduced-motion gates; prompt privacy/budget fixtures |
| 5 — Duels and analytics | Persistent Davidson/Laplace evidence, active pair selection, confidence-qualified updates to the canonical order, distribution insights, top lists, boundaries | Cycles/ties/retractions/manual-lock/stale-job tests; full-tier fits for sessions selecting ≤200 candidates; exact analytics thresholds; plausible comparison workload measurements |
| 6 — Recap | All specified templates, five Canon styles, text/cover modes, draft editing, deterministic image export | Golden-image and manual visual QA for every template/mode; archive restores editable compositions |
| 7 — Platform release readiness | Signed macOS release, Windows/Android builds and adapters, complete migration/upgrade QA | Declare release status per platform based on real device testing; no “supported” claim from compilation alone |

The complete target includes all stages. A preview build may omit unfinished sections with honest disabled states, but is not the full product. External import providers, monetization, sync and longitudinal/social ideas belong to later separately specified milestones.

## Testing strategy

### Domain/property tests

Membership/rating/placed-state rules, type/criterion archive behavior, normalized name uniqueness, partial dates, canonical/global/filtered ranks, percentiles and denominators. Generate random add/move/rate/filter/delete/restore sequences and compare order against a simple reference list; internal keys must preserve that order through rebalance. Test Davidson wins/losses/ties, cycles, disconnected evidence, repeated unit-weight judgments, explicit retractions, bounded unique manual factors, opposing-win lock release, solver/covariance failure, deterministic pair selection, placed-only reconciliation, and stale fit rejection. Include tiers larger than 200 to prove the session candidate cap does not create a filtered model or omit works. Test binary insertion interval endpoints, tie/skip/abort, frozen-list invalidation, evidence retention, the 90% placed-share threshold versus q=0.90 swap confidence, and reset semantics. Use snapshots only where they express meaningful stable contracts.

### Storage/integration tests

Real SQLite temporary databases, not only mocked repositories. Exercise transactions, foreign keys, command idempotency, conflicting tabs, failed writes, version checks, archive schema conversion, and migrations from every supported released version. Include entry history, placed/unplaced state, duel and placement-assist evidence/retractions, manual-factor history, canonical placed order, per-tier E/C/`pendingReconcile`, and inactive criteria in round-trip assertions. Crash after an answer commits but before its fit/reconciliation applies, then verify startup follows the durable flag. Crash with dirty manual-only evidence and verify refit does not change the exact manual order; crash with C=E and `pendingReconcile=true` and verify guarded reconciliation is resumed. Reset ranking and prove overall ratings, entries, unscored groups, backups, and exports survive while ranking evidence is cleared and rated entries become unplaced; prove full workspace reset remains separate. Verify asset hashes and reference collection across trash, recap snapshots, and backup manifests. Fault-inject at each safety boundary described in [Data safety](../architecture/12-data-safety.md).

### Interface end-to-end tests

Add/edit a coverless work; create custom type/criteria/tags; conditional delete with changed impact; search under filters; move within/between groups; answer, skip, revisit, retract, pause, and resume a duel; verify automatic canonical changes and visible movement feedback; compare boundary; generate/copy prompt; edit/export recap; recover archive; restart and restore tabs/panes. Include keyboard-only reordering and a screen-reader pass. For desktop host/Android flows unsupported by browser automation, use native integration harnesses and a documented manual release checklist.

### Visual tests

Stable seeds and paused animation frames for scene screenshots. Recap exports at actual output dimensions; approve baselines deliberately, never automatically overwrite failures. Fixtures: empty, single item, small complete set, 200-work group, 10,000-entry library, mixed/no covers, portrait/landscape source images, very long titles, Unicode/emoji, missing dates, custom types, 200% text scale, light/dark/high-contrast accessibility settings, compact window.

## Performance budgets to validate

Use a named baseline 8 GB Mac with OS/CPU/display recorded; target first usable window ≤2 s for a 10,000-entry fixture, warm local search/filter ≤150 ms p95 excluding deliberate debounce, ordinary rating/move commit ≤100 ms p95, and active UI response ≤100 ms. Benchmark release builds, 30 measured trials after warmup for interaction latency, and report actual p95.

Memory target: ≤350 MB idle aggregate application processes and ≤600 MB steady active Library with one scene; large archive/recap jobs may peak at ≤900 MB then return near baseline. These are budgets to test, not measured facts. Include webview helper processes. GPU budget/frames follow [Scenes](../specifications/08-scenes.md). With 10 open tabs and 100 tab switches, no monotonic retained growth beyond a 50 MB tolerance after caches settle and resources are released. If budgets fail, profile and reduce caches/effects before raising targets with evidence.

Stress graphics and archives separately, then together; the writer remains responsive and cancellation works. Library lists are virtualized, covers are thumbnail-decoded with bounded concurrency, aggregates run off the UI thread, and archive IO streams rather than loading entire archives in memory. Set explicit cache bounds after baseline measurement, never an unbounded map keyed by every visited entry.

## CI plan

Pull requests: formatting, lint/static typing, Rust checks, dependency-boundary checks, unit/property tests, contract/schema consistency, SQLite integration tests, small archive round trips, English message-key completeness and pseudo-localization checks, frontend production build and supported host compile jobs. Run on Linux for portable tests plus macOS/Windows for platform-specific builds; Android build job validates mobile bindings.

Nightly/release: expanded fault-injection, all migration fixtures, large-library benchmarks on stable hardware, golden export/scene rendering, native end-to-end suites, Android emulator and at least one real device, accessibility checks. Platform tests that cannot run in hosted CI remain explicit release blockers with recorded manual evidence, not silently skipped green checks.

Lock dependencies, audit licenses/security advisories during implementation, retain test artifacts and failure logs without personal data. Release signing credentials live in CI secret storage with scoped access; never in the repository. Package signing, installer verification, archive compatibility and update/rollback recovery are release gates. Do not auto-publish from ordinary pull requests.

## Definition of done

A change has a bounded specification reference, matching behavior, meaningful tests for its failure modes, contextual English messages, accessible interaction, and measured performance where relevant. Data-changing features include transaction/error/undo semantics and archive compatibility. No placeholders pretending to be complete capabilities; no silently skipped validation. Update the relevant specification when an accepted design decision changes.
