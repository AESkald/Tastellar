import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  Download,
  Image as ImageIcon,
  Layers3,
  Palette,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import type { Preferences } from "../../shared/bridge/types";
import type { RankingStateView } from "../ranking/Ranking";
import { t } from "../../shared/ui/i18n";
import { Modal } from "../../shared/ui/Modal";
import { mediaTypeName } from "../library/MediaTypeIcon";
import { loadRecapCover, saveRecapImage } from "../../shared/bridge/recapBridge";
import { loadRecapCoverWithCache } from "./coverCache";
import {
  createRecapComposition,
  getDefaultRecapStyle,
  getDefaultRecapOrientation,
  getRecapSourceFingerprint,
  getRecapReplacementCandidates,
  getRecapTemplates,
  removeRecapSlotEntry,
  normalizeRecapComposition,
  recapSupportsOrientation,
  replaceRecapSlotEntry,
  swapRecapSlots,
  updateRecapComposition,
  type RecapComposition,
  type RecapEntrySnapshot,
  type RecapFilter,
  type RecapRankedTier,
  type RecapStyle,
  type RecapStoredTemplateId,
  type RecapTemplateAvailability,
  type RecapTemplateId,
} from "./domain/recap";
import {
  exportRecapPng,
  loadRecapScene,
  layoutRecapScene,
  recapPageCount,
  renderRecapCanvas,
  resolveRecapSceneCovers,
  type RecapScene,
} from "../../rendering/recap/renderer";
import "./recap.css";

interface RecapDraftEnvelope {
  version: 1;
  drafts: RecapComposition[];
}

interface GallerySceneRecord {
  key: string;
  scene: RecapScene | null;
  error: boolean;
  resolved: boolean;
}

interface RecapProps {
  state: RankingStateView | null;
  preferences: Preferences;
  onPreferences: (patch: Partial<Preferences>) => Promise<void>;
  onOpenLibrary: () => void;
  onOpenRanking: () => void;
  error?: string;
  onRetry?: () => void | Promise<unknown>;
}

function draftBlobByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const templateOrder: RecapTemplateId[] = [
  "topTen",
  "challengers",
  "grid3x3",
  "releaseYear",
  "decade",
  "format",
];
const styles: RecapStyle[] = ["daylight", "dark", "dusk", "reading"];
const modes: Array<RecapComposition["mode"]> = ["cover", "text"];
const resolvedSceneCache = new Map<string, RecapScene>();

function resolvedTheme(preferenceTheme: string): string {
  if (preferenceTheme === "system") return document.documentElement.dataset.theme ?? "dark";
  return preferenceTheme === "forest" ? "reading" : preferenceTheme;
}

function useResolvedTheme(preferenceTheme: string) {
  const [theme, setTheme] = useState(() => resolvedTheme(preferenceTheme));
  useEffect(() => {
    const update = () => setTheme(resolvedTheme(preferenceTheme));
    update();
    if (preferenceTheme !== "system") return;
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [preferenceTheme]);
  return theme;
}

function parseDraftEnvelope(value: string | undefined): RecapDraftEnvelope | null {
  if (!value) return { version: 1, drafts: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" && parsed !== null &&
      "version" in parsed && parsed.version === 1 &&
      "drafts" in parsed && Array.isArray(parsed.drafts) && parsed.drafts.length <= 30 &&
      parsed.drafts.every((draft) => typeof draft === "object" && draft !== null && "id" in draft && typeof draft.id === "string" && "templateId" in draft && typeof draft.templateId === "string" && "slots" in draft && Array.isArray(draft.slots)) &&
      parsed.drafts.reduce((count, draft) => count + ("slots" in draft && Array.isArray(draft.slots) ? draft.slots.length : 0), 0) <= 300
    ) {
      const drafts = parsed.drafts.map((draft) => normalizeRecapComposition(draft));
      if (drafts.some((draft) => draft === null)) return null;
      return { version: 1, drafts: drafts as RecapComposition[] };
    }
  } catch {
    return null;
  }
  return null;
}

function templateTitle(id: RecapTemplateId) {
  return t(`recap.template.${id}`);
}

function isActiveTemplateId(id: RecapStoredTemplateId): id is RecapTemplateId {
  return id !== "selection";
}

type RecapFilterPatch = {
  kind?: RecapFilter["kind"];
  typeIds?: string[];
  tagIds?: string[];
  tagMode?: "any" | "all";
};

function mergeRecapFilter(current: RecapFilter, patch: RecapFilterPatch): RecapFilter {
  const kind = patch.kind ?? current.kind;
  const tags = patch.tagIds ?? current.tagIds;
  const tagMode = patch.tagMode ?? current.tagMode;
  const tagFields = {
    ...(tags ? { tagIds: [...tags] } : {}),
    ...(tagMode ? { tagMode } : {}),
  };
  if (kind === "types") {
    const typeIds = patch.typeIds ?? (current.kind === "types" ? current.typeIds : []);
    return { kind, typeIds: [...typeIds], ...tagFields };
  }
  return { kind, ...tagFields };
}

function compositionRenderKey(composition: RecapComposition, pageIndex: number, watermark: boolean) {
  return JSON.stringify({
    templateId: composition.templateId,
    sourceFingerprint: composition.sourceFingerprint,
    pageIndex,
    watermark,
    watermarkText: t("recap.poster.watermark"),
    selectionText: t("recap.poster.manualOrder"),
    filteredRankText: t("recap.poster.filteredRank"),
    filter: {
      kind: composition.filter.kind,
      typeIds: composition.filter.kind === "types" ? [...composition.filter.typeIds].sort() : [],
      tagIds: [...(composition.filter.tagIds ?? [])].sort(),
      tagMode: composition.filter.tagMode ?? "any",
    },
    style: composition.style,
    mode: composition.mode,
    orientation: composition.orientation,
    showTitles: composition.showTitles,
    showMediaTypes: composition.showMediaTypes ?? true,
    rankingLabel: composition.rankingLabel,
    heading: composition.heading,
    caption: composition.caption,
    slots: composition.slots.map((slot) => ({
      id: slot.id,
      page: slot.page,
      rank: slot.rank,
      label: slot.label,
      predicate: slot.predicate,
      titleOverride: slot.titleOverride,
      entry: slot.entry && {
        id: slot.entry.id,
        title: slot.entry.title,
        shortLabel: slot.entry.shortLabel,
        mediaTypeId: slot.entry.mediaTypeId,
        mediaTypeName: slot.entry.mediaTypeName,
        iconKey: slot.entry.iconKey,
        year: slot.entry.year,
        coverAssetId: slot.entry.coverAssetId,
        remoteCover: slot.entry.remoteCover && {
          provider: slot.entry.remoteCover.provider,
          url: slot.entry.remoteCover.url,
        },
      },
    })),
  });
}

function cacheResolvedScene(cache: Map<string, RecapScene>, key: string, scene: RecapScene) {
  cache.delete(key);
  cache.set(key, scene);
  while (cache.size > 24) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function sceneHasFailedCover(scene: RecapScene, composition: RecapComposition): boolean {
  const coverEntryIds = new Set(composition.slots.flatMap((slot) =>
    slot.entry && (slot.entry.coverAssetId || slot.entry.remoteCover) ? [slot.entry.id] : [],
  ));
  return scene.nodes.some((node) => node.kind === "placeholder" && coverEntryIds.has(node.entryId));
}

export function Recap({
  state,
  preferences,
  onPreferences,
  onOpenLibrary,
  onOpenRanking,
  error = "",
  onRetry,
}: RecapProps) {
  const initialBlob = preferences.recapDrafts ?? "";
  const initialEnvelope = useMemo(() => parseDraftEnvelope(initialBlob), []);
  const [drafts, setDrafts] = useState<RecapComposition[]>(initialEnvelope?.drafts ?? []);
  const [draftDataError, setDraftDataError] = useState(!initialEnvelope);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ past: RecapComposition[]; future: RecapComposition[] }>({ past: [], future: [] });
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [replacementSearch, setReplacementSearch] = useState("");
  const [scene, setScene] = useState<RecapScene | null>(null);
  const [visibleGalleryIds, setVisibleGalleryIds] = useState<RecapTemplateId[]>([]);
  const [galleryScenes, setGalleryScenes] = useState<Partial<Record<RecapTemplateId, GallerySceneRecord>>>({});
  const [loadedSceneKey, setLoadedSceneKey] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState(false);
  const [refreshDialog, setRefreshDialog] = useState(false);
  const [removeWatermarkDialog, setRemoveWatermarkDialog] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaveError, setDraftSaveError] = useState(false);
  const [watermarkSaveError, setWatermarkSaveError] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0 });
  const [exportStatus, setExportStatus] = useState<"ready" | "saved" | "cancelled" | "error">("ready");
  const [coverUrls, setCoverUrls] = useState<Record<string, string | null>>({});
  const [coverRetryVersion, setCoverRetryVersion] = useState(0);
  const [overflowWarningCount, setOverflowWarningCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [draftLimitError, setDraftLimitError] = useState("");
  const [deleteDraftId, setDeleteDraftId] = useState<string | null>(null);
  const [deleteAllDraftsDialog, setDeleteAllDraftsDialog] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gallerySectionRefs = useRef(new Map<RecapTemplateId, HTMLElement>());
  const galleryCanvasRefs = useRef(new Map<RecapTemplateId, HTMLCanvasElement>());
  const galleryLoadingKeys = useRef(new Map<RecapTemplateId, string>());
  const gallerySceneKeys = useRef(new Map<RecapTemplateId, string>());
  const galleryPreviewNow = useRef(new Date().toISOString());
  const exportCancel = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverLoads = useRef(new Map<string, Promise<string | null>>());
  const coverRetryKeys = useRef(new Set<string>());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const onPreferencesRef = useRef(onPreferences);
  onPreferencesRef.current = onPreferences;
  const lastSavedBlob = useRef(initialBlob);
  const lastSubmittedBlob = useRef<string | null>(null);
  const pendingBlob = useRef<string | null>(null);
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const [saveRetry, setSaveRetry] = useState(0);
  const activeTheme = useResolvedTheme(preferences.theme);

  const retryFailedCoverOnce = useCallback((key: string) => {
    if (coverRetryKeys.current.has(key)) return false;
    coverRetryKeys.current.add(key);
    window.setTimeout(() => {
      if (mounted.current) setCoverRetryVersion((current) => current + 1);
    }, 350);
    return true;
  }, []);

  const persistDraftBlob = useCallback((serialized: string) => {
    if (draftBlobByteLength(serialized) > 1_000_000) {
      if (mounted.current) {
        setSavingDraft(false);
        setDraftSaveError(true);
        setDraftLimitError(t("recap.limit.size"));
      }
      return Promise.resolve();
    }
    pendingBlob.current = serialized;
    persistQueue.current = persistQueue.current.catch(() => undefined).then(async () => {
      lastSubmittedBlob.current = serialized;
      if (mounted.current) {
        setSavingDraft(true);
        setDraftSaveError(false);
      }
      try {
        await onPreferencesRef.current({ recapDrafts: serialized });
        lastSavedBlob.current = serialized;
        if (pendingBlob.current === serialized) pendingBlob.current = null;
        if (mounted.current) {
          setSavingDraft(false);
          setDraftSaveError(false);
        }
      } catch {
        if (lastSubmittedBlob.current === serialized) lastSubmittedBlob.current = null;
        if (mounted.current) {
          setSavingDraft(false);
          setDraftSaveError(true);
        }
      }
    });
    return persistQueue.current;
  }, []);

  useEffect(() => {
    if (
      preferences.recapDrafts === lastSavedBlob.current ||
      preferences.recapDrafts === lastSubmittedBlob.current ||
      pendingBlob.current !== null
    ) return;
    const parsed = parseDraftEnvelope(preferences.recapDrafts);
    if (!parsed) {
      setDraftDataError(true);
      return;
    }
    lastSavedBlob.current = preferences.recapDrafts;
    setDraftDataError(false);
    setDrafts(parsed.drafts);
  }, [preferences.recapDrafts]);

  useEffect(() => {
    if (draftDataError) return;
    const serialized = JSON.stringify({ version: 1, drafts } satisfies RecapDraftEnvelope);
    if (draftBlobByteLength(serialized) > 1_000_000) {
      setDraftLimitError(t("recap.limit.size"));
      setDraftSaveError(true);
      return;
    }
    if (serialized === lastSavedBlob.current || serialized === lastSubmittedBlob.current) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    pendingBlob.current = serialized;
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      void persistDraftBlob(serialized);
    }, 280);
  }, [drafts, draftDataError, saveRetry, persistDraftBlob]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      const serialized = pendingBlob.current ?? JSON.stringify({ version: 1, drafts: draftsRef.current } satisfies RecapDraftEnvelope);
      if (serialized !== lastSavedBlob.current) void persistDraftBlob(serialized);
    };
  }, [persistDraftBlob]);

  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? null;
  const activeTemplateId = activeDraft && isActiveTemplateId(activeDraft.templateId) ? activeDraft.templateId : null;
  const activeSceneKey = activeDraft && activeTemplateId
    ? compositionRenderKey(activeDraft, pageIndex, preferences.recapWatermark ?? true)
    : "";
  const tierProjection = useMemo(
    () => state?.tiers.map(({ score, placedIds }) => ({ score, placedIds })) ?? [],
    [state?.tiers],
  );
  const activeMediaTypes = useMemo(
    () => state?.library.mediaTypes.filter((type) => !type.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder) ?? [],
    [state?.library.mediaTypes],
  );
  const catalog = useMemo(
    () => state ? getRecapTemplates(state.library.entries, tierProjection, activeMediaTypes) : null,
    [state, tierProjection, activeMediaTypes],
  );
  const activeCatalog = useMemo(
    () => state && activeDraft && activeTemplateId
      ? getRecapTemplates(state.library.entries, tierProjection, activeMediaTypes, activeDraft.filter)
      : null,
    [state, activeDraft, activeTemplateId, tierProjection, activeMediaTypes],
  );
  const currentSourceFingerprint = useMemo(
    () => state && activeDraft
      ? getRecapSourceFingerprint(state.library.entries, tierProjection, activeMediaTypes, activeDraft.filter)
      : null,
    [state, activeDraft?.filter, tierProjection, activeMediaTypes],
  );
  const eligibleTemplates = useMemo(() => {
    if (!catalog) return [];
    return templateOrder.flatMap((id) => {
      const row = catalog.templates.find((template) => template.id === id);
      return row?.eligible ? [row] : [];
    });
  }, [catalog]);
  const activeTemplateAvailability = activeCatalog?.templates.find((template) => template.id === activeTemplateId);
  const activeTemplateReady = Boolean(activeTemplateAvailability?.eligible);
  const galleryAvailabilityRows = eligibleTemplates;
  const galleryCompositions = useMemo(() => {
    if (!state) return [];
    return galleryAvailabilityRows.map((availability) => {
      const created = createRecapComposition(
        availability.id,
        state.library.entries,
        tierProjection,
        activeMediaTypes,
        { kind: "all" },
        {
          id: `gallery-${availability.id}`,
          now: galleryPreviewNow.current,
          revision: state.revision,
          defaultStyle: getDefaultRecapStyle(activeTheme),
          mode: "cover",
          orientation: getDefaultRecapOrientation(availability.id),
          showTitles: false,
          showMediaTypes: true,
          watermark: preferences.recapWatermark ?? true,
        },
      );
      return { availability, composition: { ...created, templateId: availability.id } };
    });
  }, [state, galleryAvailabilityRows, tierProjection, activeMediaTypes, activeTheme, preferences.recapWatermark]);
  const galleryCompositionById = useMemo(
    () => new Map(galleryCompositions.map(({ composition }) => [composition.templateId, composition])),
    [galleryCompositions],
  );
  const sceneOptions = useMemo(() => ({
    watermark: preferences.recapWatermark ?? true,
    watermarkText: t("recap.poster.watermark"),
    selectionText: t("recap.poster.manualOrder"),
    filteredRankText: t("recap.poster.filteredRank"),
  }), [preferences.recapWatermark]);
  const galleryLayouts = useMemo(() => new Map(galleryCompositions.map(({ composition }) => [
    composition.templateId,
    layoutRecapScene(composition, { ...sceneOptions, pageIndex: 0 }),
  ])), [galleryCompositions, sceneOptions]);
  const activeLayoutScene = useMemo(
    () => activeDraft && activeTemplateId
      ? layoutRecapScene(activeDraft, { ...sceneOptions, pageIndex })
      : null,
    [activeDraft, activeTemplateId, activeSceneKey, sceneOptions, pageIndex],
  );
  const resolvedActiveScene = activeSceneKey
    ? resolvedSceneCache.get(activeSceneKey) ?? (loadedSceneKey === activeSceneKey ? scene : null)
    : null;
  const activePreviewScene = resolvedActiveScene ?? activeLayoutScene;

  const resolveCover = useCallback((entry: RecapEntrySnapshot): Promise<string | null> => {
    const cacheKey = entry.coverAssetId ?? (entry.remoteCover
      ? `remote:${entry.remoteCover.provider}:${entry.remoteCover.url}`
      : entry.id);
    return loadRecapCoverWithCache(coverLoads.current, cacheKey, () =>
      loadRecapCover(entry.id, entry.coverAssetId, entry.remoteCover),
    ).then((url) => {
      setCoverUrls((current) => current[entry.id] === url ? current : { ...current, [entry.id]: url });
      return url;
    });
  }, []);

  const loaderForComposition = useCallback((composition: RecapComposition) => {
    const snapshots = new Map<string, RecapEntrySnapshot>();
    for (const slot of composition.slots) if (slot.entry) snapshots.set(slot.entry.id, slot.entry);
    return (entryId: string, assetId: string | null, remoteCover?: RecapEntrySnapshot["remoteCover"]) => {
      const snapshot = snapshots.get(entryId);
      return snapshot ? resolveCover(snapshot) : loadRecapCover(entryId, assetId, remoteCover);
    };
  }, [resolveCover]);

  useEffect(() => {
    for (const { composition } of galleryCompositions) {
      if (!visibleGalleryIds.includes(composition.templateId)) continue;
      const key = compositionRenderKey(composition, 0, preferences.recapWatermark ?? true);
      if (gallerySceneKeys.current.get(composition.templateId) === key || galleryLoadingKeys.current.get(composition.templateId) === key) continue;
      const layout = galleryLayouts.get(composition.templateId);
      if (!layout) continue;
      const cached = resolvedSceneCache.get(key);
      if (cached) {
        gallerySceneKeys.current.set(composition.templateId, key);
        setGalleryScenes((current) => ({ ...current, [composition.templateId]: { key, scene: cached, error: false, resolved: true } }));
        continue;
      }
      galleryLoadingKeys.current.set(composition.templateId, key);
      setGalleryScenes((current) => ({ ...current, [composition.templateId]: { key, scene: layout, error: false, resolved: false } }));
      void resolveRecapSceneCovers(layout, composition, loaderForComposition(composition)).then((loaded) => {
        const failedCover = sceneHasFailedCover(loaded, composition);
        if (failedCover) {
          resolvedSceneCache.delete(key);
          if (retryFailedCoverOnce(key)) gallerySceneKeys.current.delete(composition.templateId);
          else gallerySceneKeys.current.set(composition.templateId, key);
        } else {
          cacheResolvedScene(resolvedSceneCache, key, loaded);
          gallerySceneKeys.current.set(composition.templateId, key);
        }
        if (galleryLoadingKeys.current.get(composition.templateId) !== key) return;
        galleryLoadingKeys.current.delete(composition.templateId);
        if (!mounted.current) return;
        setGalleryScenes((current) => ({ ...current, [composition.templateId]: { key, scene: loaded, error: false, resolved: true } }));
      }).catch(() => {
        if (galleryLoadingKeys.current.get(composition.templateId) !== key) return;
        galleryLoadingKeys.current.delete(composition.templateId);
        if (!mounted.current) return;
        gallerySceneKeys.current.set(composition.templateId, key);
        setGalleryScenes((current) => ({ ...current, [composition.templateId]: { key, scene: null, error: true } }));
      });
    }
  }, [galleryCompositions, galleryLayouts, visibleGalleryIds, preferences.recapWatermark, loaderForComposition, coverRetryVersion, retryFailedCoverOnce]);

  useEffect(() => {
    for (const [templateId, record] of Object.entries(galleryScenes) as Array<[RecapTemplateId, GallerySceneRecord]>) {
      const canvas = galleryCanvasRefs.current.get(templateId);
      if (!canvas || !record.scene) continue;
      try {
        renderRecapCanvas(record.scene, canvas);
      } catch {
        setGalleryScenes((current) => ({ ...current, [templateId]: { ...record, scene: null, error: true } }));
      }
    }
  }, [galleryScenes]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setVisibleGalleryIds(galleryCompositions.map(({ composition }) => composition.templateId));
      return;
    }
    const observer = new IntersectionObserver((records) => {
      const newlyVisible = records.flatMap((record) => {
        if (!record.isIntersecting) return [];
        const id = (record.target as HTMLElement).dataset.recapTemplate as RecapTemplateId | undefined;
        return id ? [id] : [];
      });
      if (newlyVisible.length) {
        setVisibleGalleryIds((current) => [...new Set([...current, ...newlyVisible])]);
      }
    }, { rootMargin: "240px 0px", threshold: 0.01 });
    for (const { composition } of galleryCompositions) {
      const section = gallerySectionRefs.current.get(composition.templateId);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [galleryCompositions, activeDraftId]);

  const beginEdit = (templateId: RecapTemplateId, existing?: RecapComposition) => {
    if (existing) {
      if (!isActiveTemplateId(existing.templateId)) return;
      const normalized = normalizeRecapComposition(existing, state?.library.entries, activeMediaTypes) ?? existing;
      if (normalized !== existing) setDrafts((current) => current.map((draft) => draft.id === normalized.id ? normalized : draft));
      setActiveDraftId(normalized.id);
      setHistory({ past: [], future: [] });
      setSelectedSlotId(null);
      setReplacementOpen(false);
      setPageIndex(0);
      return;
    }
    if (!state || !catalog) return;
    const next = createRecapComposition(
      templateId,
      state.library.entries,
      tierProjection,
      activeMediaTypes,
      { kind: "all" },
      {
        revision: state.revision,
        defaultStyle: getDefaultRecapStyle(activeTheme),
        mode: "cover",
        orientation: getDefaultRecapOrientation(templateId),
        showTitles: false,
        showMediaTypes: true,
        watermark: preferences.recapWatermark ?? true,
      },
    );
    if (drafts.length >= 30) {
      setDraftLimitError(t("recap.limit.drafts"));
      return;
    }
    if (drafts.reduce((count, draft) => count + draft.slots.length, 0) + next.slots.length > 300) {
      setDraftLimitError(t("recap.limit.slots"));
      return;
    }
    setDraftLimitError("");
    setDrafts((current) => [...current, next]);
    setActiveDraftId(next.id);
    setHistory({ past: [], future: [] });
    setSelectedSlotId(null);
    setReplacementOpen(false);
    setPageIndex(0);
    setExportStatus("ready");
  };

  const goBack = () => {
    setActiveDraftId(null);
    setSelectedSlotId(null);
    setReplacementOpen(false);
    setHistory({ past: [], future: [] });
  };

  const saveComposition = (next: RecapComposition, remember = true): boolean => {
    const otherSlots = drafts.filter((draft) => draft.id !== next.id).reduce((count, draft) => count + draft.slots.length, 0);
    if (otherSlots + next.slots.length > 300) {
      setDraftLimitError(t("recap.limit.slots"));
      return false;
    }
    const nextDrafts = drafts.map((draft) => draft.id === next.id ? next : draft);
    if (draftBlobByteLength(JSON.stringify({ version: 1, drafts: nextDrafts })) > 1_000_000) {
      setDraftLimitError(t("recap.limit.size"));
      return false;
    }
    if (activeDraft && remember) {
      setHistory((current) => ({
        past: [...current.past.slice(-39), activeDraft],
        future: [],
      }));
    }
    setDrafts(nextDrafts);
    setDraftSaveError(false);
    setDraftLimitError("");
    return true;
  };

  const updateDesign = (patch: Parameters<typeof updateRecapComposition>[1]) => {
    if (activeDraft) saveComposition(updateRecapComposition(activeDraft, patch));
  };

  const undo = () => {
    if (!activeDraft || !history.past.length) return;
    const previous = history.past[history.past.length - 1];
    setHistory((current) => ({
      past: current.past.slice(0, -1),
      future: [...current.future, activeDraft],
    }));
    saveComposition(previous, false);
  };

  const redo = () => {
    if (!activeDraft || !history.future.length) return;
    const next = history.future[history.future.length - 1];
    setHistory((current) => ({
      past: [...current.past, activeDraft],
      future: current.future.slice(0, -1),
    }));
    saveComposition(next, false);
  };

  const changeFilter = (nextFilter: RecapFilter) => {
    if (!state || !activeDraft || !activeTemplateId) return;
    const next = createRecapComposition(
      activeTemplateId,
      state.library.entries,
      tierProjection,
      activeMediaTypes,
      nextFilter,
      {
        id: activeDraft.id,
        revision: state.revision,
        style: activeDraft.style,
        mode: activeDraft.mode,
        orientation: activeDraft.orientation,
        showTitles: activeDraft.showTitles,
        showMediaTypes: activeDraft.showMediaTypes,
        watermark: activeDraft.watermark,
        heading: activeDraft.heading,
        caption: activeDraft.caption,
      },
    );
    if (saveComposition(next)) {
        setSelectedSlotId(null);
        setPageIndex(0);
    }
  };

  const selectedSlot = activeDraft?.slots.find((slot) => slot.id === selectedSlotId) ?? null;
  const replacementCandidates = useMemo(() => {
    if (!state || !activeDraft || !replacementOpen || !selectedSlotId) return [];
    return getRecapReplacementCandidates(
      activeDraft,
      selectedSlotId,
      state.library.entries,
      tierProjection,
      activeMediaTypes,
    );
  }, [state, activeDraft, replacementOpen, selectedSlotId, tierProjection, activeMediaTypes]);
  const filteredCandidates = useMemo(() => {
    const query = replacementSearch.trim().toLocaleLowerCase();
    return query
      ? replacementCandidates.filter((entry) => `${entry.title} ${entry.mediaTypeName ?? ""}`.toLocaleLowerCase().includes(query))
      : replacementCandidates;
  }, [replacementCandidates, replacementSearch]);

  const handleSlotClick = (slotId: string) => {
    if (!activeDraft) return;
    const clicked = activeDraft.slots.find((slot) => slot.id === slotId);
    if (!clicked) return;
    if (selectedSlotId === slotId) {
      setSelectedSlotId(null);
      setReplacementOpen(false);
      return;
    }
    if (!clicked.entry) {
      setSelectedSlotId(slotId);
      setReplacementSearch("");
      setReplacementOpen(true);
      return;
    }
    if (selectedSlotId && selectedSlotId !== slotId) {
      const next = swapRecapSlots(activeDraft, selectedSlotId, slotId);
      if (next !== activeDraft) {
        saveComposition(next);
        setSelectedSlotId(null);
        return;
      }
    }
    setSelectedSlotId(slotId);
    setReplacementOpen(false);
  };

  const chooseReplacement = (snapshot: RecapEntrySnapshot) => {
    if (!activeDraft || !selectedSlotId) return;
    const next = replaceRecapSlotEntry(activeDraft, selectedSlotId, snapshot);
    if (next !== activeDraft) {
      saveComposition(next);
      setReplacementOpen(false);
      setReplacementSearch("");
    }
  };

  const changeGlobalWatermark = async (enabled: boolean) => {
    if (!enabled) {
      setRemoveWatermarkDialog(true);
      return;
    }
    setWatermarkSaveError(false);
    try {
      await onPreferences({ recapWatermark: true });
    } catch {
      setWatermarkSaveError(true);
    }
  };

  const confirmWatermarkRemoval = async () => {
    setWatermarkSaveError(false);
    try {
      await onPreferences({ recapWatermark: false });
      setRemoveWatermarkDialog(false);
    } catch {
      setWatermarkSaveError(true);
    }
  };

  const handleRefresh = () => {
    if (!state || !activeDraft || !activeTemplateId) return;
    const refreshed = createRecapComposition(
      activeTemplateId,
      state.library.entries,
      tierProjection,
      activeMediaTypes,
      activeDraft.filter,
      {
        id: activeDraft.id,
        revision: state.revision,
        style: activeDraft.style,
        mode: activeDraft.mode,
        orientation: activeDraft.orientation,
        showTitles: activeDraft.showTitles,
        showMediaTypes: activeDraft.showMediaTypes,
        watermark: activeDraft.watermark,
        heading: activeDraft.heading,
        caption: activeDraft.caption,
      },
    );
    if (saveComposition(refreshed)) {
      setSelectedSlotId(null);
      setPageIndex(0);
      setRefreshDialog(false);
    }
  };

  const confirmDeleteDraft = () => {
    if (!deleteDraftId) return;
    setDrafts((current) => current.filter((draft) => draft.id !== deleteDraftId));
    if (activeDraftId === deleteDraftId) {
      setActiveDraftId(null);
      setSelectedSlotId(null);
      setHistory({ past: [], future: [] });
    }
    setDeleteDraftId(null);
    setDraftLimitError("");
  };

  const confirmDeleteAllDrafts = () => {
    setDrafts([]);
    setActiveDraftId(null);
    setSelectedSlotId(null);
    setReplacementOpen(false);
    setHistory({ past: [], future: [] });
    setDeleteAllDraftsDialog(false);
    setDraftLimitError("");
  };

  useEffect(() => {
    let cancelled = false;
    setSceneError(false);
    if (!activeDraft || !activeTemplateId || !activeLayoutScene) return () => { cancelled = true; };
    const cached = resolvedSceneCache.get(activeSceneKey);
    if (cached) {
      setScene(cached);
      setLoadedSceneKey(activeSceneKey);
      return () => { cancelled = true; };
    }
    setLoadedSceneKey(null);
    void resolveRecapSceneCovers(activeLayoutScene, activeDraft, loaderForComposition(activeDraft)).then((loaded) => {
      if (sceneHasFailedCover(loaded, activeDraft)) {
        resolvedSceneCache.delete(activeSceneKey);
        retryFailedCoverOnce(activeSceneKey);
      } else {
        cacheResolvedScene(resolvedSceneCache, activeSceneKey, loaded);
      }
      if (!cancelled) {
        setScene(loaded);
        setLoadedSceneKey(activeSceneKey);
      }
    }).catch(() => {
      if (!cancelled) setSceneError(true);
    });
    return () => { cancelled = true; };
  }, [activeDraft, activeTemplateId, activeSceneKey, activeLayoutScene, loaderForComposition, coverRetryVersion, retryFailedCoverOnce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!activePreviewScene || !canvas) return;
    try {
      renderRecapCanvas(activePreviewScene, canvas);
      setOverflowWarningCount(activePreviewScene.overflowWarnings.length);
    } catch {
      setSceneError(true);
    }
  }, [activePreviewScene]);

  const exportCurrent = async () => {
    if (!activeDraft || !resolvedActiveScene || exportBusy) return;
    setExportBusy(true);
    exportCancel.current = false;
    setExportStatus("ready");
    try {
      const pages = recapPageCount(activeDraft);
      setExportProgress({ current: 0, total: pages });
      for (let exportPage = 0; exportPage < pages; exportPage += 1) {
        if (exportCancel.current) {
          setExportStatus("cancelled");
          return;
        }
        setExportProgress({ current: exportPage + 1, total: pages });
        const pageScene = exportPage === pageIndex ? resolvedActiveScene : await loadRecapScene(
          activeDraft,
          loaderForComposition(activeDraft),
          {
            pageIndex: exportPage,
            watermark: preferences.recapWatermark ?? true,
            watermarkText: t("recap.poster.watermark"),
            selectionText: t("recap.poster.manualOrder"),
            filteredRankText: t("recap.poster.filteredRank"),
          },
        );
        if (exportCancel.current) {
          setExportStatus("cancelled");
          return;
        }
        const blob = await exportRecapPng(pageScene);
        const baseName = t("recap.export.fileName").replace(/\.png$/i, "");
        const filename = pages > 1
          ? t("recap.export.pageFileName", { base: baseName, page: exportPage + 1, total: pages })
          : t("recap.export.fileName");
        if (!(await saveRecapImage(blob, filename))) {
          setExportStatus("cancelled");
          return;
        }
      }
      setExportStatus("saved");
    } catch {
      setExportStatus("error");
    } finally {
      setExportBusy(false);
    }
  };

  const refreshDiff = useMemo(() => {
    if (!state || !activeDraft || !activeTemplateId) return 0;
    const latest = createRecapComposition(activeTemplateId, state.library.entries, tierProjection, activeMediaTypes, activeDraft.filter);
    const oldIds = new Set(activeDraft.slots.flatMap((slot) => slot.entry ? [slot.entry.id] : []));
    const newIds = new Set(latest.slots.flatMap((slot) => slot.entry ? [slot.entry.id] : []));
    return [...oldIds].filter((id) => !newIds.has(id)).length + [...newIds].filter((id) => !oldIds.has(id)).length;
  }, [state, activeDraft, activeTemplateId, tierProjection, activeMediaTypes]);

  const previewRows = activeDraft?.slots.filter((slot) => slot.page === pageIndex) ?? [];
  const maxPage = activeDraft ? Math.max(0, ...activeDraft.slots.map((slot) => slot.page)) : 0;
  const activeFilterIds = activeDraft?.filter.kind === "types" ? activeDraft.filter.typeIds : [];
  const activeTagIds = activeDraft?.filter.tagIds ?? [];
  const activeTags = [...(state?.library.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const watermarkOn = preferences.recapWatermark ?? true;

  if (!state) {
    return (
      <div className="recap-page page-enter" aria-labelledby="recap-title">
        <header className="recap-heading">
          <div className="recap-heading-copy"><span className="recap-eyebrow">{t("recap.eyebrow")}</span><h1 id="recap-title">{t("recap.title")}</h1><p>{t("recap.intro")}</p></div>
        </header>
        {error ? (
          <div className="recap-state" role="alert"><Layers3 size={25} strokeWidth={1.3} /><h2>{t("recap.state.errorTitle")}</h2><p>{t("recap.state.errorBody")}</p>{onRetry && <button className="button secondary" onClick={() => void onRetry()}><RefreshCw size={14} />{t("recap.state.retry")}</button>}</div>
        ) : <div className="recap-loading" role="status"><Sparkles size={20} />{t("recap.state.loading")}</div>}
      </div>
    );
  }

  if (draftDataError) {
    return (
      <div className="recap-page page-enter" aria-labelledby="recap-title">
        <header className="recap-heading"><div className="recap-heading-copy"><span className="recap-eyebrow">{t("recap.eyebrow")}</span><h1 id="recap-title">{t("recap.title")}</h1><p>{t("recap.intro")}</p></div></header>
        <div className="recap-state" role="alert"><Layers3 size={25} strokeWidth={1.3} /><h2>{t("recap.state.errorTitle")}</h2><p>{t("recap.error.invalidDrafts")}</p></div>
      </div>
    );
  }

  if (activeDraft && activeTemplateId) {
    const revisionChanged = activeDraft.sourceFingerprint
      ? currentSourceFingerprint !== activeDraft.sourceFingerprint
      : activeDraft.libraryRevision !== state.revision;
    const currentScene = activePreviewScene;
    const currentPageCanvas = currentScene ? { width: currentScene.width, height: currentScene.height } : { width: 1080, height: 1920 };
    const sceneTargets = currentScene?.hitTargets ?? [];
    const pageTargets = sceneTargets.filter((target) => previewRows.some((slot) => slot.id === target.slotId));
    const canvasStyle: CSSProperties = { aspectRatio: `${currentPageCanvas.width} / ${currentPageCanvas.height}` };
    const titleForSlot = selectedSlot?.entry?.title ?? selectedSlot?.label ?? t("recap.editor.emptySlot");

    return (
      <div className="recap-page recap-editor page-enter" aria-labelledby="recap-editor-title">
        <div className="recap-editor-topbar">
          <button type="button" className="recap-back-button" onClick={goBack}><ArrowLeft size={15} />{t("recap.editor.back")}</button>
          <div className="recap-editor-actions">
            <button type="button" className="icon-button" title={t("recap.editor.undoLabel")} aria-label={t("recap.editor.undoLabel")} disabled={!history.past.length} onClick={undo}><Undo2 size={16} /></button>
            <button type="button" className="icon-button" title={t("recap.editor.redoLabel")} aria-label={t("recap.editor.redoLabel")} disabled={!history.future.length} onClick={redo}><Redo2 size={16} /></button>
            {exportBusy ? <button type="button" className="button secondary" onClick={() => { exportCancel.current = true; }}>{t("recap.editor.cancelExport")}</button> : <button type="button" className="button primary" disabled={!resolvedActiveScene || !activeTemplateReady} onClick={() => void exportCurrent()}><Download size={14} />{t("recap.editor.export")}</button>}
            <button type="button" className="icon-button" title={t("recap.editor.deleteDraft")} aria-label={t("recap.editor.deleteDraft")} onClick={() => setDeleteDraftId(activeDraft.id)}><Trash2 size={15} /></button>
          </div>
        </div>
        {revisionChanged && <div className="recap-library-changed"><RefreshCw size={15} /><span>{t("recap.editor.libraryChanged")} {t("recap.editor.refreshReview")}</span><button type="button" className="button secondary" onClick={() => setRefreshDialog(true)}>{t("recap.editor.refresh")}</button></div>}
        <div className="recap-editor-grid">
          <section className="recap-preview-column" aria-labelledby="recap-editor-title">
            <div className="recap-preview-heading"><h1 id="recap-editor-title">{templateTitle(activeTemplateId)}</h1><span>{t("recap.editor.preview")}{maxPage > 0 ? ` · ${pageIndex + 1}/${maxPage + 1}` : ""}</span></div>
            <div className="recap-stage">
              {sceneError ? <div className="recap-state" role="alert"><ImageIcon size={24} /><p>{t("recap.editor.exportError")}</p></div> : !currentScene ? <div className="recap-loading" role="status"><Sparkles size={20} />{t("recap.state.loading")}</div> : (
                <div className="recap-stage-canvas-wrap" style={canvasStyle}>
                  <canvas ref={canvasRef} className="recap-stage-canvas" width={currentPageCanvas.width} height={currentPageCanvas.height} aria-label={t("recap.editor.preview")} />
                  {pageTargets.map((target) => {
                    const slot = activeDraft.slots.find((item) => item.id === target.slotId);
                    if (!slot) return null;
                    const style: CSSProperties = {
                      left: `${target.x / currentPageCanvas.width * 100}%`,
                      top: `${target.y / currentPageCanvas.height * 100}%`,
                      width: `${target.width / currentPageCanvas.width * 100}%`,
                      height: `${target.height / currentPageCanvas.height * 100}%`,
                    };
                    return <button key={target.slotId} type="button" className={`recap-slot-hit${selectedSlotId === slot.id ? " selected" : ""}${slot.entry ? "" : " empty"}`} style={style} aria-label={slot.entry ? t("recap.a11y.slot", { rank: slot.rank ?? "", title: slot.entry.title }) : t("recap.a11y.emptySlot", { rank: slot.rank ?? slot.label ?? "" })} aria-pressed={selectedSlotId === slot.id} onClick={() => handleSlotClick(slot.id)}>{!slot.entry && <Plus size={18} aria-hidden="true" />}</button>;
                  })}
                </div>
              )}
            </div>
            <div className="recap-preview-caption"><span>{t("recap.editor.swapHint")}</span>{maxPage > 0 && <span><button type="button" className="recap-back-button" disabled={pageIndex <= 0} onClick={() => setPageIndex((page) => Math.max(0, page - 1))} aria-label={t("recap.editor.pagePrevious")}>‹</button> {pageIndex + 1} / {maxPage + 1} <button type="button" className="recap-back-button" disabled={pageIndex >= maxPage} onClick={() => setPageIndex((page) => Math.min(maxPage, page + 1))} aria-label={t("recap.editor.pageNext")}>›</button></span>}</div>
            {overflowWarningCount > 0 && <p className="recap-editor-note" role="status">{t("recap.editor.longTitles")}</p>}
            {!activeTemplateReady && <p className="recap-save-error" role="status">{t("recap.editor.filterNotEligible")}</p>}
            {draftLimitError && <p className="recap-save-error" role="alert">{draftLimitError}</p>}
            {exportBusy && <p className="recap-export-status" role="status">{t("recap.editor.exportingPage", { current: exportProgress.current, total: exportProgress.total })}</p>}
            {exportStatus !== "ready" && <p className={exportStatus === "error" ? "recap-save-error" : "recap-export-status"} role={exportStatus === "error" ? "alert" : "status"}>{exportStatus === "saved" ? t("recap.editor.exported") : exportStatus === "error" ? t("recap.editor.exportError") : t("recap.export.cancelled")}</p>}
            {draftSaveError && <p className="recap-save-error" role="alert">{t("recap.error.draftSave")} <button type="button" className="recap-back-button" onClick={() => setSaveRetry((value) => value + 1)}>{t("recap.editor.retrySave")}</button></p>}
            {!draftSaveError && savingDraft && <p className="recap-export-status" role="status">{t("recap.editor.savingDraft")}</p>}
          </section>
          <aside className="recap-inspector" aria-label={t("recap.editor.settings")}>
            <div className="recap-inspector-heading"><h2>{t("recap.editor.settings")}</h2><p>{t("recap.editor.revisionNote")}</p></div>
            {selectedSlot && <div className="recap-inspector-section"><span className="recap-field-label">{t("recap.editor.selection")}</span><div className="recap-selection-panel"><div className="recap-selected-work"><div className="recap-selected-thumb">{(selectedSlot.entry?.coverAssetId || selectedSlot.entry?.remoteCover) && coverUrls[selectedSlot.entry.id] && <img src={coverUrls[selectedSlot.entry.id] ?? undefined} alt="" />}{!(selectedSlot.entry?.coverAssetId || selectedSlot.entry?.remoteCover) && <ImageIcon size={16} />}</div><div className="recap-selected-info"><strong>{titleForSlot}</strong><span>{selectedSlot.entry?.mediaTypeName ?? selectedSlot.label ?? t("recap.editor.emptySlot")}{selectedSlot.populationCount !== undefined ? ` · ${t("recap.poster.periodPopulation", { count: selectedSlot.populationCount })}` : ""}</span></div></div><div className="recap-slot-actions">{selectedSlot.entry && <button type="button" className="button secondary" onClick={() => { saveComposition(removeRecapSlotEntry(activeDraft, selectedSlot.id)); setReplacementOpen(false); }}><Trash2 size={13} />{t("recap.editor.remove")}</button>}<button type="button" className="button secondary" onClick={() => { setReplacementOpen((open) => !open); setReplacementSearch(""); }}><ArrowLeftRight size={13} />{selectedSlot.entry ? t("recap.editor.chooseReplacement") : t("recap.editor.chooseWork")}</button></div>{replacementOpen && <div><input className="recap-replacement-search" type="search" value={replacementSearch} onChange={(event) => setReplacementSearch(event.target.value)} placeholder={t("recap.editor.searchWork")} aria-label={t("recap.editor.searchWork")} />{filteredCandidates.length ? <div className="recap-replacement-list" role="listbox">{filteredCandidates.slice(0, 40).map((entry) => <button type="button" className="recap-replacement-item" role="option" aria-selected="false" key={entry.id} onClick={() => chooseReplacement(entry)}><span>{entry.title}</span><small>{entry.mediaTypeName ?? ""}{entry.year ? ` · ${entry.year}` : ""}</small></button>)}</div> : <p className="recap-replacement-empty">{t("recap.editor.noReplacements")}</p>}</div>}</div></div>}
            <div className="recap-inspector-section"><span className="recap-field-label"><span>{t("recap.editor.mode")}</span><ImageIcon size={13} /></span><div className="recap-segmented" style={{ "--recap-segment-columns": modes.length } as CSSProperties}>{modes.map((mode) => <button key={mode} type="button" aria-pressed={activeDraft.mode === mode} onClick={() => updateDesign({ mode })}>{t(`recap.mode.${mode}`)}</button>)}</div></div>
            <div className="recap-inspector-section"><span className="recap-field-label"><span>{t("recap.editor.style")}</span><Palette size={13} /></span><div className="recap-segmented" style={{ "--recap-segment-columns": 2 } as CSSProperties}>{styles.map((style) => <button key={style} type="button" aria-pressed={activeDraft.style === style} onClick={() => updateDesign({ style })}>{t(`recap.style.${style}`)}</button>)}</div></div>
            {recapSupportsOrientation(activeTemplateId) && <div className="recap-inspector-section"><span className="recap-field-label">{t("recap.editor.orientation")}</span><div className="recap-segmented" style={{ "--recap-segment-columns": 2 } as CSSProperties}>{(["landscape", "portrait"] as const).map((orientation) => <button key={orientation} type="button" aria-pressed={activeDraft.orientation === orientation} onClick={() => updateDesign({ orientation })}>{t(`recap.orientation.${orientation}`)}</button>)}</div></div>}
            {activeDraft.mode === "cover" && <div className="recap-inspector-section"><label className="recap-toggle"><span>{t("recap.editor.coverNames")}</span><input type="checkbox" checked={activeDraft.showTitles} onChange={(event) => updateDesign({ showTitles: event.currentTarget.checked })} /></label></div>}
            {activeDraft.mode === "text" && <div className="recap-inspector-section"><label className="recap-toggle"><span>{t("recap.editor.mediaTypes")}</span><input type="checkbox" checked={activeDraft.showMediaTypes ?? true} onChange={(event) => updateDesign({ showMediaTypes: event.currentTarget.checked })} /></label></div>}
            <div className="recap-inspector-section recap-filter-section">
              <span className="recap-field-label">{t("recap.editor.filter")}</span>
              <div className="recap-filter-group">
                <span className="recap-filter-subtitle">{t("recap.filter.media")}</span>
                <div className="recap-segmented">
                  {(["all", "types"] as const).map((kind) => (
                    <button key={kind} type="button" aria-pressed={activeDraft.filter.kind === kind} onClick={() => {
                      if (kind === "all") changeFilter(mergeRecapFilter(activeDraft.filter, { kind: "all" }));
                      else changeFilter(mergeRecapFilter(activeDraft.filter, { kind: "types", typeIds: activeDraft.filter.kind === "types" ? activeDraft.filter.typeIds : activeMediaTypes.map((type) => type.id) }));
                    }}>{t(`recap.filter.${kind}`)}</button>
                  ))}
                </div>
                {activeDraft.filter.kind === "types" && <div className="recap-type-filters">{activeMediaTypes.map((type) => <label className="recap-type-option" key={type.id}><input type="checkbox" checked={activeFilterIds.includes(type.id)} onChange={(event) => {
                  const next = event.currentTarget.checked ? [...activeFilterIds, type.id] : activeFilterIds.filter((id) => id !== type.id);
                  changeFilter(mergeRecapFilter(activeDraft.filter, { kind: "types", typeIds: next }));
                }} />{mediaTypeName(type.id, type.name)}</label>)}</div>}
              </div>
              <div className="recap-filter-group">
                <span className="recap-filter-subtitle">{t("recap.filter.tags")}</span>
                {activeTagIds.length > 1 && <div className="recap-segmented recap-tag-mode" aria-label={t("recap.filter.tagMatch")}>
                  {(["any", "all"] as const).map((tagMode) => <button key={tagMode} type="button" aria-pressed={(activeDraft.filter.tagMode ?? "any") === tagMode} onClick={() => changeFilter(mergeRecapFilter(activeDraft.filter, { tagMode }))}>{t(`recap.filter.${tagMode}Tags`)}</button>)}
                </div>}
                {activeTags.length ? <div className="recap-tag-filters">{activeTags.map((tag) => <label className="recap-type-option" key={tag.id}><input type="checkbox" checked={activeTagIds.includes(tag.id)} onChange={(event) => {
                  const next = event.currentTarget.checked ? [...activeTagIds, tag.id] : activeTagIds.filter((id) => id !== tag.id);
                  changeFilter(mergeRecapFilter(activeDraft.filter, { tagIds: next }));
                }} />{tag.name}</label>)}</div> : <p className="recap-replacement-empty">{t("recap.filter.noTags")}</p>}
              </div>
            </div>
            <div className="recap-inspector-section"><label className="recap-toggle"><span>{t("recap.editor.watermark")}</span><input type="checkbox" checked={watermarkOn} onChange={(event) => void changeGlobalWatermark(event.currentTarget.checked)} /></label><p className="recap-watermark-note">{watermarkOn ? t("recap.editor.watermarkOn") : t("recap.editor.watermarkOff")}</p>{watermarkSaveError && <p className="recap-save-error" role="alert">{t("recap.watermarkDialog.error")}</p>}</div>
            {revisionChanged && <div className="recap-inspector-section"><button type="button" className="button secondary" onClick={() => setRefreshDialog(true)}><RefreshCw size={13} />{t("recap.editor.refresh")}</button></div>}
            {activeTemplateAvailability?.missingReleaseDateCount ? <div className="recap-inspector-section"><p className="recap-editor-note">{t("recap.editor.missingDates", { count: activeTemplateAvailability.missingReleaseDateCount })}</p></div> : null}
          </aside>
        </div>

        {removeWatermarkDialog && <Modal title={t("recap.watermarkDialog.title")} description={t("recap.watermarkDialog.description")} onClose={() => setRemoveWatermarkDialog(false)}><div className="recap-watermark-dialog"><div className="recap-watermark-dialog-mark"><Sparkles size={22} /></div>{watermarkSaveError && <p className="recap-save-error" role="alert">{t("recap.watermarkDialog.error")}</p>}</div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setRemoveWatermarkDialog(false)}>{t("recap.watermarkDialog.keep")}</button><button type="button" className="button primary" onClick={() => void confirmWatermarkRemoval()}>{t("recap.watermarkDialog.remove")}</button></div></Modal>}
        {refreshDialog && <Modal title={t("recap.editor.refresh")} description={t("recap.editor.refreshReview")} onClose={() => setRefreshDialog(false)}><div className="modal-body"><p>{t("recap.editor.refreshChanges", { count: refreshDiff })}</p></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setRefreshDialog(false)}>{t("recap.editor.cancel")}</button><button type="button" className="button primary" onClick={handleRefresh}><RefreshCw size={14} />{t("recap.editor.refresh")}</button></div></Modal>}
        {deleteDraftId && <Modal title={t("recap.delete.title")} description={t("recap.delete.description")} onClose={() => setDeleteDraftId(null)}><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setDeleteDraftId(null)}>{t("recap.editor.cancel")}</button><button type="button" className="button danger" onClick={confirmDeleteDraft}><Trash2 size={14} />{t("recap.delete.confirm")}</button></div></Modal>}
      </div>
    );
  }

  const showSparseInvitation = !eligibleTemplates.length;
  const savedDrafts = drafts
    .filter((draft): draft is RecapComposition & { templateId: RecapTemplateId } => isActiveTemplateId(draft.templateId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const openGalleryTemplate = (id: RecapTemplateId) => {
    beginEdit(id);
  };
  const galleryRecordFor = (id: RecapTemplateId) => {
    const composition = galleryCompositionById.get(id);
    const record = galleryScenes[id];
    if (!composition) return undefined;
    const key = compositionRenderKey(composition, 0, watermarkOn);
    if (record?.key === key) return record;
    const cached = resolvedSceneCache.get(key);
    if (cached) return { key, scene: cached, error: false, resolved: true };
    return { key, scene: galleryLayouts.get(id) ?? null, error: false, resolved: false };
  };
  const renderTemplateFeedSection = (availability: RecapTemplateAvailability) => {
    const id = availability.id;
    const record = galleryRecordFor(id);
    const periodTemplate = id === "releaseYear" || id === "decade";
    const periodPopulation = availability.periods.reduce((count, period) => count + period.count, 0);
    return (
      <section
        className="recap-feed-section"
        key={id}
        data-recap-template={id}
        data-recap-scene-status={record?.error ? "error" : record?.resolved ? "ready" : "loading"}
        ref={(node) => {
          if (node) gallerySectionRefs.current.set(id, node);
          else gallerySectionRefs.current.delete(id);
        }}
        aria-labelledby={`recap-feed-${id}`}
      >
        <header className="recap-feed-heading">
          <div className="recap-feed-title-group">
            <h2 id={`recap-feed-${id}`}>{templateTitle(id)}</h2>
            <span className={periodTemplate ? "recap-feed-count recap-feed-count-periods" : "recap-feed-count"}>{periodTemplate
              ? t("recap.gallery.periods", { count: availability.eligibleCount, works: periodPopulation })
              : t("recap.gallery.available", { count: availability.eligibleCount })}</span>
          </div>
        </header>
        <button type="button" className="recap-feed-poster" onClick={() => openGalleryTemplate(id)} aria-label={t("recap.gallery.openTemplate", { title: templateTitle(id) })}>
          {record?.scene ? (
            <canvas
              ref={(node) => {
                if (node) {
                  galleryCanvasRefs.current.set(id, node);
                  try { renderRecapCanvas(record.scene!, node); } catch { /* the scene loader exposes the error state below */ }
                } else galleryCanvasRefs.current.delete(id);
              }}
              width={record.scene.width}
              height={record.scene.height}
              aria-hidden="true"
            />
          ) : (
            <span className={record?.error ? "recap-feed-loading is-error" : "recap-feed-loading"} role="status">
              {record?.error ? <>{t("recap.state.errorTitle")} · {t("recap.gallery.retry")}</> : <><Sparkles size={16} />{t("recap.state.loading")}</>}
            </span>
          )}
        </button>
      </section>
    );
  };

  return (
    <div className="recap-page page-enter" aria-labelledby="recap-title">
      <header className="recap-heading"><div className="recap-heading-copy"><span className="recap-eyebrow">{t("recap.eyebrow")}</span><h1 id="recap-title">{t("recap.title")}</h1><p>{t("recap.intro")}</p></div><span className="recap-count">{t("recap.ratedCount", { count: catalog?.ratedCount ?? 0 })}</span></header>
      {draftLimitError && <p className="recap-save-error" role="alert">{draftLimitError}</p>}
      {showSparseInvitation && <section className="recap-gallery-empty" aria-labelledby="recap-empty-title">
        <div className="recap-empty-mark"><Sparkles size={24} /></div>
        <h2 id="recap-empty-title">{t("recap.gallery.emptyTitle")}</h2>
        <p>{t(catalog?.rankedCount ? "recap.gallery.moreWorksBody" : catalog?.ratedCount ? "recap.gallery.unplacedBody" : "recap.gallery.emptyBody")}</p>
        <div className="recap-empty-actions"><button type="button" className="button secondary" onClick={onOpenLibrary}>{t("recap.gallery.openLibrary")}</button><button type="button" className="button primary" onClick={onOpenRanking}>{t("recap.gallery.openRanking")}</button></div>
      </section>}
      <div className="recap-gallery-feed">{galleryAvailabilityRows.map(renderTemplateFeedSection)}</div>
      {!!drafts.length && <section className="recap-saved-section">
        <header className="recap-saved-heading"><div><h2>{t("recap.gallery.saved")}</h2><span>{drafts.length} / 30</span></div><button type="button" className="button secondary" onClick={() => setDeleteAllDraftsDialog(true)}><Trash2 size={14} />{t("recap.gallery.deleteAll")}</button></header>
        <div className="recap-saved-list">{savedDrafts.map((draft) => <div className="recap-saved-item" key={draft.id}>
          <button type="button" className="recap-saved-open" onClick={() => beginEdit(draft.templateId, draft)}><strong>{templateTitle(draft.templateId)}</strong><span>{t("recap.gallery.savedDate", { date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(draft.updatedAt)) })}</span></button>
          <button type="button" className="icon-button" aria-label={t("recap.gallery.deleteDraft", { title: templateTitle(draft.templateId) })} title={t("recap.gallery.deleteDraft", { title: templateTitle(draft.templateId) })} onClick={() => setDeleteDraftId(draft.id)}><Trash2 size={15} /></button>
        </div>)}</div>
      </section>}
      {deleteDraftId && <Modal title={t("recap.delete.title")} description={t("recap.delete.description")} onClose={() => setDeleteDraftId(null)}><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setDeleteDraftId(null)}>{t("recap.editor.cancel")}</button><button type="button" className="button danger" onClick={confirmDeleteDraft}><Trash2 size={14} />{t("recap.delete.confirm")}</button></div></Modal>}
      {deleteAllDraftsDialog && <Modal title={t("recap.deleteAll.title")} description={t("recap.deleteAll.description")} onClose={() => setDeleteAllDraftsDialog(false)}><div className="recap-delete-all-dialog"><div className="recap-watermark-dialog-mark"><Trash2 size={20} /></div><p>{t("recap.deleteAll.body", { count: drafts.length })}</p></div><div className="modal-actions recap-delete-all-actions"><button type="button" className="button secondary" onClick={() => setDeleteAllDraftsDialog(false)}>{t("recap.editor.cancel")}</button><button type="button" className="button danger" onClick={confirmDeleteAllDrafts}><Trash2 size={14} />{t("recap.deleteAll.confirm")}</button></div></Modal>}
    </div>
  );
}
