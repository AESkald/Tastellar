# 16 — Implementation-agent handoff protocol

This document governs future work implementing these specifications. The present task creates documentation only. Do not start coding merely because a file below describes source locations.

## Reading order and scope

For a feature task, read the root [README](../README.md), [Product contract](../specifications/01-product-contract.md), [Architecture](../architecture/02-architecture.md), [Data model](../architecture/03-data-model.md), [Contracts](../architecture/04-contracts.md), the assigned feature file, and relevant [Quality](15-quality-and-delivery.md) sections. Read linked safety/platform rules when your changes touch those boundaries. Do not browse unrelated folders/chats or ingest every future idea into the task.

Inspect the actual implementation before modifying it; this architecture records an initially empty project, not a permanent assertion about future source state. Preserve unrelated changes. Do not create another project root or duplicate `ProjectStructure` variants. All project work belongs in Tastellar_App unless the user explicitly changes scope.

## Bounded handoff examples

“Implement `projectstructure/specifications/07-library.md` entry creation and editing, using existing contracts and excluding scene rendering. Include title-only creation, disposition/rating behavior, partial release dates, retained criterion values, transactional save and relevant acceptance cases.”

“Implement the canonical order contract in `projectstructure/specifications/09-ranking.md`: exact manual insertion, persistent duel evidence, and confidence-qualified adjacent reconciliation all update one order. Keep the work bounded to ranking commands and storage; deliver property tests, replay/migration behavior, undo and shared rank queries.”

“Implement `projectstructure/specifications/11-recap.md` 3 × 3 template using the shared composition model and export pipeline. Include text/cover/mixed fixtures, replacement constraints and archive persistence; do not write library ordering from the composition editor.”

These are examples of implementation scope, not commands to execute now. Delivery stages define prerequisites; a missing prerequisite should be built within explicit task scope or reported clearly before producing incompatible substitutes.

## Required implementation practice

1. State the assigned behavior and identify the owning module/contracts.
2. Reuse existing domain commands and query projections; do not duplicate rank/filter formulas in the UI.
3. Keep modifications within the bounded task. If a shared contract must change, explain the dependent features and update specification/schema together.
4. Handle loading, empty, missing optional data, error, conflict, cancellation, and keyboard/touch states as applicable.
5. Test observable behavior and realistic failure conditions. Do not add tests merely asserting the implementation's own constants.
6. Verify actual rendered layouts for visual features, not just compile success.
7. Report completed behavior, validation results, and remaining limitations honestly. A mock, disabled control, or untested platform is not complete.

## Prohibited shortcuts

No storage of domain state solely in React/browser storage. No direct SQL from UI. No hardcoded array-index ranking or floating-point order keys. No separate hidden ranking or model per filter. No rebuilding all scene objects on each filter toggle. No causal analytics from unqualified averages. No cover requirement for library/recap. No file deletion before safety staging. No migration that overwrites a failed database with empty defaults. No payment gates around owned data or archives. No remote call for the copyable AI prompt. No duel-driven order change without the documented posterior threshold, manual-boundary lock, event history, and revision check.

Do not activate speculative future features, install a backend, or add advertisements based only on an extension seam. Do not reduce Android to an unsupported label on a desktop shell. Do not claim compatibility with unverified current external service APIs.

## Completion checklist

- Assigned acceptance criteria pass with evidence.
- Contract changes are reflected in domain, bridge, archive schemas where relevant, and documentation.
- No silent data loss or stale cross-tab overwrite.
- English messages are contextual and localizable; optional content remains optional.
- Performance/resource cleanup meets feature budgets or a concrete blocker is reported.
- The implementation retains one source of truth for every entry and order.
