# 14 — Architecture decisions, trade-offs, and validation gates

These decisions are explicit recommendations, not externally verified package claims. Research was intentionally limited to the supplied brief and connected project. Implementation agents must validate current platform support, licensing and compatible versions when authorized to begin development.

| Decision | Why | Alternative / cost |
| --- | --- | --- |
| Tauri + web UI + Rust + SQLite | Shared local rules, web-oriented charts/3D/composition, bounded desktop runtime | React Native/Flutter may offer stronger native mobile widgets; integrating uniform 3D/export and desktop docking changes the cost. Tauri requires mobile/webview proof first. |
| One local core, no server | Product has no account/sync requirement | A backend adds operations/auth/conflict complexity without solving a present need. |
| Native SQLite through core | Atomic domain writes and durable portable persistence | Browser storage would couple data lifecycle to a webview and weaken shared migration control. |
| Explicit Unrated group | Optional score cannot imply planned or dropped | Forcing every entry into a score invents data. |
| Overall score independent of criterion average | Personal judgment is not a fixed weighted formula | Automatic averaging can be offered later as a visible suggestion, never a silent override. |
| Preserve inactive criterion scores | Type/criterion edits should not erase personal work | Retention needs a clear historical/inactive section and archived identities. |
| Lexicographic order keys | Typical moves avoid rewriting a whole group | Keys can grow and need occasional transaction-safe rebalance. Dense integer ranks remain derived. |
| Bayesian Davidson pair model with Laplace uncertainty | Win/loss/tie evidence has a coherent categorical likelihood; a Gaussian prior regularizes sparse and cyclic evidence; uncertainty supports conservative adjacent changes | A simpler Bradley–Terry half-win treatment does not model ties as a separate outcome. Validate the fixed tie parameter, solver, uncertainty thresholds, and comparison workload on synthetic and real-use fixtures. |
| One continuously updated canonical order | Ranking, Library, Analytics, Home evidence, and Recap always share the same persisted order; manual moves commit exactly and duel evidence can change it only through confidence-qualified local swaps | The confidence thresholds, local locks, event history, and optimistic-concurrency rules require careful validation because filtered comparisons can still change the full tier. |
| Explicit placed/unplaced state with binary insertion | Keeps ordinal rank intentional while letting a new work find a position in O(log N) comparisons against a frozen list; a 90% placed-share prompt encourages insertion only when most of the tier is already placed | Adds placement state and deferred reconciliation semantics; test tie, skip, abort, and concurrent-order invalidation. The 90% share trigger is separate from the pair-swap confidence threshold. |
| Ranking-only reset separate from workspace reset | Users can clear rank placements and duel history without deleting media records or numeric scores | The action must be explicit about preserving backups/exports, which may restore cleared ranking history. |
| Persistent pair evidence across sessions | New comparisons build on saved evidence; repeated judgments can increase support while explicit retraction corrects mistakes | A one-vote-per-pair rule cannot express changed or strengthened judgments. Pair cooldown reduces needless repetition; every direct answer remains auditable. |
| Stable scene identities, visibility filters | Filter changes are fast and spatially predictable | Fully rebuilding a scene loses orientation and wastes resources. |
| Isolated native WebGL scene renderer with 2D canvas fallback | Keeps scene rendering bounded behind a replaceable adapter without adding a general-purpose 3D runtime to the current React app | More rendering and resource lifecycle code is owned locally; validate picking, context loss, reduced motion, and object counts in desktop webviews before making platform performance claims. |
| Separate explicit taste importance and favorite quality chart | Avoid inferring importance from high scores | True preference estimation needs evidence beyond a weighted mean. |
| Deterministic analytics with conservative thresholds | Reviewable observations and graceful sparse-data behavior | Thresholds are product heuristics and require usability tuning; no psychological diagnosis. |
| Dedicated recap scene graph/export renderer | Predictable output dimensions, no interactive controls captured | Requires shared layout logic rather than a quick DOM screenshot. |
| Normalized current data + semantic history | Simple current queries, useful future change analysis | Full event sourcing creates replay/versioning complexity not required now. |
| ZIP + documented JSON/JSONL + originals | Inspectable, broadly usable, full-fidelity transfer | CSV alone loses relations, history, images and partial dates. |

## Required stage-0 validation gates

1. **Platform host:** minimal macOS, Windows and Android shells call the same Rust domain function and SQLite transaction. Verify supported host/plugin/toolchain versions; do not assume desktop APIs exist on Android.
2. **Graphics:** render representative 200- and 2,000-object scenes, picking and labels in each platform webview. Validate WebGL capability/fallback and memory cleanup under repeated tab switching.
3. **Export:** produce a 1080 × 1920 image and multi-page timeline with bundled fonts and Unicode titles through native save/share flows. Test Android webview memory and file permissions.
4. **Durability:** kill process during a database write, staged asset import and archive restore. Verify recovery on actual OS filesystems.
5. **Duel fitting:** synthetic 10, 50, and 200-participant fixtures plus tiers larger than 200 with ties, cycles, noise, disconnected observations, repeated answers, and manual locks. Validate deterministic Davidson/Laplace fits, sparse full-tier solves, thresholded adjacent reconciliation, retraction, restart recovery, comparison workload, and order stability. Session participant caps must not create a filtered model or omit works from reconciliation. Do not replace the chosen model just to minimize coding effort; revise with evidence.
6. **Layout/input:** prove desktop resize/docking/tab restoration and compact mobile navigation with keyboard/screen-reader access.

A failing gate is a decision point, not permission to ship a broken target. Record measured result, proposed alternative, impact on contracts and revised decision. Domain/archive semantics must remain stable if the UI toolkit changes.

## Deliberate product assumptions

Single local profile initially. Default overall/criterion scale is integer 1–10. Planned/dropped do not retain a current overall score, but history does. One canonical manual-and-duel order of placed works is global across media types and shared by every feature; rated but unplaced works remain in a separate tray until explicit placement, and score-tier membership remains fixed unless the user explicitly changes the score. Filters select duel pairs but never create a parallel ranking or fit. Release dates are optional partial calendar dates. Default Add work means planned, but users can immediately choose experienced. Unsupported graphics always falls back to a usable list.

These assumptions resolve underspecified behavior and should be evaluated in product review before feature implementation. They do not require a pause in producing this architecture.

## Future evidence and costs

The largest risks are webview/mobile graphics variation, long-text/font fidelity in recap images, safe asset/archive lifecycle, and subjective duel workload. The initial staged plan tackles these before polished screens. Do not optimize for an enormous hypothetical social network or build cloud synchronization, recommendation crawling, payment verification, or external catalog normalization now.
