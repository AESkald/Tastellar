# 18 — Home foundation (v0.1.0, macOS)

## Milestone scope

This milestone covered the macOS foundation, Home, themes, and settings. Library, Ranking, Analytics, and Recap appeared only as navigation icons, tabs, and empty shells at that stage; later foundation notes record their development.

## Implemented shape

Tauri 2 hosts a React/TypeScript interface. Native storage uses SQLite with one serialized writer, explicit transactions and optimistic version checks. The root workspace contains domain validation and storage crates; the host exposes narrow typed commands. Home's UI depends on the bridge, never SQL. Prompt/radar helpers are pure functions tested independently.

Commands: `load_home`, `save_home`, `save_preferences`, `save_workspace`, `save_avatar`, `remove_avatar`, `load_avatar`, `export_home_backup`, `import_home_backup`. The UI serializes mutations and uses the returned committed version for the next command. Conflicts are errors rather than silent overwrites. This is a single-window shell with multiple tabs, not multiple independent native database windows.

This milestone originally introduced five theme choices. The current theme set is System, Daylight, Midnight, Dusk, and Reading; Reading replaces Forest with restrained paper and ink colors, and a saved `forest` choice maps to `reading`. Preferences also include text scale, reduced motion, startup section, restore tabs, previous/next tab shortcuts, radar source and visible criteria. Future scene/Library preferences are not exposed as inert settings.

Home profile supports optional nickname, avatar and stated tastes. Its avatar aligns to the top of the profile card independently of bio length, with equal top, left, and right inner padding. The expanded Library vocabulary adds the default `ideas-message` criterion; a future global criterion registry must migrate this identity explicitly rather than discarding taste inputs. Arbitrary criterion creation belongs to the vocabulary feature.

The later Library foundation supplies reactive saved-entry evidence for favorites and recommendation prompts. The favorites chart uses only selected criteria with at least one qualifying scored favorite and shows sample counts; one or two criteria render as bars, three or more as radar. The prompt includes real library titles and ratings, with optional media-type labels off by default; a no-library message is shown only for an empty saved library. It uses saved “Your thoughts” reviews and has no private-notes field or user-facing character-limit control.

## UX and implementation decisions

- Native macOS traffic lights and draggable titlebar; rail icons reveal labels on hover/focus.
- Tabs support duplicate sections, close/new-tab actions, independent scroll snapshots, drag reordering by the tab label/icon area with a visible insertion marker, and configurable Option+Arrow defaults on macOS. Implement reorder as an in-app pointer gesture with pointer capture and hit testing; do not use HTML drag data or the system pasteboard, which can export a tab as a desktop text clipping in WKWebView. Tauri's native window drag region must not consume the tab gesture. Keyboard users can move a focused tab with Option/Alt+Shift+Left/Right; no visible move-arrow controls are shown. Settings labels the shortcuts Left tab and Right tab; text editors retain caret navigation.
- Empty Library/Ranking group panes can collapse. The details shell can be opened, closed and resized. Full docking/rearrangement remains a later shell stage; no nonexistent work-selection behavior is simulated.
- Profile text, criteria and guideline edits use explicit Save. Dirty dialogs ask before discard. Avatar changes are independent immediately committed operations, labeled accordingly.
- Appearance/settings changes save immediately. Home inputs begin blank and no graph polygon is fabricated.
- Profile text is local. Recommendation creation never contacts a provider; copying is explicit and the text remains selectable if clipboard access fails.
- The browser-only preview is an ephemeral adapter with a visible notice. It is not a second persistence system and is not the native release.

## Home backup v1

Before the full-library archive specification is implemented, this slice provides a separately named `tastellar-home` JSON format, version 1, with `.tastellar-home.json` filenames. It contains Home state, preferences, tabs/panel settings and an optional base64 original avatar with MIME type and SHA-256 hash. It is deliberately not called a full library archive. Future archive support must retain an importer for Home backups.

Exports are staged/flushed and finalized without overwriting an existing file. Restores validate the entire document, avatar and preferences first; create a pre-import recovery copy under the data folder's `backups` directory; then replace the current slice in a transaction. Corrupt/newer data is rejected. Avatar bytes are managed immutably and remain available after replacement; automatic asset deletion is not enabled. Backup files contain personal text and images and are not automatically uploaded.

Avatar staging creates the final asset path only if absent, so a file created during staging cannot be overwritten. Asset reads require a hash-shaped filename within the managed assets directory and reject symlinks. A regression test verifies preservation of an existing asset file.

Schema version 1 is created only for a new database. Unknown or damaged databases are never replaced with an empty library. Full recovery tooling, automated daily backups and released-version migrations need a later data-safety milestone before wider release.

## Platform and release boundaries

At this milestone, only the macOS build had been validated; Windows and Android were architectural targets, not tested claims. Cross-platform, 3D, and export work was deferred from the original stage-0 plan until those features entered scope. This was a local development build, not a signed or notarized public release.

Development launch scripts set `TASTELLAR_DATA_DIR` to `.runtime/development` in the project. Packaged user launches normally use macOS Application Support; test launches must set the project-local override. Toolchains, package caches, browser test assets and build output are project-local and ignored by version control.

## Validation

See the root README for commands. Domain tests cover score/axis inputs and workspace references. Storage tests cover committed persistence, conflicts, image validation and Home backup restoration. Frontend tests cover prompt privacy/budgeting, taste sample eligibility, ties in input shapes and shortcut handling. Browser integration tests exercise Home edits, saved criteria/definitions, prompt copy, dirty-dialog protection, themes, tabs, empty feature shells and compact layout.

## Preview and appearance details

The profile card uses a constrained two-column layout; its orbital decoration has its own clipped layer so the avatar and text remain inside the card padding. Themes are CSS-token palettes rather than hardcoded per-component colors. System theme follows macOS appearance. Native prompt copying uses a clipboard-manager adapter; browser preview uses the browser clipboard and reports permission failure without hiding prompt text. Vite pre-optimizes the native adapters to avoid development-server reloads during the first Home edit. Test browser profiles and Rust/package caches are kept under `.tools`, and native preview data under `.runtime`.
