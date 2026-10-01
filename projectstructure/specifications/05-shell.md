# 05 — Shell, workspace, settings, accessibility

## Navigation and tabs

Desktop has a persistent narrow left rail: Home, Library, Ranking, Analytics, Recap; Settings bottom-aligned. Hover reveals the section label without shifting main content. Focus and touch provide the same label through accessible name and tooltip/long press. Rail icons are buttons with visible focus states.

Top bar contains tabs, close buttons, a new-tab button immediately after them, and a top-right contextual-panel toggle. Default first launch opens Home. Clicking a rail destination navigates the active tab. New tab opens a section chooser; a modifier action on a rail item opens a new tab. Multiple instances of any section, including Analytics at distinct scroll locations, are supported. Reopening a section does not collapse existing tabs into one. Drag the tab's label/icon area to reorder it; show a clear insertion marker during the drag. Keep activation and close actions separate from dragging. Reordering preserves each tab's identity and saved view state. Keyboard users can focus a tab and use Option/Alt+Shift+Left/Right to move it; do not add visible move-arrow controls.

Each tab owns route/subview, filter, search, selected group, selected entry, list mode, column preferences, scroll anchor, analytics selection seed, and scene camera. Switching tabs restores these. Data edits are global and invalidate relevant queries in every tab. Inactive tabs retain lightweight state, not live render loops or mounted scene resources.

Option + Left/Right Arrow is the configurable default tab switch shortcut on macOS (represented internally as Alt+ArrowLeft/Right); the shortcut editor labels these Left tab and Right tab. Do not steal native word/caret navigation from editors. Provide discoverable Left tab and Right tab commands and a keyboard shortcut editor that captures modifier/key combinations and rejects conflicts/reserved commands. Tab overflow scrolls with an accessible menu. Closing the final tab opens a fresh Home tab. Closing a tab with an unsaved editor prompts save/discard/cancel; saved recap drafts survive closure. Closing the native window flushes queued persistence, destroys the primary window through its allowed Tauri capability, then exits the single-window process.

## Contextual right panel

Modes: work details, filters, optional section-specific inspector. On an untouched tab, details opens the window's last selected existing work; explicit selection becomes tab-local. Opening filters remembers the previous details ID. Closing filters restores it. Selection from list/scene/search routes through one selection action. Selecting a trashed/deleted work in another tab clears the stale details with an explanation.

Panel content uses the same balanced inset spacing across modes. Import/export controls align to the work-details content inset; modal confirmation content has clear padding at the top and on both sides, including replace-data confirmations.

Library and Ranking additionally have a collapsible group/search column. Analytics and Recap MUST NOT inherit that column. The right panel can be available there for explicit work selection; recap composition settings live in its own inspector mode. Home does not open a random details panel by default.

## Resizing and rearrangement

Desktop defaults: rail 56 logical px, group column 208, details 340, main minimum 320. These are design starting values, not inflexible widths. Persist a validated dock tree with a mandatory main region and optional group/details nodes. Users can dock either auxiliary pane to the left or right of main, swap auxiliary panes, resize splitters, or collapse them. Do not allow a layout that hides the main region entirely. Include Reset layout.

At insufficient width, migrate auxiliary panes to one overlay drawer at a time, preserving desktop geometry for later restoration. Below approximately 640 px use a compact shell: menu access to navigation, tab switcher, one main view, and details/filter sheets. Android uses bottom primary navigation and this compact tab switcher; it is not a squeezed desktop sidebar. On desktop small windows remain usable down to a declared 360 × 480 logical px supported content size; below that rely on OS minimum constraints. Content scrolls; controls never become inaccessible.

Save layout on settled resize/dock actions, not every pointer pixel. Restore clamped bounds after monitor/DPI changes. Saved geometry is per device/layout class. Dragging splitters has keyboard equivalents and minimum sizes. Scene and list split is vertically resizable and collapsible separately.

## Visual behavior

Use spacing/typography/color tokens, neutral surfaces, restrained accent colors, and consistent selection/focus indicators. Closed select controls have a minimum 38 px height, 8 px vertical inset, and 12 px horizontal inset across settings, prompts, filters, and editors. Opened choices use a theme-aware app-rendered listbox with padded rows, keyboard navigation, and screen-reader semantics so their insets stay consistent across packaged webviews and browser previews. Use short 120–220 ms panel transitions and 300–600 ms scene transitions as starting targets. Preserve scroll anchors across data refresh. Show skeletons only for meaningful latency; do not flash placeholders for fast local reads. Save indicators and undo toasts explain completed actions without constant celebration.

Support System, Daylight, Midnight, Dusk, and Reading themes. Reading uses restrained, low-glare paper and ink colors for long reading sessions; it makes no medical claim and must retain accessible text and control contrast. Migrate a saved `forest` theme preference to `reading` so the preference remains valid. Cover colors tint scenes and small accents, not text contrast. Maintain readable focus, selected, hover, disabled, and error states independently of color. New palettes remain token-based.

## Settings

Profile links; theme; font/text scale; reduced motion (system default); graphics auto/low/medium/high/off; scene labels and animation toggle; startup section and restore tabs; default Library view and table columns; keyboard shortcuts with conflict detection/reset; media/criteria/tag editors; date/number display locale; archive import/export; backup location/retention/status; trash recovery; local diagnostic controls. Put **Reset media ranking** in **Data & privacy** beside archive tools; require confirmation, clear active ranking evidence/sessions/placements, preserve library entries and 1–10 scores, and warn that existing backups/exports are unchanged and can restore the ranking history. Keep **Reset workspace** as a separate destructive action that permanently removes all app-managed profile, Library, preference, workspace, history, trash, managed asset, and backup data on this device before returning to seeded defaults. Separately exported archive files are not deleted by workspace reset. Future entitlement display must not obscure local data tools.

Reserved OS shortcuts are warned/rejected where known. Capture shortcuts using actual modifier/key semantics per OS and label them correctly. Do not bind destructive actions to ambiguous single keys.

## Accessibility and acceptance

All core flows work by keyboard and screen reader, including add/edit, reordering with Move up/down/to-position, duels, filtering, and recap slot replacement. Drag, hover, image color, and 3D cannot be required. Respect reduced motion by stopping orbits/drift and using fades; no flashing effects. Controls target 44 logical px for touch, with compact visual icons allowed inside larger hit areas. Dialogs/sheets manage focus and return it to the opener. Verify contrast and 200% text scaling.

Acceptance: two Analytics tabs keep independent scroll/filter states through restart; opening filters and closing them restores prior details; collapse/rearrange survives relaunch; a narrow window and an Android phone can reach all primary actions without horizontal control clipping.
