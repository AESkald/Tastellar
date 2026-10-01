# Tastellar 0.3 — macOS app

A local personal media library with rating, score-tier rankings and duel-based ordering. Version 0.3 includes the profile, taste priorities, recommendation prompt, Library, Ranking, portable archives, workspace tabs and settings.

## Run the macOS app

Prerequisites: Node.js, npm, Rust stable, and Xcode command-line tools. A project-local Rust toolchain is used automatically when present under `.tools`; no global installation is required in this workspace.

```sh
npm install
npm run desktop
```

The development launcher stores data in `.runtime/development` inside this project. It uses SQLite, not browser storage. The normal packaged application uses macOS Application Support unless `TASTELLAR_DATA_DIR` is explicitly set.

Build a local macOS app:

```sh
npm run desktop:build
```

Output: `.target/release/bundle/macos/Tastellar.app`. This development build is not notarized for public distribution.

## Browser preview

```sh
npm run dev
```

Open `http://127.0.0.1:1420`. The preview is clearly labeled and keeps changes in memory only; refreshing clears them. Native persistence, avatar validation and backup dialogs must be tested in the macOS app. No browser local storage is used.

## Available now

- Editable nickname, avatar and written tastes; original avatar stored safely with a sanitized display derivative.
- Explicit 1–10 taste priorities; radar for three or more visible qualities, bars for one or two, and honest empty states.
- Editable definitions for all ten rating scores.
- Locally generated, configurable recommendation prompt with preview, inclusion controls and clipboard copy.
- Multiple independent tabs, configurable tab shortcuts, navigation rail, collapsible group sidebar shells and resizable details panel shell.
- System, Daylight, Midnight, Dusk and Forest themes, text sizing, reduced motion, startup and restore-tab settings.
- Portable `.tastellar.json` archives for profile and workspace data, stories, ratings, media types, criteria, tags, history, trash, and original covers/avatar; validation and an automatic recovery archive before restore.

There are no sample works or invented stats. Other platforms, media editors, merge import, import preview, and graphics scenes are not implemented in this slice. Archive size limits and the current JSON format are documented in [data durability](projectstructure/architecture/12-data-safety.md).

## Tests

```sh
npm test
npm run build
npm run test:e2e
```

Browser tests expect the local dev server on port 1420. Install the project-local browser first if needed:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/browsers" npx playwright install chromium
```

Native tests, with the project-local toolchain:

```sh
RUSTUP_HOME="$PWD/.tools/rustup" CARGO_HOME="$PWD/.tools/cargo" CARGO_TARGET_DIR="$PWD/.target" .tools/cargo/bin/cargo test -p tastellar-domain -p tastellar-storage
```

Use ordinary `cargo test` with the same package flags if Rust is installed globally. Storage tests use isolated project-local fixture directories and remove them afterward.

## Structure

`apps/tastellar/src`: React/TypeScript UI, contextual English messages and Home/Library features. `apps/tastellar/src-tauri`: native macOS host and narrow commands. `crates/domain`: validation and data contracts. `crates/storage`: SQLite transactions, managed images and portable Home/Library archives. `projectstructure`: product architecture, feature specifications and current implementation notes.

Start with [the specification index](projectstructure/README.md) or [the Home foundation notes](projectstructure/delivery/18-home-foundation.md).
