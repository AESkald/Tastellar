# 08 — Library universe and rendering contract

Scenes are interactive illustrations of the same canonical data, not the only usable library view. Depend on [Library](07-library.md), [Ranking](09-ranking.md), and the scene projection in [Contracts](../architecture/04-contracts.md).

## Scene concepts

| Group | Representation and rank mapping |
| --- | --- |
| 10/10 | Media solar system: the canonical #1 work is the luminous, opaque round sun; when #1 is filtered out, use a dim identity-free center. If the tier has no ranked works, its first work in canonical display order is the visual center without assigning or persisting a rank. Other works are equally sized, small colored points. Rank sets circular orbital radius, spread progressively from the sun. Points orbit on a shared plane and leave faint circular trails; sun depth occludes works behind it. Do not use fixed-size image sprites or hard oval rings. |
| 9/10 | Constellations: works are bright points in shallow, slightly three-dimensional clusters. Higher rank increases brightness. Connect related media types with fine decorative edges that do not cross from the default view; keep the systems visually separated. Cluster columns and spacing respond deterministically to the scene viewport aspect so a wide stage uses its width. A meaningful resize may recompute the layout while preserving the camera zoom ratio. |
| 8/10 | Spiral galaxy: high-ranked works gather along four soft, semi-transparent spiral-arm volumes made of points of light, dust, and faint glow. Use a centered medium-tilt opening view. Do not use a central black hole, hard schematic spiral lines, fog overlays, or image quads. Background galaxies are smaller and have no selection targets. At maximum manual zoom-out, fade work-title labels fully; fade them back in smoothly as the user zooms closer. Keep work objects and selection available at every zoom. |
| 7/10 | Deep field: every work is a small, irregular galaxy in visibly varied clusters. Work positions lie in one flat 2D plane: no camera orbit or perspective tilt. Start zoomed in enough to show only a portion of the field; users pan and zoom to explore it. Pan is clamped to bounds that include the work-title extents, so no distant empty space can be reached. Background galaxies are smaller and denser. |

The Library universe window appears only on the 10/10, 9/10, 8/10, and 7/10 score groups. Other groups keep the regular Library list and details panel without a scene window. Empty high-score groups have a restrained ambient scene plus an actionable empty state; no unlabeled fake works. A single-entry solar system contains just its sun.

## Interaction and visual language

Use the active app theme for each scene’s background and ambient surface. Dark themes stay near-black with luminous stars and vivid bodies; light themes use the theme’s light surface with dark, inverted bodies and contrast-matched glow. Keep the scene header/footer and a thin inset frame in theme colors. The desktop scene stage is about 320–380px tall; compact layouts use a shorter 240–290px stage. On 10/9/8, pointer drag rotates and wheel/pinch zooms within hard fitted bounds. On 7, dragging pans the 2D map, wheel/pinch zooms within map bounds, and orbit controls are disabled. Reset returns to the group’s default view. Saved camera state distinguishes a user-adjusted view from the default; when defaults change, an unadjusted or legacy saved view follows the new default. Scale-transition travel may exceed manual bounds. Distinguish click from drag by movement threshold. Click a work dispatches the same SelectEntry action as the list. Decorative objects cannot intercept work selection.

Keep sky stars sparse, with solid cores large enough to read at normal zoom (about 2.5–3 CSS pixels); map them black on light surfaces and pale on dark surfaces. Rating-8 distant galaxies are sparse, dim particles in fixed tilted world planes and rotate with the sky. Rating 7 has no environmental starfield or background galaxies; only work galaxies appear there, with opacity increasing by canonical rank.

Keep the existing Library group arrows and sort control immediately above the scene stage; do not add a second set of scene-specific arrows. When no scene is shown (for example, score 6), the toolbar remains in its normal position above the list.

Show every work’s full title as small, thin plain text by default. Groups above 60 works use a slightly smaller fixed label size and wrap long names within a narrower width. Labels have no pill, fog, or leader-tick treatment. Anchor each label at one fixed screen offset from its projected work and move it only as that work moves; do not collision-pack, search for alternate slots, or reassign labels. Nearby names may overlap in dense scenes. Selected/hovered labels may gain contrast without changing position. The explicit label control can hide or restore all labels; never cap or silently omit labels due to density. A user-authored shortLabel may replace the full title only when explicitly present. Never invent abbreviations or truncate the displayed name.

Palette extraction is asynchronous when a cover is first loaded: dominant, vibrant, dark-vibrant, light-vibrant and accent colors are cached in memory with an extraction version. The palette cache is runtime-only and recomputes after restart; no palette fields are added to the entry or archive schema. Choose accessible glow/accent combinations; a grayscale cover gets a tasteful deterministic fallback. No cover means stable ID-derived palette. Do not decode full covers during animation frames.

Every jump among distinct 10/10, 9/10, 8/10, and 7/10 groups uses the same two-phase 950ms camera journey, including direct jumps. The 7/10 map remains face-on at handoff; it does not orbit. These transitions may pass beyond manual zoom limits and must finish at the new scene’s fitted camera. Keep work titles fully hidden during travel, then reveal them with the renderer’s 200ms fade; the UI gate releases at the end of the camera journey. Reduced motion uses a short layout change and fade. Planet orbits actually update over time when motion is enabled; pause when unfocused. The 7/10 map itself is static.

## Stable placement and filtering

Placement derives from full-group order and stable seed. Filters toggle visibility/pickability and label eligibility without rebuilding geometry or regenerating positions. Do not turn the filtered #1 planet into the sun if the actual #1 is hidden. In that case use a dim decorative center with no entry identity. Rank/group edits can recompute affected placement; animate only changed targets. Changing cover palette updates an instance attribute. Visible objects keep IDs; picking resolves through the projection map.

One renderer/context per active window, only for the active visible scene. Inactive tabs store camera state and projection keys; they do not keep WebGL contexts, animation loops, or decoded textures. When the scene collapses, pause immediately and release heavyweight resources after a short idle period. Dispose on navigation/context loss; rebuild from the projection rather than stored GPU state. Cross-scale transitions should interpolate within one renderer rather than retain two full scenes.

The current implementation uses a small isolated native WebGL renderer with a 2D canvas fallback; it does not add Three.js. This keeps the renderer replaceable behind the scene projection and avoids a second scene graph/runtime in the app bundle. This is an implementation decision, not a claim that WebGL behavior or performance has been validated on every native webview.

## Performance targets and fallback

Initial targets on a declared 8 GB Mac test machine: smooth 60 fps for ordinary groups up to 200 visible objects on medium quality, 30 fps acceptable in automatic low mode; interaction response under 100 ms; no UI lockup during loading. Automatic mode observes frame time and reduces effects with hysteresis, not repeated quality flicker. High mode is optional.

Start with capped device pixel ratio (1.5 medium, 1 low), instanced geometry/sprites, bounded particles, no expensive real-time shadows, optional single low-resolution glow pass, texture atlas thumbnails, and idle/offscreen pause. Soft GPU asset budget 128 MB; use level of detail while keeping every work label available at ordinary library sizes. Orbit positions are lightweight transforms, not a physics engine.

If initialization fails, context is lost repeatedly, battery-saving disables animation, or graphics are off: show a static 2D universe illustration and the fully functional list. Report “3D unavailable” quietly with retry/settings. A work is never inaccessible because it is too small or occluded in the scene.

## Acceptance

Filter changes reuse object buffers where possible and never reshuffle hidden ranks. List and scene selection match for the same ID. Zooming the 8/10 scene fades its titles without hiding or disabling work selection. The 7/10 scene never changes camera yaw or pitch; its map pan and zoom remain bounded and are saved per Library tab. Groups outside 10–7 render no universe scene. Ten inactive tabs have no continuing scene frame loops. Reduced motion stops orbits. Empty and populated high-score scenes remain usable, including without covers and without WebGL.
