# 02 — Architecture and intended repository

## Proposed technology decision

Use a **Tauri desktop/mobile host**, a **TypeScript + React web interface**, and a **Rust application/domain core backed by SQLite**. Use a Three.js scene adapter for 3D, HTML/SVG for accessible charts, and a separate deterministic Canvas 2D recap renderer. Use a standard web build tool such as Vite. Pin actual compatible versions only after the platform validation stage; this document does not assert that specific package versions or plugins were checked.

This is a design choice from the supplied requirements, not a claim of measured superiority. It avoids bundling a separate browser runtime on desktop and gives the local data model one implementation across platforms. A system webview can still use substantial memory; budgets require measurement. Tauri Android, graphics behavior, filesystem grants, keyboard handling, and image export must pass the stage-0 spike in [Delivery](../delivery/15-quality-and-delivery.md). If a fundamental gate fails, update this decision before building features, rather than building a second storage core.

No shared server backend is necessary. Rust is an in-process core, not an HTTP service. Android uses the same command layer and domain rules with a mobile shell. Do not introduce Electron, a hosted database, or a native-only scene dependency without revising this decision.

## Dependency direction

`React features → typed command/query bridge → application services → pure domain rules`

Application services depend on interfaces for repositories, transactions, clock, IDs, assets, and platform capabilities. SQLite, the OS filesystem, image decoding, and host plugins implement these interfaces. Domain code does not depend on React, Tauri, SQL, GPU APIs, or payment providers. Infrastructure does not contain business rules.

- **Domain:** validation, group membership, rating changes, canonical ordering, duel model, metric formulas, eligibility rules. Pure functions where practical.
- **Application:** transactional use cases, authorization by capability, import planning, revision checks, background jobs, query projections.
- **Infrastructure:** SQLite repositories/migrations, file/asset storage, archive IO, platform integrations.
- **Frontend:** screen composition, accessibility, transient gestures/drafts, presentation. It never opens the database or modifies archive files directly.
- **Rendering adapters:** scenes and recap exports consume immutable projections. They never assign ratings or order keys.

Persist only committed domain state. Chart/scene caches and query caches are disposable. A single serialized database writer and snapshot readers prevent competing tab writes. Expensive duel fitting, asset processing, archive work, and aggregate jobs run away from the interactive UI thread.

## Planned source structure (do not create application files yet)

| Future location | Responsibility |
| --- | --- |
| `apps/tastellar/src/app/` | Shell, tab routing, layout, composition root |
| `apps/tastellar/src/features/{home,library,ranking,analytics,recap,settings}/` | Feature UI and context-specific translations |
| `apps/tastellar/src/shared/ui/` | Accessible primitives, tokens, formatting |
| `apps/tastellar/src/shared/bridge/` | Generated typed contracts, query cache, revision events |
| `apps/tastellar/src/rendering/{scenes,recap,charts}/` | Render adapters with explicit input models |
| `apps/tastellar/src-tauri/` | Host startup, narrowly scoped capabilities, platform wiring |
| `crates/domain/` | Entities, invariants, ordering, statistics and duel algorithms |
| `crates/application/` | Commands, queries, jobs, interface definitions |
| `crates/storage/` | SQLite, migrations, repositories, backup mechanics |
| `crates/portable_archive/` | Versioned archive validation/import/export |
| `crates/platform/` | Host capability adapters |
| `contracts/` | Versioned wire schemas and generated client definitions |
| `tests/{domain,integration,e2e,fixtures,performance}/` | Shared behavior fixtures and test harnesses |
| `.github/workflows/` | Future CI definitions; signing secrets external |
| `projectstructure/` | This specification set |

This is one application workspace, not microservices. Do not split small components into separately published packages. Framework-specific feature code stays close to its translations/tests.

## State ownership

SQLite: entries, configuration, history, user compositions, canonical order, duel records, profile and saved workspace. Assets directory: immutable cover/avatar files keyed by hash. Frontend query cache: server-like cache of the local core, invalidated by committed revision events. Tab-local state: filters, sort/view, selection, route, scroll, camera. Window-local state: active tab, docking, panel visibility; persisted through the core. Device-local state: display size, paths, hardware settings; never blindly applied across platforms.

Do not put domain records in browser local storage. Do not use full event sourcing: normalized current state plus append-only semantic history is sufficient. Core public contracts must allow a different UI or future synchronization without requiring either now.

## Completion evidence

Dependency checks reject domain-to-host imports. Contract fixtures round-trip between Rust and TypeScript. A headless integration harness can add, rate, reorder, archive, and restore entries without mounting React. The UI works with an unavailable GPU through equivalent list actions.
