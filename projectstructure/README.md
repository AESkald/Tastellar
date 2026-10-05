# Tastellar product and engineering documentation

Tastellar is the product; OmniList is its former working name and the source of the converted save. This directory contains the product and architecture specifications, delivery notes, and migration record. Tastellar has a desktop shell with Home, Library, Analytics, and Recap features; see [Home foundation](delivery/18-home-foundation.md), [Library foundation](delivery/19-library-foundation.md), [Analytics foundation](delivery/20-analytics-foundation.md), and [Recap foundation](delivery/21-recap-foundation.md).

## Source and authority

This directory consolidates the original product brief, later product decisions, architecture, and implementation record. The application source lives at the repository root; these documents are the canonical product and architecture record.

The original product brief takes precedence over older ideas. For example, Personal Canon is portrait **9:16**, and duels are not required to use Elo. Notes contribute future directions, not additional first-release requirements. New specifications and initial interface text are in English.

## Start here

1. Read [Product contract](specifications/01-product-contract.md).
2. Read [Architecture](architecture/02-architecture.md), [Data model](architecture/03-data-model.md), and [Commands and queries](architecture/04-contracts.md).
3. Read the specification for the feature being implemented, then [Quality and delivery](delivery/15-quality-and-delivery.md).
4. Follow the [engineering guidelines](delivery/16-contribution-guidelines.md) and keep changes focused on documented behavior.

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
| [16 Engineering guidelines](delivery/16-contribution-guidelines.md) | Implementation practices, data constraints, and definition of done |
| [18 Home foundation](delivery/18-home-foundation.md) | Initial macOS Home milestone and its implementation boundaries |
| [19 Library foundation](delivery/19-library-foundation.md) | Library implementation notes and remaining Unicode name-matching gap |
| [20 Analytics foundation](delivery/20-analytics-foundation.md) | Current analytics feed behavior, persistence, validation and limits |
| [21 Recap foundation](delivery/21-recap-foundation.md) | Current Recap compositions, editing, watermark and image export behavior and validation boundaries |
| [17 Coverage](delivery/17-requirement-coverage.md) | Requirement-to-specification traceability and future ideas |
| [OmniList migration](OmniList-Obsidian-Migration.md) | Conversion rules, source dates, ranking, and media-type choices for the importable [save file](OmniList-Obsidian.tastellar.json) |

## Reading conventions

**MUST** is a required behavior. **Default** is an initial value that may be configurable where stated. **Proposed** indicates an architectural choice requiring the specified implementation-time validation. **Deferred** means explicitly outside the initial complete product, with an extension boundary retained.

Documents describe one coherent target. Delivery stages sequence the work; they do not waive target requirements. Domain and safety contracts override examples of visual presentation. If two documents disagree, fix the specifications before building incompatible behavior.

Important decisions made here: optional unrated works get an explicit Unrated group; completed/rated entries are distinct from planned and dropped entries; manual moves and duel evidence update one canonical order shared across features; score tiers stay fixed unless the user changes a rating; Bayesian fit uncertainty gates automatic adjacent changes; no server or account is required; sparse data never produces invented analysis.
