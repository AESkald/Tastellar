# 16 — Engineering guidelines

Use these guidelines when changing the application. Keep each change focused on a documented behavior, and update the related specification when a product or data contract changes.

## Before changing code

Read the root README, product contract, architecture, data model, contracts, the relevant feature specification, and the applicable quality requirements. Read linked data-safety and platform rules when a change touches those areas. Inspect the current implementation and preserve unrelated work.

## Implementation

1. Keep domain rules in the shared core; reuse existing commands and query projections instead of duplicating formulas in the UI.
2. Keep changes within the feature's scope. When a shared contract must change, identify dependent features and update the specification and schema with it.
3. Handle loading, empty, missing optional data, error, conflict, cancellation, keyboard, and touch states where applicable.
4. Test observable behavior and realistic failure conditions. Avoid tests that only restate implementation constants.
5. Verify rendered layouts for visual features, not only compilation.
6. Report behavior, validation results, and remaining limitations accurately. Label mocked, disabled, or unverified behavior accordingly.

## Data and product constraints

- Keep domain state out of React and browser storage; the UI must not issue SQL directly.
- Use one canonical ranking and one set of filter semantics. Do not create hidden rankings or models per filter, array-index ordering, or floating-point rank keys.
- Keep scene identities stable across filtering; release resources when scenes close or change.
- Do not infer causal analytics from unqualified averages or require covers for library entries or recap compositions.
- Stage files before replacement or deletion. A failed database open or migration must never replace user data with empty defaults.
- Keep user data and archives independent of payments. Generate recommendation text locally; sending it to an external service requires the user's explicit action.
- Apply only documented confidence and revision rules to duel-driven order changes.
- Do not add speculative features, backends, or advertising solely because an extension point exists. Verify compatibility with external service APIs before relying on them.

## Definition of done

- Acceptance criteria pass with evidence.
- Contract changes are reflected in domain logic, bridges, archive schemas where relevant, and documentation.
- Writes cannot silently lose data or overwrite newer cross-tab changes.
- English messages provide translator context; optional content remains optional.
- Performance and resource cleanup meet the feature budgets, or a concrete limitation is recorded.
- Every entry and order has one source of truth.
