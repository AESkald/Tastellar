# 08 — Library universe and rendering contract

Scenes are interactive illustrations of the same canonical data, not the only usable library view. Depend on [Library](07-library.md), [Ranking](09-ranking.md), and the scene projection in [Contracts](../architecture/04-contracts.md).

## Scene concepts

| Group | Representation and rank mapping |
| --- | --- |
| 10/10 | Media solar system: #1 is the sun, others orbit in increasingly distant bands by full-group rank. Orbital phase is a stable ID-derived seed; size/glow varies within bounds so lower ranks remain selectable. |
| 9/10 | Constellations: ranked stars, brighter toward the top; seed positions deterministically. Connecting lines are decorative, never implied thematic relationships. |
| 8/10 | Spiral galaxy: works are distinct stars along arms; high ranks nearer the core. Optional central black hole is decorative, not a work. Background galaxies have no selection hit targets. |
| 7/10 | Deep field: each work is a small galaxy; rank maps to a stable near-to-far visual band, with selected/hovered work brought into focus without changing rank. |
| 6/10 through 1/10 | Muted asteroid fields, with subtle rank-based prominence. Drift wraps at viewport bounds; lower ratings are not mocked with insulting labels or unusable darkness. |
| Plan to Watch | Stellar nursery: glowing protostars inside a nebula suggest possibilities. Placement uses stable manual display order; no implied merit ranking. |
| Dropped | Black hole with works as distinct objects orbiting in the accretion disk; title labels remain legible. Black hole itself is decorative. |
| Unrated | Observatory catalog: calm points on a navigable star map, with no prominence that implies a score. |

Empty groups have a restrained ambient scene plus an actionable empty state; no unlabeled fake works. Single-entry solar system contains just its sun. At large sizes use aggregates/level of detail while guaranteeing access to each work through selection/list/search.

## Interaction and visual language

Pointer drag rotates, wheel/pinch zooms within safe bounds, reset returns to fitted camera. Distinguish click from drag by movement threshold. Click a work dispatches the same SelectEntry action as the list. Hover/focus can show a compact title/year/cover preview; touch uses tap for selection and explicit details. Decorative objects cannot intercept work selection.

Use small thin but readable labels, inspired by graph interfaces. Apply label collision avoidance and prioritize selected/hovered works, then highest ranks. User can show all labels, but renderer may cluster nonselected labels under density limits and explains this setting. Full title is always available outside the scene. Optional shortLabel is user-editable; never invent an abbreviated title from external data. Cap long labels visually, not in stored data.

Palette extraction is asynchronous at asset import: dominant, vibrant, dark-vibrant, light-vibrant, accent, plus extraction-version metadata. Choose accessible glow/accent combinations; a grayscale cover gets a tasteful deterministic fallback. No cover means stable ID-derived palette. Do not decode full covers during animation frames.

Transitions 10→9→8→7 suggest a camera pullback through one universe. These are artistic scale transitions, not physical simulation. Other jumps use a shorter fade/zoom. Reduced motion uses immediate layout changes or subtle fades. Planet orbits actually update over time when motion is enabled; pause when unfocused.

## Stable placement and filtering

Placement derives from full-group order and stable seed. Filters toggle visibility/pickability and label eligibility without rebuilding geometry or regenerating positions. Do not turn the filtered #1 planet into the sun if the actual #1 is hidden. In that case use a dim decorative center with no entry identity. Rank/group edits can recompute affected placement; animate only changed targets. Changing cover palette updates an instance attribute. Visible objects keep IDs; picking resolves through the projection map.

One renderer/context per active window, only for the active visible scene. Inactive tabs store camera state and projection keys; they do not keep WebGL contexts, animation loops, or decoded textures. When the scene collapses, pause immediately and release heavyweight resources after a short idle period. Dispose on navigation/context loss; rebuild from the projection rather than stored GPU state. Cross-scale transitions should interpolate within one renderer rather than retain two full scenes.

## Performance targets and fallback

Initial targets on a declared 8 GB Mac test machine: smooth 60 fps for ordinary groups up to 200 visible objects on medium quality, 30 fps acceptable in automatic low mode; interaction response under 100 ms; no UI lockup during loading. Automatic mode observes frame time and reduces effects with hysteresis, not repeated quality flicker. High mode is optional.

Start with capped device pixel ratio (1.5 medium, 1 low), instanced geometry/sprites, bounded particles, no expensive real-time shadows, optional single low-resolution glow pass, texture atlas thumbnails, and idle/offscreen pause. Soft GPU asset budget 128 MB; use level of detail and label limits for 1,000+ works. Orbit positions are lightweight transforms, not a physics engine.

If initialization fails, context is lost repeatedly, battery-saving disables animation, or graphics are off: show a static 2D universe illustration and the fully functional list. Report “3D unavailable” quietly with retry/settings. A work is never inaccessible because it is too small or occluded in the scene.

## Acceptance

Filter changes reuse object buffers where possible and never reshuffle hidden ranks. List and scene selection match for the same ID. Ten inactive tabs have no continuing scene frame loops. Reduced motion stops orbits and drift. Empty, 1, 200, and 2,000-entry scenes remain usable, including without covers and without WebGL.
