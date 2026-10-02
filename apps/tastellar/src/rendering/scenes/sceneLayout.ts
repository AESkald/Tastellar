import { paletteFromSeed, type UniversePalette } from "./palette";

export type UniverseGroup = "10" | "9" | "8" | "7" | "6" | "5" | "4" | "3" | "2" | "1" | "planned" | "dropped" | "unrated";
export type UniverseQuality = "auto" | "off" | "low" | "medium" | "high";

/**
 * Default camera for the rating-8 galaxy, in radians.
 * Edit these values to change its opening view (yaw ≈ 5.7°, pitch ≈ 51.6°).
 */
export const GALAXY_DEFAULT_CAMERA = Object.freeze({ yaw: 0.4, pitch: -0.9 });

export interface UniverseWork {
  id: string;
  title: string;
  shortLabel?: string | null;
  /** One-based position in the full canonical score-tier order; null means unplaced. */
  rank: number | null;
  /** Numeric score, used to order combined low-score asteroid fields. */
  rating?: number | null;
  /** Stable order for planned and other unranked groups, with no merit implication. */
  displayOrder?: number;
  mediaTypeId?: string | null;
  coverAssetId?: string | null;
  palette?: Partial<UniversePalette>;
}

export interface UniverseProjection {
  group: UniverseGroup;
  /** Full group in canonical order. Filters must only change visibleIds. */
  works: readonly UniverseWork[];
  /** Current 3D stage dimensions; scene layouts use these to fill wide or narrow viewports. */
  viewportAspect?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  /** When present, only these IDs render and receive projected label positions. */
  visibleIds?: ReadonlySet<string>;
  /** Optional transition key for content changes within the same group. */
  key?: string;
}

export interface UniverseTheme {
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  ambient?: string;
}

export interface UniverseScreenObject {
  id: string;
  /** CSS pixels from the canvas's top-left corner. */
  x: number;
  y: number;
  /** Approximate rendered diameter in CSS pixels. */
  size: number;
  /** Normalized depth; 0 is nearest and 1 is farthest. */
  depth: number;
  /** False when masked, fading out, or outside the canvas bounds. */
  visible: boolean;
  /** True only when the rendered work anchor lies inside the interactive viewport. */
  selectable?: boolean;
  /** Optional opacity for smoothly fading labels during scale transitions. */
  labelOpacity?: number;
}

export interface UniverseViewState {
  group: UniverseGroup;
  yaw: number;
  pitch: number;
  distance: number;
  /** World-space pan for bounded orthographic scenes. */
  panX?: number;
  panY?: number;
  /** True only after a user manually changes this view. */
  userAdjusted?: boolean;
}

export type UniverseRendererStatus = "ready" | "fallback";

export interface UniverseRendererOptions {
  projection: UniverseProjection;
  theme: UniverseTheme;
  quality?: UniverseQuality;
  motion?: boolean;
  active?: boolean;
  initialViewState?: UniverseViewState | null;
  onProjected?: (objects: readonly UniverseScreenObject[]) => void;
  onViewStateChange?: (state: UniverseViewState) => void;
  onStatus?: (status: UniverseRendererStatus) => void;
}

export type SpriteKind = "star" | "planet" | "galaxy" | "asteroid" | "blackHole" | "nebula" | "armGlow" | "sun";
export interface LayoutObject {
  id?: string;
  work?: UniverseWork;
  kind: SpriteKind;
  x: number;
  y: number;
  z: number;
  size: number;
  color: string;
  seed: number;
  alpha: number;
  orbitRadius?: number;
  orbitSpeed?: number;
  orbitPhase?: number;
  orbitYScale?: number;
  driftX?: number;
  driftY?: number;
}

export interface SceneLayout {
  group: UniverseGroup;
  cameraDistance: number;
  /** Optional scene-specific camera defaults used before a saved view is restored. */
  defaultYaw?: number;
  defaultPitch?: number;
  /** Optional world-space extents used by bounded orthographic scenes. */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  objects: LayoutObject[];
  lines: Array<{ points: Array<[number, number, number]>; color: string; alpha: number; closed?: boolean }>;
}

interface LabelAnchorPosition {
  x: number;
  y: number;
  halfWidth: number;
}

export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unit(seed: number, offset = 0): number {
  let value = (seed + Math.imul(offset + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function jitter(seed: number, offset: number, range: number): number {
  return (unit(seed, offset) * 2 - 1) * range;
}

function colorFor(work: UniverseWork, fallback?: string): string {
  return work.palette?.dominant ?? work.palette?.vibrant ?? fallback ?? paletteFromSeed(work.id).dominant;
}

function labelHalfWidth(work: UniverseWork): number {
  const characters = (work.shortLabel || work.title).length;
  const estimatedPixels = Math.min(250, characters * 6 + 8);
  return Math.max(1.15, Math.min(4, estimatedPixels / 74));
}

function labelClearance(x: number, y: number, halfWidth: number, other: LabelAnchorPosition): number {
  const dx = x - other.x;
  const dy = y - other.y;
  const xRadius = Math.max(2.3, halfWidth + other.halfWidth);
  const yRadius = 0.78;
  return dx * dx / (xRadius * xRadius) + dy * dy / (yRadius * yRadius);
}

function typeColor(mediaTypeId: string | null | undefined, index: number): string {
  if (!mediaTypeId) return `hsl(${190 + index * 37} 44% 72%)`;
  const hue = stableHash(mediaTypeId) % 360;
  return `hsl(${hue} 55% 73%)`;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function diskPoint(angle: number, radius: number, y = 0): [number, number, number] {
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
}

function solarOrbitRadius(rank: number): number {
  const offset = Math.max(0, rank - 2);
  return offset <= 18
    ? 1.3 + offset * 2.35
    : 1.3 + 18 * 2.35 + Math.log2(offset - 17) * 2.5;
}

function shallowPoint(angle: number, radius: number, depth: number): [number, number, number] {
  return [Math.cos(angle) * radius, Math.sin(angle) * radius, depth];
}

function fitDistance(halfWidth: number, halfHeight: number, minimum = 12, viewportAspect = 1.8): number {
  // Use a wide-library-stage estimate while leaving a comfortable edge margin.
  const verticalDistance = halfHeight / Math.tan(Math.PI / 6);
  const horizontalDistance = halfWidth / (Math.tan(Math.PI / 6) * Math.max(0.45, viewportAspect));
  return Math.max(minimum, Math.max(verticalDistance, horizontalDistance) * 1.12);
}

function projectionAspect(projection: UniverseProjection, fallback = 3.2): number {
  const measured = projection.viewportAspect
    ?? (projection.viewportWidth && projection.viewportHeight ? projection.viewportWidth / projection.viewportHeight : fallback);
  return Math.max(0.45, Math.min(4.5, Number.isFinite(measured) ? measured : fallback));
}

function gridCenters(count: number, spacingX: number, spacingY: number, aspect: number): Array<[number, number]> {
  if (!count) return [];
  const columns = Math.min(count, Math.ceil(Math.sqrt(count * aspect)));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return [(column - (columns - 1) / 2) * spacingX, ((rows - 1) / 2 - row) * spacingY];
  });
}

function spiralPoint(index: number, spacing: number, seed: number): [number, number] {
  const angle = index * GOLDEN_ANGLE + unit(seed, 0) * 0.09;
  const radius = spacing * Math.sqrt(index);
  return [Math.cos(angle) * radius + jitter(seed, 1, 0.035), Math.sin(angle) * radius + jitter(seed, 2, 0.035)];
}

function planarMst(members: readonly LayoutObject[], color: string, alpha: number): SceneLayout["lines"] {
  if (members.length < 2) return [];
  const lines: SceneLayout["lines"] = [];
  const visited = new Uint8Array(members.length);
  const nearestDistance = new Float64Array(members.length);
  const nearestParent = new Int32Array(members.length);
  nearestDistance.fill(Number.POSITIVE_INFINITY);
  visited[0] = 1;
  const origin = members[0];
  for (let index = 1; index < members.length; index += 1) {
    const dx = origin.x - members[index].x;
    const dy = origin.y - members[index].y;
    nearestDistance[index] = dx * dx + dy * dy;
    nearestParent[index] = 0;
  }
  for (let edge = 1; edge < members.length; edge += 1) {
    let next = -1;
    for (let index = 1; index < members.length; index += 1) {
      if (!visited[index] && (next < 0 || nearestDistance[index] < nearestDistance[next])) next = index;
    }
    if (next < 0) break;
    const from = members[nearestParent[next]];
    const to = members[next];
    lines.push({ points: [[from.x, from.y, from.z], [to.x, to.y, to.z]], color, alpha });
    visited[next] = 1;
    for (let index = 1; index < members.length; index += 1) {
      if (visited[index]) continue;
      const dx = to.x - members[index].x;
      const dy = to.y - members[index].y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance[index]) {
        nearestDistance[index] = distance;
        nearestParent[index] = next;
      }
    }
  }
  return lines;
}

function layoutSolar(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  const lines: SceneLayout["lines"] = [];
  const canonicalOrder = new Map(projection.works.map((work, index) => [work.id, index] as const));
  const placed = projection.works.filter((work) => work.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const unplaced = projection.works
    .filter((work) => work.rank === null)
    .sort((a, b) => (a.displayOrder ?? canonicalOrder.get(a.id) ?? 0) - (b.displayOrder ?? canonicalOrder.get(b.id) ?? 0));
  const rankedFirst = placed.find((work) => work.rank === 1);
  // An entirely unranked solar tier still has a visual centerpiece, using its
  // canonical display order without writing a synthetic rank into the work.
  const first = rankedFirst ?? (placed.length === 0 ? unplaced[0] : undefined);
  // The identity-free center stays in place if filtering hides the canonical #1 work.
  objects.push({ kind: "sun", x: 0, y: 0, z: 0, size: first ? 0.92 : 1.05, color: "#ffe3a0", seed: 17, alpha: first ? 0.18 : 0.85 });
  if (first) objects.push({ id: first.id, work: first, kind: "sun", x: 0, y: 0, z: 0, size: 0.92, color: colorFor(first, "#ffca76"), seed: stableHash(first.id), alpha: 1 });
  const outerPlacedRadius = placed.reduce((maximum, work) => {
    const rank = work.rank ?? 1;
    if (rank <= 1) return maximum;
    return Math.max(maximum, solarOrbitRadius(rank));
  }, 0);
  for (const work of placed) {
    const rank = work.rank ?? 1;
    if (work.id === first?.id || rank === 1) continue;
    const seed = stableHash(work.id);
    const radius = solarOrbitRadius(rank);
    const phase = unit(seed, 0) * Math.PI * 2;
    const speed = 0.07 + unit(seed, 1) * 0.055;
    const [x, y, z] = diskPoint(phase, radius);
    objects.push({ id: work.id, work, kind: "planet", x, y, z, size: 0.14, color: "#a9d4f4", seed, alpha: 0.82, orbitRadius: radius, orbitSpeed: speed, orbitPhase: phase, orbitYScale: 0 });
  }
  let unplacedOrbitIndex = 0;
  unplaced.forEach((work) => {
    if (work.id === first?.id) return;
    const seed = stableHash(work.id);
    const angle = unit(seed, 3) * Math.PI * 2;
    const radius = (outerPlacedRadius > 0 ? outerPlacedRadius + 2.35 : 1.3) + unplacedOrbitIndex * 2.35;
    unplacedOrbitIndex += 1;
    const [x, y, z] = diskPoint(angle, radius);
    objects.push({ id: work.id, work, kind: "planet", x, y, z, size: 0.14, color: "#a9d4f4", seed, alpha: 0.82, orbitRadius: radius, orbitSpeed: 0.07 + unit(seed, 5) * 0.055, orbitPhase: angle, orbitYScale: 0 });
  });
  const farthestOrbit = objects.reduce((maximum, object) => Math.max(maximum, object.orbitRadius ?? Math.hypot(object.x, object.y, object.z)), 0);
  return { group: "10", cameraDistance: fitDistance(farthestOrbit, farthestOrbit * 0.86, 10.5), defaultYaw: 0.1, defaultPitch: 0.5, objects, lines };
}

function layoutConstellations(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  const lines: SceneLayout["lines"] = [];
  const groups = new Map<string, UniverseWork[]>();
  for (const work of projection.works) {
    const key = work.mediaTypeId ?? "__none__";
    const group = groups.get(key) ?? [];
    group.push(work);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  const largestCluster = Math.max(1, ...[...groups.values()].map((members) => members.length));
  const widestTitle = Math.max(1.15, ...projection.works.map(labelHalfWidth));
  const localSpacing = 3.1;
  const localSpreadRadius = localSpacing * Math.sqrt(Math.max(0, largestCluster - 1));
  const clusterHalfWidth = Math.max(1.15, localSpreadRadius + widestTitle + 0.2);
  const clusterHalfHeight = Math.max(1.15, localSpreadRadius + 11 / 74 + 0.2);
  const aspect = projectionAspect(projection);
  const centers = gridCenters(keys.length, clusterHalfWidth * 2 + 0.6, clusterHalfHeight * 2 + 0.6, aspect);
  const rankMaximum = Math.max(1, projection.works.length - 1);
  const pointByType = new Map<string, LayoutObject[]>();

  keys.forEach((key, clusterIndex) => {
    const members = [...(groups.get(key) ?? [])].sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return a.id.localeCompare(b.id);
    });
    const [centerX, centerY] = centers[clusterIndex] ?? [0, 0];
    const typeId = key === "__none__" ? null : key;
    const clusterObjects: LayoutObject[] = [];
    members.forEach((work, index) => {
      const seed = stableHash(work.id);
      const [localX, localY] = spiralPoint(index, localSpacing, seed);
      const rankFraction = work.rank === null ? 0.72 : Math.max(0, Math.min(1, (work.rank - 1) / rankMaximum));
      const brightness = 1 - rankFraction * 0.78;
      const object: LayoutObject = {
        id: work.id,
        work,
        kind: "star",
        x: centerX + localX,
        y: centerY + localY,
        z: jitter(seed, 5, 0.8),
        size: 0.095 + brightness * 0.19,
        color: work.rank === 1 ? "#fff3c5" : colorFor(work, typeColor(typeId, clusterIndex)),
        seed,
        alpha: 0.5 + brightness * 0.5,
      };
      objects.push(object);
      clusterObjects.push(object);
    });
    pointByType.set(key, clusterObjects);
  });

  for (const [index, key] of keys.entries()) {
    lines.push(...planarMst(pointByType.get(key) ?? [], typeColor(key === "__none__" ? null : key, index), 0.14));
  }
  const bounds = objects.reduce((result, object) => ({
    x: Math.max(result.x, Math.abs(object.x) + (object.work ? labelHalfWidth(object.work) : object.size)),
    y: Math.max(result.y, Math.abs(object.y) + (object.work ? 11 / 74 : object.size)),
  }), { x: 1, y: 1 });
  return { group: "9", cameraDistance: fitDistance(bounds.x, bounds.y, 5, aspect), defaultYaw: 0.05, defaultPitch: 0.08, objects, lines };
}

function layoutGalaxy(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  const lines: SceneLayout["lines"] = [];
  const rankOne = projection.works.find((work) => work.rank === 1);
  const densityScale = Math.max(1, Math.sqrt(projection.works.length / 90));
  const galaxyRadius = 11 * densityScale;
  const workCells = new Map<string, number[]>();
  const workPositions: LabelAnchorPosition[] = [];
  const cellWidth = 2.5;
  const cellHeight = 0.78;
  const cellCoordinates = (x: number, y: number) => [Math.floor(x / cellWidth), Math.floor(y / cellHeight)] as const;
  const cellKey = (x: number, y: number) => `${x},${y}`;
  const nearestClearance = (x: number, y: number, halfWidth: number): number => {
    const [cellX, cellY] = cellCoordinates(x, y);
    let nearest = Number.POSITIVE_INFINITY;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
        for (const index of workCells.get(cellKey(cellX + offsetX, cellY + offsetY)) ?? []) {
          nearest = Math.min(nearest, labelClearance(x, y, halfWidth, workPositions[index]));
        }
      }
    }
    return nearest;
  };
  const addPosition = (x: number, y: number, work: UniverseWork): void => {
    const index = workPositions.length;
    workPositions.push({ x, y, halfWidth: labelHalfWidth(work) });
    const [cellX, cellY] = cellCoordinates(x, y);
    const key = cellKey(cellX, cellY);
    const entries = workCells.get(key) ?? [];
    entries.push(index);
    workCells.set(key, entries);
  };
  if (rankOne) {
    addPosition(0, 0, rankOne);
    objects.push({ id: rankOne.id, work: rankOne, kind: "star", x: 0, y: 0, z: 0, size: 0.86, color: colorFor(rankOne, "#ffe7b5"), seed: stableHash(rankOne.id), alpha: 1 });
  }
  const count = Math.max(1, projection.works.length - 1);
  const workArms = 4;
  const remainingWorks = projection.works
    .filter((work) => work.rank !== 1)
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank !== null && b.rank === null) return -1;
      if (a.rank === null && b.rank !== null) return 1;
      return stableHash(a.id) - stableHash(b.id) || a.id.localeCompare(b.id);
    });
  for (const work of remainingWorks) {
    const seed = stableHash(work.id);
    const radial = work.rank === null
      ? Math.sqrt(unit(seed, 0))
      : Math.max(0.015, Math.min(1, (work.rank - 1) / count));
    const radius = 0.35 + radial * (galaxyRadius - 0.8);
    const arm = Math.floor(unit(seed, 2) * workArms);
    const angle = arm / workArms * Math.PI * 2 + radial * 4.2 + jitter(seed, 1, 0.35);
    const desiredX = Math.cos(angle) * radius;
    const desiredY = Math.sin(angle) * radius;
    const halfWidth = labelHalfWidth(work);
    let selected: [number, number] | null = null;
    let bestClearance = Number.NEGATIVE_INFINITY;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const sampleSeed = stableHash(`${work.id}:galaxy-work:${attempt}`);
      let x: number;
      let y: number;
      if (attempt < 52) {
        const offsetAngle = jitter(sampleSeed, 0, 0.12);
        const offsetRadius = jitter(sampleSeed, 1, 0.8 * densityScale);
        const candidateRadius = Math.max(0.2, Math.min(galaxyRadius - 0.4, radius + offsetRadius));
        const candidateAngle = angle + offsetAngle;
        x = Math.cos(candidateAngle) * candidateRadius;
        y = Math.sin(candidateAngle) * candidateRadius;
      } else {
        const fallbackRadius = Math.sqrt(unit(sampleSeed, 2)) * (galaxyRadius - 0.4);
        const fallbackAngle = unit(sampleSeed, 3) * Math.PI * 2;
        x = Math.cos(fallbackAngle) * fallbackRadius;
        y = Math.sin(fallbackAngle) * fallbackRadius;
      }
      const clearance = nearestClearance(x, y, halfWidth);
      if (clearance >= 1) {
        selected = [x, y];
        break;
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        selected = [x, y];
      }
    }
    const [x, y] = selected ?? [desiredX, desiredY];
    addPosition(x, y, work);
    objects.push({ id: work.id, work, kind: "star", x, y, z: jitter(seed, 4, 0.16), size: 0.28 + unit(seed, 3) * 0.12, color: colorFor(work), seed, alpha: 0.82 + unit(seed, 5) * 0.18 });
  }
  // Particle arms form the galaxy itself; a smaller bulge and sparse inter-arm
  // light add depth without schematic lines or fog sprites.
  const dustCount = Math.min(6_400, Math.max(3_200, projection.works.length * 42));
  const arms = 4;
  for (let arm = 0; arm < arms; arm += 1) {
    for (let index = 0; index < 72; index += 1) {
      const seed = stableHash(`galaxy-arm-glow-${arm}-${index}`);
      const radial = 0.035 + (index / 71) * 0.96;
      const radius = 0.35 + radial * (galaxyRadius - 0.7);
      const angle = arm / arms * Math.PI * 2 + radial * 4.2 + jitter(seed, 0, 0.025);
      const [x, y, z] = shallowPoint(angle, radius, jitter(seed, 1, 0.05));
      objects.push({
        kind: "armGlow",
        x,
        y,
        z,
        size: 0.72 + unit(seed, 2) * 0.28,
        color: arm % 2 ? "#aa8be8" : "#8c9fff",
        seed,
        alpha: 0.12 + unit(seed, 3) * 0.06,
      });
    }
  }
  for (let index = 0; index < dustCount; index += 1) {
    const seed = stableHash(`galaxy-dust-${index}`);
    const population = unit(seed, 0);
    let radius: number;
    let angle: number;
    if (population < 0.14) {
      radius = Math.sqrt(unit(seed, 1)) * 4.2;
      angle = unit(seed, 2) * Math.PI * 2;
    } else if (population < 0.98) {
      const radial = Math.pow(unit(seed, 1), 0.84);
      const arm = Math.floor(unit(seed, 2) * arms);
      const spread = 0.1 + radial * 0.5;
      angle = arm / arms * Math.PI * 2 + radial * 4.2 + jitter(seed, 3, spread);
      radius = 0.35 + radial * (galaxyRadius - 0.7) + jitter(seed, 4, 0.45 * densityScale);
    } else {
      radius = Math.sqrt(unit(seed, 1)) * galaxyRadius;
      angle = unit(seed, 2) * Math.PI * 2;
    }
    const [x, y, z] = shallowPoint(angle, radius, jitter(seed, 4, 0.18));
    const color = index % 5 === 0 ? "#f2d5ae" : index % 3 === 0 ? "#d3a8dc" : index % 2 ? "#9fb8e8" : "#ead7c7";
    objects.push({ kind: "star", x, y, z, size: 0.032 + unit(seed, 5) * 0.052, color, seed, alpha: 0.34 + unit(seed, 6) * 0.55 });
  }
  return {
    group: "8",
    cameraDistance: 27,
    defaultYaw: GALAXY_DEFAULT_CAMERA.yaw,
    defaultPitch: GALAXY_DEFAULT_CAMERA.pitch,
    objects,
    lines,
  };
}

function layoutDeepField(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  const sorted = [...projection.works].sort((a, b) => stableHash(a.id) - stableHash(b.id));
  // `works` is the canonical full group; visibleIds only affects rendering, so
  // filtering never changes the brightness assigned to a work.
  const maxCanonicalRank = projection.works.reduce(
    (maximum, work) => Math.max(maximum, work.rank ?? 0),
    1,
  );
  const densityScale = Math.max(0.55, Math.sqrt(sorted.length / 124) * 1.15);
  const halfWidth = 15.5 * densityScale;
  const halfHeight = 9.25 * densityScale;
  const knots: Array<[number, number]> = [
    [-12.0, -3.6], [-9.4, 4.0], [-5.2, 0.5], [-3.1, 7.0], [-0.6, -4.9],
    [3.4, 3.1], [7.2, 7.5], [9.5, -0.9], [5.2, -7.3], [-6.1, -7.0],
  ].map(([x, y]) => [x * densityScale, y * densityScale]);
  const filaments: Array<[number, number]> = [
    [0, 2], [0, 9], [1, 2], [1, 3], [2, 4], [2, 3], [2, 5], [4, 5],
    [4, 9], [5, 6], [5, 7], [7, 8], [4, 8], [8, 9], [6, 7],
  ];
  const cellWidth = 2.5;
  const cellHeight = 0.78;
  const cells = new Map<string, LabelAnchorPosition[]>();
  const cellCoordinates = (x: number, y: number) => [Math.floor(x / cellWidth), Math.floor(y / cellHeight)] as const;
  const cellKey = (x: number, y: number) => `${x},${y}`;
  const nearestClearance = (x: number, y: number, halfWidth: number): number => {
    const [cx, cy] = cellCoordinates(x, y);
    let nearest = Number.POSITIVE_INFINITY;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
        for (const other of cells.get(cellKey(cx + offsetX, cy + offsetY)) ?? []) {
          nearest = Math.min(nearest, labelClearance(x, y, halfWidth, other));
        }
      }
    }
    return nearest;
  };
  const remember = (x: number, y: number, work: UniverseWork): void => {
    const [cx, cy] = cellCoordinates(x, y);
    const key = cellKey(cx, cy);
    const entries = cells.get(key) ?? [];
    entries.push({ x, y, halfWidth: labelHalfWidth(work) });
    cells.set(key, entries);
  };
  const candidate = (seed: number, attempt: number): [number, number] => {
    const sampleSeed = stableHash(`${seed}:${attempt}`);
    const population = unit(sampleSeed, 0);
    if (population < 0.62) {
      const edge = filaments[Math.floor(unit(sampleSeed, 1) * filaments.length)] ?? filaments[0];
      const [fromIndex, toIndex] = edge;
      const from = knots[fromIndex];
      const to = knots[toIndex];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.max(0.001, Math.hypot(dx, dy));
      const along = 0.07 + unit(sampleSeed, 2) * 0.86;
      const normalOffset = jitter(sampleSeed, 3, (0.35 + unit(sampleSeed, 4) * 1.8) * densityScale);
      const tangentOffset = jitter(sampleSeed, 5, 0.8 * densityScale);
      return [
        from[0] + dx * along - (dy / length) * normalOffset + (dx / length) * tangentOffset,
        from[1] + dy * along + (dx / length) * normalOffset + (dy / length) * tangentOffset,
      ];
    }
    if (population < 0.89) {
      const knot = knots[Math.floor(unit(sampleSeed, 1) * knots.length)] ?? knots[0];
      const angle = unit(sampleSeed, 2) * Math.PI * 2;
      const radius = Math.sqrt(unit(sampleSeed, 3)) * (1.0 + unit(sampleSeed, 4) * 2.7) * densityScale;
      return [knot[0] + Math.cos(angle) * radius, knot[1] + Math.sin(angle) * radius];
    }
    return [jitter(sampleSeed, 6, halfWidth * 0.97), jitter(sampleSeed, 7, halfHeight * 0.97)];
  };

  for (const work of sorted) {
    const seed = stableHash(work.id);
    const rankFraction = work.rank === null
      ? 0
      : maxCanonicalRank <= 1
        ? 1
        : 1 - Math.min(1, Math.max(0, (work.rank - 1) / (maxCanonicalRank - 1)));
    const size = 0.48 + unit(seed, 8) * 0.15 + rankFraction * 0.08;
    const halfLabelWidth = labelHalfWidth(work);
    let best: [number, number] | null = null;
    let bestClearance = Number.NEGATIVE_INFINITY;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const point = candidate(seed, attempt);
      const x = Math.max(-halfWidth, Math.min(halfWidth, point[0]));
      const y = Math.max(-halfHeight, Math.min(halfHeight, point[1]));
      const clearance = nearestClearance(x, y, halfLabelWidth);
      if (clearance >= 1) {
        best = [x, y];
        break;
      }
      if (clearance > bestClearance) {
        best = [x, y];
        bestClearance = clearance;
      }
    }
    const [x, y] = best ?? [jitter(seed, 9, halfWidth), jitter(seed, 10, halfHeight)];
    remember(x, y, work);
    objects.push({
      id: work.id,
      work,
      kind: "galaxy",
      x,
      y,
      z: 0,
      size,
      color: colorFor(work),
      seed,
      alpha: 0.18 + rankFraction * 0.82,
    });
  }
  const bounds = objects.reduce((result, object) => {
    const horizontalExtent = object.work ? labelHalfWidth(object.work) : object.size;
    return {
      minX: Math.min(result.minX, object.x - horizontalExtent),
      maxX: Math.max(result.maxX, object.x + horizontalExtent),
      minY: Math.min(result.minY, object.y - (object.work ? 0.42 : object.size)),
      maxY: Math.max(result.maxY, object.y + (object.work ? 0.42 : object.size)),
    };
  }, { minX: 0, maxX: 0, minY: 0, maxY: 0 });
  const extentHalfWidth = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX));
  const extentHalfHeight = Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY));
  return { group: "7", cameraDistance: fitDistance(extentHalfWidth, extentHalfHeight, 10), defaultYaw: 0, defaultPitch: 0, bounds, objects, lines: [] };
}

function layoutAsteroids(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  const works = [...projection.works].sort((a, b) => {
    if (a.rating != null && b.rating != null && a.rating !== b.rating) return b.rating - a.rating;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank !== null && b.rank === null) return -1;
    if (a.rank === null && b.rank !== null) return 1;
    return a.id.localeCompare(b.id);
  });
  const xSlots = new Map([...works]
    .sort((a, b) => stableHash(`asteroid-x-${a.id}`) - stableHash(`asteroid-x-${b.id}`) || a.id.localeCompare(b.id))
    .map((work, index) => [work.id, index] as const));
  const trackSpacing = works.length <= 31 ? 0.56 : 17 / Math.max(1, works.length - 1);
  const asteroidSize = Math.min(0.27, trackSpacing * 0.72);
  works.forEach((work, index) => {
    const seed = stableHash(work.id);
    const xSlot = xSlots.get(work.id) ?? index;
    const x = works.length < 2 ? 0 : -12 + (xSlot / (works.length - 1)) * 24;
    const y = (index - (works.length - 1) / 2) * trackSpacing;
    objects.push({ id: work.id, work, kind: "asteroid", x, y, z: jitter(seed, 2, 0.16), size: asteroidSize, color: "#858b93", seed, alpha: 0.88, driftX: 0.09 + unit(seed, 4) * 0.075, driftY: 0 });
  });
  for (let index = 0; index < 56; index += 1) {
    const seed = stableHash(`asteroid-dust-${index}`);
    objects.push({ kind: "star", x: jitter(seed, 0, 13), y: jitter(seed, 1, 8), z: jitter(seed, 2, 4), size: 0.014 + unit(seed, 3) * 0.02, color: "#979da4", seed, alpha: 0.27 });
  }
  const halfHeight = works.length * trackSpacing / 2 + 0.6;
  return { group: projection.group, cameraDistance: fitDistance(12.4, halfHeight, 11), defaultYaw: 0, defaultPitch: 0.06, objects, lines: [] };
}

function layoutPlanned(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  const works = [...projection.works].sort((a, b) => (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  for (const [index, work] of works.entries()) {
    const seed = stableHash(work.id);
    const displayOrder = Math.max(0, work.displayOrder ?? index);
    const [x, y] = spiralPoint(displayOrder, 1.15, seed);
    objects.push({ id: work.id, work, kind: "star", x, y: y * 0.84, z: jitter(seed, 3, 2.4), size: 0.22 + unit(seed, 4) * 0.1, color: colorFor(work), seed, alpha: 0.96 });
  }
  const bounds = objects.reduce((result, object) => ({
    x: Math.max(result.x, Math.abs(object.x) + object.size),
    y: Math.max(result.y, Math.abs(object.y) + object.size),
  }), { x: 1, y: 1 });
  return { group: "planned", cameraDistance: fitDistance(bounds.x, bounds.y, 12), defaultYaw: 0, defaultPitch: 0.24, objects, lines: [] };
}

function layoutDropped(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [{ kind: "blackHole", x: 0, y: 0, z: 0, size: 2.2, color: "#e88153", seed: 421, alpha: 0.98 }];
  const lines: SceneLayout["lines"] = [];
  projection.works.forEach((work) => {
    const seed = stableHash(work.id);
    const angle = unit(seed, 0) * Math.PI * 2;
    const radius = 1.85 + unit(seed, 4) * 2.45;
    const phase = angle + unit(seed, 5) * 0.12;
    const [x, y, z] = diskPoint(phase, radius);
    objects.push({ id: work.id, work, kind: "star", x, y, z, size: 0.17, color: colorFor(work, "#f2ae79"), seed, alpha: 0.94, orbitRadius: radius, orbitSpeed: 0.075 + unit(seed, 3) * 0.07, orbitPhase: phase, orbitYScale: 0 });
  });
  for (let index = 0; index < 360; index += 1) {
    const seed = stableHash(`accretion-particle-${index}`);
    const radius = 1.45 + Math.pow(unit(seed, 0), 0.72) * 3.4;
    const phase = unit(seed, 1) * Math.PI * 2;
    const [x, y, z] = diskPoint(phase, radius);
    objects.push({ kind: "star", x, y, z, size: 0.02 + unit(seed, 2) * 0.035, color: index % 3 ? "#efa26b" : "#c78be0", seed, alpha: 0.35 + unit(seed, 6) * 0.4, orbitRadius: radius, orbitSpeed: 0.08 + unit(seed, 3) * 0.09, orbitPhase: phase, orbitYScale: 0 });
  }
  return { group: "dropped", cameraDistance: 10.5, defaultYaw: 0.1, defaultPitch: 0.95, objects, lines };
}

function layoutUnrated(projection: UniverseProjection): SceneLayout {
  const objects: LayoutObject[] = [];
  for (const work of projection.works) {
    const seed = stableHash(work.id);
    objects.push({ id: work.id, work, kind: "star", x: jitter(seed, 0, 11), y: jitter(seed, 1, 6), z: jitter(seed, 2, 5), size: 0.25 + unit(seed, 3) * 0.16, color: colorFor(work), seed, alpha: 0.8 });
  }
  return { group: "unrated", cameraDistance: 24, objects, lines: [] };
}

export function buildSceneLayout(projection: UniverseProjection): SceneLayout {
  const layout = projection.group === "10" ? layoutSolar(projection)
    : projection.group === "9" ? layoutConstellations(projection)
      : projection.group === "8" ? layoutGalaxy(projection)
        : projection.group === "7" ? layoutDeepField(projection)
          : projection.group === "planned" ? layoutPlanned(projection)
            : projection.group === "dropped" ? layoutDropped(projection)
              : projection.group === "unrated" ? layoutUnrated(projection)
                : layoutAsteroids(projection);
  // Empty groups still get an ambient sky; these points have no work IDs or pick targets.
  const ambientGroup = ["1", "2", "3", "4", "5", "6"].includes(projection.group) ? "asteroids" : projection.group;
  const ambientCount = projection.group === "8" || projection.group === "7" ? 0 : 76;
  for (let index = 0; index < ambientCount; index += 1) {
    const seed = stableHash(`ambient-${ambientGroup}-${index}`);
    layout.objects.push({ kind: "star", x: jitter(seed, 0, 20), y: jitter(seed, 1, 11), z: -8 - unit(seed, 2) * 24, size: 0.025 + unit(seed, 3) * 0.035, color: "#a8bad5", seed, alpha: 0.27 + unit(seed, 4) * 0.25 });
  }
  return layout;
}

export function isScaleTransition(from: UniverseGroup, to: UniverseGroup): boolean {
  const scales: UniverseGroup[] = ["10", "9", "8", "7"];
  const fromIndex = scales.indexOf(from);
  const toIndex = scales.indexOf(to);
  return fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex;
}

/** Keep scene labels bounded while always retaining the selected work. */
export function selectLabelWorkIds(
  works: readonly UniverseWork[],
  selectedId: string | null,
  maxLabels = 72,
  showAll = false,
): Set<string> {
  if (showAll) return new Set(works.map((work) => work.id));
  const limit = Math.max(0, Math.floor(maxLabels));
  const candidates = [...works].sort((a, b) => {
    if (a.id === selectedId) return -1;
    if (b.id === selectedId) return 1;
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER);
  });
  const chosen = candidates.slice(0, limit).map((work) => work.id);
  if (selectedId && works.some((work) => work.id === selectedId) && !chosen.includes(selectedId)) chosen.push(selectedId);
  return new Set(chosen);
}
