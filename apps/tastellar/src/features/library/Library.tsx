import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Columns3,
  FileDown,
  Filter,
  ImagePlus,
  List,
  Plus,
  Search,
  SlidersHorizontal,
  Table2,
  X,
} from "lucide-react";
import { ImportExportPanel } from "../settings/ImportExportPanel";
import { VocabularyEditor } from "./VocabularyEditor";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryDetailsPanel } from "./LibraryDetailsPanel";
import { LibraryWorkDetails } from "./LibraryWorkDetails";
import { LibraryUniverse } from "./LibraryUniverse";
import {
  createEmptyLibraryEntry,
  LibraryEntryEditor,
  readLibraryCover,
} from "./LibraryEntryEditor";
import { SelectControl } from "../../shared/ui/SelectControl";
import { errorMessage } from "../../shared/bridge/client";
import "./library.css";
import type {
  Entry as LibraryEntry,
  EntryDraft as LibraryEntryInput,
  LibraryState,
  Tag as LibraryTag,
} from "../../shared/bridge/libraryTypes";
import type { LibraryViewSnapshot, Preferences } from "../../shared/bridge/types";
import { t } from "../../shared/ui/i18n";
import { criterionName, mediaTypeName, MediaTypeIcon } from "./MediaTypeIcon";
import {
  buildLibraryRankIndex,
  sortEntriesByRank,
  type LibraryRankIndex,
  type RankedTierOrder,
} from "./domain/rankDisplay";

export type { LibraryViewSnapshot } from "../../shared/bridge/types";

type LibraryFilters = LibraryViewSnapshot["filters"];

const initialFilters: LibraryFilters = {
  mediaTypes: [],
  tags: [],
  tagMode: "any",
  minYear: "",
  maxYear: "",
  cover: "any",
  criteriaComplete: false,
};

const scoreGroups = Array.from({ length: 10 }, (_, index) => 10 - index);
const baseGroups = [
  ...scoreGroups.map((score) => ({
    id: `score:${score}`,
    label: String(score),
    score,
  })),
  { id: "planned", label: t("library.ui.group.planned"), score: null },
  { id: "dropped", label: t("library.ui.group.dropped"), score: null },
  { id: "unrated", label: t("library.ui.group.unrated"), score: null },
];

function entryGroupId(entry: LibraryEntry) {
  if (entry.disposition === "planned") return "planned";
  if (entry.disposition === "dropped") return "dropped";
  return entry.overallRating === null
    ? "unrated"
    : `score:${entry.overallRating}`;
}

function formatDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime())
    ? t("library.ui.recentlyAdded")
    : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(parsed);
}

function filtersMatch(
  entry: LibraryEntry,
  filters: LibraryFilters,
  state?: LibraryState,
) {
  if (filters.mediaTypes.length) {
    const noType =
      filters.mediaTypes.includes("__none__") && entry.mediaTypeId === null;
    const matchingType = filters.mediaTypes.includes(entry.mediaTypeId ?? "");
    if (!noType && !matchingType) return false;
  }
  if (filters.tags.length) {
    const matches = filters.tags.filter((id) =>
      entry.tagIds.includes(id),
    ).length;
    if (filters.tagMode === "all" ? matches !== filters.tags.length : !matches)
      return false;
  }
  const year = entry.releaseDate?.year;
  if (filters.minYear && (year === undefined || year < Number(filters.minYear)))
    return false;
  if (filters.maxYear && (year === undefined || year > Number(filters.maxYear)))
    return false;
  if (filters.cover === "has" && !entry.coverAssetId) return false;
  if (filters.cover === "missing" && entry.coverAssetId) return false;
  if (filters.criteriaComplete) {
    const type = state?.mediaTypes.find(
      (item) => item.id === entry.mediaTypeId,
    );
    const criteria =
      type?.criterionIds.filter((id) =>
        state?.criteria.some((item) => item.id === id && !item.archivedAt),
      ) ?? [];
    if (!criteria.length || criteria.some((id) => !entry.criterionRatings[id]))
      return false;
  }
  return true;
}

function getInitialGroup(entries: LibraryEntry[]) {
  const rated = entries.find((entry) => entry.overallRating !== null);
  if (rated) return entryGroupId(rated);
  if (entries.some((entry) => entry.disposition === "planned"))
    return "planned";
  if (entries.some((entry) => entry.disposition === "dropped"))
    return "dropped";
  return "planned";
}

export function Library({
  state,
  rankingTiers,
  onSaveEntry,
  onDeleteEntry,
  onSaveTag,
  onSaveCover,
  onLoadCover,
  onLibraryMutation,
  onExport,
  onImport,
  isNative,
  detailsOpen,
  detailsWidth,
  onDetailsOpenChange,
  onDetailsWidthChange,
  sidebarOpen = true,
  initialView,
  onViewChange,
  graphics = "auto",
  reducedMotion = false,
  onGraphicsChange,
  sceneViewKey,
  scenesEnabled = true,
}: {
  state: LibraryState;
  rankingTiers: readonly RankedTierOrder[] | null;
  onSaveEntry: (entry: LibraryEntryInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onSaveTag: (name: string) => Promise<LibraryTag>;
  onSaveCover?: (
    entryId: string,
    mimeType: string,
    base64: string,
  ) => Promise<void>;
  onLoadCover?: (entryId: string) => Promise<string | null>;
  onLibraryMutation: (
    job: (current: LibraryState) => Promise<LibraryState>,
  ) => Promise<LibraryState>;
  onExport: (path: string) => Promise<void>;
  onImport: (path: string) => Promise<void>;
  isNative: boolean;
  detailsOpen: boolean;
  detailsWidth: number;
  onDetailsOpenChange: (open: boolean) => void;
  onDetailsWidthChange: (width: number) => void;
  sidebarOpen?: boolean;
  initialView?: LibraryViewSnapshot;
  onViewChange?: (snapshot: LibraryViewSnapshot) => void;
  graphics?: Preferences["graphics"];
  reducedMotion?: boolean;
  onGraphicsChange?: (graphics: Preferences["graphics"]) => void | Promise<void>;
  sceneViewKey: string;
  scenesEnabled?: boolean;
}) {
  const [activeGroupId, setActiveGroupId] = useState(
    initialView?.activeGroupId ?? getInitialGroup(state.entries),
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    initialView?.selectedEntryId ?? null,
  );
  const [listMode, setListMode] = useState<"covers" | "compact" | "table">(
    initialView?.listMode ?? "covers",
  );
  const [searchText, setSearchText] = useState(initialView?.searchText ?? "");
  const [settledSearch, setSettledSearch] = useState(searchText.trim());
  const [includeReviewSearch, setIncludeReviewSearch] = useState(
    initialView?.includeReviewSearch ?? false,
  );
  const [includeTagSearch, setIncludeTagSearch] = useState(
    initialView?.includeTagSearch ?? false,
  );
  const [withinCurrentFilters, setWithinCurrentFilters] = useState(
    initialView?.withinCurrentFilters ?? false,
  );
  const [filters, setFilters] = useState<LibraryFilters>(
    initialView?.filters ?? initialFilters,
  );
  const [tableColumns, setTableColumns] = useState<string[]>(
    initialView?.tableColumns ?? [
      "type",
      "score",
      "rank",
      "year",
      "tags",
      "added",
    ],
  );
  const [tableSort, setTableSort] = useState<"rank" | "title" | "year">(
    initialView?.tableSort === "title" || initialView?.tableSort === "year"
      ? initialView.tableSort
      : "rank",
  );
  const [panelMode, setPanelMode] = useState<
    "details" | "filters" | "transfer"
  >(initialView?.panelMode ?? "details");
  const [vocabularyOpen, setVocabularyOpen] = useState(false);
  const [mainScrollTop, setMainScrollTop] = useState(
    initialView?.scrollTop ?? 0,
  );
  const mainScrollRef = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState(detailsWidth);
  const [editorEntry, setEditorEntry] = useState<LibraryEntry | null>(null);
  const [isNewEntry, setIsNewEntry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [searchResultSelection, setSearchResultSelection] = useState<
    string | null
  >(null);
  const priorSearch = useRef(settledSearch);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const activeEntry =
    state.entries.find((entry) => entry.id === selectedEntryId) ?? null;
  const rankIndex = useMemo(
    () => buildLibraryRankIndex(state.entries, rankingTiers),
    [rankingTiers, state.entries],
  );
  const activeType = useMemo(
    () =>
      state.mediaTypes.find((type) => type.id === editorEntry?.mediaTypeId) ??
      null,
    [editorEntry?.mediaTypeId, state.mediaTypes],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSettledSearch(searchText.trim()),
      150,
    );
    return () => window.clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLocaleLowerCase("en") === "f") {
        event.preventDefault();
        document.getElementById("library-search")?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    if (!detailsOpen && panelMode === "filters") setPanelMode("details");
  }, [detailsOpen, panelMode]);

  useEffect(() => setPanelWidth(detailsWidth), [detailsWidth]);

  useEffect(() => {
    if (priorSearch.current && !settledSearch && searchResultSelection) {
      setSelectedEntryId(null);
      setSearchResultSelection(null);
    }
    priorSearch.current = settledSearch;
  }, [searchResultSelection, settledSearch]);

  useEffect(() => {
    if (mainScrollRef.current)
      mainScrollRef.current.scrollTop = initialView?.scrollTop ?? 0;
    // Restore the selected tab's own Library scroll position on remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeEntry?.coverAssetId || !onLoadCover) {
      setCoverUrl(null);
      return;
    }
    let cancelled = false;
    void onLoadCover(activeEntry.id)
      .then((url) => {
        if (!cancelled) setCoverUrl(url);
      })
      .catch(() => {
        if (!cancelled) setCoverUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeEntry?.id, activeEntry?.coverAssetId, onLoadCover]);

  useEffect(() => {
    onViewChange?.({
      activeGroupId,
      selectedEntryId,
      listMode,
      searchText,
      includeReviewSearch,
      includeTagSearch,
      withinCurrentFilters,
      filters,
      tableColumns,
      tableSort,
      panelMode,
      scrollTop: mainScrollTop,
    });
  }, [
    activeGroupId,
    selectedEntryId,
    listMode,
    searchText,
    includeReviewSearch,
    includeTagSearch,
    withinCurrentFilters,
    filters,
    tableColumns,
    tableSort,
    panelMode,
    mainScrollTop,
    onViewChange,
  ]);

  const filteredEntries = useMemo(
    () => state.entries.filter((entry) => filtersMatch(entry, filters, state)),
    [filters, state],
  );
  const groups = useMemo(() => {
    const counts = new Map<string, { full: number; matching: number }>();
    for (const group of baseGroups)
      counts.set(group.id, { full: 0, matching: 0 });
    for (const entry of state.entries) {
      const group = counts.get(entryGroupId(entry))!;
      group.full++;
      if (filtersMatch(entry, filters, state)) group.matching++;
    }
    return baseGroups
      .filter(
        (group) =>
          group.id !== "unrated" ||
          counts.get(group.id)!.full > 0 ||
          activeGroupId === "unrated",
      )
      .map((group) => ({ ...group, ...counts.get(group.id)! }));
  }, [activeGroupId, filters, state]);
  const selectedGroup =
    groups.find((group) => group.id === activeGroupId) ?? groups[0];
  const searchResults = useMemo(() => {
    if (!settledSearch) return [];
    const needle = settledSearch.toLocaleLowerCase("en");
    return state.entries.filter((entry) => {
      if (withinCurrentFilters && !filtersMatch(entry, filters, state))
        return false;
      const primary =
        `${entry.title} ${entry.shortLabel ?? ""}`.toLocaleLowerCase("en");
      const review = includeReviewSearch
        ? entry.reviewText.toLocaleLowerCase("en")
        : "";
      const tagNames = includeTagSearch
        ? state.tags
            .filter((tag) => entry.tagIds.includes(tag.id))
            .map((tag) => tag.name)
            .join(" ")
            .toLocaleLowerCase("en")
        : "";
      return (
        primary.includes(needle) ||
        review.includes(needle) ||
        tagNames.includes(needle)
      );
    });
  }, [
    filters,
    includeReviewSearch,
    includeTagSearch,
    settledSearch,
    state.entries,
    state.tags,
    state.mediaTypes,
    state.criteria,
    withinCurrentFilters,
  ]);
  const groupEntries = useMemo(() => {
    let entries = filteredEntries.filter(
      (entry) => entryGroupId(entry) === activeGroupId,
    );
    const selectedOutside = selectedEntryId
      ? state.entries.find((entry) => entry.id === selectedEntryId)
      : undefined;
    if (
      selectedOutside &&
      entryGroupId(selectedOutside) === activeGroupId &&
      !entries.some((entry) => entry.id === selectedOutside.id)
    )
      entries = [selectedOutside, ...entries];
    if (tableSort === "rank")
      entries = sortEntriesByRank(entries, state.entries, rankIndex.overall);
    if (tableSort === "title")
      entries = [...entries].sort((a, b) => a.title.localeCompare(b.title));
    if (tableSort === "year")
      entries = [...entries].sort(
        (a, b) => (b.releaseDate?.year ?? 0) - (a.releaseDate?.year ?? 0),
      );
    return entries;
  }, [
    activeGroupId,
    filteredEntries,
    selectedEntryId,
    state.entries,
    tableSort,
    rankIndex,
  ]);
  const sceneGroupId = activeGroupId.startsWith("score:")
    ? activeGroupId.slice("score:".length)
    : activeGroupId;
  const showUniverse = scenesEnabled && !settledSearch && ["10", "9", "8", "7"].includes(sceneGroupId);
  const sceneEntries = useMemo(
    () => {
      if (!showUniverse) return [];
      return sortEntriesByRank(
        state.entries.filter((entry) => entryGroupId(entry) === `score:${sceneGroupId}`),
        state.entries,
        rankIndex.withinScore,
      );
    },
    [rankIndex.withinScore, sceneGroupId, showUniverse, state.entries],
  );
  const sceneWorks = useMemo(
    () =>
      sceneEntries.map((entry, index) => ({
        id: entry.id,
        title: entry.title,
        shortLabel: entry.shortLabel ?? undefined,
        rank: rankIndex.withinScore.get(entry.id) ?? null,
        rating: entry.overallRating,
        displayOrder: index,
        mediaTypeId: entry.mediaTypeId,
        coverAssetId: entry.coverAssetId,
      })),
    [rankIndex.withinScore, sceneEntries],
  );
  const sceneVisibleIds = useMemo(
    () => new Set(groupEntries.map((entry) => entry.id)),
    [groupEntries],
  );
  const sceneGroupCount = sceneVisibleIds.size;
  const selectedOutsideFilters = Boolean(
    activeEntry && !filtersMatch(activeEntry, filters, state),
  );
  const hasActiveFilters =
    filters.mediaTypes.length > 0 ||
    filters.tags.length > 0 ||
    filters.criteriaComplete ||
    Boolean(filters.minYear || filters.maxYear) ||
    filters.cover !== "any";

  const selectEntry = (entry: LibraryEntry, fromSearch = false) => {
    setSelectedEntryId(entry.id);
    setSearchResultSelection(fromSearch ? entry.id : null);
    setPanelMode("details");
    onDetailsOpenChange(true);
  };
  const createEntry = () => {
    setActionError("");
    setIsNewEntry(true);
    setEditorEntry(createEmptyLibraryEntry());
  };
  const editEntry = (entry: LibraryEntry) => {
    setIsNewEntry(false);
    setEditorEntry(structuredClone(entry));
    setActionError("");
  };
  const saveEntry = async (entry: LibraryEntry, coverFile: File | null) => {
    setBusy(true);
    setActionError("");
    try {
      await onSaveEntry({
        id: entry.id,
        title: entry.title.trim(),
        disposition:
          entry.overallRating === null ? entry.disposition : "experienced",
        mediaTypeId: entry.mediaTypeId,
        overallRating: entry.overallRating,
        coverAssetId: entry.coverAssetId,
        releaseDate: entry.releaseDate,
        reviewText: entry.reviewText,
        shortLabel: entry.shortLabel?.trim() || null,
        tagIds: entry.tagIds,
        criterionRatings: entry.criterionRatings,
      });
      if (coverFile && onSaveCover) {
        await onSaveCover(
          entry.id,
          coverFile.type,
          await readLibraryCover(coverFile),
        );
      }
      setActiveGroupId(entryGroupId(entry));
      setSelectedEntryId(entry.id);
      setPanelMode("details");
      onDetailsOpenChange(true);
      setEditorEntry(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const removeEntry = async (entry: LibraryEntry) => {
    if (
      !window.confirm(
        t("library.ui.confirmMoveToTrash", { title: entry.title }),
      )
    )
      return;
    setBusy(true);
    setActionError("");
    try {
      await onDeleteEntry(entry.id);
      setSelectedEntryId(null);
      onDetailsOpenChange(false);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const moveGroup = (direction: -1 | 1) => {
    const index = groups.findIndex((group) => group.id === activeGroupId);
    const target = groups[index + direction];
    if (target) setActiveGroupId(target.id);
  };
  const clearFilters = () => setFilters(initialFilters);
  const changeFilterList = (key: "mediaTypes" | "tags", value: string) => {
    setFilters((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };

  const panelResizeHandle = (
    <div
      className="resize-handle library-resize-handle"
      role="separator"
      aria-label={t("library.ui.resizePanel")}
      aria-orientation="vertical"
      aria-valuemin={240}
      aria-valuemax={440}
      aria-valuenow={panelWidth}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const next = Math.max(
            240,
            Math.min(440, panelWidth + (event.key === "ArrowLeft" ? 10 : -10)),
          );
          setPanelWidth(next);
          onDetailsWidthChange(next);
        }
      }}
      onPointerDown={(event) => {
        const handle = event.currentTarget;
        const start = event.clientX;
        const width = panelWidth;
        handle.setPointerCapture(event.pointerId);
        let next = width;
        const move = (pointer: PointerEvent) => {
          next = Math.max(240, Math.min(440, width + start - pointer.clientX));
          setPanelWidth(next);
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          onDetailsWidthChange(next);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up, { once: true });
      }}
    />
  );

  return (
    <div className={`library-layout ${detailsOpen ? "with-panel" : ""}`}>
      {sidebarOpen && (
        <aside
          className="library-groups"
          aria-label={t("library.ui.groupsSearch")}
        >
          <LibrarySidebar
            ariaLabel={t("library.ui.groupsSearch")}
            searchId="library-search"
            searchValue={searchText}
            onSearchChange={setSearchText}
            onAddWork={createEntry}
            heading={t("library.ui.groups")}
            count={state.entries.length}
            items={groups.map((group) => ({
              id: group.id,
              label: group.label,
              count: hasActiveFilters
                ? `${group.matching}/${group.full}`
                : group.full,
              selected: activeGroupId === group.id,
              onSelect: () => setActiveGroupId(group.id),
            }))}
            showSearchContent={Boolean(settledSearch)}
            searchContent={
              <div className="library-search-results">
                <div className="library-pane-caption">
                  <strong>
                    {withinCurrentFilters
                      ? t("library.ui.currentFilters")
                      : t("library.ui.allWorks")}
                  </strong>
                  <span>{searchResults.length}</span>
                </div>
                <label className="library-scope-toggle">
                  <input
                    type="checkbox"
                    checked={withinCurrentFilters}
                    onChange={(event) =>
                      setWithinCurrentFilters(event.target.checked)
                    }
                  />
                  {t("library.ui.withinFilters")}
                </label>
                <label className="library-scope-toggle">
                  <input
                    type="checkbox"
                    checked={includeReviewSearch}
                    onChange={(event) =>
                      setIncludeReviewSearch(event.target.checked)
                    }
                  />
                  {t("library.ui.searchReviews")}
                </label>
                <label className="library-scope-toggle">
                  <input
                    type="checkbox"
                    checked={includeTagSearch}
                    onChange={(event) =>
                      setIncludeTagSearch(event.target.checked)
                    }
                  />
                  {t("library.ui.searchTags")}
                </label>
                <div
                  className="library-result-list"
                  role="listbox"
                  aria-label={t("library.ui.searchResults")}
                >
                  {searchResults.map((entry) => (
                    <button
                      key={entry.id}
                      role="option"
                      aria-selected={selectedEntryId === entry.id}
                      className={selectedEntryId === entry.id ? "selected" : ""}
                      onClick={() => {
                        setActiveGroupId(entryGroupId(entry));
                        selectEntry(entry, true);
                      }}
                    >
                      <span className="result-title">{entry.title}</span>
                      <span className="result-meta">
                        {state.mediaTypes.find(
                          (type) => type.id === entry.mediaTypeId,
                        )?.name ?? t("library.ui.noType")}
                        {entry.releaseDate
                          ? ` · ${entry.releaseDate.year}`
                          : ""}
                        {entry.overallRating
                          ? ` · ${entry.overallRating}/10`
                          : ""}
                      </span>
                    </button>
                  ))}
                  {!searchResults.length && (
                    <p className="library-side-empty">
                      {t("library.ui.noSearchResults")}
                    </p>
                  )}
                </div>
              </div>
            }
            footer={
              <button
                className="library-sidebar-action"
                onClick={() => setVocabularyOpen(true)}
              >
                <SlidersHorizontal size={15} />{" "}
                {t("library.ui.manageTypesTags")}
              </button>
            }
          />
        </aside>
      )}

      <section
        className="library-main"
        ref={mainScrollRef}
        onScroll={(event) => setMainScrollTop(event.currentTarget.scrollTop)}
        aria-label={t("library.ui.libraryWorks")}
      >
        <div className="library-heading-row">
          <div className="library-heading-copy">
            <span className="eyebrow">{t("library.ui.yourStories")}</span>
            <h1>
              {settledSearch
                ? t("library.ui.searchResultHeading", { query: settledSearch })
                : (selectedGroup?.label ?? t("library.ui.library"))}
            </h1>
            <p>
              {settledSearch
                ? t("library.ui.searchCount", {
                    count: searchResults.length,
                    scope: withinCurrentFilters
                      ? t("library.ui.withinFilters")
                      : t("library.ui.allActiveWorks"),
                  })
                : t("library.ui.groupCount", {
                    shown: selectedGroup?.matching ?? 0,
                    full: selectedGroup?.full ?? 0,
                  })}
            </p>
          </div>
          <div className="library-heading-actions">
            <button
              className={`icon-button ${hasActiveFilters ? "active" : ""}`}
              aria-label={t("library.ui.openFilters")}
              title={t("library.ui.filters")}
              aria-pressed={panelMode === "filters" && detailsOpen}
              onClick={() => {
                setPanelMode("filters");
                onDetailsOpenChange(true);
              }}
            >
              <Filter size={17} />
              {hasActiveFilters && <i className="filter-dot" />}
            </button>
            <div
              className="library-view-switch"
              role="group"
              aria-label={t("library.ui.listView")}
            >
              <button
                className={listMode === "covers" ? "selected" : ""}
                aria-label={t("library.ui.coverGrid")}
                title={t("library.ui.coverGrid")}
                onClick={() => setListMode("covers")}
              >
                <Columns3 size={16} />
              </button>
              <button
                className={listMode === "compact" ? "selected" : ""}
                aria-label={t("library.ui.compactGrid")}
                title={t("library.ui.compactGrid")}
                onClick={() => setListMode("compact")}
              >
                <List size={16} />
              </button>
              <button
                className={listMode === "table" ? "selected" : ""}
                aria-label={t("library.ui.table")}
                title={t("library.ui.table")}
                onClick={() => setListMode("table")}
              >
                <Table2 size={16} />
              </button>
            </div>
            <button
              className="button secondary library-export"
              onClick={() => {
                setPanelMode("transfer");
                onDetailsOpenChange(true);
              }}
            >
              <FileDown size={15} /> {t("library.ui.importExport")}
            </button>
          </div>
        </div>

        {settledSearch && (
          <div className="library-search-context">
            <Search size={14} />
            <span>
              {withinCurrentFilters
                ? t("library.ui.searchLimited")
                : t("library.ui.searchAllActive")}
            </span>
          </div>
        )}
        {hasActiveFilters && (
          <div
            className="library-active-filters"
            aria-label={t("library.ui.activeFilters")}
          >
            {filters.mediaTypes.map((id) => (
              <button
                key={id}
                className="filter-chip"
                onClick={() => changeFilterList("mediaTypes", id)}
              >
                {id === "__none__"
                  ? t("library.ui.noType")
                  : (() => {
                      const type = state.mediaTypes.find(
                        (item) => item.id === id,
                      );
                      return type
                        ? mediaTypeName(type.id, type.name)
                        : t("library.ui.type");
                    })()}
                <X size={12} />
              </button>
            ))}
            {filters.tags.map((id) => (
              <button
                key={id}
                className="filter-chip"
                onClick={() => changeFilterList("tags", id)}
              >
                {state.tags.find((tag) => tag.id === id)?.name ??
                  t("library.ui.tag")}
                <X size={12} />
              </button>
            ))}
            {filters.tags.length > 1 && filters.tagMode === "all" && (
              <span className="filter-chip static">
                {t("library.ui.allSelectedTags")}
              </span>
            )}
            {(filters.minYear || filters.maxYear) && (
              <span className="filter-chip static">
                {t("library.ui.years", {
                  min: filters.minYear || "…",
                  max: filters.maxYear || "…",
                })}
              </span>
            )}
            {filters.cover !== "any" && (
              <span className="filter-chip static">
                {filters.cover === "has"
                  ? t("library.ui.hasCover")
                  : t("library.ui.noCover")}
              </span>
            )}
            <button className="text-button" onClick={clearFilters}>
              {t("library.ui.clearAll")}
            </button>
          </div>
        )}

        <div className="library-list-toolbar">
          <div className="library-group-navigation">
            <button
              className="icon-button"
              aria-label={t("library.ui.previousGroup")}
              disabled={
                groups.findIndex((group) => group.id === activeGroupId) <= 0
              }
              onClick={() => moveGroup(-1)}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={t("library.ui.nextGroup")}
              disabled={
                groups.findIndex((group) => group.id === activeGroupId) >=
                groups.length - 1
              }
              onClick={() => moveGroup(1)}
            >
              <ChevronRight size={16} />
            </button>
            <span>{selectedGroup?.label ?? t("library.ui.library")}</span>
            {hasActiveFilters && (
              <small>
                {selectedGroup?.matching ?? 0} of {selectedGroup?.full ?? 0}
              </small>
            )}
          </div>
          <label className="library-sort-control">
            <ArrowDownUp size={14} />
            <span>{t("library.ui.sort")}</span>
            <SelectControl
              value={tableSort}
              onValueChange={(value) => setTableSort(value as typeof tableSort)}
              aria-label={t("library.ui.sortWorks")}
            >
              <option value="rank">{t("library.ui.canonicalOrder")}</option>
              <option value="title">{t("library.ui.title")}</option>
              <option value="year">{t("library.ui.releaseYear")}</option>
            </SelectControl>
          </label>
          {listMode === "table" && (
            <details className="table-column-menu">
              <summary
                aria-label={t("library.ui.chooseColumns")}
                title={t("library.ui.chooseColumns")}
              >
                <Columns3 size={15} />
              </summary>
              <div>
                <span className="micro-label">
                  {t("library.ui.tableColumns")}
                </span>
                {tableColumnChoices.map((column) => (
                  <label key={column.id}>
                    <input
                      type="checkbox"
                      checked={
                        column.id === "title" ||
                        tableColumns.includes(column.id)
                      }
                      disabled={column.id === "title"}
                      onChange={() =>
                        setTableColumns((current) =>
                          current.includes(column.id)
                            ? current.filter((value) => value !== column.id)
                            : [...current, column.id],
                        )
                      }
                    />
                    {t(column.labelKey)}
                  </label>
                ))}
              </div>
            </details>
          )}
        </div>

        {showUniverse && (
          <LibraryUniverse
            key={sceneViewKey}
            sceneViewKey={sceneViewKey}
            groupId={sceneGroupId}
            groupLabel={selectedGroup?.label ?? t("library.ui.library")}
            works={sceneWorks}
            visibleIds={sceneVisibleIds}
            selectedId={selectedEntryId}
            groupCount={sceneGroupCount}
            quality={graphics}
            reducedMotion={reducedMotion}
            onQualityChange={onGraphicsChange}
            onLoadCover={onLoadCover}
            onSelect={(id) => {
              const entry = state.entries.find((item) => item.id === id);
              if (entry) selectEntry(entry);
            }}
            onAddWork={createEntry}
            onClearFilters={clearFilters}
            emptyBecauseFiltered={sceneEntries.length > 0 && sceneGroupCount === 0}
          />
        )}

        {searchResultSelection && selectedOutsideFilters && (
          <div className="library-exception-note" role="status">
            <CircleHelp size={15} />{" "}
            {t("library.ui.selectedResultOutsideFilters")}
          </div>
        )}
        {actionError && (
          <div className="library-error" role="alert">
            {actionError}
            <button
              onClick={() => setActionError("")}
              aria-label={t("library.ui.dismissError")}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {groupEntries.length ? (
          listMode === "table" ? (
            <LibraryTable
              entries={groupEntries}
              state={state}
              withinScoreRanks={rankIndex.withinScore}
              selectedId={selectedEntryId}
              columns={tableColumns}
              onSelect={selectEntry}
              onEdit={editEntry}
            />
          ) : (
            <div
              className={`library-work-grid ${listMode === "compact" ? "compact" : "covers"}`}
            >
              {groupEntries.map((entry) => (
                <article
                  key={entry.id}
                  className={`library-work-card ${selectedEntryId === entry.id ? "selected" : ""} ${selectedOutsideFilters && selectedEntryId === entry.id ? "outside-filter" : ""}`}
                >
                  <button
                    className="work-card-select"
                    onClick={() => selectEntry(entry)}
                    onDoubleClick={() => editEntry(entry)}
                    aria-label={t("library.ui.cardAria", {
                      title: entry.title,
                      rating:
                        entry.overallRating === null
                          ? t("library.ui.notRatedLower")
                          : t("library.ui.ratingOutOfTen", {
                              rating: entry.overallRating,
                            }),
                      date: formatDate(entry.createdAt),
                    })}
                    aria-current={
                      selectedEntryId === entry.id ? "true" : undefined
                    }
                  >
                    {listMode === "covers" && (
                      <CoverGridTile
                        entry={entry}
                        state={state}
                        onLoadCover={onLoadCover}
                      />
                    )}
                    <span className="work-card-text">
                      <FittedEntryTitle
                        title={entry.title}
                        shortLabel={entry.shortLabel}
                      />
                      <span className="work-card-media-type">
                        <MediaTypeIcon
                          iconKey={
                            state.mediaTypes.find(
                              (type) => type.id === entry.mediaTypeId,
                            )?.iconKey
                          }
                          size={12}
                        />
                        {(() => {
                          const type = state.mediaTypes.find(
                            (item) => item.id === entry.mediaTypeId,
                          );
                          return type
                            ? mediaTypeName(type.id, type.name)
                            : t("library.ui.noType");
                        })()}
                        {entry.releaseDate
                          ? ` · ${entry.releaseDate.year}`
                          : ""}
                      </span>
                      {listMode === "compact" && (
                        <span className="compact-card-tags">
                          {entry.tagIds
                            .map(
                              (id) =>
                                state.tags.find((tag) => tag.id === id)?.name,
                            )
                            .filter(Boolean)
                            .join(" · ") ||
                            (entry.overallRating === null
                              ? t("library.ui.notRated")
                              : `${entry.overallRating}/10`)}
                        </span>
                      )}
                    </span>
                  </button>
                  {listMode === "covers" &&
                    rankIndex.withinScore.has(entry.id) && (
                      <span className="work-card-rank">
                        {t("library.ui.rankInScore", {
                          rank: rankIndex.withinScore.get(entry.id) ?? 0,
                          score: entry.overallRating ?? 0,
                        })}
                      </span>
                    )}
                </article>
              ))}
            </div>
          )
        ) : settledSearch ? (
          <div className="library-empty-state">
            <div className="empty-symbol">
              <BookOpen size={30} strokeWidth={1.15} />
            </div>
            <h2>
              {hasActiveFilters
                ? t("library.ui.noMatchingFilters")
                : settledSearch
                  ? t("library.ui.noMatchingWorks")
                  : t("library.ui.nothingInGroup", {
                      group: selectedGroup?.label ?? t("library.ui.thisGroup"),
                    })}
            </h2>
            <p>
              {hasActiveFilters
                ? t("library.ui.clearFiltersHint")
                : settledSearch
                  ? t("library.ui.searchHint")
                  : t("library.ui.addFirstWork")}
            </p>
            {hasActiveFilters ? (
              <button className="button secondary" onClick={clearFilters}>
                {t("library.ui.clearAllFilters")}
              </button>
            ) : (
              !settledSearch && (
                <button className="button primary" onClick={createEntry}>
                  <Plus size={15} /> {t("library.ui.addWork")}
                </button>
              )
            )}
          </div>
        ) : null}
      </section>

      {detailsOpen && (
        <LibraryDetailsPanel
          className={panelMode}
          width={panelWidth}
          ariaLabel={
            panelMode === "filters"
              ? t("library.ui.libraryFilters")
              : panelMode === "transfer"
                ? t("library.ui.importExportPanel")
                : t("library.ui.workDetails")
          }
          title={
            panelMode === "filters"
              ? t("library.ui.filters")
              : panelMode === "transfer"
                ? t("library.ui.importExport")
                : t("library.ui.details")
          }
          onClose={() => {
            if (panelMode === "filters") setPanelMode("details");
            onDetailsOpenChange(false);
          }}
          resizer={panelResizeHandle}
        >
          {panelMode === "filters" ? (
            <LibraryFilterPanel
              state={state}
              filters={filters}
              onChange={setFilters}
              onToggleList={changeFilterList}
              onClear={clearFilters}
            />
          ) : panelMode === "transfer" ? (
            <ImportExportPanel
              onExport={onExport}
              onImport={onImport}
              isNative={isNative}
            />
          ) : activeEntry ? (
            <LibraryWorkDetails
              entry={activeEntry}
              state={state}
              rankIndex={rankIndex}
              coverUrl={coverUrl}
              outsideFilters={selectedOutsideFilters}
              onEdit={() => editEntry(activeEntry)}
              onDelete={() => void removeEntry(activeEntry)}
            />
          ) : (
            <div className="library-details-empty">
              <BookOpen size={27} strokeWidth={1.2} />
              <h2>{t("library.ui.collectionAtGlance")}</h2>
              <p>{t("library.ui.selectWorkDetails")}</p>
              <button
                className="text-button"
                onClick={() => {
                  setPanelMode("transfer");
                }}
              >
                <FileDown size={14} /> {t("library.ui.importExportLibrary")}
              </button>
            </div>
          )}
        </LibraryDetailsPanel>
      )}

      {editorEntry && (
        <LibraryEntryEditor
          key={editorEntry.id}
          entry={editorEntry}
          state={state}
          isNew={isNewEntry}
          busy={busy}
          error={actionError}
          hasCoverStorage={Boolean(onSaveCover)}
          onCancel={() => setEditorEntry(null)}
          onSave={(entry, file) => void saveEntry(entry, file)}
          onCreateTag={onSaveTag}
        />
      )}
      {vocabularyOpen && (
        <VocabularyEditor
          state={state}
          mutateLibrary={onLibraryMutation}
          onClose={() => setVocabularyOpen(false)}
        />
      )}
    </div>
  );
}

function LibraryFilterPanel({
  state,
  filters,
  onChange,
  onToggleList,
  onClear,
}: {
  state: LibraryState;
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  onToggleList: (key: "mediaTypes" | "tags", value: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="library-filter-panel">
      <div className="library-filter-heading">
        <div>
          <SlidersHorizontal size={17} />
          <strong>{t("library.ui.refineLibrary")}</strong>
        </div>
        <button className="text-button" onClick={onClear}>
          {t("library.ui.clearAll")}
        </button>
      </div>
      <fieldset>
        <legend>{t("library.ui.mediaType")}</legend>
        {state.mediaTypes
          .filter((type) => !type.archivedAt)
          .map((type) => (
            <label key={type.id}>
              <input
                type="checkbox"
                checked={filters.mediaTypes.includes(type.id)}
                onChange={() => onToggleList("mediaTypes", type.id)}
              />
              <MediaTypeIcon iconKey={type.iconKey} size={14} />
              {mediaTypeName(type.id, type.name)}
            </label>
          ))}
        <label>
          <input
            type="checkbox"
            checked={filters.mediaTypes.includes("__none__")}
            onChange={() => onToggleList("mediaTypes", "__none__")}
          />
          {t("library.ui.noType")}
        </label>
      </fieldset>
      <fieldset>
        <legend>{t("library.ui.tags")}</legend>
        {state.tags.length > 1 && (
          <div
            className="filter-tag-mode"
            role="group"
            aria-label={t("library.ui.tagMatchingMode")}
          >
            <button
              type="button"
              className={filters.tagMode === "any" ? "selected" : ""}
              aria-pressed={filters.tagMode === "any"}
              onClick={() => onChange({ ...filters, tagMode: "any" })}
            >
              {t("library.ui.any")}
            </button>
            <button
              type="button"
              className={filters.tagMode === "all" ? "selected" : ""}
              aria-pressed={filters.tagMode === "all"}
              onClick={() => onChange({ ...filters, tagMode: "all" })}
            >
              {t("library.ui.all")}
            </button>
          </div>
        )}
        {state.tags.length ? (
          state.tags.map((tag) => (
            <label key={tag.id}>
              <input
                type="checkbox"
                checked={filters.tags.includes(tag.id)}
                onChange={() => onToggleList("tags", tag.id)}
              />
              {tag.name}
            </label>
          ))
        ) : (
          <p className="filter-no-tags">{t("library.ui.tagsAppear")}</p>
        )}
      </fieldset>
      <fieldset>
        <legend>{t("library.ui.criteria")}</legend>
        <label>
          <input
            type="checkbox"
            checked={filters.criteriaComplete}
            onChange={(event) =>
              onChange({ ...filters, criteriaComplete: event.target.checked })
            }
          />
          {t("library.ui.everyCriterionScored")}
        </label>
      </fieldset>
      <fieldset>
        <legend>{t("library.ui.releaseYear")}</legend>
        <div className="filter-range">
          <label>
            {t("library.ui.from")}
            <input
              inputMode="numeric"
              value={filters.minYear}
              placeholder={t("library.ui.any")}
              onChange={(event) =>
                onChange({
                  ...filters,
                  minYear: event.target.value.replace(/\D/g, "").slice(0, 4),
                })
              }
            />
          </label>
          <label>
            {t("library.ui.to")}
            <input
              inputMode="numeric"
              value={filters.maxYear}
              placeholder={t("library.ui.any")}
              onChange={(event) =>
                onChange({
                  ...filters,
                  maxYear: event.target.value.replace(/\D/g, "").slice(0, 4),
                })
              }
            />
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("library.ui.cover")}</legend>
        <SelectControl
          value={filters.cover}
          onValueChange={(value) =>
            onChange({
              ...filters,
              cover: value as LibraryFilters["cover"],
            })
          }
        >
          <option value="any">{t("library.ui.any")}</option>
          <option value="has">{t("library.ui.hasACover")}</option>
          <option value="missing">{t("library.ui.noCover")}</option>
        </SelectControl>
      </fieldset>
      <p className="filter-result-count">
        {
          state.entries.filter((entry) => filtersMatch(entry, filters, state))
            .length
        }{" "}
        {t("library.ui.matchingWorks")}
      </p>
    </div>
  );
}

const tableColumnChoices = [
  { id: "title", labelKey: "library.ui.title" },
  { id: "type", labelKey: "library.ui.type" },
  { id: "score", labelKey: "library.ui.overallScore" },
  { id: "rank", labelKey: "library.ui.rank" },
  { id: "year", labelKey: "library.ui.releaseYear" },
  { id: "tags", labelKey: "library.ui.tags" },
  { id: "added", labelKey: "library.ui.dateAdded" },
  { id: "cover", labelKey: "library.ui.cover" },
];

function FittedEntryTitle({
  title,
  shortLabel,
}: {
  title: string;
  shortLabel: string | null;
}) {
  const titleRef = useRef<HTMLElement>(null);
  const measurementRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = titleRef.current;
    const measurement = measurementRef.current;
    if (!element || !measurement || !shortLabel?.trim()) {
      setOverflows(false);
      return;
    }
    let active = true;
    const measure = () => {
      if (active) {
        setOverflows(measurement.scrollWidth > element.clientWidth + 1);
      }
    };
    measure();
    // Cover grids can mount before their final card widths and font metrics are
    // settled. Recheck after layout and whenever either the title or its text
    // container resizes.
    const frame = window.requestAnimationFrame(measure);
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
    } else {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
      void document.fonts?.ready.then(measure);
      return () => {
        active = false;
        window.cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [shortLabel, title]);
  return (
    <>
      <strong ref={titleRef} title={title}>
        {overflows && shortLabel?.trim() ? shortLabel : title}
      </strong>
      <span
        ref={measurementRef}
        className="work-card-title-measure"
        aria-hidden="true"
      >
        {title}
      </span>
    </>
  );
}

function CoverGridTile({
  entry,
  state,
  onLoadCover,
}: {
  entry: LibraryEntry;
  state: LibraryState;
  onLoadCover?: (entryId: string) => Promise<string | null>;
}) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (!entry.coverAssetId || !onLoadCover) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void onLoadCover(entry.id)
      .then((value) => {
        if (!cancelled) setImage(value);
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.coverAssetId, entry.id, onLoadCover]);
  const type = state.mediaTypes.find((item) => item.id === entry.mediaTypeId);
  return (
    <span
      className={`work-cover-tile ${entry.coverAssetId ? "has-cover" : "no-cover"}`}
    >
      {image ? (
        <img src={image} alt="" />
      ) : entry.coverAssetId ? (
        <span className="cover-present">
          <ImagePlus size={19} /> {t("library.ui.coverSaved")}
        </span>
      ) : (
        <>
          <MediaTypeIcon iconKey={type?.iconKey} size={24} />
          <span>{entry.title.slice(0, 1).toUpperCase()}</span>
        </>
      )}
    </span>
  );
}

function LibraryTable({
  entries,
  state,
  withinScoreRanks,
  selectedId,
  columns,
  onSelect,
  onEdit,
}: {
  entries: LibraryEntry[];
  state: LibraryState;
  withinScoreRanks: Map<string, number>;
  selectedId: string | null;
  columns: string[];
  onSelect: (entry: LibraryEntry) => void;
  onEdit: (entry: LibraryEntry) => void;
}) {
  const enabled = tableColumnChoices.filter(
    (column) => column.id === "title" || columns.includes(column.id),
  );
  const value = (entry: LibraryEntry, id: string) => {
    switch (id) {
      case "type": {
        const type = state.mediaTypes.find(
          (item) => item.id === entry.mediaTypeId,
        );
        return type
          ? mediaTypeName(type.id, type.name)
          : t("library.ui.noType");
      }
      case "score":
        return entry.overallRating === null
          ? t("library.ui.notRated")
          : `${entry.overallRating}/10`;
      case "rank":
        return withinScoreRanks.has(entry.id)
          ? `#${withinScoreRanks.get(entry.id)}`
          : "—";
      case "year":
        return entry.releaseDate?.year ?? "—";
      case "tags":
        return (
          entry.tagIds
            .map((id) => state.tags.find((tag) => tag.id === id)?.name)
            .filter(Boolean)
            .join(", ") || "—"
        );
      case "added":
        return formatDate(entry.createdAt);
      case "cover":
        return entry.coverAssetId ? t("library.ui.yes") : t("library.ui.no");
      default:
        return entry.title;
    }
  };
  return (
    <div className="library-table-wrap">
      <table className="library-table">
        <thead>
          <tr>
            {enabled.map((column) => (
              <th key={column.id}>{t(column.labelKey)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.id}
              tabIndex={0}
              aria-selected={selectedId === entry.id}
              className={selectedId === entry.id ? "selected" : ""}
              onClick={() => onSelect(entry)}
              onDoubleClick={() => onEdit(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(entry);
                }
              }}
            >
              {enabled.map((column) => (
                <td
                  key={column.id}
                  className={column.id === "title" ? "table-title-cell" : ""}
                >
                  {column.id === "title" ? (
                    <>
                      <span className="table-cover-dot">
                        {entry.coverAssetId ? (
                          <ImagePlus size={13} />
                        ) : (
                          <MediaTypeIcon
                            iconKey={
                              state.mediaTypes.find(
                                (type) => type.id === entry.mediaTypeId,
                              )?.iconKey
                            }
                            size={13}
                          />
                        )}
                      </span>
                      <strong>{entry.title}</strong>
                    </>
                  ) : column.id === "type" ? (
                    <span className="table-media-type">
                      <MediaTypeIcon
                        iconKey={
                          state.mediaTypes.find(
                            (type) => type.id === entry.mediaTypeId,
                          )?.iconKey
                        }
                        size={13}
                      />
                      {value(entry, column.id)}
                    </span>
                  ) : (
                    value(entry, column.id)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
