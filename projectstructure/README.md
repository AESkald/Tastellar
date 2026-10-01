# Tastellar implementation specifications

Tastellar is the primary product name. OmniList is a former working name, not a separate application. This directory contains the product and architecture authority, delivery notes, and a converted OmniList save. The application currently has a macOS shell, Home, and Library foundation; see [Home foundation](delivery/18-home-foundation.md) and [Library foundation](delivery/19-library-foundation.md).

## Source and authority

Based on the supplied product brief and subsequent user-directed product decisions. The implementation lives in the repository outside this directory; this lowercase `projectstructure` directory is the authoritative specification and project record. The leading-space legacy directory is left untouched.

The supplied brief takes precedence over older ideas. For example, Personal Canon is portrait **9:16**, and duels are not required to use Elo. The notes contribute future directions, not additional first-release requirements. All new specifications and initial interface text are English.

## Start here

1. Read [Product contract](specifications/01-product-contract.md).
2. Read [Architecture](architecture/02-architecture.md), [Data model](architecture/03-data-model.md), and [Commands and queries](architecture/04-contracts.md).
3. Read the specification for the feature being implemented, then [Quality and delivery](delivery/15-quality-and-delivery.md).
4. Follow [Agent implementation protocol](delivery/16-agent-protocol.md). Do not implement this whole directory in one unreviewable change.

## File map

| File | Owns |
| --- | --- |
| [01 Product contract](specifications/01-product-contract.md) | Product principles, terminology, defaults, scope, invariant behaviors |
| [02 Architecture](architecture/02-architecture.md) | Technology decision, dependency boundaries, planned repository, platforms |
| [03 Data model](architecture/03-data-model.md) | Entities, constraints, persistence, ownership, derived values |
| [04 Contracts](architecture/04-contracts.md) | Commands, queries, transactions, errors, cross-tab consistency |
| [05 Shell](specifications/05-shell.md) | Navigation, tabs, panels, resizing, shortcuts, settings, accessibility |
| [06 Home](specifications/06-home.md) | Profile, taste radar, guidelines, external AI prompt |
| [07 Library and editors](specifications/07-library.md) | Groups, search, filtering, details, media/criteria/tag editors |
| [08 Universe scenes](specifications/08-scenes.md) | Scene designs, interaction, lifecycle, graphics budgets |
| [09 Ranking](specifications/09-ranking.md) | Manual ordering, filtered moves, duels, ties, cycles |
| [10 Analytics](specifications/10-analytics.md) | Metrics, eligibility, wording, top lists, boundary review |
| [11 Recap](specifications/11-recap.md) | Templates, compositions, editing, image export |
| [12 Data safety](architecture/12-data-safety.md) | Archive format, migrations, recovery, import, asset handling |
| [13 Platform and localization](architecture/13-platform-and-localization.md) | OS adapters, mobile, contextual translations, privacy, monetization |
| [14 Decision record](architecture/14-decisions.md) | Alternatives, rejected approaches, unresolved validation gates |
| [15 Quality and delivery](delivery/15-quality-and-delivery.md) | Acceptance suites, CI, benchmarks, implementation sequence |
| [16 Agent protocol](delivery/16-agent-protocol.md) | Bounded task handoff and definition of done |
| [18 Home foundation](delivery/18-home-foundation.md) | Current macOS implementation scope, behavior and remaining boundaries |
| [19 Library foundation](delivery/19-library-foundation.md) | Library implementation notes and remaining Unicode name-matching gap |
| [17 Coverage](delivery/17-requirement-coverage.md) | Requirement-to-specification traceability and future ideas |
| [OmniList migration](OmniList-Obsidian-Migration.md) | Conversion rules, source dates, ranking, and media-type choices for the importable [save file](OmniList-Obsidian.tastellar.json) |

## Reading conventions

**MUST** is a required behavior. **Default** is an initial value that may be configurable where stated. **Proposed** indicates an architectural choice requiring the specified implementation-time validation. **Deferred** means explicitly outside the initial complete product, with an extension boundary retained.

Documents describe one coherent target. Delivery stages sequence the work; they do not waive target requirements. Domain and safety contracts override examples of visual presentation. If two documents disagree, fix the specifications before building incompatible behavior.

Important decisions made here: optional unrated works get an explicit Unrated group; completed/rated entries are distinct from planned and dropped entries; manual moves and duel evidence update one canonical order shared across features; score tiers stay fixed unless the user changes a rating; Bayesian fit uncertainty gates automatic adjacent changes; no server or account is required; sparse data never produces invented analysis.
