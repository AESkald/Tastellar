# 19 — Library foundation implementation notes

The macOS Library foundation adds persisted entries, media types, criteria, tags, entry covers, and a versioned story-inclusive archive. Follow-up maintenance adds a user-selectable media-type icon, the Animation and Comic defaults, the Ideas/Message criterion, short-label card fallback, and localized entry copy. The Entry model has a Your thoughts review field and no private-notes field. Overall score remains part of rating and groups, but is not a filter predicate. 3D scenes and external-catalog imports remain deferred.

## Vocabulary name matching limit

The data model requires trimmed Unicode-normalized, case-folded name equality. The current native storage implementation trims names and applies Rust's Unicode lowercase conversion before uniqueness checks. Rust's standard library does not provide Unicode normalization or full case folding. The local offline dependency cache has an ICU normalizer but no full case-fold API or dedicated normalization/case-fold crate; adding only NFKC plus lowercase would still miss full-fold equivalences such as `ß` and `ss`.

This is a known conformance gap. Do not weaken the data-model requirement to match the current behavior. Before release, add a pinned Unicode normalization and full case-fold implementation and cover composed/decomposed forms, compatibility forms, and multi-character fold mappings in tests.

## Workspace reset regression

Reset reseeds the current vocabulary through the migration helper, which also restores the archived `animated-films-series` type and its criterion links. Delete those `media_type_criterion` links before deleting that archived type; otherwise SQLite rejects the reset with a foreign-key error that the UI reports as a failed local data operation. The storage reset test covers this sequence.
