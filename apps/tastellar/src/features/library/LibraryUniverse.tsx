import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import {
  Eye,
  EyeOff,
  RotateCcw,
  PanelTopClose,
  PanelTopOpen,
} from "lucide-react";
import type { Preferences } from "../../shared/bridge/types";
import { t } from "../../shared/ui/i18n";
import {
  createUniverseRenderer,
  type UniverseProjection,
  type UniverseRendererOptions,
  type UniverseTheme,
  type UniverseViewState,
} from "../../rendering/scenes/universeRenderer";
import {
  extractCoverPalette,
  paletteFromSeed,
  type UniversePalette,
} from "../../rendering/scenes/palette";
import "./universe.css";

type GraphicsQuality = Preferences["graphics"];

interface TabUniverseState {
  camera: UniverseViewState | null;
  collapsed: boolean;
  showAllLabels: boolean;
}

const tabUniverseStates = new Map<string, TabUniverseState>();
const MAX_TAB_UNIVERSE_STATES = 64;

function readTabUniverseState(key: string): TabUniverseState | undefined {
  const state = tabUniverseStates.get(key);
  if (!state) return undefined;
  tabUniverseStates.delete(key);
  tabUniverseStates.set(key, state);
  return state;
}

function saveTabUniverseState(key: string, patch: Partial<TabUniverseState>) {
  const previous = tabUniverseStates.get(key) ?? {
    camera: null,
    collapsed: false,
    showAllLabels: true,
  };
  tabUniverseStates.delete(key);
  tabUniverseStates.set(key, { ...previous, ...patch });
  while (tabUniverseStates.size > MAX_TAB_UNIVERSE_STATES)
    tabUniverseStates.delete(tabUniverseStates.keys().next().value as string);
}

export interface LibraryUniverseWork {
  id: string;
  title: string;
  shortLabel?: string;
  rank: number | null;
  rating?: number | null;
  displayOrder: number;
  mediaTypeId?: string | null;
  coverAssetId?: string | null;
}

const scaleNames = {
  "10": "library.universe.scale.solarSystem",
  "9": "library.universe.scale.constellations",
  "8": "library.universe.scale.galaxy",
  "7": "library.universe.scale.deepField",
} as const;

function sceneName(groupId: string) {
  return t(scaleNames[groupId as keyof typeof scaleNames] ?? scaleNames["7"]);
}

function cssTheme(): UniverseTheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--surface", "#1c1c23"),
    ambient: read("--bg", "#15151a"),
    foreground: read("--text", "#ebebf0"),
    muted: read("--muted", "#9a9aa9"),
    accent: read("--accent", "#bab0ef"),
  };
}

function useUniverseTheme() {
  const [theme, setTheme] = useState<UniverseTheme>(() => cssTheme());
  useEffect(() => {
    const update = () => setTheme(cssTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return theme;
}

function labelLayout(
  objects: readonly ProjectedWork[],
  works: readonly {
    id: string;
    title: string;
    shortLabel?: string | null;
    rank: number | null;
  }[],
  showAll: boolean,
  retainInvisible: boolean,
) {
  const anchorOffsetY = 10;
  const workById = new Map(works.map((work) => [work.id, work]));
  if (!showAll) return [];
  return objects.flatMap((object) => {
    if ((!object.visible && !retainInvisible) || !workById.has(object.id)) return [];
    return [{
      object,
      left: object.x,
      top: object.y + anchorOffsetY,
    }];
  });
}

interface ProjectedWork {
  id: string;
  x: number;
  y: number;
  size: number;
  depth: number;
  visible: boolean;
  labelOpacity?: number;
  selectable?: boolean;
}

function UniverseCanvas({
  projection,
  theme,
  quality,
  motion,
  selectedId,
  onSelect,
  onStatus,
  showAllLabels,
  resetToken,
  initialViewState,
  onViewStateChange,
}: {
  projection: UniverseProjection;
  theme: UniverseTheme;
  quality: GraphicsQuality;
  motion: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStatus: (status: "fallback" | "ready") => void;
  showAllLabels: boolean;
  resetToken: number;
  initialViewState: UniverseViewState | null;
  onViewStateChange: (state: UniverseViewState) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createUniverseRenderer> | null>(null);
  const projectedRef = useRef<ProjectedWork[]>([]);
  const [projected, setProjected] = useState<ProjectedWork[]>([]);
  const [groupTransitioning, setGroupTransitioning] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const pointerOrigin = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const ignoreNextClick = useRef(false);
  const previousResetToken = useRef(resetToken);
  const previousProjectionGroup = useRef(projection.group);
  const labelTransitionMs = useRef(motion ? 950 : 120);
  labelTransitionMs.current = motion ? 950 : 120;
  useLayoutEffect(() => {
    if (previousProjectionGroup.current === projection.group) return;
    previousProjectionGroup.current = projection.group;
    setGroupTransitioning(true);
    const timeout = window.setTimeout(() => setGroupTransitioning(false), labelTransitionMs.current);
    return () => window.clearTimeout(timeout);
  }, [projection.group]);
  const callback = useCallback((next: readonly ProjectedWork[]) => {
    const value = [...next];
    const previous = projectedRef.current;
    const unchanged = value.length === previous.length && value.every((object, index) => {
      const old = previous[index];
      return old?.id === object.id && old.visible === object.visible &&
        Math.abs(old.x - object.x) < 0.35 && Math.abs(old.y - object.y) < 0.35 &&
        Math.abs(old.size - object.size) < 0.35 && Math.abs(old.depth - object.depth) < 0.001 &&
        Math.abs((old.labelOpacity ?? 1) - (object.labelOpacity ?? 1)) < 0.005 &&
        old.selectable === object.selectable;
    });
    if (unchanged) return;
    projectedRef.current = value;
    setProjected(value);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onStatus("ready");
    const renderer = createUniverseRenderer(canvas, {
      projection,
      theme,
      quality,
      motion,
      initialViewState,
      onViewStateChange,
      onProjected: callback,
      onStatus,
    } satisfies UniverseRendererOptions);
    rendererRef.current = renderer;
    onViewStateChange(renderer.getViewState());
    return () => {
      rendererRef.current = null;
      onViewStateChange(renderer.getViewState());
      renderer.dispose();
      projectedRef.current = [];
    };
    // The renderer owns one live context; only rebuild when crossing into or out of
    // graphics-off so the static Canvas2D fallback gets a fresh context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality === "off", callback, onStatus, onViewStateChange]);

  // Enable the full transition policy before updating the projection so entering
  // the stationary 2D Deep Field still receives the intended 7↔8 handoff.
  useEffect(() => {
    rendererRef.current?.updateMotion(motion);
  }, [motion]);
  useEffect(() => {
    rendererRef.current?.updateProjection(projection);
  }, [projection]);
  useEffect(() => {
    rendererRef.current?.updateTheme(theme);
  }, [theme]);
  useEffect(() => {
    rendererRef.current?.updateSelection(selectedId);
  }, [selectedId]);
  useEffect(() => {
    rendererRef.current?.updateQuality(quality);
  }, [quality]);
  useEffect(() => {
    rendererRef.current?.setActive(active);
  }, [active]);
  useEffect(() => {
    if (previousResetToken.current === resetToken) return;
    previousResetToken.current = resetToken;
    rendererRef.current?.reset();
  }, [resetToken]);
  useEffect(() => {
    const viewport = canvasRef.current?.parentElement;
    if (!viewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => setActive(entry.isIntersecting && entry.intersectionRatio > 0),
      { threshold: 0.01 },
    );
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const workById = useMemo(
    () => new Map(projection.works.map((work) => [work.id, work])),
    [projection.works],
  );
  const labels = useMemo(
    () =>
      labelLayout(
        projected,
        projection.works,
        showAllLabels,
        groupTransitioning || projection.group === "7",
      ),
    [groupTransitioning, projected, projection.group, projection.works, showAllLabels],
  );
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      rendererRef.current?.rotateBy(event.key === "ArrowLeft" ? -24 : 24, 0);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      rendererRef.current?.rotateBy(0, event.key === "ArrowUp" ? -18 : 18);
    } else if (event.key.toLocaleLowerCase("en") === "r" || event.key === "Home") {
      event.preventDefault();
      rendererRef.current?.reset();
    }
  };
  const pickAt = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== canvasRef.current) return;
    if (ignoreNextClick.current) {
      ignoreNextClick.current = false;
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let picked: ProjectedWork | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const object of projectedRef.current) {
      if (!(object.selectable ?? object.visible)) continue;
      const distance = Math.hypot(x - object.x, y - object.y);
      const hitRadius = Math.max(15, Math.min(28, object.size * 1.5 + 5));
      if (distance > hitRadius) continue;
      const score = distance + object.depth * 0.15;
      if (score < best) {
        best = score;
        picked = object;
      }
    }
    if (picked) onSelect(picked.id);
  };

  return (
    <div
      className="universe-viewport"
      role="region"
      aria-label={t("library.universe.viewport")}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={pickAt}
      onPointerDown={(event) => {
        if (event.target === canvasRef.current)
          pointerOrigin.current = { x: event.clientX, y: event.clientY, dragged: false };
      }}
      onPointerMove={(event) => {
        const origin = pointerOrigin.current;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 5)
          origin.dragged = true;
      }}
      onPointerUp={() => {
        if (pointerOrigin.current?.dragged) {
          ignoreNextClick.current = true;
          window.setTimeout(() => { ignoreNextClick.current = false; }, 0);
        }
        pointerOrigin.current = null;
      }}
      onPointerCancel={() => { pointerOrigin.current = null; }}
    >
      <canvas ref={canvasRef} className="universe-canvas" aria-hidden="true" />
      <div
        className={`universe-object-layer${projection.works.length > 60 ? " dense" : ""}`}
        aria-label={t("library.universe.visibleWorks")}
      >
        {labels.map(({ object, left, top }) => {
          const work = workById.get(object.id);
          if (!work) return null;
          const labelOpacity = groupTransitioning
            ? 0
            : Math.max(0, Math.min(1, object.labelOpacity ?? 1));
          return (
            <button
              key={work.id}
              type="button"
              className={`universe-object-label${selectedId === work.id ? " selected" : ""}${hoveredId === work.id ? " hovered" : ""}${groupTransitioning ? " transition-hidden" : ""}`}
              style={{ left, top, opacity: labelOpacity, pointerEvents: labelOpacity < 0.05 || object.selectable === false ? "none" : "auto" }}
              data-testid="universe-work"
              data-work-id={work.id}
              data-work-rank={work.rank ?? "unplaced"}
              data-projected-x={object.x}
              data-projected-y={object.y}
              data-label-opacity={labelOpacity}
              data-selectable={object.selectable ?? object.visible}
              aria-label={work.title}
              aria-hidden={labelOpacity < 0.05 || object.selectable === false}
              tabIndex={labelOpacity < 0.05 || object.selectable === false ? -1 : 0}
              aria-pressed={selectedId === work.id}
              title={work.title}
              onPointerEnter={() => setHoveredId(work.id)}
              onPointerLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(work.id)}
              onBlur={() => setHoveredId(null)}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(work.id);
              }}
            >
              <span>{work.shortLabel || work.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LibraryUniverse({
  groupId,
  groupLabel,
  works,
  visibleIds,
  selectedId,
  groupCount,
  quality,
  reducedMotion,
  onQualityChange,
  onSelect,
  onLoadCover,
  onAddWork,
  onClearFilters,
  emptyBecauseFiltered,
  sceneViewKey,
}: {
  groupId: string;
  groupLabel: string;
  works: readonly LibraryUniverseWork[];
  visibleIds: ReadonlySet<string>;
  selectedId: string | null;
  groupCount: number;
  quality: GraphicsQuality;
  reducedMotion: boolean;
  onQualityChange?: (quality: GraphicsQuality) => void | Promise<void>;
  onSelect: (id: string) => void;
  onLoadCover?: (entryId: string, assetId?: string | null) => Promise<string | null>;
  onAddWork: () => void;
  onClearFilters: () => void;
  emptyBecauseFiltered: boolean;
  sceneViewKey: string;
}) {
  const [restoredView] = useState(() => readTabUniverseState(sceneViewKey));
  const cameraState = useRef<UniverseViewState | null>(restoredView?.camera ?? null);
  const [cameraSnapshot, setCameraSnapshot] = useState<UniverseViewState | null>(restoredView?.camera ?? null);
  const [collapsed, setCollapsed] = useState(restoredView?.collapsed ?? false);
  const [showAllLabels, setShowAllLabels] = useState(restoredView?.showAllLabels ?? true);
  const [graphics, setGraphics] = useState(quality);
  const [status, setStatus] = useState<"fallback" | "ready">("ready");
  const [retryKey, setRetryKey] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [palettes, setPalettes] = useState<Map<string, UniversePalette>>(() => new Map());
  const paletteRequests = useRef(new Map<string, Promise<UniversePalette>>());
  const theme = useUniverseTheme();
  const [systemReduced, setSystemReduced] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => setGraphics(quality), [quality]);
  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    const pending = works
      .filter((work) => visibleIds.has(work.id) && work.coverAssetId)
      .slice(0, 128)
      .filter(
        (work) => Boolean(work.coverAssetId) && !palettes.has(work.coverAssetId!) && onLoadCover,
      );
    if (!pending.length) return;
    void (async () => {
      const queue = [...pending];
      const extractNext = async () => {
        const results: Array<[string, UniversePalette]> = [];
        while (queue.length && !cancelled) {
          const work = queue.shift()!;
          if (!work.coverAssetId || !onLoadCover) continue;
          let request = paletteRequests.current.get(work.coverAssetId);
          if (!request) {
            request = onLoadCover(work.id, work.coverAssetId)
              .then((source) =>
                source
                  ? extractCoverPalette(source, work.id, work.coverAssetId ?? undefined)
                  : paletteFromSeed(work.id),
              )
              .catch(() => paletteFromSeed(work.id));
            paletteRequests.current.set(work.coverAssetId, request);
            while (paletteRequests.current.size > 128)
              paletteRequests.current.delete(
                paletteRequests.current.keys().next().value as string,
              );
          }
          const palette = await request;
          results.push([work.coverAssetId, palette]);
        }
        return results;
      };
      const batches = await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, extractNext),
      );
      if (cancelled) return;
      setPalettes((current) => {
        const next = new Map(current);
        for (const [key, palette] of batches.flat()) next.set(key, palette);
        while (next.size > 128) next.delete(next.keys().next().value as string);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [collapsed, onLoadCover, palettes, visibleIds, works]);

  const projectionWorks = useMemo(
    () => works.map((work) => ({
      ...work,
      palette: work.coverAssetId
        ? palettes.get(work.coverAssetId) ?? paletteFromSeed(work.id)
        : paletteFromSeed(work.id),
    })),
    [palettes, works],
  );
  const projection = useMemo<UniverseProjection>(() => ({
    group: groupId as UniverseProjection["group"],
    works: projectionWorks,
    visibleIds,
  }), [groupId, projectionWorks, visibleIds]);
  const fullMotion = graphics !== "off" && !reducedMotion && !systemReduced;
  const name = sceneName(groupId);
  const sceneStatus = useCallback((next: "fallback" | "ready") => setStatus(next), []);
  const handleViewStateChange = useCallback((view: UniverseViewState) => {
    cameraState.current = view;
    saveTabUniverseState(sceneViewKey, { camera: view });
    setCameraSnapshot(view);
  }, [sceneViewKey]);
  const setCollapsedAndSave = (value: boolean) => {
    setCollapsed(value);
    saveTabUniverseState(sceneViewKey, { collapsed: value });
  };
  const setShowAllLabelsAndSave = (value: boolean) => {
    setShowAllLabels(value);
    saveTabUniverseState(sceneViewKey, { showAllLabels: value });
  };
  const qualityChanged = (value: GraphicsQuality) => {
    setGraphics(value);
    void Promise.resolve(onQualityChange?.(value)).catch(() => setGraphics(quality));
  };

  return (
    <section
      className={`library-universe${collapsed ? " collapsed" : ""}`}
      data-testid="library-universe"
      data-renderer-status={status}
      data-motion-enabled={fullMotion}
      data-camera-group={cameraSnapshot?.group}
      data-camera-yaw={cameraSnapshot?.yaw}
      data-camera-pitch={cameraSnapshot?.pitch}
      data-camera-distance={cameraSnapshot?.distance}
      data-camera-pan-x={cameraSnapshot?.panX}
      data-camera-pan-y={cameraSnapshot?.panY}
      aria-label={t("library.universe.sceneFor", { scene: name, group: groupLabel })}
    >
      <header className="universe-header">
        <div className="universe-heading">
          <span className="universe-eyebrow">{t("library.universe.eyebrow")}</span>
          <div className="universe-title-row">
            <h2>{name}</h2>
            <span className="universe-count">{t("library.universe.workCount", { count: groupCount })}</span>
          </div>
        </div>
        <div className="universe-controls" aria-label={t("library.universe.controls")}>
          <button
            type="button"
            className="universe-tool"
            title={t("library.universe.resetHint")}
            aria-label={t("library.universe.resetView")}
            onClick={() => {
              cameraState.current = null;
              saveTabUniverseState(sceneViewKey, { camera: null });
              setResetToken((value) => value + 1);
            }}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            className={`universe-tool${showAllLabels ? " active" : ""}`}
            title={showAllLabels ? t("library.universe.fewerTitles") : t("library.universe.moreTitles")}
            aria-label={showAllLabels ? t("library.universe.fewerTitles") : t("library.universe.moreTitles")}
            aria-pressed={showAllLabels}
            onClick={() => setShowAllLabelsAndSave(!showAllLabels)}
          >
            {showAllLabels ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <label className="universe-quality">
            <span className="sr-only">{t("library.universe.quality")}</span>
            <select
              aria-label={t("library.universe.quality")}
              value={graphics}
              onChange={(event) => qualityChanged(event.target.value as GraphicsQuality)}
            >
              <option value="auto">{t("library.universe.quality.auto")}</option>
              <option value="low">{t("library.universe.quality.low")}</option>
              <option value="medium">{t("library.universe.quality.medium")}</option>
              <option value="high">{t("library.universe.quality.high")}</option>
              <option value="off">{t("library.universe.quality.off")}</option>
            </select>
          </label>
          <button
            type="button"
            className="universe-tool"
            title={collapsed ? t("library.universe.expandScene") : t("library.universe.collapseScene")}
            aria-label={collapsed ? t("library.universe.expandScene") : t("library.universe.collapseScene")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsedAndSave(!collapsed)}
          >
            {collapsed ? <PanelTopOpen size={14} /> : <PanelTopClose size={14} />}
          </button>
        </div>
      </header>

      {!collapsed ? (
        <>
          <div className="universe-canvas-wrap" key={retryKey}>
            <UniverseCanvas
              key={`${graphics === "off" ? "static" : "3d"}-${retryKey}`}
              projection={projection}
              theme={theme}
              quality={graphics}
              motion={fullMotion}
              selectedId={selectedId}
              onSelect={onSelect}
              onStatus={sceneStatus}
              showAllLabels={showAllLabels}
              resetToken={resetToken}
              initialViewState={cameraState.current}
              onViewStateChange={handleViewStateChange}
            />
            {groupCount === 0 && (
              <div className="universe-empty-state">
                <span>{emptyBecauseFiltered ? t("library.universe.filteredTitle") : t("library.universe.emptyTitle", { group: groupLabel })}</span>
                <p>{emptyBecauseFiltered ? t("library.universe.filteredDescription") : t("library.universe.emptyDescription")}</p>
                <button type="button" onClick={emptyBecauseFiltered ? onClearFilters : onAddWork}>
                  {emptyBecauseFiltered ? t("library.ui.clearAllFilters") : t("library.ui.addWork")}
                </button>
              </div>
            )}
            {status === "fallback" && (
              <div className="universe-render-status" role="status">
                <span>{graphics === "off" ? t("library.universe.staticView") : t("library.universe.unavailable")}</span>
                {graphics !== "off" && (
                  <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
                    {t("library.universe.retry")}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
