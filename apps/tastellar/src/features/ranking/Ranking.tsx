import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CircleHelp,
  Filter,
  Layers3,
  ListOrdered,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Swords,
  X,
} from "lucide-react";
import type { Entry, LibraryState } from "../../shared/bridge/libraryTypes";
import { MediaTypeIcon, mediaTypeName } from "../library/MediaTypeIcon";
import { Modal } from "../../shared/ui/Modal";
import { t } from "../../shared/ui/i18n";
import {
  resolveRankingDropPosition,
  shouldSuggestBinaryPlacement,
  type RankingDropPosition,
} from "./domain/ranking";
import "./ranking.css";

export interface RankingTierView {
  score: number;
  placedIds: string[];
  unplacedIds: string[];
  pendingReconcile: boolean;
}

export interface RankingSessionView {
  id: string;
  score: number;
  status: "active" | "paused" | "ended";
  mode: "binary" | "normal" | "seed" | "confirm";
  answeredCount: number;
  candidateEntryId: string | null;
}

export interface RankingPromptView {
  sessionId: string;
  duelId: string;
  kind: "binary" | "normal" | "seed" | "confirm";
  leftEntryId: string;
  rightEntryId: string;
  candidateEntryId: string | null;
  step: number | null;
  totalSteps: number | null;
  proposedPosition?: number | null;
  tierLength?: number | null;
  previousEntryId?: string | null;
  nextEntryId?: string | null;
}

export interface RankingStateView {
  revision: number;
  library: LibraryState;
  unscoredIds: string[];
  tiers: RankingTierView[];
  activeSession: RankingSessionView | null;
}

export type RankingAnswer = "leftWin" | "rightWin" | "tie" | "skip";

export function Ranking({
  state,
  onMoveEntry,
  onUndoMove,
  onStartSession,
  onNextDuel,
  onAnswerDuel,
  onHasRetractableDuel,
  onUndoDuel,
  onConfirmBinaryPlacement,
  onEndSession,
  onRefresh,
  onLoadCover,
  onSelectEntry,
  onEditEntry,
  onDetailsOpenChange,
  searchQuery,
  onSearchQueryChange,
  navigationRequest,
  lastCreatedEntryId,
}: {
  state: RankingStateView | null;
  onMoveEntry: (
    entryId: string,
    score: number,
    ranked: boolean,
    position: RankingDropPosition,
  ) => Promise<RankingStateView>;
  onUndoMove: () => Promise<RankingStateView>;
  onStartSession: (
    score: number,
    mode: "auto" | "binary" | "normal",
    candidateEntryId?: string,
    candidateEntryIds?: string[],
    filterMediaTypeIds?: string[],
    eligibleUnplacedEntryIds?: string[],
  ) => Promise<{ state: RankingStateView; prompt: RankingPromptView | null }>;
  onNextDuel: (
    sessionId: string,
    revisit?: boolean,
  ) => Promise<RankingPromptView | null>;
  onAnswerDuel: (
    sessionId: string,
    duelId: string,
    answer: RankingAnswer,
  ) => Promise<RankingStateView>;
  onHasRetractableDuel: (sessionId: string) => Promise<boolean>;
  onUndoDuel: (sessionId: string) => Promise<{ state: RankingStateView; prompt: RankingPromptView | null } | null>;
  onConfirmBinaryPlacement: (
    sessionId: string,
    accepted: boolean,
  ) => Promise<{ state: RankingStateView; prompt: RankingPromptView | null; nextStep: "binary" | "normal" | "requiresSubset" | "done" | "offerBinary" }>;
  onEndSession: (sessionId: string) => Promise<RankingStateView>;
  onRefresh: () => Promise<RankingStateView>;
  onLoadCover: (entryId: string) => Promise<string | null>;
  onSelectEntry: (entryId: string) => void;
  onEditEntry: (entryId: string) => void;
  onDetailsOpenChange: (open: boolean) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  navigationRequest: { groupId: string; score: number | null } | null;
  lastCreatedEntryId: string | null;
}) {
  const [view, setView] = useState<"tiers" | "duels">("tiers");
  const [help, setHelp] = useState<"tiers" | "duels" | null>(null);
  const [selectedScore, setSelectedScore] = useState(10);
  const [prompt, setPrompt] = useState<RankingPromptView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragEntryId, setDragEntryId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveUndoAvailable, setMoveUndoAvailable] = useState(false);
  const [duelUndoAvailable, setDuelUndoAvailable] = useState(false);
  const [subsetScore, setSubsetScore] = useState<number | null>(null);
  const [subsetEntryIds, setSubsetEntryIds] = useState<string[]>([]);
  const [subsetSearch, setSubsetSearch] = useState("");
  const [completedScore, setCompletedScore] = useState<number | null>(null);
  const [sessionRestarted, setSessionRestarted] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [openFilterMenu, setOpenFilterMenu] = useState<"types" | "tags" | null>(null);
  const [filterPopoverPosition, setFilterPopoverPosition] = useState<CSSProperties>({});
  const [binaryOfferScore, setBinaryOfferScore] = useState<number | null>(null);
  const typeFilterTriggerRef = useRef<HTMLButtonElement>(null);
  const tagFilterTriggerRef = useRef<HTMLButtonElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const tierListRef = useRef<HTMLElement | null>(null);
  const lastPromptId = useRef("");
  const duelCoverCache = useRef(new Map<string, Promise<string | null>>());
  const autoPromptSession = useRef<string | null>(null);
  const dragActive = useRef(false);
  const dragPointerY = useRef<number | null>(null);
  const dragScrollFrame = useRef<number | null>(null);
  const dragGesture = useRef<{ entryId: string; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  const suppressDragClick = useRef(false);
  const hoveredDropElement = useRef<HTMLElement | null>(null);
  const pointerListeners = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
  } | null>(null);

  const library = state?.library;
  const entryById = useMemo(
    () => new Map((library?.entries ?? []).map((entry) => [entry.id, entry])),
    [library?.entries],
  );
  const tiers = useMemo(
    () =>
      Array.from({ length: 10 }, (_, index) => {
        const score = 10 - index;
        return (
          state?.tiers.find((tier) => tier.score === score) ?? {
            score,
            placedIds: [],
            unplacedIds: [],
            pendingReconcile: false,
          }
        );
      }),
    [state?.tiers],
  );
  useLayoutEffect(() => {
    const tierList = tierListRef.current;
    if (!tierList || view !== "tiers") return;
    let disposed = false;
    let frame = 0;
    const fitWrappedTitles = () => {
      frame = 0;
      if (disposed) return;
      tierList.querySelectorAll<HTMLButtonElement>(
        ".ranking-media-chip .ranking-card-title-button, .unplaced-card .ranking-card-title-button",
      ).forEach((button) => {
        // Measure from the unconstrained title cap each time so a wider viewport
        // or sidebar change can restore space before fitting the rendered lines.
        if (button.style.width) button.style.removeProperty("width");
        const range = document.createRange();
        range.selectNodeContents(button);
        const lineRects = Array.from(range.getClientRects());
        if (lineRects.length < 2) return;
        const widestLine = Math.max(...lineRects.map((rect) => rect.width));
        const currentWidth = button.getBoundingClientRect().width;
        const cap = Number.parseFloat(getComputedStyle(button).maxWidth);
        const fittedWidth = Math.ceil(widestLine + 2);
        const targetWidth = Number.isFinite(cap) ? Math.min(fittedWidth, cap) : fittedWidth;
        if (targetWidth < currentWidth - 2) button.style.width = `${targetWidth}px`;
      });
    };
    const scheduleFit = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(fitWrappedTitles);
    };
    fitWrappedTitles();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleFit);
    observer?.observe(tierList);
    window.addEventListener("resize", scheduleFit);
    void document.fonts?.ready.then(scheduleFit);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleFit);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [view, library?.entries, state?.tiers, searchQuery, typeFilters, tagFilters]);
  const availableTypes = useMemo(
    () =>
      (library?.mediaTypes ?? []).filter((type) => !type.archivedAt),
    [library?.mediaTypes],
  );
  const activeSession = state?.activeSession ?? null;
  const currentPrompt = prompt && prompt.sessionId === activeSession?.id ? prompt : null;
  const currentTier = tiers.find((tier) => tier.score === selectedScore)!;
  const search = searchQuery.trim().toLocaleLowerCase();
  const filtersActive = Boolean(search || typeFilters.length || tagFilters.length);
  const matchesFilters = (entry: Entry | undefined) => {
    if (!entry) return false;
    if (search && !entry.title.toLocaleLowerCase().includes(search) && !(entry.shortLabel ?? "").toLocaleLowerCase().includes(search)) return false;
    if (typeFilters.length) {
      const matchesType = entry.mediaTypeId
        ? typeFilters.includes(entry.mediaTypeId)
        : typeFilters.includes("__none__");
      if (!matchesType) return false;
    }
    if (tagFilters.length && !tagFilters.some((id) => entry.tagIds.includes(id))) return false;
    return true;
  };
  const subsetTier = subsetScore == null ? null : tiers.find((tier) => tier.score === subsetScore) ?? null;
  const subsetCandidates = (subsetTier?.placedIds ?? [])
    .map((id) => entryById.get(id))
    .filter((entry): entry is Entry => Boolean(entry));
  const visibleSubsetCandidates = subsetCandidates.filter((entry) => {
    const query = subsetSearch.trim().toLowerCase();
    return matchesFilters(entry) && (!query || entry.title.toLowerCase().includes(query) || (entry.shortLabel ?? "").toLowerCase().includes(query));
  });
  const selectedSubsetIds = subsetTier?.placedIds.filter((id) => subsetEntryIds.includes(id) && matchesFilters(entryById.get(id))) ?? [];
  const visibleUnplacedIds = currentTier.unplacedIds.filter((id) => matchesFilters(entryById.get(id)));
  const visiblePlacedIds = currentTier.placedIds.filter((id) => matchesFilters(entryById.get(id)));
  const visibleUnscoredIds = state?.unscoredIds.filter((id) => matchesFilters(entryById.get(id))) ?? [];
  const visiblePlannedEntries = (library?.entries ?? []).filter((entry) => entry.disposition === "planned" && matchesFilters(entry));
  const visibleDroppedEntries = (library?.entries ?? []).filter((entry) => entry.disposition === "dropped" && matchesFilters(entry));
  const visiblePlacedTierCount = tiers.reduce(
    (count, tier) => count + tier.placedIds.filter((id) => matchesFilters(entryById.get(id))).length,
    0,
  );
  const visibleToPlaceCount = tiers.reduce(
    (count, tier) => count + tier.unplacedIds.filter((id) => matchesFilters(entryById.get(id))).length,
    0,
  );
  const visibleTierWorkCount = visiblePlacedTierCount + visibleToPlaceCount;
  const placementPercent = visibleTierWorkCount
    ? Math.round((visiblePlacedTierCount / visibleTierWorkCount) * 100)
    : 0;
  const resetFilters = () => {
    setTypeFilters([]);
    setTagFilters([]);
    onSearchQueryChange("");
  };
  const visibleRankingCount = tiers.reduce((total, tier) => total + tier.placedIds.filter((id) => matchesFilters(entryById.get(id))).length + tier.unplacedIds.filter((id) => matchesFilters(entryById.get(id))).length, visibleUnscoredIds.length + visiblePlannedEntries.length + visibleDroppedEntries.length);
  const toggleFilter = (values: string[], update: (values: string[]) => void, id: string) => {
    update(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  };

  useLayoutEffect(() => {
    if (!openFilterMenu) return;
    const trigger = (openFilterMenu === "types" ? typeFilterTriggerRef : tagFilterTriggerRef).current;
    if (!trigger) {
      setOpenFilterMenu(null);
      return;
    }
    const updatePosition = () => {
      const anchor = trigger.getBoundingClientRect();
      const page = trigger.closest<HTMLElement>(".ranking-page")?.getBoundingClientRect();
      const pageLeft = Math.max(8, (page?.left ?? 0) + 8);
      const pageRight = Math.min(window.innerWidth - 8, (page?.right ?? window.innerWidth) - 8);
      const width = Math.max(120, Math.min(232, pageRight - pageLeft, window.innerWidth - 16));
      const popover = filterPopoverRef.current;
      const measuredHeight = popover?.scrollHeight ?? 220;
      const maxHeight = Math.max(120, Math.min(280, window.innerHeight - 24));
      const height = Math.min(measuredHeight, maxHeight);
      let top = anchor.bottom + 5;
      if (top + height > window.innerHeight - 12 && anchor.top - height - 5 >= 12) {
        top = anchor.top - height - 5;
      } else {
        top = Math.min(top, window.innerHeight - height - 12);
      }
      const left = Math.max(pageLeft, Math.min(anchor.left, pageRight - width));
      setFilterPopoverPosition({ top, left, width, maxHeight });
    };
    updatePosition();
    const onScroll = () => updatePosition();
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [openFilterMenu, view, activeSession?.id, availableTypes.length, library?.tags.length]);

  useEffect(() => {
    if (!openFilterMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (typeFilterTriggerRef.current?.contains(target) || tagFilterTriggerRef.current?.contains(target) || filterPopoverRef.current?.contains(target)) return;
      setOpenFilterMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const trigger = openFilterMenu === "types" ? typeFilterTriggerRef.current : tagFilterTriggerRef.current;
      setOpenFilterMenu(null);
      trigger?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openFilterMenu]);

  const filterControls = (
    <div className="ranking-filter-bar" aria-label={t("ranking.filterWorks")}>
      <span className="ranking-filter-caption"><Filter size={14} />{t("ranking.filters")}</span>
      <button
        ref={typeFilterTriggerRef}
        type="button"
        className="ranking-filter-trigger"
        aria-expanded={openFilterMenu === "types"}
        aria-controls="ranking-filter-options-types"
        onClick={() => setOpenFilterMenu((current) => current === "types" ? null : "types")}
      >{t("ranking.filterMediaTypes")}{typeFilters.length > 0 && <span>{typeFilters.length}</span>}</button>
      <button
        ref={tagFilterTriggerRef}
        type="button"
        className="ranking-filter-trigger"
        aria-expanded={openFilterMenu === "tags"}
        aria-controls="ranking-filter-options-tags"
        onClick={() => setOpenFilterMenu((current) => current === "tags" ? null : "tags")}
      >{t("ranking.filterTags")}{tagFilters.length > 0 && <span>{tagFilters.length}</span>}</button>
      {filtersActive && <button type="button" className="ranking-clear-filters" onClick={resetFilters}>{t("ranking.clearFilters")}</button>}
    </div>
  );

  const filterPopover = openFilterMenu && createPortal(
    <div
      ref={filterPopoverRef}
      id={`ranking-filter-options-${openFilterMenu}`}
      className="ranking-filter-options ranking-filter-popover"
      role="group"
      aria-label={t(openFilterMenu === "types" ? "ranking.filterMediaTypes" : "ranking.filterTags")}
      style={filterPopoverPosition}
    >
      {openFilterMenu === "types" ? (
        <>
          {availableTypes.map((type) => (
            <label key={type.id}>
              <input type="checkbox" checked={typeFilters.includes(type.id)} onChange={() => toggleFilter(typeFilters, setTypeFilters, type.id)} />
              <span>{mediaTypeName(type.id, type.name)}</span>
            </label>
          ))}
          <label>
            <input type="checkbox" checked={typeFilters.includes("__none__")} onChange={() => toggleFilter(typeFilters, setTypeFilters, "__none__")} />
            <span>{t("ranking.noType")}</span>
          </label>
        </>
      ) : (
        <>
          {(library?.tags ?? []).map((tag) => (
            <label key={tag.id}>
              <input type="checkbox" checked={tagFilters.includes(tag.id)} onChange={() => toggleFilter(tagFilters, setTagFilters, tag.id)} />
              <span>{tag.name}</span>
            </label>
          ))}
          {!(library?.tags.length) && <p>{t("ranking.noTags")}</p>}
        </>
      )}
    </div>,
    document.body,
  );

  useEffect(() => {
    if (!navigationRequest) return;
    setView("tiers");
    if (navigationRequest.score !== null) setSelectedScore(navigationRequest.score);
    setCompletedScore(null);
    const targetId = navigationRequest.groupId.startsWith("score:")
      ? `ranking-tier-${navigationRequest.score}`
      : navigationRequest.groupId === "unrated"
        ? "ranking-unscored-title"
        : navigationRequest.groupId === "planned"
          ? "ranking-planned-title"
          : navigationRequest.groupId === "dropped"
            ? "ranking-dropped-title"
            : "ranking-media-top";
    requestAnimationFrame(() => {
      document.getElementById(targetId)
        ?.scrollIntoView({ behavior: document.documentElement.dataset.motion === "reduced" ? "auto" : "smooth", block: "start" });
    });
  }, [navigationRequest]);

  useEffect(() => {
    let current = true;
    if (view !== "duels" || !activeSession || activeSession.status !== "active") {
      setDuelUndoAvailable(false);
      return () => { current = false; };
    }
    void onHasRetractableDuel(activeSession.id)
      .then((available) => { if (current) setDuelUndoAvailable(available); })
      .catch(() => { if (current) setDuelUndoAvailable(false); });
    return () => { current = false; };
  }, [view, activeSession?.id, activeSession?.answeredCount, activeSession?.status, onHasRetractableDuel]);
  useEffect(() => {
    if (view !== "duels" || !activeSession || activeSession.status !== "active" || currentPrompt)
      return;
    if (autoPromptSession.current === activeSession.id) return;
    autoPromptSession.current = activeSession.id;
    let current = true;
    void onNextDuel(activeSession.id)
      .then((nextPrompt) => {
        if (!current) return;
        setPrompt(nextPrompt);
        lastPromptId.current = nextPrompt?.duelId ?? "";
        if (nextPrompt && nextPrompt.sessionId !== activeSession.id) setSessionRestarted(true);
      })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : t("ranking.error")); });
    return () => { current = false; };
  }, [view, activeSession?.id, activeSession?.status, currentPrompt, onNextDuel]);
  useEffect(() => () => {
    if (dragScrollFrame.current != null) cancelAnimationFrame(dragScrollFrame.current);
  }, []);

  const applyState = (next: RankingStateView) => {
    // Parent state is authoritative; the local prompt remains keyed to its duel.
    void next;
  };
  const run = async (job: () => Promise<RankingStateView>): Promise<boolean> => {
    setError("");
    setBusy(true);
    try {
      const next = await job();
      applyState(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("ranking.error"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const runMove = async (job: () => Promise<RankingStateView>) => {
    if (await run(job)) {
      setMoveUndoAvailable(true);
      setCompletedScore(null);
    }
  };

  const openSubsetPicker = (score: number) => {
    setSubsetScore(score);
    setSubsetEntryIds([]);
    setSubsetSearch("");
    setSelectedScore(score);
    setView("duels");
  };

  const addVisibleToSubset = () => {
    const remaining = 200 - selectedSubsetIds.length;
    if (remaining <= 0) return;
    const next = visibleSubsetCandidates
      .map((entry) => entry.id)
      .filter((id) => !subsetEntryIds.includes(id))
      .slice(0, remaining);
    setSubsetEntryIds([...subsetEntryIds, ...next]);
  };

  const startSession = async (
    score: number,
    mode: "auto" | "binary" | "normal",
    candidateEntryId?: string,
    candidateEntryIds?: string[],
  ) => {
    setCompletedScore(null);
    setBinaryOfferScore(null);
    const targetTier = tiers.find((tier) => tier.score === score);
    if (mode === "normal" && targetTier?.unplacedIds.length) {
      setError(t("ranking.finishPlacementFirst"));
      return;
    }
    const scopedParticipants = targetTier?.placedIds.filter((id) => matchesFilters(entryById.get(id))) ?? [];
    const participantIds = candidateEntryIds ?? (mode === "normal" && filtersActive ? scopedParticipants : undefined);
    if (mode === "normal" && participantIds && participantIds.length < 2) {
      setError(t("ranking.filteredDuelsNeedTwo"));
      return;
    }
    const binaryFirst = mode === "binary" || (mode === "auto" && Boolean(
      targetTier?.unplacedIds.length && shouldSuggestBinaryPlacement({
        placed: targetTier.placedIds.length,
        unplaced: targetTier.unplacedIds.length,
      }),
    ));
    if (!participantIds && !candidateEntryIds && mode !== "binary" && !binaryFirst && (targetTier?.placedIds.length ?? 0) > 200) {
      openSubsetPicker(score);
      return;
    }
    setError("");
    setBusy(true);
    try {
      const eligibleUnplacedIds = targetTier?.unplacedIds.filter((id) => matchesFilters(entryById.get(id))) ?? [];
      const started = await onStartSession(score, mode, candidateEntryId, participantIds, [], eligibleUnplacedIds);
      applyState(started.state);
      autoPromptSession.current = started.state.activeSession?.id ?? null;
      setSelectedScore(score);
      setView("duels");
      setPrompt(started.prompt);
      lastPromptId.current = started.prompt?.duelId ?? "";
      setSessionRestarted(false);
      setOrderChanged(false);
      if (candidateEntryIds) setSubsetScore(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (mode !== "binary" && !candidateEntryIds && /200|subset|filter/i.test(message)) openSubsetPicker(score);
      else setError(message || t("ranking.error"));
    } finally {
      setBusy(false);
    }
  };

  const startTierDuels = (score: number) => {
    const tier = tiers.find((item) => item.score === score);
    if (!tier) return;
    const eligibleUnplaced = tier.unplacedIds.filter((id) => matchesFilters(entryById.get(id)));
    if (tier.unplacedIds.length > 0) {
      if (!eligibleUnplaced.length) {
        setError(t("ranking.filteredUnplacedEmpty"));
        return;
      }
      if (tier.placedIds.length === 0) {
        if (eligibleUnplaced.length >= 2) void startSession(score, "auto", eligibleUnplaced[Math.floor(Math.random() * eligibleUnplaced.length)]);
        else setError(t("ranking.needSecondFilteredWork"));
        return;
      }
      void startSession(score, "binary", eligibleUnplaced[Math.floor(Math.random() * eligibleUnplaced.length)]);
      return;
    }
    if (tier.placedIds.length >= 2) void startSession(score, "normal");
    else setError(t("ranking.needTwoPlaced"));
  };

  const isSessionConflict = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const code = typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";
    return /conflict|concurrent|changed in another tab|stale revision/i.test(`${code} ${message}`);
  };

  const recoverDuelSession = async (sessionId: string, score: number, candidateEntryId?: string | null) => {
    try {
      const latest = await onRefresh();
      const freshSession = latest.activeSession;
      if (freshSession?.status === "active") {
        const nextPrompt = await onNextDuel(freshSession.id);
        if (nextPrompt) {
          setPrompt(nextPrompt);
          lastPromptId.current = nextPrompt.duelId;
          setSessionRestarted(freshSession.id !== sessionId || nextPrompt.sessionId !== sessionId);
          setError("");
          return;
        }
      }

      const freshTier = latest.tiers.find((tier) => tier.score === score);
      if (!freshTier) throw new Error("Missing tier after refresh");
      const candidate = candidateEntryId && freshTier.unplacedIds.includes(candidateEntryId)
        ? candidateEntryId
        : freshTier.placedIds.length === 1
          ? freshTier.unplacedIds[0]
          : undefined;
      if (freshTier.placedIds.length > 200 && !candidate) {
        setPrompt(null);
        openSubsetPicker(score);
        setError("");
        return;
      }
      const canRestart = freshTier.placedIds.length >= 2 || (freshTier.placedIds.length === 0 && freshTier.unplacedIds.length >= 2) || (freshTier.placedIds.length === 1 && freshTier.unplacedIds.length > 0);
      if (!canRestart) {
        setPrompt(null);
        setCompletedScore(score);
        setSessionRestarted(true);
        setError("");
        return;
      }
      const restarted = await onStartSession(score, candidate ? "binary" : "auto", candidate);
      setPrompt(restarted.prompt);
      autoPromptSession.current = restarted.state.activeSession?.id ?? null;
      setCompletedScore(null);
      setSessionRestarted(true);
      lastPromptId.current = restarted.prompt?.duelId ?? "";
      setError("");
    } catch {
      setError(t("ranking.duelRestartFailed"));
    }
  };

  const answer = async (choice: RankingAnswer) => {
    if (!activeSession || !currentPrompt || busy) return;
    setError("");
    setBusy(true);
    try {
      const nextState = await onAnswerDuel(
        activeSession.id,
        currentPrompt.duelId,
        choice,
      );
      const previousOrder = tiers.find((tier) => tier.score === activeSession.score)?.placedIds ?? [];
      const nextOrder = nextState.tiers.find((tier) => tier.score === activeSession.score)?.placedIds ?? [];
      setOrderChanged(choice !== "skip" && (previousOrder.length !== nextOrder.length || previousOrder.some((id, index) => nextOrder[index] !== id)));
      applyState(nextState);
      const nextSessionId = nextState.activeSession?.id;
      if (!nextSessionId) {
        setPrompt(null);
        const nextTier = nextState.tiers.find((tier) => tier.score === activeSession.score);
        if (nextTier?.unplacedIds.length) {
          setBinaryOfferScore(activeSession.score);
          setCompletedScore(null);
        } else {
          setCompletedScore(activeSession.score);
        }
        return;
      }
      if (nextSessionId !== activeSession.id) setSessionRestarted(true);
      const nextPrompt = await onNextDuel(nextSessionId);
      setPrompt(nextPrompt);
      lastPromptId.current = nextPrompt?.duelId ?? "";
      if (nextPrompt && nextPrompt.sessionId !== activeSession.id) setSessionRestarted(true);
      if (!nextPrompt) {
        const refreshed = await onRefresh();
        const refreshedTier = refreshed.tiers.find((tier) => tier.score === activeSession.score);
        if (!refreshed.activeSession && refreshedTier?.unplacedIds.length) {
          setPrompt(null);
          setBinaryOfferScore(activeSession.score);
          setCompletedScore(null);
        } else if (!refreshed.activeSession) {
          setPrompt(null);
          setCompletedScore(activeSession.score);
        }
      }
      setDuelUndoAvailable(choice !== "skip");
    } catch (cause) {
      if (isSessionConflict(cause)) await recoverDuelSession(activeSession.id, activeSession.score, currentPrompt.candidateEntryId);
      else setError(cause instanceof Error ? cause.message : t("ranking.error"));
    } finally {
      setBusy(false);
    }
  };

  const undoDuel = async () => {
    if (!activeSession || busy) return;
    setError("");
    setBusy(true);
    try {
      const result = await onUndoDuel(activeSession.id);
      if (result) {
        applyState(result.state);
        setPrompt(result.prompt);
        lastPromptId.current = result.prompt?.duelId ?? "";
      }
      setDuelUndoAvailable(false);
    } catch (cause) {
      if (isSessionConflict(cause)) await recoverDuelSession(activeSession.id, activeSession.score, activeSession.candidateEntryId);
      else setError(cause instanceof Error ? cause.message : t("ranking.error"));
    } finally {
      setBusy(false);
    }
  };

  const undoMove = async () => {
    if (busy || !moveUndoAvailable) return;
    setError("");
    setBusy(true);
    try {
      applyState(await onUndoMove());
      setMoveUndoAvailable(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("ranking.error"));
    } finally {
      setBusy(false);
    }
  };

  const confirmPlacement = async (accepted: boolean) => {
    if (!activeSession || busy) return;
    setError("");
    setBusy(true);
    try {
      const result = await onConfirmBinaryPlacement(activeSession.id, accepted);
      const beforeOrder = tiers.find((tier) => tier.score === activeSession.score)?.placedIds ?? [];
      const afterOrder = result.state.tiers.find((tier) => tier.score === activeSession.score)?.placedIds ?? [];
      if (accepted && (beforeOrder.length !== afterOrder.length || beforeOrder.some((id, index) => afterOrder[index] !== id))) setOrderChanged(true);
      applyState(result.state);
      setPrompt(result.prompt);
      lastPromptId.current = result.prompt?.duelId ?? "";
      if (result.nextStep === "offerBinary") {
        autoPromptSession.current = null;
        setBinaryOfferScore(activeSession.score);
        setCompletedScore(null);
        return;
      }
      if (result.nextStep === "requiresSubset") {
        autoPromptSession.current = null;
        setBinaryOfferScore(null);
        setCompletedScore(activeSession.score);
        return;
      }
      setBinaryOfferScore(null);
      setCompletedScore(result.prompt ? null : activeSession.score);
    } catch (cause) {
      if (isSessionConflict(cause)) await recoverDuelSession(activeSession.id, activeSession.score, activeSession.candidateEntryId);
      else setError(cause instanceof Error ? cause.message : t("ranking.error"));
    } finally {
      setBusy(false);
    }
  };

  const binaryCandidate = async (entryId: string, score: number) => {
    await startSession(score, "binary", entryId);
  };

  const continueBinaryPlacement = (score: number) => {
    const tier = tiers.find((item) => item.score === score);
    const eligible = tier?.unplacedIds.filter((id) => matchesFilters(entryById.get(id))) ?? [];
    if (!eligible.length) {
      setBinaryOfferScore(score);
      setPrompt(null);
      setError(t("ranking.filteredUnplacedEmpty"));
      return;
    }
    const candidate = eligible[Math.floor(Math.random() * eligible.length)];
    setSelectedScore(score);
    void startSession(score, "binary", candidate);
  };

  const resumeSession = async (sessionId: string) => {
    setBusy(true);
    setError("");
    try {
      const nextPrompt = await onNextDuel(sessionId);
      setPrompt(nextPrompt);
      if (nextPrompt && nextPrompt.sessionId !== sessionId) setSessionRestarted(true);
      await onRefresh();
    } catch (cause) {
      if (isSessionConflict(cause)) await recoverDuelSession(sessionId, selectedScore);
      else setError(cause instanceof Error ? cause.message : t("ranking.error"));
    } finally {
      setBusy(false);
    }
  };

  const beginPointerDrag = (event: ReactPointerEvent<HTMLElement>, entryId: string) => {
    if (busy || event.button !== 0) return;
    dragGesture.current = {
      entryId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    const move = (pointerEvent: PointerEvent) => updatePointerDrag(pointerEvent);
    const up = (pointerEvent: PointerEvent) => stopPointerDrag(pointerEvent);
    const cancel = (pointerEvent: PointerEvent) => cancelPointerDrag(pointerEvent);
    pointerListeners.current = { move, up, cancel };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
  };
  const clearPointerListeners = () => {
    const listeners = pointerListeners.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move, true);
    window.removeEventListener("pointerup", listeners.up, true);
    window.removeEventListener("pointercancel", listeners.cancel, true);
    pointerListeners.current = null;
  };
  const updatePointerDrag = (event: PointerEvent) => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.active && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) return;
    if (!gesture.active) {
      gesture.active = true;
      dragActive.current = true;
      setDragEntryId(gesture.entryId);
      const scrollFrame = () => {
        if (!dragActive.current || dragPointerY.current == null) return;
        scrollToDragEdge(dragPointerY.current);
        dragScrollFrame.current = requestAnimationFrame(scrollFrame);
      };
      dragScrollFrame.current = requestAnimationFrame(scrollFrame);
    }
    event.preventDefault();
    dragPointerY.current = event.clientY;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(
      "[data-ranking-drop-score], [data-ranking-score], [data-ranking-tier-score]",
    );
    if (hoveredDropElement.current !== target) {
      hoveredDropElement.current?.classList.remove("drop-active");
      hoveredDropElement.current = target ?? null;
      hoveredDropElement.current?.classList.add("drop-active");
    }
    if (!target) {
      setDropTarget(null);
    } else if (target.dataset.rankingDropScore) {
      setDropTarget(`sidebar:${target.dataset.rankingDropScore}`);
    } else if (target.dataset.rankingScore && target.dataset.rankingEntry) {
      setDropTarget(`${target.dataset.rankingRanked === "true" ? "placed" : "unplaced"}:${target.dataset.rankingEntry}`);
    } else if (target.dataset.rankingTierScore) {
      setDropTarget(`${target.dataset.rankingDropKind === "placed" ? "tier" : "tray"}:${target.dataset.rankingTierScore}`);
    }
    scrollToDragEdge(event.clientY);
  };
  const stopPointerDrag = (event: PointerEvent) => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    dragGesture.current = null;
    clearPointerListeners();
    if (!gesture.active) return;

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(
      "[data-ranking-drop-score], [data-ranking-score], [data-ranking-tier-score]",
    );
    hoveredDropElement.current?.classList.remove("drop-active");
    hoveredDropElement.current = null;
    const sourceId = gesture.entryId;
    let destination: { score: number; ranked: boolean; position: RankingDropPosition } | null = null;
    if (target?.dataset.rankingDropScore) {
      destination = { score: Number(target.dataset.rankingDropScore), ranked: false, position: { kind: "end" } };
    } else if (target?.dataset.rankingScore && target.dataset.rankingEntry && target.dataset.rankingEntry !== sourceId) {
      const score = Number(target.dataset.rankingScore);
      const ranked = target.dataset.rankingRanked === "true";
      const bounds = target.getBoundingClientRect();
      const side = event.clientX > bounds.left + bounds.width / 2 ? "after" : "before";
      destination = {
        score,
        ranked,
        position: resolveRankingDropPosition(target.dataset.rankingEntry, side),
      };
    } else if (target?.dataset.rankingTierScore) {
      const score = Number(target.dataset.rankingTierScore);
      destination = {
        score,
        ranked: target.dataset.rankingDropKind === "placed",
        position: { kind: "end" },
      };
    }

    dragActive.current = false;
    if (dragScrollFrame.current != null) cancelAnimationFrame(dragScrollFrame.current);
    dragScrollFrame.current = null;
    dragPointerY.current = null;
    setDragEntryId(null);
    setDropTarget(null);
    suppressDragClick.current = true;
    window.setTimeout(() => { suppressDragClick.current = false; }, 0);
    if (destination && Number.isInteger(destination.score) && destination.score >= 1 && destination.score <= 10) {
      void runMove(() => onMoveEntry(sourceId, destination!.score, destination!.ranked, destination!.position));
    }
  };
  const cancelPointerDrag = (event: PointerEvent) => {
    if (dragGesture.current?.pointerId !== event.pointerId) return;
    dragGesture.current = null;
    clearPointerListeners();
    dragActive.current = false;
    if (dragScrollFrame.current != null) cancelAnimationFrame(dragScrollFrame.current);
    dragScrollFrame.current = null;
    dragPointerY.current = null;
    hoveredDropElement.current?.classList.remove("drop-active");
    hoveredDropElement.current = null;
    setDragEntryId(null);
    setDropTarget(null);
  };
  const scrollToDragEdge = (clientY: number) => {
    const scroller = document.querySelector<HTMLElement>(".ranking-workspace .content-scroll");
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      const edge = Math.min(96, bounds.height * 0.16);
      if (clientY < bounds.top + edge) {
        const distance = bounds.top + edge - clientY;
        scroller.scrollTop -= Math.min(16, Math.max(4, distance * 0.2));
      } else if (clientY > bounds.bottom - edge) {
        const distance = clientY - (bounds.bottom - edge);
        scroller.scrollTop += Math.min(16, Math.max(4, distance * 0.2));
      }
    }
  };
  const dragProps = (entryId: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginPointerDrag(event, entryId),
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!suppressDragClick.current) return;
      suppressDragClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  const rankedCard = (entry: Entry, score: number, index: number, ids: string[]) => {
    const mediaType = entry.mediaTypeId
      ? library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)
      : null;
    const mediaTypeLabel = mediaType
      ? mediaTypeName(mediaType.id, mediaType.name)
      : entry.mediaTypeId
        ? mediaTypeName(entry.mediaTypeId, entry.mediaTypeId)
        : "";
    return (
      <article
        key={entry.id}
        className={`ranking-work-card ranking-media-chip placed-card${mediaTypeLabel ? " has-media-type" : ""}${dragEntryId === entry.id ? " dragging" : ""}${dropTarget === `placed:${entry.id}` ? " drop-active" : ""}`}
        data-ranking-entry={entry.id}
        data-ranking-score={score}
        data-ranking-ranked="true"
        {...dragProps(entry.id)}
        aria-label={t("ranking.cardAria", { title: entry.title, rank: index + 1, score })}
      >
        <span className="ranking-position" aria-hidden="true">{index + 1}</span>
        {mediaTypeLabel && (
          <span className="ranking-card-type-icon" role="img" aria-label={mediaTypeLabel} title={mediaTypeLabel}>
            <MediaTypeIcon iconKey={mediaType?.iconKey} size={13} />
          </span>
        )}
        <span className="ranking-work-copy">
          <button
            className="ranking-card-title-button"
            title={entry.title}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onClick={() => { onSelectEntry(entry.id); onDetailsOpenChange(true); }}
            onDoubleClick={() => onEditEntry(entry.id)}
            onKeyDown={(event) => {
              if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              const anchorId = ids[index + (event.key === "ArrowUp" ? -1 : 1)];
              if (!anchorId) return;
              event.preventDefault();
              event.stopPropagation();
              void runMove(() => onMoveEntry(entry.id, score, true, { kind: event.key === "ArrowUp" ? "before" : "after", anchorId }));
            }}
          >{entry.shortLabel || entry.title}</button>
        </span>
      </article>
    );
  };

  const unplacedCard = (entry: Entry, score: number) => (
    <article
      key={entry.id}
      className={`ranking-work-card unplaced-card${lastCreatedEntryId === entry.id ? " newly-created" : ""}${dragEntryId === entry.id ? " dragging" : ""}${dropTarget === `unplaced:${entry.id}` ? " drop-active" : ""}`}
      data-ranking-entry={entry.id}
      data-ranking-score={score}
      data-ranking-ranked="false"
      {...dragProps(entry.id)}
    >
      {entry.mediaTypeId && (
        <span className="ranking-card-type-icon" role="img" aria-label={mediaTypeName(entry.mediaTypeId, library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)?.name ?? entry.mediaTypeId)} title={mediaTypeName(entry.mediaTypeId, library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)?.name ?? entry.mediaTypeId)}>
          <MediaTypeIcon iconKey={library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)?.iconKey} size={13} />
        </span>
      )}
      <span className="ranking-work-copy">
        <button className="ranking-card-title-button" title={entry.title} onClick={() => { onSelectEntry(entry.id); onDetailsOpenChange(true); }} onDoubleClick={() => onEditEntry(entry.id)}>{entry.shortLabel || entry.title}</button>
      </span>
      <button
        className="ranking-inline-action ranking-inline-action-icon"
        aria-label={t("ranking.binaryPlace")}
        title={t("ranking.binaryPlace")}
        onClick={() => void binaryCandidate(entry.id, score)}
        disabled={busy || ((tiers.find((tier) => tier.score === score)?.placedIds.length ?? 0) === 0 && (tiers.find((tier) => tier.score === score)?.unplacedIds.length ?? 0) < 1)}
      >
        <Swords size={14} aria-hidden="true" />
      </button>
    </article>
  );

  const dispositionCard = (entry: Entry) => (
    <article key={entry.id} className="ranking-work-card disposition-card" data-ranking-entry={entry.id}>
      {entry.mediaTypeId && (
        <MediaTypeIcon iconKey={library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)?.iconKey} size={14} />
      )}
      <button className="ranking-card-title-button" title={entry.title} onClick={() => { onSelectEntry(entry.id); onDetailsOpenChange(true); }}>
        {entry.shortLabel || entry.title}
      </button>
      <small>{entry.mediaTypeId ? mediaTypeName(entry.mediaTypeId, library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)?.name ?? entry.mediaTypeId) : t("ranking.noType")}</small>
    </article>
  );

  if (!state) {
    return (
      <section className="ranking-page ranking-loading">
        <Layers3 size={28} />
        <h1>{t("ranking.title")}</h1>
        <p>{t("ranking.loading")}</p>
        <button className="button secondary small" onClick={() => void onRefresh().catch(() => undefined)}>
          {t("common.tryAgain")}
        </button>
      </section>
    );
  }

  return (
    <div className="ranking-page">
      <header className="ranking-header">
        <div className="ranking-title-wrap">
          <div>
            <span className="micro-label">{t("ranking.eyebrow")}</span>
            <h1>{t("ranking.title")}</h1>
          </div>
          <button className="icon-button ranking-help-button" aria-label={t("ranking.tierHelpLabel")} title={t("ranking.tierHelpLabel")} onClick={() => setHelp("tiers")}>
            <CircleHelp size={17} />
          </button>
        </div>
        <div className="ranking-header-actions">
          <div className="ranking-mode-switch" role="tablist" aria-label={t("ranking.views")}>
            <button role="tab" aria-selected={view === "tiers"} className={view === "tiers" ? "selected" : ""} onClick={() => setView("tiers")}>
              <ListOrdered size={15} />{t("ranking.tierListTab")}
            </button>
            <button role="tab" aria-selected={view === "duels"} className={view === "duels" ? "selected" : ""} onClick={() => setView("duels")}>
              <Swords size={15} />{t("ranking.duelsTab")}
            </button>
          </div>
        </div>
      </header>

      {filterPopover}
      {error && <div className="ranking-error" role="alert">{error}<button aria-label={t("ranking.dismissError")} onClick={() => setError("")}><X size={14} /></button></div>}
      {view === "tiers" && moveUndoAvailable && (
        <div className="ranking-undo-toast" role="status">
          <span>{t("ranking.moveSaved")}</span>
          <button type="button" disabled={busy} onClick={() => void undoMove()}>{t("ranking.undoMove")}</button>
          <button type="button" className="ranking-undo-dismiss" aria-label={t("ranking.dismissUndo")} onClick={() => setMoveUndoAvailable(false)}><X size={13} /></button>
        </div>
      )}

      {view === "tiers" ? (
        <>
        <section ref={tierListRef} className={`ranking-tier-list${dragEntryId ? " is-dragging" : ""}`} id="ranking-media-top" aria-label={t("ranking.tierListLabel")}>
          <div className="ranking-tier-toolbar">
            <div className="ranking-tier-summary">
              <div className="ranking-tier-summary-copy">
                <strong>{t("ranking.orderedCount", { count: visiblePlacedTierCount })}</strong>
                <span aria-hidden="true">·</span>
                <span>{t("ranking.toPlaceCount", { count: visibleToPlaceCount })}</span>
              </div>
              <div
                className="ranking-summary-progress"
                role="progressbar"
                aria-label={t("ranking.progressLabel")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={placementPercent}
              >
                <span style={{ width: `${placementPercent}%` }} />
              </div>
            </div>
            {filterControls}
          </div>
          {filtersActive && visibleRankingCount === 0 && (
            <div className="ranking-filter-empty" role="status">
              <span>{t("ranking.noFilterMatches")}</span>
              <button type="button" className="text-button" onClick={resetFilters}>{t("ranking.clearFilters")}</button>
            </div>
          )}

          {tiers.map((tier) => {
            const visiblePlaced = tier.placedIds.map((id, index) => ({ id, index, entry: entryById.get(id) })).filter((item) => matchesFilters(item.entry));
            const visibleUnplaced = tier.unplacedIds.filter((id) => matchesFilters(entryById.get(id)));
            const unplacedCount = visibleUnplaced.length;
            const suggestion = shouldSuggestBinaryPlacement({
              placed: tier.placedIds.length,
              unplaced: tier.unplacedIds.length,
            });
            const total = tier.placedIds.length + tier.unplacedIds.length;
            const visibleTotal = visiblePlaced.length + visibleUnplaced.length;
            const canStartDuels = tier.unplacedIds.length > 0
              ? visibleUnplaced.length > 0 && (tier.placedIds.length > 0 || visibleUnplaced.length >= 2)
              : visiblePlaced.length >= 2;
            const statPlacedCount = filtersActive ? visiblePlaced.length : tier.placedIds.length;
            const statTierCount = filtersActive ? visibleTotal : total;
            return (
              <section className={`ranking-tier${total === 0 ? " empty" : ""}${filtersActive && visibleTotal === 0 ? " filtered-empty" : ""}`} key={tier.score} id={`ranking-tier-${tier.score}`} aria-labelledby={`ranking-tier-title-${tier.score}`}>
                <header className="ranking-tier-heading">
                  <span className="ranking-score-anchor" aria-hidden="true">
                    <strong>{tier.score}</strong>
                    <small>/10</small>
                  </span>
                  <div className="ranking-tier-label">
                    <h2 className="ranking-visually-hidden" id={`ranking-tier-title-${tier.score}`}>{t("ranking.scoreTier", { score: tier.score })}</h2>
                    <p>{t("ranking.tierProgress", { placed: statPlacedCount, total: statTierCount })}</p>
                  </div>
                  <div className="ranking-tier-actions">
                    {(tier.placedIds.length > 0 || tier.unplacedIds.length >= 2) && (
                      <button className="icon-button compact-icon-button" aria-label={t("ranking.startDuelsForTier", { score: tier.score })} title={t("ranking.startDuels")} onClick={() => startTierDuels(tier.score)} disabled={busy || !canStartDuels}>
                      <Swords size={15} />
                      </button>
                    )}
                    {tier.pendingReconcile && <span className="ranking-fitting" aria-live="polite">{t("ranking.updatingOrder")}</span>}
                  </div>
                </header>
                <div
                  className={`ranking-placed-list${dropTarget === `tier:${tier.score}` ? " drop-active" : ""}`}
                  data-ranking-tier-score={tier.score}
                  data-ranking-drop-kind="placed"
                  aria-label={t("ranking.orderedWorks", { score: tier.score })}
                >
                  {visiblePlaced.map(({ id, index, entry }) => entry ? rankedCard(entry, tier.score, index, tier.placedIds) : null)}
                  {!visiblePlaced.length && <p className="ranking-drop-hint">{filtersActive && tier.placedIds.length ? t("ranking.noTierMatches") : t("ranking.emptyPlacedHint")}</p>}
                </div>
                <div
                  className={`ranking-unplaced-tray${dropTarget === `tray:${tier.score}` ? " drop-active" : ""}`}
                  data-ranking-tier-score={tier.score}
                  data-ranking-drop-kind="tray"
                  aria-label={t("ranking.unplacedDropTarget", { score: tier.score })}
                >
                  <div className="ranking-unplaced-heading">
                    <span>{t("ranking.toPlace")}</span>
                    <span>{unplacedCount}</span>
                  </div>
                  {unplacedCount ? (
                    <div className="ranking-unplaced-items">
                      {visibleUnplaced.map((id) => {
                        const entry = entryById.get(id);
                        return entry ? unplacedCard(entry, tier.score) : null;
                      })}
                    </div>
                  ) : tier.unplacedIds.length && filtersActive ? (
                    <div className="ranking-filter-empty compact" role="status">
                      <span>{t("ranking.filteredUnplacedEmpty")}</span>
                      <button type="button" className="text-button" onClick={resetFilters}>{t("ranking.clearFilters")}</button>
                    </div>
                  ) : (
                    <p>{t("ranking.unplacedDropHint")}</p>
                  )}
                  {suggestion && lastCreatedEntryId && tier.unplacedIds.includes(lastCreatedEntryId) && matchesFilters(entryById.get(lastCreatedEntryId)) && (
                    <div className="ranking-binary-suggestion" role="status">
                      <Sparkles size={14} />
                      <span>{t("ranking.binarySuggestion", { title: entryById.get(lastCreatedEntryId)?.title ?? "" })}</span>
                      <button className="text-button" onClick={() => void binaryCandidate(lastCreatedEntryId, tier.score)}>{t("ranking.placeNow")}</button>
                    </div>
                  )}
                </div>
              </section>
            );
          })}

          <section className="ranking-unscored" aria-labelledby="ranking-unscored-title">
            <header>
              <div>
                <h2 id="ranking-unscored-title">{t("ranking.unratedHeading")}</h2>
                <p>{t("ranking.unratedDescription")}</p>
              </div>
              <span className="ranking-unrated-count">{visibleUnscoredIds.length}</span>
            </header>
            <div className="ranking-unscored-items">
              {visibleUnscoredIds.map((id) => {
                const entry = entryById.get(id);
                if (!entry) return null;
                return (
                  <article
                    key={id}
                    className={`ranking-work-card unscored-card${dragEntryId === id ? " dragging" : ""}`}
                    data-ranking-entry={id}
                    {...dragProps(id)}
                    title={t("ranking.dropToRate", { title: entry.title })}
                  >
                    {entry.mediaTypeId && <MediaTypeIcon iconKey={library?.mediaTypes.find((type) => type.id === entry.mediaTypeId)?.iconKey} size={14} />}
                    <button className="ranking-card-title-button" onClick={() => { onSelectEntry(entry.id); onDetailsOpenChange(true); }}>{entry.shortLabel || entry.title}</button>
                    <select
                      className="ranking-unrated-select"
                      aria-label={t("ranking.rateUnratedWork", { title: entry.title })}
                      defaultValue=""
                      onChange={(event) => {
                        const score = Number(event.target.value);
                        if (score >= 1 && score <= 10) void runMove(() => onMoveEntry(id, score, false, { kind: "end" }));
                        event.currentTarget.value = "";
                      }}
                    >
                      <option value="" disabled>{t("ranking.rateAs")}</option>
                      {Array.from({ length: 10 }, (_, index) => 10 - index).map((score) => <option key={score} value={score}>{score}/10</option>)}
                    </select>
                    <small>{t("ranking.dropOnTier")}</small>
                  </article>
                );
              })}
              {!visibleUnscoredIds.length && <p>{filtersActive && state.unscoredIds.length ? t("ranking.noFilterMatches") : t("ranking.noUnrated")}</p>}
            </div>
            {state.unscoredIds.length > 0 && <p className="ranking-unscored-footer">{t("ranking.unratedDragHint")}</p>}
          </section>
          <section className="ranking-disposition-group" id="ranking-planned" aria-labelledby="ranking-planned-title">
            <header>
              <div><h2 id="ranking-planned-title">{t("library.ui.group.planned")}</h2><p>{t("ranking.plannedGroupDescription")}</p></div>
              <span className="ranking-unrated-count">{visiblePlannedEntries.length}</span>
            </header>
            <div className="ranking-unscored-items">
              {visiblePlannedEntries.map(dispositionCard)}
              {!visiblePlannedEntries.length && <p>{filtersActive && library?.entries.some((entry) => entry.disposition === "planned") ? t("ranking.noFilterMatches") : t("ranking.noPlannedWorks")}</p>}
            </div>
          </section>
          <section className="ranking-disposition-group" id="ranking-dropped" aria-labelledby="ranking-dropped-title">
            <header>
              <div><h2 id="ranking-dropped-title">{t("library.ui.group.dropped")}</h2><p>{t("ranking.droppedGroupDescription")}</p></div>
              <span className="ranking-unrated-count">{visibleDroppedEntries.length}</span>
            </header>
            <div className="ranking-unscored-items">
              {visibleDroppedEntries.map(dispositionCard)}
              {!visibleDroppedEntries.length && <p>{filtersActive && library?.entries.some((entry) => entry.disposition === "dropped") ? t("ranking.noFilterMatches") : t("ranking.noDroppedWorks")}</p>}
            </div>
          </section>
        </section>
        </>
      ) : (
        <section className="ranking-duels" aria-label={t("ranking.duelsLabel")}>
          {(!activeSession || activeSession.status === "ended") && filterControls}
          {!activeSession || activeSession.status === "ended" ? (
            binaryOfferScore === selectedScore ? (
              <div className="ranking-binary-offer" role="status">
                <span className="ranking-confirm-check"><Swords size={18} /></span>
                <h2>{t("ranking.binaryOfferTitle")}</h2>
                <p>{t("ranking.binaryOfferBody")}</p>
                {visibleUnplacedIds.length ? (
                  <button className="button primary" disabled={busy} onClick={() => continueBinaryPlacement(selectedScore)}>
                    <Play size={15} />{t("ranking.binaryOfferContinue", { count: visibleUnplacedIds.length })}
                  </button>
                ) : (
                  <div className="ranking-filter-empty" role="status">
                    <span>{t("ranking.filteredUnplacedEmpty")}</span>
                    <button type="button" className="text-button" onClick={resetFilters}>{t("ranking.clearFilters")}</button>
                  </div>
                )}
                <button className="button secondary" onClick={() => { setView("tiers"); setBinaryOfferScore(null); }}>{t("ranking.viewTierList")}</button>
                {orderChanged && <div className="ranking-updated-tier-bottom"><span>{t("ranking.orderChanged")}</span><button type="button" className="button secondary small" onClick={() => { setView("tiers"); setBinaryOfferScore(null); }}>{t("ranking.viewUpdatedTier")}</button></div>}
              </div>
            ) : completedScore === selectedScore ? (
              <div className="ranking-duel-complete" role="status">
                <span className="ranking-confirm-check"><Check size={19} /></span>
                <button className="icon-button compact-icon-button" aria-label={t("ranking.duelHelpLabel")} title={t("ranking.duelHelpLabel")} onClick={() => setHelp("duels")}><CircleHelp size={16} /></button>
                <h3>{t("ranking.sessionFinishedTitle")}</h3>
                <p>{t("ranking.sessionComplete")}</p>
                <button className="button secondary" onClick={() => { setView("tiers"); setCompletedScore(null); }}>{t("ranking.viewTierList")}</button>
                {!currentTier.unplacedIds.length && currentTier.placedIds.length >= 2 && (
                  <button className="text-button" disabled={busy} onClick={() => startSession(selectedScore, "normal")}><RotateCcw size={14} />{t("ranking.startAnotherSession")}</button>
                )}
                {orderChanged && <div className="ranking-updated-tier-bottom"><span>{t("ranking.orderChanged")}</span><button type="button" className="button secondary small" onClick={() => setView("tiers")}>{t("ranking.viewUpdatedTier")}</button></div>}
              </div>
            ) : <div className="ranking-duels-start">
              <div className="ranking-duels-start-icon"><Swords size={27} /></div>
              <div className="ranking-duels-copy">
                <div className="ranking-help-title">
                  <h2>{t("ranking.duelsHeading")}</h2>
                  <button className="icon-button compact-icon-button" aria-label={t("ranking.duelHelpLabel")} title={t("ranking.duelHelpLabel")} onClick={() => setHelp("duels")}><CircleHelp size={16} /></button>
                </div>
                <p>{t("ranking.duelsIntro")}</p>
              </div>
              <label className="ranking-tier-select">
                <span>{t("ranking.chooseTier")}</span>
                <select value={selectedScore} onChange={(event) => { setSelectedScore(Number(event.target.value)); setCompletedScore(null); setBinaryOfferScore(null); }}>
                  {tiers.map((tier) => <option key={tier.score} value={tier.score}>{t("ranking.scoreTier", { score: tier.score })}</option>)}
                </select>
              </label>
              <button className="button primary" disabled={busy || !(currentTier.unplacedIds.length ? visibleUnplacedIds.length > 0 && (currentTier.placedIds.length > 0 || visibleUnplacedIds.length >= 2) : visiblePlacedIds.length >= 2)} onClick={() => startTierDuels(selectedScore)}><Play size={16} />{t("ranking.startDuels")}</button>
              <p className="ranking-fast-note">{currentTier.unplacedIds.length > 0 && !visibleUnplacedIds.length ? t("ranking.filteredUnplacedEmpty") : currentTier.placedIds.length === 0 && visibleUnplacedIds.length >= 2 ? t("ranking.seedStartNote") : currentTier.placedIds.length > 0 && visibleUnplacedIds.length > 0 ? t("ranking.binaryOfferBody") : visiblePlacedIds.length < 2 ? t("ranking.filteredDuelsNeedTwo") : t("ranking.fastDuelsNote")}</p>
            </div>
          ) : (
            <div className="ranking-duel-session">
              <header className="ranking-duel-session-header">
                <div className="ranking-duel-toolbar-main">
                  <span className="ranking-duel-tier-pill">{t("ranking.scoreTier", { score: activeSession.score })}</span>
                  <div className="ranking-duel-toolbar-copy">
                    <h2>{currentPrompt?.kind === "seed" || activeSession.mode === "seed" ? t("ranking.seedHeading") : activeSession.mode === "binary" ? t("ranking.binaryPlacementHeading") : t("ranking.duelsHeading")}</h2>
                    <div className="ranking-duel-toolbar-meta">
                      <span>{t("ranking.sessionProgress", { count: activeSession.answeredCount })}</span>
                      {currentPrompt?.kind === "binary" && (
                        <span className="ranking-duel-step">
                          <span>{t("ranking.binaryStep", { step: currentPrompt.step ?? 1, total: currentPrompt.totalSteps ?? "…" })}</span>
                          {currentPrompt.totalSteps != null && currentPrompt.totalSteps > 0 && (
                            <span
                              className="ranking-duel-step-track"
                              role="progressbar"
                              aria-label={t("ranking.binaryStep", { step: currentPrompt.step ?? 1, total: currentPrompt.totalSteps })}
                              aria-valuemin={0}
                              aria-valuemax={currentPrompt.totalSteps}
                              aria-valuenow={Math.min(currentPrompt.step ?? 1, currentPrompt.totalSteps)}
                            >
                              <span style={{ width: `${Math.min(100, ((currentPrompt.step ?? 1) / currentPrompt.totalSteps) * 100)}%` }} />
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="ranking-session-actions">
                  <button className="icon-button" aria-label={t("ranking.duelHelpLabel")} title={t("ranking.duelHelpLabel")} onClick={() => setHelp("duels")}><CircleHelp size={16} /></button>
                  {activeSession.status === "active" && duelUndoAvailable && (
                    <button className="text-button ranking-duel-undo" disabled={busy} onClick={() => void undoDuel()}>{t("ranking.undoChoice")}</button>
                  )}
                  {activeSession.status !== "active" && (
                    <button className="button secondary small" disabled={busy} onClick={() => void resumeSession(activeSession.id)}><Play size={14} />{t("ranking.resume")}</button>
                  )}
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void (async () => {
                      if (await run(() => onEndSession(activeSession.id))) {
                        setPrompt(null);
                        setCompletedScore(null);
                        setBinaryOfferScore(null);
                        setView("duels");
                      }
                    })()}
                  >{t("ranking.chooseAnotherTier")}</button>
                </div>
              </header>
              {sessionRestarted && (
                <div className="ranking-session-restarted" role="status">
                  <span>{t("ranking.sessionRestarted")}</span>
                  <button type="button" aria-label={t("ranking.dismissRestartNotice")} onClick={() => setSessionRestarted(false)}><X size={13} /></button>
                </div>
              )}
              {activeSession.status === "paused" ? (
                <div className="ranking-paused-state">
                  <Pause size={21} />
                  <h3>{t("ranking.sessionPaused")}</h3>
                  <p>{t("ranking.sessionProgress", { count: activeSession.answeredCount })}</p>
                  <button className="button primary" disabled={busy} onClick={() => void resumeSession(activeSession.id)}><Play size={14} />{t("ranking.resume")}</button>
                </div>
              ) : currentPrompt?.kind === "confirm" ? (
                <div className="ranking-binary-confirm" key={currentPrompt.duelId}>
                  <span className="ranking-confirm-check"><Check size={19} /></span>
                  <span className="micro-label">{t("ranking.binaryPlacementHeading")}</span>
                  <h3>{t("ranking.confirmPlacementTitle")}</h3>
                  <p>{t("ranking.confirmPlacementBody", { score: activeSession.score })}</p>
                  <div className="ranking-placement-preview">
                    {currentPrompt.previousEntryId && entryById.get(currentPrompt.previousEntryId) && <div className="ranking-preview-neighbor"><small>{t("ranking.abovePlacement")}</small><strong>{entryById.get(currentPrompt.previousEntryId)?.title}</strong></div>}
                    <div className="ranking-preview-candidate"><small>{t("ranking.proposedPosition", { position: (currentPrompt.proposedPosition ?? 0) + 1, total: currentPrompt.tierLength ?? 1 })}</small><strong>{entryById.get(currentPrompt.candidateEntryId ?? "")?.title ?? t("ranking.newWork")}</strong></div>
                    {currentPrompt.nextEntryId && entryById.get(currentPrompt.nextEntryId) && <div className="ranking-preview-neighbor"><small>{t("ranking.belowPlacement")}</small><strong>{entryById.get(currentPrompt.nextEntryId)?.title}</strong></div>}
                  </div>
                  <div className="ranking-duel-actions">
                    <button className="button primary" disabled={busy} onClick={() => void confirmPlacement(true)}><Check size={14} />{t("ranking.confirmPlacement")}</button>
                    <button className="button secondary" disabled={busy} onClick={() => void confirmPlacement(false)}>{t("ranking.keepUnplaced")}</button>
                  </div>
                </div>
              ) : currentPrompt ? (
                <div key={currentPrompt.duelId} className="ranking-duel-prompt" data-kind={currentPrompt.kind}>
                <div className="ranking-duel-prompt-heading">
                    <h3 className="ranking-duel-question">{currentPrompt.kind === "seed" ? t("ranking.seedQuestion") : currentPrompt.kind === "binary" ? t("ranking.binaryQuestion") : t("ranking.normalQuestion")}</h3>
                  </div>
                  <div className="ranking-duel-cards">
                    {[currentPrompt.leftEntryId, currentPrompt.rightEntryId].map((id, index) => {
                      const entry = entryById.get(id);
                      if (!entry) return null;
                      const mediaType = library?.mediaTypes.find((type) => type.id === entry.mediaTypeId);
                      return (
                        <button
                          key={`${currentPrompt.duelId}:${id}`}
                          className="ranking-duel-card"
                          data-choice={index === 0 ? "left" : "right"}
                          disabled={busy}
                          onClick={() => void answer(index === 0 ? "leftWin" : "rightWin")}
                          aria-label={t("ranking.chooseWork", { title: entry.title })}
                        >
                          <RankingDuelArtwork
                            entry={entry}
                            iconKey={mediaType?.iconKey}
                            onLoadCover={onLoadCover}
                            coverCache={duelCoverCache.current}
                          />
                          <span className="ranking-duel-card-title">{entry.title}</span>
                          <span className="ranking-duel-card-type">{entry.mediaTypeId ? mediaTypeName(entry.mediaTypeId, mediaType?.name ?? entry.mediaTypeId) : t("ranking.noType")}</span>
                          <span className="ranking-duel-select-label">{index === 0 ? t("ranking.chooseLeft") : t("ranking.chooseRight")}</span>
                        </button>
                      );
                    })}
                    <span className="ranking-duel-versus" aria-hidden="true">VS</span>
                  </div>
                  <div className="ranking-duel-actions">
                    <button className="button secondary" disabled={busy} onClick={() => void answer("tie")}><span>{currentPrompt.kind === "binary" || currentPrompt.kind === "seed" ? t("ranking.aboutEqual") : t("ranking.tie")}</span></button>
                    <button className="text-button" disabled={busy} onClick={() => void answer("skip")}>{t("ranking.skip")}</button>
                  </div>
                </div>
              ) : (
                <div className="ranking-duel-complete">
                  <span className="ranking-confirm-check"><Check size={19} /></span>
                  {tiers.find((tier) => tier.score === activeSession.score)?.unplacedIds.length ? (
                    <>
                      <h3>{t("ranking.binaryOfferTitle")}</h3>
                      <p>{t(visibleUnplacedIds.length ? "ranking.binaryOfferBody" : "ranking.filteredUnplacedEmpty")}</p>
                      {visibleUnplacedIds.length ? (
                        <button className="button primary" disabled={busy} onClick={() => continueBinaryPlacement(activeSession.score)}><Play size={15} />{t("ranking.binaryOfferContinue", { count: visibleUnplacedIds.length })}</button>
                      ) : <button className="text-button" onClick={resetFilters}>{t("ranking.clearFilters")}</button>}
                    </>
                  ) : (
                    <>
                      <h3>{t("ranking.sessionFinishedTitle")}</h3>
                      <p>{t("ranking.sessionComplete")}</p>
                      <button className="button secondary" onClick={() => setView("tiers")}>{t("ranking.viewTierList")}</button>
                      <button className="text-button" onClick={() => void onNextDuel(activeSession.id, true).then(setPrompt).catch((cause) => setError(String(cause)))}><RotateCcw size={14} />{t("ranking.revisitPair")}</button>
                    </>
                  )}
                </div>
              )}
              {orderChanged && (
                <div className="ranking-updated-tier-bottom" role="status">
                  <span>{t("ranking.orderChanged")}</span>
                  <button type="button" className="button secondary small" onClick={() => { setView("tiers"); setSelectedScore(activeSession.score); }}>{t("ranking.viewUpdatedTier")}</button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {help && (
        <Modal
          title={t(help === "tiers" ? "ranking.tierHelpTitle" : "ranking.duelHelpTitle")}
          description={t(help === "tiers" ? "ranking.tierHelpDescription" : "ranking.duelHelpDescription")}
          onClose={() => setHelp(null)}
        >
          <div className="ranking-help-body">
            <p>{t(help === "tiers" ? "ranking.tierHelpBody" : "ranking.duelHelpBody")}</p>
            <ul>
              {(help === "tiers" ? ["ranking.tierHelpPointOne", "ranking.tierHelpPointTwo", "ranking.tierHelpPointThree"] : ["ranking.duelHelpPointOne", "ranking.duelHelpPointTwo", "ranking.duelHelpPointThree"]).map((key) => <li key={key}>{t(key)}</li>)}
            </ul>
            <div className="modal-actions"><button className="button primary" onClick={() => setHelp(null)}>{t("common.done")}</button></div>
          </div>
        </Modal>
      )}

      {subsetScore != null && (
        <Modal
          title={t("ranking.subsetTitle", { score: subsetScore })}
          description={t("ranking.subsetDescription")}
          onClose={() => setSubsetScore(null)}
        >
          <div className="ranking-subset-picker">
            <p>{t("ranking.subsetPrompt")}</p>
            <label className="ranking-subset-search">
              <span>{t("ranking.subsetSearch")}</span>
              <input
                autoFocus
                type="search"
                value={subsetSearch}
                onChange={(event) => setSubsetSearch(event.target.value)}
              />
            </label>
            <div className="ranking-subset-toolbar">
              <span aria-live="polite">{t("ranking.subsetSelectionCount", { selected: selectedSubsetIds.length })}</span>
              <div>
                <button type="button" className="text-button" disabled={selectedSubsetIds.length >= 200 || !visibleSubsetCandidates.length} onClick={addVisibleToSubset}>{t("ranking.subsetSelectVisible")}</button>
                <button type="button" className="text-button" disabled={!selectedSubsetIds.length} onClick={() => setSubsetEntryIds([])}>{t("ranking.subsetClear")}</button>
              </div>
            </div>
            <div className="ranking-subset-list" role="group" aria-label={t("ranking.subsetListLabel")}>
              {visibleSubsetCandidates.map((entry) => {
                const checked = subsetEntryIds.includes(entry.id);
                return (
                  <label className="ranking-subset-option" key={entry.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selectedSubsetIds.length >= 200}
                      onChange={() => setSubsetEntryIds(checked ? subsetEntryIds.filter((id) => id !== entry.id) : [...subsetEntryIds, entry.id])}
                    />
                    <span>{entry.shortLabel || entry.title}</span>
                  </label>
                );
              })}
              {!visibleSubsetCandidates.length && <p className="ranking-subset-empty">{t("ranking.subsetEmpty")}</p>}
            </div>
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setSubsetScore(null)}>{t("common.cancel")}</button>
              <button type="button" className="button primary" disabled={busy || selectedSubsetIds.length < 2 || selectedSubsetIds.length > 200} onClick={() => void startSession(subsetScore, "normal", undefined, selectedSubsetIds)}>
                <Play size={14} />{t("ranking.subsetStart")}
              </button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
}

function RankingDuelArtwork({
  entry,
  iconKey,
  onLoadCover,
  coverCache,
}: {
  entry: Entry;
  iconKey?: string | null;
  onLoadCover: (entryId: string) => Promise<string | null>;
  coverCache: Map<string, Promise<string | null>>;
}) {
  const coverKey = entry.coverAssetId
    ? `${entry.id}\u0000${entry.coverAssetId}`
    : null;
  const [resolvedCover, setResolvedCover] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  const [failedCoverKey, setFailedCoverKey] = useState<string | null>(null);

  useEffect(() => {
    if (!coverKey) {
      setResolvedCover(null);
      return;
    }
    let active = true;
    let request = coverCache.get(coverKey);
    if (!request) {
      request = Promise.resolve().then(() => onLoadCover(entry.id)).catch(() => null);
      coverCache.set(coverKey, request);
      while (coverCache.size > 24) {
        const oldestKey = coverCache.keys().next().value;
        if (!oldestKey) break;
        coverCache.delete(oldestKey);
      }
    }
    void request.then((url) => {
      if (active) setResolvedCover({ key: coverKey, url });
    });
    return () => {
      active = false;
    };
  }, [coverCache, coverKey, entry.id, onLoadCover]);

  const imageUrl = resolvedCover?.key === coverKey ? resolvedCover.url : null;
  const showCover = Boolean(imageUrl && failedCoverKey !== coverKey);
  return (
    <span className={`ranking-duel-art ${showCover ? "has-cover" : "no-cover"}`} aria-hidden="true">
      {showCover ? (
        <img
          src={imageUrl ?? undefined}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailedCoverKey(coverKey)}
        />
      ) : (
        <>
          <MediaTypeIcon iconKey={iconKey} size={22} />
          <span className="ranking-duel-monogram">
            {entry.title.trim().slice(0, 1).toLocaleUpperCase() || "✦"}
          </span>
        </>
      )}
    </span>
  );
}
