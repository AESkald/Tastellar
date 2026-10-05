import {
  getRecapEntryCaption,
  type RecapComposition,
  type RecapEntrySnapshot,
  type RecapSlot,
  type RecapStyle,
  type RecapStoredTemplateId,
} from "../../features/recap/domain/recap";
import type { RemoteCoverReference } from "../../shared/bridge/libraryTypes";

export const RECAP_RENDERER_VERSION = 1 as const;
export const RECAP_MAX_DIMENSION = 4096;
export const RECAP_EXPORT_TARGET_LONG_EDGE = 3200;
export const RECAP_EXPORT_MAX_DIMENSION = 4096;
export const RECAP_EXPORT_MAX_PIXELS = 12_000_000;
const COVER_RATIO = 2 / 3;
const TILE_WIDTH = 300;
const GUTTER = 16;
const SAFE = 28;
const HEADER = 76;
const FOOTER = 42;

export interface RecapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecapHitTarget extends RecapRect {
  slotId: string;
  entryId: string | null;
  page: number;
}

export interface RecapRectNode extends RecapRect {
  kind: "rect";
  fill: string;
  role?: "captionBand";
  radius?: number;
  opacity?: number;
  stroke?: string;
  strokeWidth?: number;
}

export interface RecapImageNode extends RecapRect {
  kind: "image";
  slotId: string;
  entryId: string;
  /** Stable source key; remote references use a provider-and-URL key. */
  assetId: string;
  remoteCover?: RemoteCoverReference | null;
  image: HTMLImageElement | null;
  radius: number;
  fit: "cover" | "contain";
  opacity?: number;
}

export interface RecapPlaceholderNode extends RecapRect {
  kind: "placeholder";
  entryId: string;
  radius: number;
  gradientStart: string;
  gradientEnd: string;
  iconKey: string | null;
  initial: string;
  iconColor: string;
  initialColor: string;
  opacity?: number;
}

export interface RecapTextNode {
  kind: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  fontFamily: string;
  weight?: number;
  align?: CanvasTextAlign;
  opacity?: number;
  maxLines?: number;
  letterSpacing?: number;
  shadow?: boolean;
  entryId?: string;
}

export type RecapNode = RecapRectNode | RecapImageNode | RecapPlaceholderNode | RecapTextNode;

export interface RecapScene {
  version: typeof RECAP_RENDERER_VERSION;
  width: number;
  height: number;
  pageIndex: number;
  pageCount: number;
  background: string;
  nodes: RecapNode[];
  hitTargets: RecapHitTarget[];
  overflowWarnings: string[];
}

export interface RecapSceneOptions {
  pageIndex?: number;
  watermark?: boolean;
  watermarkText?: string;
  selectionText?: string;
  filteredRankText?: string;
  /** @deprecated Missing covers now use a theme-matched generated cover tile. */
  missingCoverText?: string;
}

export type RecapCoverLoader = (
  entryId: string,
  assetId: string | null,
  remoteCover?: RemoteCoverReference | null,
) => Promise<string | null>;

interface Palette {
  background: string;
  panel: string;
  card: string;
  text: string;
  muted: string;
  accent: string;
  watermark: string;
  captionBand: string;
  placeholderStart: string;
  placeholderEnd: string;
  placeholderIcon: string;
  placeholderInitial: string;
  textTile: string;
  serif: boolean;
}

const palettes: Record<RecapStyle, Palette> = {
  dark: {
    background: "#17171d", panel: "#24232d", card: "#211f28", text: "#f3f1f8",
    muted: "#aaa5b5", accent: "#bab0ef", watermark: "rgba(238,234,250,.48)",
    captionBand: "#15151a", placeholderStart: "#302e3a",
    placeholderEnd: "#1c1c23", placeholderIcon: "#bab0ef", placeholderInitial: "#a69bcf",
    textTile: "#22212b", serif: false,
  },
  daylight: {
    background: "#f5f4f1", panel: "#eee9f4", card: "#fcfbf8", text: "#27232d",
    muted: "#77717f", accent: "#746199", watermark: "rgba(71,60,87,.47)",
    captionBand: "#f5f4f1", placeholderStart: "#eee9f4",
    placeholderEnd: "#fcfbf8", placeholderIcon: "#746199", placeholderInitial: "#8a7ba3",
    textTile: "#fcfbf8", serif: false,
  },
  dusk: {
    background: "#211d29", panel: "#392b44", card: "#302739", text: "#f6edf9",
    muted: "#c0b3c7", accent: "#d2b1df", watermark: "rgba(246,232,250,.47)",
    captionBand: "#241c2c", placeholderStart: "#403647",
    placeholderEnd: "#2a2434", placeholderIcon: "#d2b1df", placeholderInitial: "#c39bcc",
    textTile: "#352a3d", serif: false,
  },
  reading: {
    background: "#eee9de", panel: "#eee5d6", card: "#f7f2e7", text: "#30281f",
    muted: "#776a5d", accent: "#806a53", watermark: "rgba(73,60,46,.48)",
    captionBand: "#f3eddf", placeholderStart: "#eee5d6",
    placeholderEnd: "#f7f2e7", placeholderIcon: "#806a53", placeholderInitial: "#8b765f",
    textTile: "#f7f2e7", serif: true,
  },
};

const sansFamily = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const serifFamily = "Georgia, 'Times New Roman', serif";
const decodedCoverCache = new Map<string, HTMLImageElement>();
const coverDecodeJobs = new Map<string, Promise<HTMLImageElement>>();
const MAX_DECODED_COVERS = 48;

function pageSlots(composition: RecapComposition, pageIndex: number): RecapSlot[] {
  return composition.slots.filter((slot) => slot.page === pageIndex);
}

export function recapPageCount(composition: RecapComposition): number {
  return Math.max(1, ...composition.slots.map((slot) => slot.page + 1));
}

function addRect(scene: RecapScene, x: number, y: number, width: number, height: number, fill: string, radius = 0, opacity = 1, role?: RecapRectNode["role"]) {
  scene.nodes.push({ kind: "rect", x, y, width, height, fill, radius, opacity, role });
}

function addText(
  scene: RecapScene,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  color: string,
  palette: Palette,
  options: Partial<Pick<RecapTextNode, "weight" | "align" | "opacity" | "maxLines" | "letterSpacing" | "shadow" | "entryId">> = {},
) {
  if (!text || width <= 0 || height <= 0) return;
  scene.nodes.push({
    kind: "text", text, x, y, width, height, fontSize, color,
    fontFamily: palette.serif ? serifFamily : sansFamily,
    weight: options.weight ?? 500, align: options.align ?? "left", opacity: options.opacity ?? 1,
    maxLines: options.maxLines ?? 2, letterSpacing: options.letterSpacing ?? 0, shadow: options.shadow, entryId: options.entryId,
  });
}

function normalizedInitial(entry: RecapEntrySnapshot): string {
  const caption = getRecapEntryCaption(entry).trim();
  return Array.from(caption)[0]?.toLocaleUpperCase() ?? "•";
}

function addPlaceholder(scene: RecapScene, slot: RecapSlot, rect: RecapRect, radius: number, palette: Palette) {
  if (!slot.entry) return;
  scene.nodes.push({
    kind: "placeholder",
    x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius,
    entryId: slot.entry.id,
    gradientStart: palette.placeholderStart,
    gradientEnd: palette.placeholderEnd,
    iconKey: slot.entry.iconKey ?? null,
    initial: normalizedInitial(slot.entry),
    iconColor: palette.placeholderIcon,
    initialColor: palette.placeholderInitial,
  });
}

function recapCoverSourceKey(entry: RecapEntrySnapshot): string | null {
  if (entry.coverAssetId) return entry.coverAssetId;
  const remoteCover = entry.remoteCover;
  return remoteCover ? `remote:${remoteCover.provider}:${remoteCover.url}` : null;
}

function captionFor(slot: RecapSlot): string {
  if (!slot.entry) return "";
  return slot.titleOverride?.trim() || getRecapEntryCaption(slot.entry);
}

function addRank(scene: RecapScene, slot: RecapSlot, rect: RecapRect, palette: Palette, onCover = false) {
  if (slot.rank === null || !slot.entry) return;
  const fontSize = rect.width > 650 ? 30 : rect.width > 260 ? 23 : 18;
  addText(scene, "#" + slot.rank, rect.x + 13, rect.y + 12, Math.min(90, rect.width * 0.35), fontSize * 1.55,
    fontSize, onCover ? "#ffffff" : palette.accent, palette,
    { weight: 640, opacity: 0.88, maxLines: 1, entryId: slot.entry.id, shadow: onCover });
}

function addSlot(
  scene: RecapScene,
  composition: RecapComposition,
  slot: RecapSlot,
  rect: RecapRect,
  palette: Palette,
  options: RecapSceneOptions,
) {
  const radius = Math.max(5, Math.min(11, rect.width * 0.022));
  const entry = slot.entry;
  if (!entry) {
    addRect(scene, rect.x, rect.y, rect.width, rect.height, palette.panel, radius);
    addRect(scene, rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4, palette.card, Math.max(3, radius - 2), 0.62);
    scene.hitTargets.push({ ...rect, slotId: slot.id, entryId: null, page: slot.page });
    return;
  }

  scene.hitTargets.push({ ...rect, slotId: slot.id, entryId: entry.id, page: slot.page });
  const textMode = composition.mode === "text";
  if (textMode) {
    addRect(scene, rect.x, rect.y, rect.width, rect.height, palette.textTile, radius);
    addRect(scene, rect.x + rect.width * 0.09, rect.y + rect.height * 0.17, rect.width * 0.17, 2, palette.accent, 1, 0.8);
    addRank(scene, slot, rect, palette);
    const meta = composition.showMediaTypes ? entry.mediaTypeName : null;
    if (meta) {
      addText(scene, meta, rect.x + rect.width * 0.09, rect.y + rect.height * 0.28,
        rect.width * 0.82, rect.height * 0.12, Math.max(13, Math.min(19, rect.width * 0.055)),
        palette.muted, palette, { maxLines: 1, opacity: 0.9 });
    }
    const titleY = meta ? rect.y + rect.height * 0.43 : rect.y + rect.height * 0.36;
    const titleHeight = rect.y + rect.height * 0.84 - titleY;
    const titleFont = Math.min(rect.width > 650 ? 46 : 32, Math.max(22, rect.width * 0.11));
    addText(scene, captionFor(slot), rect.x + rect.width * 0.09, titleY, rect.width * 0.82, titleHeight,
      titleFont, palette.text, palette, { weight: 650, maxLines: rect.height > 600 ? 5 : 4, entryId: entry.id });
    return;
  }

  const periodTemplate = composition.templateId === "releaseYear" || composition.templateId === "decade";
  const coverSourceKey = recapCoverSourceKey(entry);
  if (periodTemplate) {
    // Period cells are the posters themselves; no empty title area is reserved.
    const posterRect = rect;
    if (coverSourceKey) {
      addRect(scene, posterRect.x, posterRect.y, posterRect.width, posterRect.height, palette.card, radius);
      scene.nodes.push({
        kind: "image", ...posterRect, slotId: slot.id, entryId: entry.id, assetId: coverSourceKey,
        remoteCover: entry.coverAssetId ? null : entry.remoteCover ?? null,
        image: null, radius, fit: "contain",
      });
    } else {
      addPlaceholder(scene, slot, posterRect, radius, palette);
    }
    if (composition.showTitles) {
      const bandHeight = Math.min(76, Math.max(54, rect.height * 0.19));
      addRect(scene, rect.x, rect.y + rect.height - bandHeight, rect.width, bandHeight, palette.panel, 8, 0.88);
      addText(scene, captionFor(slot), rect.x + 12, rect.y + rect.height - bandHeight + 9,
        rect.width - 24, bandHeight - 16, 14, palette.text, palette,
        { weight: 520, maxLines: 3, opacity: 0.96, entryId: entry.id });
    }
    return;
  }

  if (coverSourceKey) {
    // A neutral tile is visible while the async cover resolver is pending.
    // Successful covers cover it completely; generated art is only used after
    // the resolver confirms that an asset is unavailable.
    addRect(scene, rect.x, rect.y, rect.width, rect.height, palette.card, radius);
    scene.nodes.push({
      kind: "image", x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      slotId: slot.id, entryId: entry.id, assetId: coverSourceKey,
      remoteCover: entry.coverAssetId ? null : entry.remoteCover ?? null,
      image: null, radius, fit: "cover",
    });
  } else {
    addPlaceholder(scene, slot, rect, radius, palette);
  }

  addRank(scene, slot, rect, palette, Boolean(coverSourceKey));
  const showName = composition.showTitles;
  if (showName) {
    const bandHeight = rect.width > 600 ? 44 : 36;
    const bandY = rect.y + rect.height - bandHeight;
    addRect(scene, rect.x, bandY, rect.width, bandHeight, palette.captionBand, 0, 1, "captionBand");
    const caption = captionFor(slot);
    const titleHeight = bandHeight - 3;
    addText(scene, caption, rect.x + 10, bandY + 2, rect.width - 20, titleHeight,
      rect.width > 600 ? 18 : 13, palette.text, palette,
      { weight: 430, maxLines: 2, opacity: 0.84, entryId: entry.id });
  }
  void options;
}

interface Layout {
  width: number;
  height: number;
  rects: Array<{ slot: RecapSlot; rect: RecapRect; label?: string }>;
}

function dimensionsForGrid(rows: number, cols: number, width = TILE_WIDTH) {
  const tileHeight = Math.round(width / COVER_RATIO);
  return {
    width: cols * width + (cols - 1) * GUTTER,
    height: rows * tileHeight + (rows - 1) * GUTTER,
    tileWidth: width,
    tileHeight,
  };
}

function gridRects(slots: RecapSlot[], x: number, y: number, cols: number, width = TILE_WIDTH): Layout["rects"] {
  const tileHeight = Math.round(width / COVER_RATIO);
  return slots.map((slot, index) => ({
    slot,
    rect: {
      x: x + (index % cols) * (width + GUTTER),
      y: y + Math.floor(index / cols) * (tileHeight + GUTTER),
      width,
      height: tileHeight,
    },
  }));
}

function layoutTopTen(slots: RecapSlot[], orientation: RecapComposition["orientation"]): Layout {
  const ordered = [...slots].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const hero = ordered.find((slot) => slot.rank === 1) ?? ordered[0];
  const others = ordered.filter((slot) => slot !== hero);
  const cell = dimensionsForGrid(3, 3);
  if (orientation === "landscape") {
    const heroHeight = cell.height;
    const heroWidth = Math.round(heroHeight * COVER_RATIO);
    const heroRect = { x: SAFE, y: HEADER, width: heroWidth, height: heroHeight };
    const gridX = SAFE + heroWidth + GUTTER;
    const rects = hero ? [{ slot: hero, rect: heroRect }] : [];
    rects.push(...gridRects(others, gridX, HEADER, 3));
    return { width: gridX + cell.width + SAFE, height: HEADER + cell.height + SAFE + FOOTER, rects };
  }
  const heroWidth = cell.width;
  const heroHeight = Math.round(heroWidth / COVER_RATIO);
  const heroRect = { x: SAFE, y: HEADER, width: heroWidth, height: heroHeight };
  const gridY = HEADER + heroHeight + GUTTER;
  const rects = hero ? [{ slot: hero, rect: heroRect }] : [];
  rects.push(...gridRects(others, SAFE, gridY, 3));
  return { width: cell.width + SAFE * 2, height: gridY + cell.height + SAFE + FOOTER, rects };
}

function layoutChallengers(slots: RecapSlot[], orientation: RecapComposition["orientation"]): Layout {
  const ordered = [...slots].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const hero = ordered.find((slot) => slot.rank === 1) ?? ordered[0];
  const others = ordered.filter((slot) => slot !== hero);
  const cell = dimensionsForGrid(2, 2);
  if (orientation === "landscape") {
    const heroHeight = cell.height;
    const heroWidth = Math.round(heroHeight * COVER_RATIO);
    const gridX = SAFE + heroWidth + GUTTER;
    const rects = hero ? [{ slot: hero, rect: { x: SAFE, y: HEADER, width: heroWidth, height: heroHeight } }] : [];
    rects.push(...gridRects(others, gridX, HEADER, 2));
    return { width: gridX + cell.width + SAFE, height: HEADER + cell.height + SAFE + FOOTER, rects };
  }
  const heroWidth = cell.width;
  const heroHeight = Math.round(heroWidth / COVER_RATIO);
  const gridY = HEADER + heroHeight + GUTTER;
  const rects = hero ? [{ slot: hero, rect: { x: SAFE, y: HEADER, width: heroWidth, height: heroHeight } }] : [];
  rects.push(...gridRects(others, SAFE, gridY, 2));
  return { width: cell.width + SAFE * 2, height: gridY + cell.height + SAFE + FOOTER, rects };
}

const centerRingOrder = [4, 0, 1, 2, 5, 8, 7, 6, 3];
function layoutGrid3x3(slots: RecapSlot[]): Layout {
  const byRank = [...slots].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const mapped = new Map<number, RecapSlot>();
  byRank.forEach((slot, index) => mapped.set(centerRingOrder[index], slot));
  const edgeW = 276;
  const centerW = 304;
  const edgeH = Math.round(edgeW / COVER_RATIO);
  const centerH = Math.round(centerW / COVER_RATIO);
  const widths = [edgeW, centerW, edgeW];
  const heights = [edgeH, centerH, edgeH];
  const xs = [SAFE, SAFE + edgeW + GUTTER, SAFE + edgeW + GUTTER + centerW + GUTTER];
  const ys = [HEADER, HEADER + edgeH + GUTTER, HEADER + edgeH + GUTTER + centerH + GUTTER];
  const rects: Layout["rects"] = [];
  for (let position = 0; position < 9; position += 1) {
    const slot = mapped.get(position);
    if (!slot) continue;
    const row = Math.floor(position / 3);
    const col = position % 3;
    const isCenter = position === 4;
    const tileWidth = isCenter ? centerW : edgeW;
    const tileHeight = isCenter ? centerH : edgeH;
    rects.push({ slot, rect: {
      x: xs[col] + (widths[col] - tileWidth) / 2,
      y: ys[row] + (heights[row] - tileHeight) / 2,
      width: tileWidth,
      height: tileHeight,
    } });
  }
  return {
    width: widths[0] + widths[1] + widths[2] + GUTTER * 2 + SAFE * 2,
    height: HEADER + heights[0] + heights[1] + heights[2] + GUTTER * 2 + SAFE + FOOTER,
    rects,
  };
}

function tileCollection(slots: RecapSlot[], orientation: RecapComposition["orientation"], templateId: RecapStoredTemplateId): Layout {
  const landscape = orientation === "landscape";
  const compact = templateId === "releaseYear" || templateId === "decade" || templateId === "format";
  const periodTemplate = templateId === "releaseYear" || templateId === "decade";
  const width = periodTemplate ? 280 : landscape ? (compact ? 220 : 240) : 280;
  const periodCardHeight = Math.round(width / COVER_RATIO);
  const count = slots.length;
  let cols = 1;
  let rows: number;
  if (periodTemplate && count > 0) {
    // Keep each 2:3 poster intact and use only complete, bounded grids.
    const shapes: Record<number, { landscape: [number, number]; portrait: [number, number] }> = {
      2: { landscape: [2, 1], portrait: [1, 2] },
      3: { landscape: [3, 1], portrait: [1, 3] },
      4: { landscape: [4, 1], portrait: [2, 2] },
      6: { landscape: [3, 2], portrait: [2, 3] },
      8: { landscape: [4, 2], portrait: [2, 4] },
      9: { landscape: [3, 3], portrait: [3, 3] },
      12: { landscape: [6, 2], portrait: [3, 4] },
    };
    const shape = shapes[count] ?? {
      landscape: [Math.min(6, count), Math.ceil(count / 6)] as [number, number],
      portrait: [Math.min(3, count), Math.ceil(count / 3)] as [number, number],
    };
    [cols, rows] = landscape ? shape.landscape : shape.portrait;
  } else if (landscape) {
    if (templateId === "releaseYear" || templateId === "format") cols = Math.max(1, Math.min(16, count));
    else if (templateId === "decade") cols = Math.max(1, count <= 6 ? count : Math.ceil(count / 2));
    else cols = Math.max(1, count <= 6 ? count : Math.ceil(count / 2));
    rows = Math.ceil(slots.length / cols);
  } else {
    cols = Math.max(1, count <= 3 ? 1 : 2);
    rows = Math.ceil(slots.length / cols);
  }
  const cellH = periodTemplate ? periodCardHeight : Math.round(width / COVER_RATIO);
  const labelHeight = periodTemplate ? 45 : compact ? 26 : 0;
  const gapY = GUTTER + labelHeight;
  const gridWidth = cols * width + (cols - 1) * GUTTER;
  const gridHeight = rows * cellH + (rows - 1) * gapY;
  const nominalWidth = gridWidth + SAFE * 2;
  const nominalHeight = HEADER + gridHeight + SAFE + FOOTER + labelHeight;
  const canvasWidth = periodTemplate && landscape
    ? Math.max(nominalWidth, Math.ceil(nominalHeight * 4 / 3))
    : nominalWidth;
  const gridOffsetX = periodTemplate && landscape ? Math.round((canvasWidth - nominalWidth) / 2) : 0;
  const rects: Layout["rects"] = [];
  slots.forEach((slot, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = SAFE + gridOffsetX + col * (width + GUTTER);
    const y = HEADER + row * (cellH + gapY) + labelHeight;
    rects.push({ slot, rect: { x, y, width, height: cellH }, label: compact ? slot.label ?? undefined : undefined });
  });
  return {
    width: canvasWidth,
    height: nominalHeight,
    rects,
  };
}

function buildLayout(composition: RecapComposition, slots: RecapSlot[]): Layout {
  if (composition.templateId === "topTen") return layoutTopTen(slots, composition.orientation);
  if (composition.templateId === "challengers") return layoutChallengers(slots, composition.orientation);
  if (composition.templateId === "grid3x3") return layoutGrid3x3(slots);
  return tileCollection(slots, composition.orientation, composition.templateId);
}

function addFrame(scene: RecapScene, composition: RecapComposition, palette: Palette, options: RecapSceneOptions) {
  addRect(scene, 0, 0, scene.width, scene.height, palette.background);
  const includeWatermark = options.watermark ?? composition.watermark;
  const watermarkText = includeWatermark ? options.watermarkText ?? "Made with Tastellar" : "";
  const watermarkWidth = watermarkText ? Math.min(320, Math.max(160, watermarkText.length * 9)) : 0;
  const leftWidth = Math.max(80, scene.width - SAFE * 2 - (watermarkWidth ? watermarkWidth + 24 : 0));
  if (composition.heading) {
    addText(scene, composition.heading, SAFE, 25, leftWidth, 30, Math.min(25, scene.width * 0.022),
      palette.text, palette, { weight: 600, maxLines: 1 });
  }
  if (watermarkText) {
    addText(scene, watermarkText, scene.width - SAFE - watermarkWidth, 25, watermarkWidth, 28,
      Math.min(15, scene.width * 0.013), palette.watermark, palette,
      { align: "right", weight: 500, maxLines: 1, letterSpacing: 0.3 });
  }
  const footerItems = [
    ...(composition.rankingLabel === "mySelection" ? [options.selectionText ?? "My selection"] : []),
    ...(composition.filter.kind === "types" ? [options.filteredRankText ?? "Filtered works"] : []),
    ...(composition.caption.trim() ? [composition.caption.trim()] : []),
  ];
  if (footerItems.length) {
    addText(scene, footerItems.join(" · "), SAFE, scene.height - 32, scene.width - SAFE * 2, 22,
      Math.min(14, scene.width * 0.012), palette.muted, palette, { maxLines: 1, opacity: 0.88 });
  }
}

function addBucketLabel(scene: RecapScene, item: Layout["rects"][number], composition: RecapComposition, palette: Palette) {
  if (!item.label) return;
  if (composition.templateId === "format" && composition.mode === "text" && !composition.showMediaTypes) return;
  if ((composition.templateId === "releaseYear" || composition.templateId === "decade") && item.slot.populationCount !== undefined) {
    addText(scene, item.label, item.rect.x, item.rect.y - 43, item.rect.width, 21,
      20, palette.muted, palette, { maxLines: 1, weight: 570, opacity: 0.96 });
    addText(scene, `${item.slot.populationCount} rated ${item.slot.populationCount === 1 ? "work" : "works"}`,
      item.rect.x, item.rect.y - 20, item.rect.width, 18,
      15, palette.muted, palette, { maxLines: 1, weight: 450, opacity: 0.86 });
    return;
  }
  addText(scene, item.label, item.rect.x, item.rect.y - 23, item.rect.width, 20,
    14, palette.muted, palette, { maxLines: 1, weight: 570, opacity: 0.92 });
}

function layoutScene(composition: RecapComposition, options: RecapSceneOptions): RecapScene {
  const pageCount = recapPageCount(composition);
  const pageIndex = Math.max(0, Math.min(pageCount - 1, options.pageIndex ?? 0));
  const slots = pageSlots(composition, pageIndex);
  const layout = buildLayout(composition, slots);
  const palette = palettes[composition.style] ?? palettes.dark;
  const scene: RecapScene = {
    version: RECAP_RENDERER_VERSION,
    width: Math.min(RECAP_MAX_DIMENSION, layout.width),
    height: Math.min(RECAP_MAX_DIMENSION, layout.height),
    pageIndex, pageCount, background: palette.background, nodes: [], hitTargets: [], overflowWarnings: [],
  };
  addFrame(scene, composition, palette, options);
  for (const item of layout.rects) {
    addBucketLabel(scene, item, composition, palette);
    addSlot(scene, composition, item.slot, item.rect, palette, options);
  }
  return scene;
}

/** Create one versioned layout scene. Preview and export use this exact geometry. */
export function layoutRecapScene(
  composition: RecapComposition,
  options: RecapSceneOptions = {},
): RecapScene {
  return layoutScene(composition, options);
}

export const buildRecapScene = layoutRecapScene;

function loadImage(src: string, assetId: string): Promise<HTMLImageElement> {
  const cached = decodedCoverCache.get(assetId);
  if (cached) {
    decodedCoverCache.delete(assetId);
    decodedCoverCache.set(assetId, cached);
    return Promise.resolve(cached);
  }
  const pending = coverDecodeJobs.get(assetId);
  if (pending) return pending;
  const job = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    let settled = false;
    const ready = () => {
      if (settled) return;
      settled = true;
      decodedCoverCache.set(assetId, image);
      while (decodedCoverCache.size > MAX_DECODED_COVERS) {
        const oldest = decodedCoverCache.keys().next().value;
        if (oldest === undefined) break;
        decodedCoverCache.delete(oldest);
      }
      resolve(image);
    };
    image.onload = ready;
    image.onerror = () => reject(new Error("Image could not be loaded"));
    image.src = src;
    if (typeof image.decode === "function") image.decode().then(ready).catch(() => undefined);
  });
  coverDecodeJobs.set(assetId, job);
  void job.finally(() => coverDecodeJobs.delete(assetId)).catch(() => undefined);
  return job;
}

/** Resolve immutable cover asset references before either preview draw or export. */
export async function resolveRecapSceneCovers(
  scene: RecapScene,
  composition: RecapComposition,
  loadCover: RecapCoverLoader,
): Promise<RecapScene> {
  const resolvedScene: RecapScene = {
    ...scene,
    nodes: [...scene.nodes],
    hitTargets: [...scene.hitTargets],
    overflowWarnings: [...scene.overflowWarnings],
  };
  const assetIds = new Map<string, { entryId: string; assetId: string | null; remoteCover: RemoteCoverReference | null }>();
  for (const node of resolvedScene.nodes) {
    if (node.kind === "image") assetIds.set(node.assetId, {
      entryId: node.entryId,
      assetId: node.remoteCover ? null : node.assetId,
      remoteCover: node.remoteCover ?? null,
    });
  }
  const loaded = new Map<string, HTMLImageElement>();
  await Promise.all([...assetIds.entries()].map(async ([sourceKey, { entryId, assetId, remoteCover }]) => {
    try {
      const src = await loadCover(entryId, assetId, remoteCover);
      if (src) loaded.set(sourceKey, await loadImage(src, sourceKey));
      else loaded.delete(sourceKey);
    } catch {
      loaded.delete(sourceKey);
    }
  }));
  resolvedScene.nodes = resolvedScene.nodes.flatMap((node): RecapNode[] => {
    if (node.kind !== "image") return [node];
    const image = loaded.get(node.assetId);
    if (image) return [{ ...node, image }];
    const slot = pageSlots(composition, resolvedScene.pageIndex).find((item) => item.id === node.slotId);
    const hit = resolvedScene.hitTargets.find((target) => target.slotId === node.slotId);
    if (!slot?.entry || !hit) return [];
    const palette = palettes[composition.style] ?? palettes.dark;
    const placeholder: RecapPlaceholderNode = {
      kind: "placeholder", x: hit.x, y: hit.y, width: hit.width, height: hit.height,
      entryId: slot.entry.id, radius: node.radius,
      gradientStart: palette.placeholderStart, gradientEnd: palette.placeholderEnd,
      iconKey: slot.entry.iconKey ?? null, initial: normalizedInitial(slot.entry),
      iconColor: palette.placeholderIcon, initialColor: palette.placeholderInitial,
    };
    return [placeholder];
  });
  return resolvedScene;
}

/** Resolve every cover before returning, for PNG/export callers. */
export async function loadRecapScene(
  composition: RecapComposition,
  loadCover: RecapCoverLoader,
  options: RecapSceneOptions = {},
): Promise<RecapScene> {
  return resolveRecapSceneCovers(layoutRecapScene(composition, options), composition, loadCover);
}

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawCoverCrop(ctx: CanvasRenderingContext2D, image: HTMLImageElement, rect: RecapRect) {
  const sw = image.naturalWidth;
  const sh = image.naturalHeight;
  const imageAspect = sw / Math.max(1, sh);
  const targetAspect = rect.width / rect.height;
  let sx = 0, sy = 0, cropWidth = sw, cropHeight = sh;
  if (imageAspect > targetAspect) {
    cropWidth = sh * targetAspect;
    sx = (sw - cropWidth) / 2;
  } else {
    cropHeight = sw / targetAspect;
    sy = (sh - cropHeight) / 2;
  }
  ctx.drawImage(image, sx, sy, cropWidth, cropHeight, rect.x, rect.y, rect.width, rect.height);
}

function drawImageContain(ctx: CanvasRenderingContext2D, image: HTMLImageElement, rect: RecapRect) {
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  ctx.drawImage(image, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

function drawMediaIcon(ctx: CanvasRenderingContext2D, iconKey: string | null, cx: number, cy: number, size: number, color: string) {
  const key = iconKey || "shape-circle";
  const s = size;
  const left = cx - s / 2, top = cy - s / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, s * 0.075);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (key === "book-open") {
    ctx.moveTo(cx, top + s * 0.18); ctx.lineTo(cx, top + s * 0.82);
    ctx.moveTo(cx, top + s * 0.25); ctx.bezierCurveTo(left + s * 0.26, top + s * 0.12, left + s * 0.12, top + s * 0.22, left + s * 0.12, top + s * 0.28);
    ctx.lineTo(left + s * 0.12, top + s * 0.78); ctx.bezierCurveTo(left + s * 0.35, top + s * 0.65, cx - s * 0.04, top + s * 0.7, cx, top + s * 0.82);
    ctx.moveTo(cx, top + s * 0.25); ctx.bezierCurveTo(left + s * 0.74, top + s * 0.12, left + s * 0.88, top + s * 0.22, left + s * 0.88, top + s * 0.28);
    ctx.lineTo(left + s * 0.88, top + s * 0.78); ctx.bezierCurveTo(left + s * 0.65, top + s * 0.65, cx + s * 0.04, top + s * 0.7, cx, top + s * 0.82);
  } else if (key === "clapperboard") {
    roundedPath(ctx, left + s * .12, top + s * .34, s * .76, s * .5, s * .06);
    ctx.moveTo(left + s * .12, top + s * .36); ctx.lineTo(left + s * .2, top + s * .16); ctx.lineTo(left + s * .9, top + s * .16); ctx.lineTo(left + s * .82, top + s * .36);
    ctx.moveTo(left + s * .38, top + s * .16); ctx.lineTo(left + s * .3, top + s * .36);
    ctx.moveTo(left + s * .65, top + s * .16); ctx.lineTo(left + s * .57, top + s * .36);
  } else if (key === "film") {
    roundedPath(ctx, left + s * .14, top + s * .18, s * .72, s * .64, s * .06);
    ctx.moveTo(left + s * .3, top + s * .18); ctx.lineTo(left + s * .3, top + s * .82);
    ctx.moveTo(left + s * .7, top + s * .18); ctx.lineTo(left + s * .7, top + s * .82);
  } else if (key === "tv") {
    roundedPath(ctx, left + s * .12, top + s * .28, s * .76, s * .52, s * .06);
    ctx.moveTo(left + s * .36, top + s * .16); ctx.lineTo(cx, top + s * .28); ctx.lineTo(left + s * .64, top + s * .16);
    ctx.moveTo(left + s * .4, top + s * .8); ctx.lineTo(left + s * .34, top + s * .9);
    ctx.moveTo(left + s * .6, top + s * .8); ctx.lineTo(left + s * .66, top + s * .9);
  } else if (key === "gamepad-2") {
    ctx.moveTo(left + s * .23, top + s * .37); ctx.quadraticCurveTo(left + s * .08, top + s * .37, left + s * .12, top + s * .58);
    ctx.lineTo(left + s * .18, top + s * .79); ctx.quadraticCurveTo(left + s * .22, top + s * .9, left + s * .34, top + s * .81);
    ctx.lineTo(left + s * .45, top + s * .72); ctx.lineTo(left + s * .57, top + s * .72);
    ctx.lineTo(left + s * .68, top + s * .81); ctx.quadraticCurveTo(left + s * .8, top + s * .9, left + s * .84, top + s * .79);
    ctx.lineTo(left + s * .9, top + s * .58); ctx.quadraticCurveTo(left + s * .94, top + s * .37, left + s * .79, top + s * .37); ctx.closePath();
    ctx.moveTo(left + s * .3, top + s * .47); ctx.lineTo(left + s * .3, top + s * .63);
    ctx.moveTo(left + s * .22, top + s * .55); ctx.lineTo(left + s * .38, top + s * .55);
    ctx.moveTo(left + s * .69, top + s * .49); ctx.arc(left + s * .69, top + s * .49, s * .025, 0, Math.PI * 2);
    ctx.moveTo(left + s * .77, top + s * .6); ctx.arc(left + s * .77, top + s * .6, s * .025, 0, Math.PI * 2);
  } else if (key === "message-circle") {
    ctx.arc(cx, cy - s * .03, s * .34, 0, Math.PI * 2);
    ctx.moveTo(left + s * .32, top + s * .74); ctx.lineTo(left + s * .2, top + s * .87); ctx.lineTo(left + s * .48, top + s * .79);
  } else if (key === "messages-square") {
    roundedPath(ctx, left + s * .12, top + s * .16, s * .67, s * .52, s * .08);
    ctx.moveTo(left + s * .28, top + s * .68); ctx.lineTo(left + s * .2, top + s * .8); ctx.lineTo(left + s * .42, top + s * .68);
    ctx.moveTo(left + s * .39, top + s * .36); ctx.lineTo(left + s * .84, top + s * .36); ctx.lineTo(left + s * .84, top + s * .74);
    ctx.lineTo(left + s * .68, top + s * .74);
  } else if (key === "shape-square" || key === "shape-grid") {
    ctx.rect(left + s * .18, top + s * .18, s * .64, s * .64);
    if (key === "shape-grid") { ctx.moveTo(cx, top + s * .18); ctx.lineTo(cx, top + s * .82); ctx.moveTo(left + s * .18, cy); ctx.lineTo(left + s * .82, cy); }
  } else if (key === "shape-triangle") {
    ctx.moveTo(cx, top + s * .14); ctx.lineTo(left + s * .86, top + s * .82); ctx.lineTo(left + s * .14, top + s * .82); ctx.closePath();
  } else if (key === "shape-diamond") {
    ctx.moveTo(cx, top + s * .1); ctx.lineTo(left + s * .88, cy); ctx.lineTo(cx, top + s * .9); ctx.lineTo(left + s * .12, cy); ctx.closePath();
  } else if (key === "shape-hexagon") {
    ctx.moveTo(left + s * .25, top + s * .12); ctx.lineTo(left + s * .75, top + s * .12); ctx.lineTo(left + s * .9, cy); ctx.lineTo(left + s * .75, top + s * .88); ctx.lineTo(left + s * .25, top + s * .88); ctx.lineTo(left + s * .1, cy); ctx.closePath();
  } else if (key === "shape-pentagon") {
    for (let i = 0; i < 5; i++) { const angle = -Math.PI / 2 + i * Math.PI * 2 / 5; const x = cx + Math.cos(angle) * s * .38; const y = cy + Math.sin(angle) * s * .38; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
  } else if (key === "shape-octagon") {
    for (let i = 0; i < 8; i++) { const angle = -Math.PI / 8 + i * Math.PI / 4; const x = cx + Math.cos(angle) * s * .38; const y = cy + Math.sin(angle) * s * .38; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
  } else if (key === "shape-star") {
    for (let i = 0; i < 10; i++) { const angle = -Math.PI / 2 + i * Math.PI / 5; const radius = s * (i % 2 ? .17 : .39); const x = cx + Math.cos(angle) * radius; const y = cy + Math.sin(angle) * radius; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
  } else if (key === "shape-shapes") {
    ctx.arc(cx - s * .12, cy + s * .08, s * .23, 0, Math.PI * 2);
    ctx.rect(cx, cy - s * .3, s * .36, s * .36);
  } else {
    ctx.arc(cx, cy, s * .34, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, node: RecapPlaceholderNode) {
  roundedPath(ctx, node.x, node.y, node.width, node.height, node.radius);
  ctx.save();
  ctx.clip();
  const gradient = ctx.createLinearGradient(node.x, node.y, node.x + node.width * 0.82, node.y + node.height);
  gradient.addColorStop(0, node.gradientStart);
  gradient.addColorStop(1, node.gradientEnd);
  ctx.fillStyle = gradient;
  ctx.fillRect(node.x, node.y, node.width, node.height);
  const cx = node.x + node.width / 2;
  const iconSize = Math.min(node.width * 0.18, node.height * 0.12);
  const gap = node.height * 0.035;
  const initialFont = Math.min(node.width * 0.34, node.height * 0.22);
  const groupHeight = iconSize + gap + initialFont;
  const startY = node.y + (node.height - groupHeight) / 2 - node.height * 0.015;
  drawMediaIcon(ctx, node.iconKey, cx, startY + iconSize / 2, iconSize, node.iconColor);
  ctx.fillStyle = node.initialColor;
  ctx.font = "400 " + initialFont + "px Georgia, 'Times New Roman', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(node.initial, cx, startY + iconSize + gap, node.width * 0.72);
  ctx.restore();
}

function wrappedLines(ctx: CanvasRenderingContext2D, node: RecapTextNode): { lines: string[]; overflow: boolean } {
  const result: string[] = [];
  for (const paragraph of node.text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { result.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (line && ctx.measureText(candidate).width > node.width) {
        result.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) result.push(line);
  }
  const maxLines = node.maxLines ?? result.length;
  if (result.length > maxLines) {
    const visible = result.slice(0, maxLines);
    let last = visible[visible.length - 1] ?? "";
    while (last && ctx.measureText(last + "…").width > node.width) last = last.slice(0, -1);
    visible[visible.length - 1] = last.trimEnd() + "…";
    return { lines: visible, overflow: true };
  }
  return { lines: result, overflow: false };
}

/** Draw a scene into an opaque, bounded sRGB browser canvas. */
export function renderRecapCanvas(scene: RecapScene, canvas: HTMLCanvasElement = document.createElement("canvas"), scale = 1): HTMLCanvasElement {
  if (scene.width > RECAP_MAX_DIMENSION || scene.height > RECAP_MAX_DIMENSION) throw new RangeError("Recap canvas exceeds the 4096 pixel limit");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Recap render scale must be a positive finite number");
  canvas.width = Math.max(1, Math.floor(scene.width * scale + 1e-7));
  canvas.height = Math.max(1, Math.floor(scene.height * scale + 1e-7));
  const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const warnings = new Set(scene.overflowWarnings);
  for (const node of scene.nodes) {
    ctx.save();
    ctx.globalAlpha = node.opacity ?? 1;
    if (node.kind === "rect") {
      roundedPath(ctx, node.x, node.y, node.width, node.height, node.radius ?? 0);
      ctx.fillStyle = node.fill;
      ctx.fill();
      if (node.stroke && node.strokeWidth) {
        ctx.lineWidth = node.strokeWidth;
        ctx.strokeStyle = node.stroke;
        ctx.stroke();
      }
    } else if (node.kind === "image") {
      roundedPath(ctx, node.x, node.y, node.width, node.height, node.radius);
      ctx.clip();
      if (node.image?.naturalWidth && node.image.naturalHeight) {
        if (node.fit === "contain") drawImageContain(ctx, node.image, node);
        else drawCoverCrop(ctx, node.image, node);
      }
    } else if (node.kind === "placeholder") {
      drawPlaceholder(ctx, node);
    } else {
      ctx.fillStyle = node.color;
      if (node.shadow) {
        ctx.shadowColor = "rgba(0,0,0,.54)";
        ctx.shadowBlur = Math.max(2, node.fontSize * 0.16);
        ctx.shadowOffsetY = 1;
      }
      ctx.font = (node.weight ?? 500) + " " + node.fontSize + "px " + node.fontFamily;
      ctx.textAlign = node.align ?? "left";
      ctx.textBaseline = "top";
      const { lines, overflow } = wrappedLines(ctx, node);
      if (overflow && node.entryId) warnings.add("title-overflow:" + node.entryId);
      const lineHeight = node.fontSize * 1.18;
      const textX = node.align === "center" ? node.x + node.width / 2 : node.align === "right" ? node.x + node.width : node.x;
      lines.forEach((line, index) => {
        if (index * lineHeight < node.height) ctx.fillText(line, textX, node.y + index * lineHeight, node.width);
      });
    }
    ctx.restore();
  }
  scene.overflowWarnings = [...warnings];
  return canvas;
}

/** PNG bytes used by browser download and the native platform save adapter. */
export function getRecapExportDimensions(scene: Pick<RecapScene, "width" | "height">): { width: number; height: number; scale: number } {
  const longestEdge = Math.max(scene.width, scene.height);
  const requestedScale = Math.max(1, RECAP_EXPORT_TARGET_LONG_EDGE / longestEdge);
  const edgeScale = RECAP_EXPORT_MAX_DIMENSION / longestEdge;
  const pixelScale = Math.sqrt(RECAP_EXPORT_MAX_PIXELS / (scene.width * scene.height));
  const scale = Math.min(requestedScale, edgeScale, pixelScale);
  return {
    width: Math.max(1, Math.floor(scene.width * scale + 1e-7)),
    height: Math.max(1, Math.floor(scene.height * scale + 1e-7)),
    scale,
  };
}

export async function exportRecapPng(scene: RecapScene, options: { canvas?: HTMLCanvasElement } = {}): Promise<Blob> {
  const dimensions = getRecapExportDimensions(scene);
  const canvas = renderRecapCanvas(scene, options.canvas, dimensions.scale);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
  });
}

export function recapSceneForPage(
  composition: RecapComposition,
  pageIndex: number,
  options: Omit<RecapSceneOptions, "pageIndex"> = {},
): RecapScene {
  return layoutRecapScene(composition, { ...options, pageIndex });
}

export function findRecapHitTarget(scene: RecapScene, x: number, y: number): RecapHitTarget | null {
  for (let index = scene.hitTargets.length - 1; index >= 0; index -= 1) {
    const target = scene.hitTargets[index];
    if (x >= target.x && x <= target.x + target.width && y >= target.y && y <= target.y + target.height) return target;
  }
  return null;
}

export function recapImageEntry(scene: RecapScene, slotId: string, composition: RecapComposition): RecapEntrySnapshot | null {
  return composition.slots.find((slot) => slot.id === slotId)?.entry ?? null;
}
