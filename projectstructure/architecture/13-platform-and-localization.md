# 13 — Platforms, localization, privacy, future entitlements

## Platform boundary

All three targets use the same domain/application/storage contracts. Native adapters expose capabilities, not assumptions based on OS names. Initial capability interfaces: user file pick/save, managed asset IO, clipboard text/image, reveal file, share image, window geometry, background lifecycle, keyboard modifiers, reduced motion/theme, secure secret storage (future integrations), update/install channel, and diagnostics.

| Concern | macOS / Windows | Android |
| --- | --- | --- |
| Navigation | Desktop rail, top tabs, resizable/dockable panes | Bottom primary navigation, tab switcher, sheets and touch actions |
| Files | Native file dialogs; explicit selected paths | Scoped document picker and persistable grants where supported; do not require broad storage permission |
| Export | Save PNG/archive; optional reveal | Save through document provider or share sheet |
| Lifecycle | Close/minimize/background suspend scene | Pause rendering/jobs safely; resume from persisted state after process death |
| Keyboard | User mappings, native modifier labels | Hardware keyboard support optional enhancement, touch parity required |
| Updates | Signed distribution and installer verification | Store/package channel; same migration invariants |

Mobile initially has one visible work area but supports multiple saved tabs. Do not keep desktop dock widths on a phone. Heavy jobs persist checkpoints where safe and surface interruption; UI must never assume an Android background task will finish. Re-check file permissions when resuming. Native plugins remain narrow and auditable.

No accounts/sync server is needed for multi-platform support. Manual archive transfer is the initial transfer method. UUIDs, revisions, external identities, and event provenance create useful future seams, but do not claim to solve distributed conflicts. Future sync requires a separate conflict/tombstone/encryption specification.

## Localization contract

All initial UI text is English. Keep every fixed, user-visible frontend string in context-owned `messages/en.json` catalogs alongside its feature; shared shell, bridge fallbacks, accessible labels, dialogs, errors, native file-picker labels, and primitives use the shared catalog. Store whole messages with semantic variables and plural/select rules through an ICU-compatible message layer, not translated word fragments glued into English sentences. Components look up messages through the shared `t()` function. English literals in JSX, attributes, or surfaced error fallbacks are localization defects.

Keys name intent, not the current English wording. Include translator context for score/group meanings, placeholder type, and constrained UI locations. Example intent: deletion dialog has one pluralized full message with count, while the affected title list is a separate accessible list. User media type/tag names are data, never translation keys. Stable default vocabulary has a `defaultKey`; untouched seeded labels can display localized defaults, while a user rename is preserved exactly. Fixed criterion labels, chart accessibility labels, and the copyable recommendation-prompt template belong in the Home catalog; user profile, review, title, and guideline text remains data.

Use locale-aware numbers, plurals, dates, and collation. Ordering keys are binary and locale-independent. Search should support normalized text without altering saved spelling; do not strip distinctions from names when presenting them. Future right-to-left locales require logical spacing/docking properties and mirrored navigation as appropriate; do not mirror cover artwork or numerical charts without meaning. Export renderer needs font fallback and shaping support; validate this before claiming support for each new locale.

Pseudo-localization with expansion, non-Latin scripts, and RTL fixtures is part of CI. User content already may be multilingual even while the interface is English. No sentence concatenation for analytics, archive errors, or prompt help. The copyable external-AI prompt has a dedicated context-specific template catalog so the template can be translated independently from its user-supplied content.

## Privacy and external data

Reviews, profiles, prompts and archives remain local unless the user exports, shares, or manually copies them. Clipboard copy is explicit. Prompt generation never sends a request. Diagnostic logging defaults to technical codes/counts, excludes content and full paths; telemetry is absent initially. File imports and future remote metadata are untrusted text, not executable markup. Restrict webview bridge capabilities and remote navigation; never expose arbitrary filesystem/network commands to UI content.

Future provider imports implement `detect → parse → normalize → map → preview → commit` and feed the same import application service. Preserve provider IDs and source provenance. Separate source rating from the converted personal rating; show the conversion mapping explicitly. Handle missing dates, duplicate editions, tags, unavailable covers, and provider-specific statuses without guessing. IMDb, Goodreads, and MyAnimeList adapters are deferred until supported formats/access terms are verified at implementation time. Do not promise scraping or current API availability.

## Entitlements and advertising boundary

Define an entitlement service returning typed capabilities such as `recap.premium_styles` and `analytics.advanced`; local development uses an explicit free-capability implementation. Feature boundaries consult capabilities for optional entry points. Keep entity tables, readers, rating edits, archive export/import, backup/recovery, and already-owned data independent of payment state. Never encrypt a user's library behind a subscription key.

Expired entitlements must leave saved compositions readable and basic editing/export available; premium styling may be preserved for existing drafts, while creating new premium drafts can be gated under a later explicit policy. No purchase flow or remote checks in the initial product. Advertising, if added later, lives in an isolated presentation adapter, has no raw-library access, and cannot block navigation, recovery, or exports. A new privacy/consent specification is required before activation.

## Acceptance

Same domain fixture results on all platforms; storage permissions fail recoverably; Android process death loses no committed rating/order changes. English UI handles long custom names and Unicode reviews. Entitlement loss cannot lock a library or its full-fidelity archive. A future integration can add provider-specific parsing without changing Entry IDs or screen business rules.
