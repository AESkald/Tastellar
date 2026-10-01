# 01 — Product contract

## Intent

A private, local personal media library that makes detailed taste curation enjoyable and gives casual users beautiful views and shareable images with little setup. Everything essential works offline. There is no account requirement or automatic upload. Users can begin with only a title.

Primary navigation: Home, Library, Ranking, Analytics, Recap; Settings at the bottom. The same entry, rating, and order are used everywhere. Presentation never becomes a second database.

## Terminology and invariants

- **Entry/work:** one personal library record. Different editions/adaptations may be separate entries; titles are not unique identifiers.
- **Media type:** zero or one user-configurable classification for an entry.
- **Criterion:** a global named quality; each media type selects an ordered subset. Criterion scores are optional integers 1–10, independent of overall score.
- **Rating:** an explicit overall integer 1–10, never computed silently from criteria.
- **Disposition:** `experienced`, `planned`, or `dropped`. Experienced does not assert completion; detailed progress tracking is deferred.
- **Group:** derived from disposition and rating. Experienced + score belongs to that score group; experienced without score belongs to Unrated; planned belongs to Plan to Watch; dropped belongs to Dropped.
- **Rank:** a placed work's strict canonical order, best first, within each rated score group. Rated but unplaced works remain in a separate tray with no ordinal rank until intentional placement. Equal scores can have different positions. Ranking, Library, Analytics, Home evidence, and Recap read the same placed order. A duel tie is evidence about that matchup and never forces equal display ranks.

Ordinary duels compare placed works within one fixed 1–10 score tier, across media types when the user wants. Each saved answer contributes persistent pairwise evidence and requests a guarded reconciliation after fitting; the same canonical placed order may change through confidence-qualified adjacent swaps. There is no separate duel order or Apply step. A manual move inserts the work exactly where requested immediately, clears any pending automatic reorder, and its bounded local preference evidence helps keep later automatic moves consistent with that choice. A scored but unplaced work can be inserted with binary placement against a frozen placed-list snapshot; these answers are durable evidence, but order reconciliation is deferred until the user confirms an exact position. When at least 90% of active rated works in a tier are placed, suggest this flow on rating entry and prioritize it on entering Duels. This placed-share trigger is separate from the model's 90% pairwise confidence threshold. Filters select ordinary comparison pairs but do not create another ranking or model. Ordinary reconciliation considers all placed works in the tier and never places an unplaced work implicitly.

Planned and dropped entries have no current overall rating and are excluded from rated analytics and overall ranks. Moving a rated entry to either disposition clears the current rating, explains that result in the action UI, and preserves rating history. Rating a planned/dropped entry makes it experienced. Removing a rating from an experienced entry moves it to Unrated. Criterion scores may be retained on all dispositions but only experienced rated entries contribute to derived taste analysis.

Unrated resolves an omission in the brief: optional ratings must not force a work into Plan to Watch. The original navigation order remains **10 → 9 → ... → 1 → Plan to Watch → Dropped**, followed by **Unrated**, shown when populated or explicitly requested. Previous/next navigation follows this visible sequence without skipping empty score groups. With Unrated hidden, Dropped is the final group.

## Initial configuration

| Default media type | Default criterion subset, in display order |
| --- | --- |
| Literature | Plot, World, Characters, Atmosphere, Writing style, Ideas/Message |
| Animation | Plot, World, Characters, Audiovisual presentation, Atmosphere, Direction, Animation, Ideas/Message |
| Games | Gameplay, Plot, World, Characters, Audiovisual presentation, Atmosphere, Ideas/Message |
| Films | Plot, World, Characters, Audiovisual presentation, Atmosphere, Direction, Acting, Ideas/Message |
| TV series | Plot, World, Characters, Audiovisual presentation, Atmosphere, Direction, Acting, Ideas/Message |
| Comic | Plot, World, Characters, Atmosphere, Writing style, Ideas/Message |

Global initial criteria are the union above: Plot, World, Characters, Audiovisual presentation, Atmosphere, Gameplay, Direction, Acting, Animation, Writing style, Ideas/Message. The default `Animation` type replaces the former seeded `Anime` type and retains its stable identity where possible. The former seeded `Animated films or series` type is removed. Migration removes only that known seeded type; a user-created type with the same name is retained. Types may overlap conceptually; users choose one per entry and can rename or add types. Each type has a selectable icon. Seed records once using stable identities; upgrades must not recreate defaults the user removed.

Covers, types, reviews, dates, tags, and criterion ratings are optional. Reviews, labeled **Your thoughts** in the interface, support multiline plain text. There is no private-notes field in the current entry model. An optional short label is shown on a constrained media card only when the full title does not fit and a short label exists; otherwise the full title is visually clamped. Details and accessible names retain the full title. Titles remain visible without an image. Release dates support year-only and year/month precision, never a fabricated January 1.

## Deletion behavior

Deleting an unused media type needs no confirmation. Deleting a type assigned to any entry MUST show the affected entry names, total count, and an explicit statement that their type will be cleared. No entries are deleted.

Confirm global criterion deletion only when it belongs to at least one type currently assigned to an entry. The confirmation names impacted types and affected entries and explains removal from current scoring forms. Historical values are retained; deletion means archive, not destructive erasure. An unused criterion can be archived immediately. Renaming does not change identity.

Deleting an entry uses confirmation and a recoverable trash period; permanent removal is a separate explicit action. See [Data safety](../architecture/12-data-safety.md).

## Complete initial product and later extensions

The complete initial product includes all five sections, custom types/criteria/tags, scenes, one shared manual-and-duel canonical ranking, safe archives containing ranking evidence and history, themes, keyboard configuration, resizing, persistent workspaces, meaningful tests, and platform boundaries for macOS, Windows, Android. macOS ships first; platform completion is separately gated, not assumed from a shared toolkit.

Deferred: external service import adapters, accounts/sync/social matching, external public ratings, subscriptions/advertising activation, character-level ratings, adaptation relationships, automatic trope mining, runtime tracking, and longitudinal insights requiring real historical coverage. Store useful events now without claiming the future features already exist.

## Acceptance

A new user can add three text-only works, rate two equally, order them differently, view the same ranks in every section, export all data, and restore the same state. After a duel answer, the canonical order updates only when the posterior clears the documented confidence threshold; manual moves are immediate and never silently replaced by a filtered ranking. A casual user can generate a truthful text recap without filling in criteria or dates. A detailed user can change type/criteria without silently losing old scores.
