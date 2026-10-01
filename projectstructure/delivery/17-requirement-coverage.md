# 17 — Requirement coverage and future backlog

This index ties the supplied brief to implementable owners. It does not claim the product has been implemented.

| Brief requirement | Specification owner |
| --- | --- |
| Tastellar name; former OmniList; local personal media library | README, 01 |
| Default and custom media types; conditional deletion naming affected works | 01, 03, 04, 07 |
| Global criteria, per-type defaults/subsets, nested creation, conditional delete | 01, 03, 04, 07 |
| 10-point overall/criterion rating and finer order within a score | 01, 03, 09 |
| Empty initial tags and custom tags | 01, 03, 07 |
| Optional covers, Your thoughts review, release date, ranking and history; text-only entries | 03, 07, 11, 12 |
| Five-icon persistent rail, hover labels, bottom Settings | 05 |
| Multiple tabs and duplicate sections, configurable tab shortcuts, new tab | 05 |
| Contextual right panel, last selection, panel toggle | 05, 07 |
| Local profile avatar/nickname, taste radar and rating guidelines | 06 |
| Single external-AI prompt, preview/copy and help | 06 |
| Library folders, Add/Search, search results replace folders | 01, 07 |
| Group navigation and disabled endpoints | 01, 07 |
| Upper scene, lower ordered list; cover grid/text grid/table and columns | 07, 08 |
| Detailed work panel, rank/percentile/history/review/statistics/Add cover | 03, 07 |
| Selectable type icons; short label shown as overflow fallback in cards | 01, 03, 07 |
| Collapsible folder and details panes; resizable/rearrangeable persisted areas | 05 |
| Filters in right panel; matching scene/list results; visibility changes | 04, 07, 08 |
| Solar system/orbits, constellations, galaxy, deep field, asteroids, black hole | 08 |
| Designed Plan to Watch scene and consistent universe transitions | 08 |
| Clickable objects, thin readable titles, cover palettes, rotation | 08 |
| One canonical order shared by Ranking, Library, Analytics, Home evidence, and Recap | 01, 03, 04, 07, 09, 10 |
| Tier list cover/text, all groups, immediate manual insertion, efficient keys | 09 |
| Persistent Bayesian duels, ties/skips, active pair selection, cycles, confidence-qualified order updates | 03, 04, 09, 14, 15 |
| Cross-media comparison help and hide-after-read rule | 09 |
| Rating distribution shape and tentative observations | 10 |
| Media-type distribution differences, equal peaks/sample-size handling | 10 |
| Rating rarity and filtered meaningful top lists changing on fresh open | 10 |
| Adjacent rating-boundary review and rating changes | 10 |
| Editable recap images, swap/remove/replace, watermark | 11 |
| Canon 9:16, double-area #1, five named styles | 11 |
| Throne, 3 × 3, release-year timeline, decades, custom formats | 11 |
| Sparse data, missing dates, clashing/no covers, no folders in Analytics/Recap | 05, 10, 11 |
| Animation, responsiveness, 8 GB Mac performance | 05, 08, 15 |
| Enthusiast detail and casual immediate visual value | 01, 06, 07, 11 |
| Themes, shortcuts and natural supporting settings | 05 |
| Safe updates, export/import including images/profile/history | 03, 12 |
| Future IMDb/Goodreads/MyAnimeList imports and external IDs | 03, 12, 13 |
| English initial interface, contextual localization, grammar/word order | 13 |
| macOS, Windows, Android and shared/platform-specific boundaries | 02, 13, 14, 15 |
| CI and meaningful tests | 15 |
| Future subscription/advertising, data independent of payment | 13 |
| Agent-addressable Markdown structure with no application code | README, 16 |

## Additions resolving ambiguity

- Unrated is explicit because an entry's score is optional.
- Planned/dropped status and current score have a defined mutual-exclusion rule; history survives changes.
- Criterion values remain recoverable when a type/subset is changed.
- Global ranks are distinguished from filtered positions, Top percentage, and percentile.
- A filtered manual drag inserts at its exact visible target in the full group. Filters select duel pairs only; each duel fit and reconciliation uses the full current tier.
- Manual placements add bounded local preference evidence and protect their boundaries until an opposing direct win on that exact pair.
- Persistent duel outcomes and retractions set durable reconciliation intent; after a guarded fit they may update the shared canonical order through confidence-qualified adjacent reconciliation. Manual and membership edits preserve their exact canonical placement, refit without reconciliation, and clear any pending automatic reorder.
- Per-tier fit freshness and automatic-reorder intent are persisted separately as E, C, and `pendingReconcile`; dirty manual-only state refits without order changes, while recovery honors pending duel reconciliation.
- Placed status is separate from overall score; binary insertion is explicit, snapshot-guarded, and preserves each answer as evidence without reconciling until confirmation. The 90% placement suggestion uses the placed share, separately from q=0.90 swap confidence.
- Settings → Data & privacy offers a confirmed ranking-only reset that clears ranking evidence and returns rated works to Unplaced while preserving entries, overall scores, unscored groups, and existing backups/exports; full workspace reset remains separate.
- Radar distinguishes explicit importance from qualities scored highly in favorites.
- Date-dependent output states that it uses the dated subset rather than inventing missing dates.
- Archive versioning, staged assets, backup retention, corruption recovery, trash and merge conflict behavior are specified.

These are proposed product decisions, not claims that the source brief explicitly dictated each detail. See [Decisions](../architecture/14-decisions.md).

## Earlier idea notes: retained and deferred

| Idea from `notes/ideas.md` | Treatment and future prerequisite |
| --- | --- |
| Rating boundaries, rating rarity, cross-media help, space library, recap templates | Included in initial target; current brief controls conflicting details |
| Experimental Elo/Glicko alongside conscious ranking | Reframed as persistent pair evidence that updates the one canonical order under a Bayesian Davidson/Laplace model; Elo/Glicko are not initial models |
| Rank stability/top snapshots over years | Deferred; order events and future explicitly scheduled snapshots support later work; do not fabricate pre-install history |
| Old-rating audit, honeymoon score, upward/downward reevaluation | Deferred; rating timestamps/events retained now; needs sufficient actual longitudinal data and eligibility rules |
| Cultural autobiography and life-period strictness | Deferred; event provenance supports future analysis, but cannot establish changing standards versus changing media quality without caution |
| Adaptation gap and linked versions | Deferred; explicit relation entity and identity resolution needed |
| Hype resistance versus public ratings | Deferred; provider data rights, scale normalization and sampling requirements needed |
| Taste twin/nemesis, social profiles/live recap links | Deferred; accounts, privacy, consent, overlap thresholds, sync and server architecture required |
| Runtime/time spent, reread/rewatch tracking | Deferred detailed tracker; optional manual experience events can preserve truthful history |
| Character-level or subwork rating scales | Deferred; separate subject model needed, not overloaded Entry criteria |
| Query-language top lists | Deferred user query language; typed internal filter contract already supports structured selection |
| Automatic tag mapping/genre cleanup | Deferred to import preview; never silently merge unlike vocabulary |
| AI trope mining or browsing to recommend | Deferred; initial product produces only a locally assembled prompt for external use |
| Public QR/link in shared images | Deferred until a real service exists; initial watermark is plain Tastellar attribution |

No placeholder controls should promise these deferred capabilities. Each needs its own future specification before implementation.
