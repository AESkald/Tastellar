# 03 — Data model and persistence invariants

## Common rules

IDs are opaque UUIDs generated locally. Instants are UTC RFC 3339 in portable data; user-entered release dates are calendar fields with precision. Store text as Unicode; never use names as foreign keys. `createdAt`, `updatedAt`, and integer `version` accompany mutable entities. A committed transaction increments one global `libraryRevision`. Foreign keys and CHECK constraints enforce invariants in addition to domain validation.

Archive rather than hard-delete configurable vocabulary to preserve historical references. Queries hide archived configuration unless explicitly reading history. A renamed historical subject retains its event-time label in the event payload.

## Entities

| Entity | Required fields and important constraints |
| --- | --- |
| Entry | id, nonblank title, disposition, optional mediaTypeId, optional overallRating, rankingPlaced (true only for an active Experienced entry with a score), optional coverAssetId, optional releaseDate, reviewText, optional shortLabel, timestamps, version, optional trashedAt |
| MediaType | id, name, sortOrder, iconKey, optional defaultKey, archivedAt; active normalized names unique |
| Criterion | id, name, optional description, optional defaultKey, archivedAt; active normalized names unique |
| MediaTypeCriterion | typeId, criterionId, displayOrder; unique pair |
| CriterionRating | entryId, criterionId, integer score 1–10, recordedAt; unique pair, retained when currently inapplicable |
| Tag | id, name, timestamps; active normalized names unique |
| EntryTag | entryId, tagId; unique pair |
| GroupOrder | entryId unique, groupId, binary-collated orderKey; unique (groupId, orderKey); the sole persisted canonical order |
| Profile | singleton id, nickname, optional avatarAssetId, statedTastesText, radarMode |
| RatingGuideline | score 1–10 unique, multiline description |
| TasteInput | criterionId unique, explicit importance integer 1–10; absence is not zero |
| EntryEvent | id, entryId, kind, occurredAt, recordedAt, source, payloadVersion, typed payload; append-only until explicit purge |
| OrderEvent | id, groupId, revision, kind, moved IDs, before/after neighbors or affected interval, source judgment/session, order-algorithm version; sufficient to reproduce a manual insertion or deterministic adjacent reconciliation and to guard undo |
| DuelSession | id, groupId, normalized filterSnapshot, participantIds, explicitSubset flag, membershipFingerprint, scheduler/model version, reproducible seed, event sequence, state, timestamps |
| PlacementAssistSession | id, targetEntryId, groupId, frozen placed-entry ID sequence, expected order/membership revisions, half-open pivot-index interval, current pivot, reproducible seed, state; answers are ordinary durable pairwise evidence tagged with placement source |
| DuelJudgment | id, sessionId, groupId, canonical unordered pair IDs, presented left/right IDs, result left-win/right-win/tie, per-tier input sequence, createdAt, optional retraction event; every non-retracted judgment contributes one unit, including repeated comparisons |
| DuelSkip | id, sessionId, groupId, unordered pair IDs, presented left/right IDs, createdAt, scheduler sequence; presentation counts for side balance but not preference likelihood, graph coverage, or answered-comparison cooldown |
| ManualBoundaryConstraint | id, groupId, higher/lower entry IDs, binary-logit weight, protected state, creation sequence, legacy-unlock marker; at most one active factor per unordered pair. `BoundaryUnlock` separately links a boundary ID to each later opposing judgment that currently releases its lock. |
| TierRankingState | groupId, latest tier-change sequence E, last successfully fitted sequence C, pendingReconcile; one row per rated tier, with C ≤ E and automatic reorder intent independent of fit dirtiness |
| DuelReconciliation | id, groupId, evidence sequence, source order revision, resulting order revision, model version, committed swap IDs; durable reconciliation record, not a stored posterior |
| JudgmentRetraction | id, judgmentId, reason, createdAt; preserves the answer in audit history while removing its likelihood contribution |
| BoundaryReview | lower/higher group IDs, boundary entry IDs, rating/order fingerprint, confirmedAt |
| RecapComposition | id, templateId/version, styleId, mode, filter snapshot, slot assignments, text/style overrides, content snapshot, createdAt, updatedAt |
| Asset | id/contentHash, relative managed path, MIME, dimensions, byteLength, role, palette metadata/version |
| ExternalIdentity | entryId, provider, externalId, optional sourceUrl; unique (provider, externalId, entryId); identity is evidence, not automatic merging |
| ImportBatch | id, source, report summary, committedAt; retained for provenance |
| Preference | namespaced key, schemaVersion, value; separate portable and device namespaces |
| Workspace | device/layout class, schemaVersion, tabs, active tab, dock tree, panel geometry |
| AppMetadata | schemaVersion, archive compatibility version, libraryRevision, installId |

Date value: `{year, month?, day?, precision: year|month|day}` with valid calendar constraints. No timezone applies. Release-year filters work for any known year precision.

Normalized name equality uses trimmed Unicode-normalized case-folded text. Keep original display text. Reject empty names. Duplicate titles are allowed and disambiguated by type/year/ID. Suggested practical limits: title/name 500/100 characters, review 100,000 characters, stated tastes 20,000. There is no entry notes field. Enforce and explain limits consistently in import and UI; never truncate silently.

## Membership and retained scores

Within the rated population, placed works are ordered by score descending and GroupOrder within each score tier; unplaced rated works appear in their score-tier tray without ordinal rank. The same placed order feeds Ranking, Library, Analytics, Home evidence, and Recap. Media type and other filters never own a separate order. Ordinary duel sessions may restrict which placed pairs are offered, but a model fit uses every current active entry and all active evidence in that tier; reconciliation changes the placed order only through confidence-qualified adjacent swaps. The initial session candidate cap is 200 and is not a tier-size limit.

`rankingPlaced` is independent of the numeric `overallRating`: `true` means the user has assigned the entry an intentional position within its score tier; `false` means the entry belongs in that tier's Unplaced tray and has no displayed ordinal rank. Only active Experienced entries with a non-null overall rating can be placed. Migration marks existing rated entries placed while preserving their order; a newly rated entry starts unplaced. Unplaced works retain a stable tray order. A confirmed manual insertion sets the target placed; moving a placed work back to Unplaced clears that state without changing its overall rating. Full workspace reset does not apply this partial-reset rule; see [Data safety](12-data-safety.md).

Direct duel outcomes, skips, retractions, session seeds, manual boundary-factor events, TierRankingState, reconciliation records, and OrderEvents are durable user data. The fitted Davidson posterior and Laplace covariance are disposable caches. E advances for each fit/order-relevant tier change: a direct judgment or retraction, manual placement (including factor addition/retirement), or membership change. C is the latest E successfully fit; C < E means the cache needs refitting. `pendingReconcile` is durable intent independent of fit dirtiness: a direct win/loss/tie or duel retraction sets it true; a manual order or membership change sets it false and supersedes any pending automatic reorder. Skips change neither E nor this flag. A successful fit advances C to its fitted E, but changes GroupOrder only when pending reconciliation is still true; reconciliation and clearing the flag commit atomically. A manual-only fit advances C while preserving exact user order. On membership change, duel evidence remains in history and contributes when both works are again active in the same tier; manual constraints involving the moved work are retired. Manual factors are unique by unordered pair: a later placement involving that pair supersedes its active factor and preserves both events. A lock releases only for a direct opposing win whose persisted input sequence is later than the boundary's creation sequence; each qualifying judgment has its own unlock relation, and the boundary factor remains in the fit after unlock. Retracting one such judgment removes only its relation; the lock returns when no qualifying unlock remains, without rewriting the current canonical order ahead of guarded reconciliation. The v6-to-v7 migration and the v7-to-v8 chronology migration preserve legacy unlocked status when exact provenance is unavailable, without fabricating unlock relations.

An active binary placement assist freezes the placed-entry sequence for its tier and records a half-open candidate interval `[lo, hi)` over pivot indexes. With N placed entries, initialize `[lo, hi)=[0,N)`; when the interval closes, `lo` is the proposed insertion gap in `0…N`, covering all N+1 gaps. Each pivot answer is persisted as direct preference evidence, but the assist holds `pendingReconcile=false` so no ordinary reconciliation can change its snapshot before confirmation. Confirmation performs the exact insertion and refits without global reconciliation; abort or Skip keeps the target unplaced while retaining any completed answers. A tie records Davidson evidence and proposes a gap immediately after that pivot for explicit confirmation.

`overallRating != null` implies disposition experienced. `GroupOrder.groupId` MUST equal the derived group. Every active entry has one order record, even unscored entries; their order is presentation only, not merit. Trash excludes entries from all standard results while retaining order for restoration. Restoration appends if the original key is unavailable.

A criterion rating is **active** only if its criterion is not archived and is selected by the entry's active media type. Changing or clearing the type, removing a type's criterion, or archiving a criterion makes scores inactive without deleting them. The editor shows retained values in a clearly labeled history/previous criteria section. Restoring the same criterion applicability revives the saved value. Type deletion clears current `mediaTypeId`, archives the type, and records old identity in events. Recreating a name makes a new identity and does not autoattach entries. `iconKey` identifies a selectable icon from the built-in icon set; default media types receive distinct semantic icons and custom types can use any of ten abstract, subject-neutral shapes.

Entry events include created, rating_changed (old/new score and disposition), type_changed, criterion_score_changed, and optional user-authored experience events. Do not claim a rewatch history from creation dates. Edits to reviews need not retain every keystroke; save on deliberate commit/debounced completed edit with unsaved/error feedback. Rating history is append-only and retained through reranking.

## Derived values

Rated population N: active, nontrashed, experienced entries with a current score. Canonical overall order: score descending, then orderKey ascending, then ID as corruption-defense tie-break only. Duplicate keys are invalid and repaired before normal operation.

- Within-score rank: 1-based index in its full group, not current filter.
- Overall rank r: 1-based index in the full rated population.
- `Top p%`: p = 100 × r / N, display at most one decimal with a 0.1% floor; singleton displays “#1 of 1”, not a misleading rarity claim.
- Percentile: 100 × (N − r) / (N − 1) for N > 1, undefined for N = 1. Label distinctly from Top p%; do not interchange the two.
- Filtered rank: explicitly labeled “#k in this selection.” Full ranks remain available.

No stored rank numbers, percentiles, histogram bins, or eligibility booleans. Compute from queries/revision caches. Index active disposition/rating, type, release year, tag joins, group/key, and history entry/time. Search indexing is rebuildable and locale-aware; fallback substring search must still work.

## Acceptance

Reject score 0/11, invalid calendar dates, mismatched groups, dangling asset references on normal writes, and duplicate order keys. Type switching preserves inactive criterion scores. Rank queries agree across list, details, analytics, and recap for the same revision. Empty and singleton populations have no division-by-zero or fabricated percentile.
