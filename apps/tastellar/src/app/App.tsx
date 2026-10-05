import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Home as HomeIcon,
  Library as LibraryIcon,
  Layers3,
  ChartNoAxesCombined,
  PanelsTopLeft,
  Settings2,
  Plus,
  Search,
  X,
  PanelRight,
  PanelLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import * as bridge from "../shared/bridge/client";
import {
  announceCatalogCapabilitiesChanged,
  catalogCapabilities,
} from "../shared/bridge/catalogBridge";
import {
  type HomeState,
  type HomePatch,
  type Preferences,
  type Section,
  type Workspace,
  type WorkspaceTab,
} from "../shared/bridge/types";
import { Home } from "../features/home/Home";
import { Library, type LibraryViewSnapshot } from "../features/library/Library";
import { LibrarySidebar } from "../features/library/LibrarySidebar";
import { LibraryDetailsPanel } from "../features/library/LibraryDetailsPanel";
import { LibraryWorkDetails } from "../features/library/LibraryWorkDetails";
import {
  createEmptyLibraryEntry,
  LibraryEntryEditor,
  readLibraryCover,
} from "../features/library/LibraryEntryEditor";
import { buildLibraryRankIndex } from "../features/library/domain/rankDisplay";
import { Settings } from "../features/settings/Settings";
import { SupportReminder } from "../features/settings/SupportReminder";
import { Ranking, type RankingStateView } from "../features/ranking/Ranking";
import { Analytics } from "../features/analytics/Analytics";
import { Recap } from "../features/recap/Recap";
import type { RankingDropPosition } from "../features/ranking/domain/ranking";
import * as libraryBridge from "../shared/bridge/libraryBridge";
import { loadRecapCover } from "../shared/bridge/recapBridge";
import * as rankingBridge from "../shared/bridge/rankingBridge";
import type { Entry, EntryDraft, LibraryState } from "../shared/bridge/libraryTypes";
import { t } from "../shared/ui/i18n";
import { isEditing, shortcutFromEvent } from "./shortcuts";
import "./styles.css";
import "./tabs.css";
type TabDropTarget = { id: string; side: "before" | "after" };
type TabPointerDrag = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  isDragging: boolean;
};
const sections: {
  id: Section;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  { id: "home", icon: HomeIcon },
  { id: "library", icon: LibraryIcon },
  { id: "ranking", icon: Layers3 },
  { id: "analytics", icon: ChartNoAxesCombined },
  { id: "recap", icon: PanelsTopLeft },
];
const allSections = [
  ...sections,
  { id: "settings" as Section, icon: Settings2 },
];
function hasBridgeErrorCode(error: unknown, code: string): boolean {
  if (typeof error === "object" && error && "code" in error)
    return error.code === code;
  const raw = error instanceof Error ? error.message : error;
  if (typeof raw !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      parsed.code === code
    );
  } catch {
    return false;
  }
}
const makeTab = (
  section: Section,
  sidebarState: { folderOpen: boolean; detailsOpen: boolean } = {
    folderOpen: true,
    detailsOpen: false,
  },
): WorkspaceTab => ({
  id: crypto.randomUUID(),
  section,
  title: t(`nav.${section}`),
  scrollTop: 0,
  folderOpen: sidebarState.folderOpen,
  detailsOpen: sidebarState.detailsOpen,
});
export function App() {
  const [state, setState] = useState<HomeState | null>(null),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [avatar, setAvatar] = useState<string | null>(null);
  const [libraryState, setLibraryState] = useState<LibraryState | null>(null);
  const [rankingState, setRankingState] = useState<RankingStateView | null>(null);
  const mappedRankingTiers = useMemo(
    () => rankingState?.tiers.map(({ score, placedIds }) => ({ score, placedIds })) ?? null,
    [rankingState],
  );
  const libraryRankingTiers =
    rankingState &&
    libraryState &&
    (rankingState.revision === libraryState.revision ||
      rankingState.library.entries === libraryState.entries)
      ? mappedRankingTiers
      : null;
  const [rankingSidebarDropTarget, setRankingSidebarDropTarget] = useState<number | null>(null);
  const [selectedRankingEntryId, setSelectedRankingEntryId] = useState<string | null>(null);
  const [rankingSearch, setRankingSearch] = useState("");
  const [rankingSidebarSection, setRankingSidebarSection] = useState("score:10");
  const [rankingNavigationRequest, setRankingNavigationRequest] = useState<{ groupId: string; score: number | null } | null>(null);
  const [rankingEditorEntry, setRankingEditorEntry] = useState<Entry | null>(null);
  const [rankingEditorIsNew, setRankingEditorIsNew] = useState(false);
  const [rankingEditorBusy, setRankingEditorBusy] = useState(false);
  const [rankingEditorError, setRankingEditorError] = useState("");
  const [rankingCoverUrl, setRankingCoverUrl] = useState<string | null>(null);
  const [rankingCreatedEntryId, setRankingCreatedEntryId] = useState<string | null>(null);
  const [libraryLoadError, setLibraryLoadError] = useState("");
  const [loadError, setLoadError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [chooser, setChooser] = useState(false);
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(
    null,
  );
  const suppressTabClick = useRef(false);
  const stateRef = useRef<HomeState | null>(null),
    libraryStateRef = useRef<LibraryState | null>(null),
    rankingStateRef = useRef<RankingStateView | null>(null),
    workspaceRef = useRef<Workspace | null>(null),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    libraryViews = useRef<Record<string, LibraryViewSnapshot>>({}),
    analyticsOpenCounts = useRef<Record<string, number>>({}),
    tabPointerDrag = useRef<TabPointerDrag | null>(null),
    tabDropTargetRef = useRef<TabDropTarget | null>(null),
    libraryViewPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    ),
    contentRef = useRef<HTMLDivElement>(null);
  const [systemDark, setSystemDark] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [systemReduced, setSystemReduced] = useState(
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [detailsWidth, setDetailsWidth] = useState(320);
  const enqueue = useCallback(
    (job: (current: HomeState) => Promise<HomeState>) => {
      setSaveError("");
      const result = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (!stateRef.current) throw new Error(t("app.profileLoading"));
          const next = await job(stateRef.current);
          stateRef.current = next;
          setState(next);
          const library = libraryStateRef.current;
          if (library && library.revision !== next.version) {
            const synchronized = { ...library, revision: next.version };
            libraryStateRef.current = synchronized;
            setLibraryState(synchronized);
          }
          return next;
        });
      queue.current = result;
      void result.catch((e) => setSaveError(bridge.errorMessage(e)));
      return result;
    },
    [],
  );
  const mutateLibrary = useCallback(
    (job: (current: LibraryState) => Promise<LibraryState>) => {
      const result = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (!libraryStateRef.current)
            throw new Error(t("app.libraryLoading"));
          const next = await job(libraryStateRef.current);
          libraryStateRef.current = next;
          setLibraryState(next);
          const home = stateRef.current;
          if (home && home.version !== next.revision) {
            const synchronized = { ...home, version: next.revision };
            stateRef.current = synchronized;
            setState(synchronized);
          }
          setLibraryLoadError("");
          return next;
        });
      queue.current = result;
      return result;
    },
    [],
  );
  const acceptRankingState = useCallback((next: RankingStateView) => {
    rankingStateRef.current = next;
    setRankingState(next);
    libraryStateRef.current = next.library;
    setLibraryState(next.library);
    const home = stateRef.current;
    if (home && home.version !== next.revision) {
      const synchronized = { ...home, version: next.revision };
      stateRef.current = synchronized;
      setState(synchronized);
    }
  }, []);
  const serializeOperation = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const result = queue.current.catch(() => undefined).then(job);
    queue.current = result;
    return result;
  }, []);
  const refreshRanking = useCallback(async () => {
    return serializeOperation(async () => {
      const next = await rankingBridge.loadRanking();
      acceptRankingState(next);
      setLibraryLoadError("");
      return next;
    });
  }, [acceptRankingState, serializeOperation]);
  const initialize = useCallback(async () => {
      setLoadError("");
    try {
      let current = await bridge.loadHome();
      let ws = structuredClone(current.workspace);
      if (!current.preferences.restoreTabs || !ws.tabs.length) {
        const tab = makeTab(current.preferences.startupSection, ws);
        ws.tabs = [tab];
        ws.activeTabId = tab.id;
      } else if (current.preferences.rememberSidebarsPerTab) {
        // Migrate legacy workspaces in memory by seeding each tab with the
        // former global visibility. The next normal workspace save persists it.
        const tabs = ws.tabs.map((tab) => {
          if (typeof tab.folderOpen === "boolean" && typeof tab.detailsOpen === "boolean")
            return tab;
          return {
            ...tab,
            folderOpen: tab.folderOpen ?? ws.folderOpen,
            detailsOpen: tab.detailsOpen ?? ws.detailsOpen,
          };
        });
        ws = { ...ws, tabs };
      }
      if (!ws.tabs.some((tab) => tab.id === ws.activeTabId))
        ws.activeTabId = ws.tabs[0].id;
      if (current.preferences.rememberSidebarsPerTab) {
        const active = ws.tabs.find((tab) => tab.id === ws.activeTabId);
        if (active) {
          const folderOpen = active.folderOpen ?? ws.folderOpen;
          const detailsOpen = active.detailsOpen ?? ws.detailsOpen;
          ws.folderOpen = folderOpen;
          ws.detailsOpen = detailsOpen;
        }
      }
      // Normalize legacy tab state without a startup write. React StrictMode
      // may initialize twice; a read path must not race another initialization
      // against the optimistic workspace revision.
      current = { ...current, workspace: ws };
      stateRef.current = current;
      setState(current);
      try {
        const loadedRanking = await rankingBridge.loadRanking();
        acceptRankingState(loadedRanking);
        setLibraryLoadError("");
      } catch (error) {
        try {
          const library = await libraryBridge.loadLibrary();
          libraryStateRef.current = library;
          setLibraryState(library);
        } catch (libraryError) {
          setLibraryLoadError(bridge.errorMessage(libraryError));
        }
        console.error("Ranking could not be loaded", error);
      }
      setWorkspace(ws);
      workspaceRef.current = ws;
      setDetailsWidth(Math.max(240, Math.min(440, ws.detailsWidth)));
      try {
        setAvatar(await bridge.loadAvatar());
      } catch {
        setSaveError(t("app.avatarUnavailable"));
      }
    } catch (e) {
      setLoadError(bridge.errorMessage(e));
    }
  }, [acceptRankingState]);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    const dark = matchMedia("(prefers-color-scheme: dark)"),
      reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const onDark = () => setSystemDark(dark.matches),
      onReduce = () => setSystemReduced(reduce.matches);
    dark.addEventListener("change", onDark);
    reduce.addEventListener("change", onReduce);
    return () => {
      dark.removeEventListener("change", onDark);
      reduce.removeEventListener("change", onReduce);
    };
  }, []);
  const theme = state?.preferences.theme ?? "dark";
  useEffect(() => {
    document.documentElement.dataset.theme =
      theme === "system"
        ? systemDark
          ? "dark"
          : "light"
        : theme === "forest"
          ? "reading"
          : theme;
    document.documentElement.style.fontSize = `${14 * (state?.preferences.textScale ?? 1)}px`;
    document.documentElement.dataset.motion =
      state?.preferences.reducedMotion === "on" ||
      (state?.preferences.reducedMotion === "system" && systemReduced)
        ? "reduced"
        : "full";
  }, [
    theme,
    state?.preferences.textScale,
    state?.preferences.reducedMotion,
    systemDark,
    systemReduced,
  ]);
  const updateWorkspace = useCallback(
    (requested: Workspace) => {
      const previous = workspaceRef.current;
      let next = requested;
      if (
        previous &&
        stateRef.current?.preferences.rememberSidebarsPerTab
      ) {
        const switchingTabs = requested.activeTabId !== previous.activeTabId;
        if (switchingTabs) {
          const active = requested.tabs.find(
            (tab) => tab.id === requested.activeTabId,
          );
          const folderOpen = active?.folderOpen ?? requested.folderOpen;
          const detailsOpen = active?.detailsOpen ?? requested.detailsOpen;
          next = {
            ...requested,
            folderOpen,
            detailsOpen,
            tabs: active
              ? requested.tabs.map((tab) =>
                  tab.id === active.id
                    ? { ...tab, folderOpen, detailsOpen }
                    : tab,
                )
              : requested.tabs,
          };
        } else if (
          requested.folderOpen !== previous.folderOpen ||
          requested.detailsOpen !== previous.detailsOpen
        ) {
          next = {
            ...requested,
            tabs: requested.tabs.map((tab) =>
              tab.id === requested.activeTabId
                ? {
                    ...tab,
                    folderOpen: requested.folderOpen,
                    detailsOpen: requested.detailsOpen,
                  }
                : tab,
            ),
          };
        }
      }
      workspaceRef.current = next;
      setWorkspace(next);
      void enqueue((current) =>
        bridge.saveWorkspace(current.version, next),
      ).catch(() => undefined);
    },
    [enqueue],
  );
  const currentScroll = () => {
    const ws = workspaceRef.current!;
    const rememberPerTab =
      stateRef.current?.preferences.rememberSidebarsPerTab ?? true;
    return {
      ...ws,
      tabs: ws.tabs.map((tab) =>
        tab.id === ws.activeTabId
          ? {
              ...tab,
              scrollTop: contentRef.current?.scrollTop ?? tab.scrollTop,
              libraryView:
                libraryViews.current[tab.id] ?? tab.libraryView ?? null,
              ...(rememberPerTab
                ? {
                    folderOpen: ws.folderOpen,
                    detailsOpen: ws.detailsOpen,
                  }
                : {}),
            }
          : tab,
      ),
    };
  };
  const selectTab = (id: string) => {
    const ws = currentScroll();
    updateWorkspace({ ...ws, activeTabId: id });
    setChooser(false);
  };
  const openTab = (section: Section) => {
    const ws = currentScroll();
    if (ws.tabs.length >= 20) {
      setSaveError(t("app.tabsLimit"));
      return;
    }
    const tab = makeTab(section, {
      folderOpen: ws.folderOpen,
      detailsOpen: ws.detailsOpen,
    });
    updateWorkspace({ ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id });
    setChooser(false);
  };
  const navigate = (section: Section, newTab = false) => {
    if (newTab) {
      openTab(section);
      return;
    }
    const ws = currentScroll();
    const currentTab = ws.tabs.find((tab) => tab.id === ws.activeTabId);
    if (section === "analytics" && currentTab?.section !== "analytics") {
      analyticsOpenCounts.current[ws.activeTabId!] =
        (analyticsOpenCounts.current[ws.activeTabId!] ?? 0) + 1;
    }
    updateWorkspace({
      ...ws,
      tabs: ws.tabs.map((tab) =>
        tab.id === ws.activeTabId
          ? { ...tab, section, title: t(`nav.${section}`), scrollTop: 0 }
          : tab,
      ),
    });
  };
  const closeTab = (id: string) => {
    const ws = currentScroll(),
      index = ws.tabs.findIndex((tab) => tab.id === id);
    let tabs = ws.tabs.filter((tab) => tab.id !== id);
    if (!tabs.length)
      tabs = [makeTab("home", { folderOpen: ws.folderOpen, detailsOpen: ws.detailsOpen })];
    updateWorkspace({
      ...ws,
      tabs,
      activeTabId:
        ws.activeTabId === id
          ? tabs[Math.min(index, tabs.length - 1)].id
          : ws.activeTabId,
    });
  };
  const moveTabToIndex = (id: string, targetIndex: number) => {
    const ws = currentScroll();
    const fromIndex = ws.tabs.findIndex((tab) => tab.id === id);
    if (fromIndex < 0) return;
    const boundedIndex = Math.max(0, Math.min(targetIndex, ws.tabs.length - 1));
    if (fromIndex === boundedIndex) return;
    const tabs = [...ws.tabs];
    const [moving] = tabs.splice(fromIndex, 1);
    tabs.splice(boundedIndex, 0, moving);
    updateWorkspace({ ...ws, tabs });
  };
  const updateTabDropTarget = (
    sourceId: string,
    clientX: number,
    clientY: number,
  ): TabDropTarget | null => {
    const targetElement = document.elementFromPoint(clientX, clientY);
    const targetTab = targetElement?.closest<HTMLElement>(".app-tab");
    const targetId = targetTab?.dataset.tabId;
    if (
      !targetTab ||
      !targetId ||
      targetId === sourceId ||
      !targetTab.closest(".tab-strip")
    ) {
      if (tabDropTargetRef.current) {
        tabDropTargetRef.current = null;
        setTabDropTarget(null);
      }
      return null;
    }
    const bounds = targetTab.getBoundingClientRect();
    const next: TabDropTarget = {
      id: targetId,
      side: clientX > bounds.left + bounds.width / 2 ? "after" : "before",
    };
    const previous = tabDropTargetRef.current;
    if (previous?.id !== next.id || previous?.side !== next.side) {
      tabDropTargetRef.current = next;
      setTabDropTarget(next);
    }
    return next;
  };
  const finishTabPointerDrag = (
    pointerId: number,
    clientX: number,
    clientY: number,
    cancelled = false,
  ) => {
    const drag = tabPointerDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.isDragging && !cancelled) {
      const target = updateTabDropTarget(drag.id, clientX, clientY);
      const ws = workspaceRef.current;
      const sourceIndex = ws?.tabs.findIndex((tab) => tab.id === drag.id) ?? -1;
      const targetIndex =
        ws?.tabs.findIndex((tab) => tab.id === target?.id) ?? -1;
      if (sourceIndex >= 0 && targetIndex >= 0 && target) {
        const insertionIndex =
          targetIndex + (target.side === "after" ? 1 : 0);
        moveTabToIndex(
          drag.id,
          insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex,
        );
      }
    }
    tabPointerDrag.current = null;
    tabDropTargetRef.current = null;
    setDraggingTab(null);
    setTabDropTarget(null);
    if (drag.isDragging) {
      suppressTabClick.current = true;
      window.setTimeout(() => {
        suppressTabClick.current = false;
      }, 0);
    }
  };
  const onTabPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const drag = tabPointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.isDragging &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5
    )
      return;
    if (!drag.isDragging) {
      drag.isDragging = true;
      suppressTabClick.current = true;
      setDraggingTab(drag.id);
    }
    updateTabDropTarget(drag.id, event.clientX, event.clientY);
  };
  const onTabPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    id: string,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    tabPointerDrag.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    };
  };
  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => {
    if (!event.altKey || !event.shiftKey) return;
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const index = workspaceRef.current?.tabs.findIndex((tab) => tab.id === id);
    if (index !== undefined && index >= 0)
      moveTabToIndex(id, index + direction);
  };
  const activeTab =
    workspace?.tabs.find((tab) => tab.id === workspace.activeTabId) ??
    workspace?.tabs[0];
  useEffect(() => {
    if (
      (activeTab?.section === "ranking" || activeTab?.section === "analytics" || activeTab?.section === "recap") &&
      libraryState &&
      rankingState?.revision !== libraryState.revision
    ) {
      void refreshRanking().catch((error) => {
        const message = bridge.errorMessage(error);
        setLibraryLoadError(message);
        setSaveError(message);
      });
    }
  }, [activeTab?.section, libraryState?.revision, rankingState?.revision, refreshRanking]);
  const onLibraryViewChange = useCallback(
    (view: LibraryViewSnapshot) => {
      if (!activeTab) return;
      const tabId = activeTab.id;
      libraryViews.current[tabId] = view;
      if (libraryViewPersistTimer.current)
        clearTimeout(libraryViewPersistTimer.current);
      libraryViewPersistTimer.current = setTimeout(() => {
        const current = workspaceRef.current;
        if (!current) return;
        updateWorkspace({
          ...current,
          tabs: current.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, libraryView: view } : tab,
          ),
        });
      }, 450);
    },
    [activeTab?.id, updateWorkspace],
  );
  useEffect(() => {
    if (contentRef.current && activeTab)
      contentRef.current.scrollTop = activeTab.scrollTop;
  }, [activeTab?.id, activeTab?.section]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") {
        setChooser(false);
        return;
      }
      if (isEditing(e.target) || !stateRef.current || !workspaceRef.current)
        return;
      const chord = shortcutFromEvent(e),
        prefs = stateRef.current.preferences;
      if (
        chord === prefs.nextTabShortcut ||
        chord === prefs.previousTabShortcut
      ) {
        e.preventDefault();
        const ws = currentScroll(),
          index = ws.tabs.findIndex((tab) => tab.id === ws.activeTabId),
          direction = chord === prefs.nextTabShortcut ? 1 : -1;
        updateWorkspace({
          ...ws,
          activeTabId:
            ws.tabs[(index + direction + ws.tabs.length) % ws.tabs.length].id,
        });
      }
      if (chord === "Meta+,") {
        e.preventDefault();
        navigate("settings");
      }
      if (chord === "Meta+t") {
        e.preventDefault();
        setChooser((v) => !v);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!bridge.native) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false,
      closing = false;
    import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const off = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        const dirtyDialog = document.querySelector(
          'dialog[open][data-dirty="true"]',
        );
        if (dirtyDialog) {
          closing = false;
          dirtyDialog.dispatchEvent(
            new Event("cancel", { bubbles: false, cancelable: true }),
          );
          return;
        }
        try {
          if (workspaceRef.current) {
            const ws = currentScroll();
            await enqueue((current) =>
              bridge.saveWorkspace(current.version, ws),
            );
          }
          await queue.current;
          // This callback is running inside onCloseRequested. Calling close()
          // here can dispatch another close request while the original is
          // still waiting for us. Destroy the window after persistence instead.
          await win.destroy();
        } catch (e) {
          closing = false;
          setSaveError(bridge.errorMessage(e));
        }
      });
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enqueue]);
  const analyticsConfirmations = state?.preferences.analyticsBoundaryReviews ?? [];
  const confirmAnalyticsReview = async (fingerprint: string) => {
    await enqueue((current) => bridge.savePreferences(current.version, {
      ...current.preferences,
      analyticsBoundaryReviews: [...new Set([
        ...(current.preferences.analyticsBoundaryReviews ?? []),
        fingerprint,
      ])].slice(-1000),
    }));
    await refreshRanking();
  };
  const resetAnalyticsReviews = async () => {
    await enqueue((current) => bridge.savePreferences(current.version, {
      ...current.preferences,
      analyticsBoundaryReviews: [],
    }));
    await refreshRanking();
  };
  const saveHome = async (patch: HomePatch) => {
    await enqueue((current) => bridge.saveHome(current.version, patch));
  };
  const savePrefs = async (patch: Partial<Preferences>) => {
    const nextState = await enqueue(async (current) => {
      const nextPreferences = { ...current.preferences, ...patch };
      let nextWorkspace = current.workspace;
      let persistWorkspace = false;
      if (
        patch.rememberSidebarsPerTab !== undefined &&
        patch.rememberSidebarsPerTab !== current.preferences.rememberSidebarsPerTab
      ) {
        if (patch.rememberSidebarsPerTab) {
          // Keep existing per-tab choices when re-enabling the mode. Fill only
          // snapshots that came from legacy data and were never initialized.
          const tabs = current.workspace.tabs.map((tab) => ({
            ...tab,
            folderOpen: tab.folderOpen ?? current.workspace.folderOpen,
            detailsOpen: tab.detailsOpen ?? current.workspace.detailsOpen,
          }));
          const active = tabs.find((tab) => tab.id === current.workspace.activeTabId);
          nextWorkspace = {
            ...current.workspace,
            folderOpen: active?.folderOpen ?? current.workspace.folderOpen,
            detailsOpen: active?.detailsOpen ?? current.workspace.detailsOpen,
            tabs,
          };
        } else {
          const active = current.workspace.tabs.find(
            (tab) => tab.id === current.workspace.activeTabId,
          );
          nextWorkspace = {
            ...current.workspace,
            folderOpen: active?.folderOpen ?? current.workspace.folderOpen,
            detailsOpen: active?.detailsOpen ?? current.workspace.detailsOpen,
          };
        }
        persistWorkspace = true;
      }
      let saved = await bridge.savePreferences(current.version, nextPreferences);
      if (persistWorkspace)
        saved = await bridge.saveWorkspace(saved.version, nextWorkspace);
      return saved;
    });
    if (nextState.workspace !== workspaceRef.current) {
      workspaceRef.current = nextState.workspace;
      setWorkspace(nextState.workspace);
    }
  };
  const resetAllWorkspaceData = async () => {
    if (libraryViewPersistTimer.current) {
      clearTimeout(libraryViewPersistTimer.current);
      libraryViewPersistTimer.current = null;
    }
    const result = queue.current
      .catch(() => undefined)
      .then(async () => {
        const current = stateRef.current;
        if (!current) throw new Error(t("app.profileLoading"));
        let reset: bridge.WorkspaceResetResult;
        try {
          reset = await bridge.resetWorkspace(current.version);
        } catch (cause) {
          if (!hasBridgeErrorCode(cause, "ResetCommittedCleanupPending"))
            throw cause;
          // The database reset committed, but startup recovery still needs to
          // remove staged managed files. Rehydrate so no stale in-memory data
          // can be shown or written back, then surface the localized warning.
          await initialize();
          try {
            announceCatalogCapabilitiesChanged(await catalogCapabilities());
          } catch {
            // Keep the committed reset visible if provider status cannot refresh.
          }
          libraryViews.current = {};
          setSaveError(bridge.errorMessage(cause));
          return;
        }
        const freshWorkspace = structuredClone(reset.home.workspace);
        stateRef.current = reset.home;
        workspaceRef.current = freshWorkspace;
        libraryStateRef.current = reset.library;
        setState(reset.home);
        setWorkspace(freshWorkspace);
        setLibraryState(reset.library);
        setAvatar(null);
        setDetailsWidth(freshWorkspace.detailsWidth);
        setLibraryLoadError("");
        setSaveError("");
        setChooser(false);
        libraryViews.current = {};
        try {
          announceCatalogCapabilitiesChanged(await catalogCapabilities());
        } catch {
          // Keep the reset committed if provider status cannot refresh.
        }
      });
    queue.current = result;
    await result;
  };
  const saveLibraryEntry = (entry: EntryDraft) =>
    mutateLibrary((current) =>
      libraryBridge.saveEntry(current.revision, entry),
    ).then(() => undefined);
  const createRankingEntry = async (entry: EntryDraft) => {
    await mutateLibrary((current) =>
      libraryBridge.saveEntry(current.revision, entry),
    );
    return refreshRanking();
  };
  const moveRankingEntry = (
    entryId: string,
    score: number,
    ranked: boolean,
    position: RankingDropPosition,
  ) => serializeOperation(async () => {
    const current = rankingStateRef.current;
    if (!current) throw new Error(t("app.libraryLoading"));
    const next = await rankingBridge.moveRankingEntry(
      current.revision,
      entryId,
      score,
      ranked,
      position,
    );
    acceptRankingState(next);
    return next;
  });
  const dropRankingEntryInSidebar = (event: ReactDragEvent<HTMLButtonElement>, score: number) => {
    event.preventDefault();
    const entryId = event.dataTransfer.getData("text/plain");
    setRankingSidebarDropTarget(null);
    if (!entryId) return;
    void moveRankingEntry(entryId, score, false, { kind: "end" }).catch((cause) => {
      setSaveError(bridge.errorMessage(cause));
    });
  };
  const undoRankingMove = () => serializeOperation(async () => {
    const current = rankingStateRef.current;
    if (!current) throw new Error(t("app.libraryLoading"));
    const next = await rankingBridge.undoLastRankingMove(current.revision);
    acceptRankingState(next);
    return next;
  });
  const hasRetractableRankingDuel = useCallback(
    async (sessionId: string) => Boolean(await rankingBridge.latestRetractableJudgmentId(sessionId)),
    [],
  );
  const undoRankingDuel = (sessionId: string) => serializeOperation(async () => {
    const current = rankingStateRef.current;
    if (!current) throw new Error(t("app.libraryLoading"));
    const judgmentId = await rankingBridge.latestRetractableJudgmentId(sessionId);
    if (!judgmentId) return null;
    const next = await rankingBridge.retractDuelJudgment(current.revision, judgmentId);
    acceptRankingState(next);
    const prompt = await rankingBridge.nextDuel(sessionId, false);
    return { state: next, prompt };
  });
  const startRankingSession = (
    score: number,
    intent: "auto" | "binary" | "normal",
    candidateEntryId?: string,
    candidateEntryIds?: string[],
    filterMediaTypeIds?: string[],
    eligibleUnplacedEntryIds?: string[],
  ) => serializeOperation(async () => {
    const current = rankingStateRef.current;
    if (!current) throw new Error(t("app.libraryLoading"));
    const session = await rankingBridge.startDuelSession(
      current.revision,
      score,
      filterMediaTypeIds ?? [],
      candidateEntryId ?? null,
      intent,
      candidateEntryIds,
      eligibleUnplacedEntryIds,
    );
    const next = await rankingBridge.loadRanking();
    acceptRankingState(next);
    const prompt = await rankingBridge.nextDuel(session.id, false);
    return { state: next, prompt };
  });
  const getNextRankingDuel = useCallback((sessionId: string, revisit = false) =>
    serializeOperation(async () => {
      const prompt = await rankingBridge.nextDuel(sessionId, revisit);
      const next = await rankingBridge.loadRanking();
      acceptRankingState(next);
      return prompt;
    }), [acceptRankingState, serializeOperation]);
  const answerRankingDuel = (
    sessionId: string,
    duelId: string,
    answer: "leftWin" | "rightWin" | "tie" | "skip",
  ) => serializeOperation(async () => {
    const current = rankingStateRef.current;
    if (!current) throw new Error(t("app.libraryLoading"));
    const next = await rankingBridge.answerDuel(
      current.revision,
      sessionId,
      duelId,
      answer,
    );
    acceptRankingState(next);
    return next;
  });
  const confirmRankingPlacement = (sessionId: string, accepted: boolean) =>
    serializeOperation(async () => {
      const current = rankingStateRef.current;
      if (!current) throw new Error(t("app.libraryLoading"));
      const result = await rankingBridge.confirmBinaryPlacement(
        current.revision,
        sessionId,
        accepted,
      );
      const next = result.state;
      acceptRankingState(next);
      return { state: next, prompt: null, nextStep: result.nextStep };
    });
  const endRankingSession = (sessionId: string) =>
    serializeOperation(async () => {
      await rankingBridge.endDuelSession(sessionId);
      const next = await rankingBridge.loadRanking();
      acceptRankingState(next);
      return next;
    });
  const resetMediaRanking = async () => {
    await mutateLibrary((current) =>
      rankingBridge.resetMediaRanking(current.revision),
    );
    await refreshRanking();
    setSelectedRankingEntryId(null);
  };
  const deleteLibraryEntry = (entryId: string) =>
    mutateLibrary((current) =>
      libraryBridge.deleteEntry(current.revision, entryId),
    ).then(() => undefined);
  const createLibraryTag = async (name: string) => {
    const id = crypto.randomUUID();
    const updated = await mutateLibrary((current) =>
      libraryBridge.saveTag(current.revision, id, name),
    );
    const tag = updated.tags.find((item) => item.id === id);
    if (!tag) throw new Error(t("app.tagNotReturned"));
    return tag;
  };
  const saveLibraryCover = (
    entryId: string,
    mimeType: string,
    base64: string,
  ) =>
    mutateLibrary((current) =>
      libraryBridge.saveEntryCover(current.revision, entryId, mimeType, base64),
    ).then(() => undefined);
  const openRankingCreate = () => {
    setRankingEditorError("");
    setRankingEditorIsNew(true);
    setRankingEditorEntry(createEmptyLibraryEntry());
  };
  const openRankingEdit = (entry: Entry) => {
    setRankingEditorError("");
    setRankingEditorIsNew(false);
    setRankingEditorEntry(structuredClone(entry));
  };
  const saveRankingEditor = async (entry: Entry, coverFile: File | null) => {
    setRankingEditorBusy(true);
    setRankingEditorError("");
    try {
      const draft: EntryDraft = {
        id: entry.id,
        title: entry.title.trim(),
        disposition: entry.overallRating === null ? entry.disposition : "experienced",
        mediaTypeId: entry.mediaTypeId,
        overallRating: entry.overallRating,
        coverAssetId: entry.coverAssetId,
        releaseDate: entry.releaseDate,
        reviewText: entry.reviewText,
        shortLabel: entry.shortLabel?.trim() || null,
        tagIds: entry.tagIds,
        criterionRatings: entry.criterionRatings,
      };
      if (rankingEditorIsNew) {
        await createRankingEntry(draft);
        setRankingCreatedEntryId(entry.id);
      }
      else await saveLibraryEntry(draft);
      if (coverFile) {
        await saveLibraryCover(entry.id, coverFile.type, await readLibraryCover(coverFile));
      }
      await refreshRanking();
      setSelectedRankingEntryId(entry.id);
      updateWorkspace({ ...workspaceRef.current!, detailsOpen: true });
      setRankingEditorEntry(null);
    } catch (error) {
      setRankingEditorError(bridge.errorMessage(error));
    } finally {
      setRankingEditorBusy(false);
    }
  };
  const refreshLibrary = async () => {
    await queue.current.catch(() => undefined);
    const next = await libraryBridge.loadLibrary();
    libraryStateRef.current = next;
    setLibraryState(next);
    setLibraryLoadError("");
  };
  const restoreArchive = async (path: string) => {
    const restored = await enqueue((current) =>
      bridge.importLibraryArchive(path, current.version),
    );
    setAvatar(await bridge.loadAvatar());
    const ws = structuredClone(restored.workspace);
    workspaceRef.current = ws;
    setWorkspace(ws);
    setDetailsWidth(Math.max(240, Math.min(440, ws.detailsWidth)));
    await refreshLibrary();
    try {
      announceCatalogCapabilitiesChanged(await catalogCapabilities());
    } catch {
      // Archive restore is complete; open catalog panels can retry their status refresh.
    }
  };
  const uploadAvatar = async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
      throw new Error(t("home.imageTypeError"));
    if (file.size > 25 * 1024 * 1024) throw new Error(t("home.imageSizeError"));
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error(t("home.imageReadError")));
      reader.readAsDataURL(file);
    });
    await enqueue((current) =>
      bridge.saveAvatar(current.version, file.type, data),
    );
    setAvatar(await bridge.loadAvatar());
  };
  const removeAvatar = async () => {
    await enqueue((current) => bridge.removeAvatar(current.version));
    setAvatar(null);
  };
  const selectedRankingEntry = rankingState?.library.entries.find(
    (entry) => entry.id === selectedRankingEntryId,
  );
  const coverPrewarmEntries = useMemo(() => {
    if (!libraryState) return [];
    const entriesById = new Map(libraryState.entries.map((entry) => [entry.id, entry]));
    const prioritizedIds: string[] = [];
    const view = activeTab?.section === "library" ? activeTab.libraryView : null;
    if (view) {
      if (view.selectedEntryId) prioritizedIds.push(view.selectedEntryId);
      const { filters, activeGroupId } = view;
      const inGroup = (entry: Entry) => {
        const groupId = entry.disposition === "planned"
          ? "planned"
          : entry.disposition === "dropped"
            ? "dropped"
            : entry.overallRating === null
              ? "unrated"
              : `score:${entry.overallRating}`;
        return activeGroupId === "all" || activeGroupId === groupId;
      };
      const matchesSavedFilters = (entry: Entry) => {
        if (filters.mediaTypes.length) {
          const noType = filters.mediaTypes.includes("__none__") && entry.mediaTypeId === null;
          if (!noType && !filters.mediaTypes.includes(entry.mediaTypeId ?? "")) return false;
        }
        if (filters.tags.length) {
          const matchingTags = filters.tags.filter((id) => entry.tagIds.includes(id)).length;
          if (filters.tagMode === "all" ? matchingTags !== filters.tags.length : matchingTags === 0) return false;
        }
        const year = entry.releaseDate?.year;
        if (filters.minYear && (year === undefined || year < Number(filters.minYear))) return false;
        if (filters.maxYear && (year === undefined || year > Number(filters.maxYear))) return false;
        if (filters.cover === "has" && !entry.coverAssetId) return false;
        if (filters.cover === "missing" && entry.coverAssetId) return false;
        return true;
      };
      prioritizedIds.push(...libraryState.entries
        .filter((entry) => inGroup(entry) && matchesSavedFilters(entry))
        .map((entry) => entry.id));
    }
    const canonicalPlacedIds = [...(rankingState?.tiers ?? [])]
      .sort((a, b) => b.score - a.score)
      .flatMap((tier) => tier.placedIds);
    prioritizedIds.push(...canonicalPlacedIds);
    prioritizedIds.push(...libraryState.entries.map((entry) => entry.id));
    const seen = new Set<string>();
    const result = prioritizedIds.flatMap((id) => {
      const entry = entriesById.get(id);
      if (!entry?.coverAssetId || seen.has(id)) return [];
      seen.add(id);
      return [entry];
    });
    return result.slice(0, 32);
  }, [activeTab?.libraryView, activeTab?.section, libraryState, rankingState?.tiers]);
  const coverPrewarmSignature = coverPrewarmEntries
    .map((entry) => `${entry.id}:${entry.coverAssetId}`)
    .join("\u0000");
  const prewarmedCoverSignature = useRef("");
  useEffect(() => {
    if (!libraryState || !coverPrewarmSignature || prewarmedCoverSignature.current === coverPrewarmSignature) return;
    prewarmedCoverSignature.current = coverPrewarmSignature;
    void libraryBridge.prewarmEntryCovers(coverPrewarmEntries, { concurrency: 3, limit: 32 });
  }, [coverPrewarmEntries, coverPrewarmSignature]);
  const recapPrewarmEntries = useMemo(() => {
    if (!libraryState) return [];
    const entriesById = new Map(libraryState.entries.map((entry) => [entry.id, entry]));
    const topPlacedIds = [...(rankingState?.tiers ?? [])]
      .sort((a, b) => b.score - a.score)
      .flatMap((tier) => tier.placedIds)
      .slice(0, 10);
    return topPlacedIds.flatMap((id) => {
      const entry = entriesById.get(id);
      return entry?.coverAssetId ? [entry] : [];
    });
  }, [libraryState, rankingState?.tiers]);
  const recapPrewarmSignature = recapPrewarmEntries
    .map((entry) => `${entry.id}:${entry.coverAssetId}`)
    .join("\u0000");
  const prewarmedRecapSignature = useRef("");
  useEffect(() => {
    if (!libraryState || !recapPrewarmSignature || prewarmedRecapSignature.current === recapPrewarmSignature) return;
    prewarmedRecapSignature.current = recapPrewarmSignature;
    let cancelled = false;
    const warmRecapVariants = async () => {
      // Warm the smaller Library assets first; Recap keeps its own native render-size variant.
      await libraryBridge.prewarmEntryCovers(coverPrewarmEntries, { concurrency: 3, limit: 32 });
      if (cancelled) return;
      const queue = [...recapPrewarmEntries];
      const worker = async () => {
        while (queue.length && !cancelled) {
          const entry = queue.shift();
          if (!entry?.coverAssetId) continue;
          await loadRecapCover(entry.id, entry.coverAssetId).catch(() => null);
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
      if (!cancelled) prewarmedRecapSignature.current = recapPrewarmSignature;
    };
    const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number };
    let idleId: number | undefined;
    const timerId = window.setTimeout(() => { void warmRecapVariants(); }, 120);
    if (idleWindow.requestIdleCallback) {
      window.clearTimeout(timerId);
      idleId = idleWindow.requestIdleCallback(() => { void warmRecapVariants(); }, { timeout: 900 });
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
      if (idleId !== undefined) (idleWindow as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idleId);
    };
  }, [coverPrewarmEntries, libraryState, recapPrewarmEntries, recapPrewarmSignature]);
  const rankingRankIndex = buildLibraryRankIndex(
    rankingState?.library.entries ?? [],
    rankingState?.tiers.map(({ score, placedIds }) => ({ score, placedIds })) ?? null,
  );
  useEffect(() => {
    if (!selectedRankingEntry?.coverAssetId) {
      setRankingCoverUrl(null);
      return;
    }
    let cancelled = false;
    void libraryBridge.loadEntryCover(selectedRankingEntry.id, selectedRankingEntry.coverAssetId)
      .then((url) => { if (!cancelled) setRankingCoverUrl(url); })
      .catch(() => { if (!cancelled) setRankingCoverUrl(null); });
    return () => { cancelled = true; };
  }, [selectedRankingEntry?.id, selectedRankingEntry?.coverAssetId]);
  if (loadError)
    return (
      <div className="startup-state">
        <div className="startup-symbol">✦</div>
        <h1>{t("app.startupErrorTitle")}</h1>
        <p role="alert">{loadError}</p>
        <p>{t("app.startupErrorBody")}</p>
        <button className="button primary" onClick={() => void initialize()}>
          {t("common.tryAgain")}
        </button>
      </div>
    );
  if (!state || !workspace || !activeTab)
    return (
      <div className="startup-state">
        <div className="startup-symbol">✦</div>
        <p>{t("app.opening")}</p>
      </div>
    );
  const activeSection = activeTab.section;
  const hideSidebars = activeSection === "home" || activeSection === "settings" || activeSection === "analytics" || activeSection === "recap";
  const SectionIcon =
    allSections.find((s) => s.id === activeSection)?.icon ?? HomeIcon;
  const hasFolders = activeSection === "ranking";
  const rankingPanelResizer = (
    <div
      className="resize-handle library-resize-handle"
      role="separator"
      aria-label={t("library.ui.resizePanel")}
      aria-orientation="vertical"
      aria-valuemin={240}
      aria-valuemax={440}
      aria-valuenow={detailsWidth}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = Math.max(240, Math.min(440, detailsWidth + (event.key === "ArrowLeft" ? 10 : -10)));
        setDetailsWidth(next);
        updateWorkspace({ ...workspaceRef.current!, detailsWidth: next });
      }}
      onPointerDown={(event) => {
        const handle = event.currentTarget;
        const start = event.clientX;
        const initialWidth = detailsWidth;
        handle.setPointerCapture(event.pointerId);
        let next = initialWidth;
        const move = (pointer: PointerEvent) => {
          next = Math.max(240, Math.min(440, initialWidth + start - pointer.clientX));
          setDetailsWidth(next);
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          updateWorkspace({ ...workspaceRef.current!, detailsWidth: next });
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up, { once: true });
      }}
    />
  );
  return (
    <div
      className={`app-shell ${bridge.native ? "native-app" : "browser-app"} ${bridge.native && /Windows/i.test(navigator.userAgent) ? "windows-app" : ""}`}
    >
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-brand" data-tauri-drag-region>
          <span className="brand-word" data-tauri-drag-region>
            TASTELLAR
          </span>
        </div>
        <div
          className="tab-strip"
          role="tablist"
          aria-label={t("app.workspaceTabs")}
        >
          {workspace.tabs.map((tab) => {
            const Icon =
              allSections.find((s) => s.id === tab.section)?.icon ?? HomeIcon;
            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                className={`app-tab ${tab.id === activeTab.id ? "active" : ""}${draggingTab === tab.id ? " dragging" : ""}${tabDropTarget?.id === tab.id ? ` drop-${tabDropTarget.side}` : ""}`}
              >
                <button
                  role="tab"
                  aria-selected={tab.id === activeTab.id}
                  aria-description={t("app.tabReorderHelp")}
                  onClick={(event) => {
                    if (suppressTabClick.current) {
                      suppressTabClick.current = false;
                      event.preventDefault();
                      return;
                    }
                    selectTab(tab.id);
                  }}
                  onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                  onPointerDown={(event) => onTabPointerDown(event, tab.id)}
                  onPointerMove={onTabPointerMove}
                  onPointerUp={(event) =>
                    finishTabPointerDrag(
                      event.pointerId,
                      event.clientX,
                      event.clientY,
                    )
                  }
                  onPointerCancel={(event) =>
                    finishTabPointerDrag(
                      event.pointerId,
                      event.clientX,
                      event.clientY,
                      true,
                    )
                  }
                  onLostPointerCapture={(event) =>
                    finishTabPointerDrag(
                      event.pointerId,
                      event.clientX,
                      event.clientY,
                      true,
                    )
                  }
                >
                  <Icon size={14} />
                  <span>{t(`nav.${tab.section}`)}</span>
                </button>
                <button
                  className="tab-close"
                  aria-label={t("app.closeTab", { section: tab.title })}
                  onClick={() => closeTab(tab.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="tab-add-wrap">
          <button
            className={`icon-button add-tab ${chooser ? "active" : ""}`}
            aria-expanded={chooser}
            aria-label={t("app.newTab")}
            title={t("app.newTab")}
            onClick={() => setChooser(!chooser)}
          >
            <Plus size={17} />
          </button>
          {chooser && (
            <>
              <button
                className="menu-dismiss"
                tabIndex={-1}
                aria-label={t("app.closeNewTabMenu")}
                onClick={() => setChooser(false)}
              />
              <div className="tab-chooser">
                <span className="micro-label">{t("app.openNewTab")}</span>
                {allSections.map(({ id, icon: Icon }) => (
                  <button key={id} onClick={() => openTab(id)}>
                    <Icon size={16} />
                    {t(`nav.${id}`)}
                    <Plus size={13} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="titlebar-spacer" data-tauri-drag-region />
        <button
          className={`icon-button panel-toggle left-sidebar-toggle ${workspace.folderOpen ? "active" : ""}`}
          hidden={hideSidebars}
          aria-label={workspace.folderOpen ? t("app.hideLeftSidebar") : t("app.showLeftSidebar")}
          aria-pressed={workspace.folderOpen}
          onClick={() => updateWorkspace({ ...workspaceRef.current!, folderOpen: !workspaceRef.current!.folderOpen })}
        >
          <PanelLeft size={18} />
        </button>
        <button
          className={`icon-button panel-toggle ${workspace.detailsOpen ? "active" : ""}`}
          hidden={hideSidebars}
          aria-label={activeSection === "ranking"
            ? workspace.detailsOpen ? t("ranking.hideRightSidebar") : t("ranking.showRightSidebar")
            : t("app.details")}
          aria-pressed={workspace.detailsOpen}
          onClick={() =>
            updateWorkspace({
              ...workspace,
              detailsOpen: !workspace.detailsOpen,
            })
          }
        >
          <PanelRight size={18} />
        </button>
      </header>
      <nav className="navigation-rail" aria-label={t("app.mainNavigation")}>
        <button
          className="brand-button"
          aria-label={t("app.home")}
          onClick={() => navigate("home")}
        >
          <span>✦</span>
        </button>
        <div className="primary-navigation">
          {sections.map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`rail-button ${activeSection === id ? "active" : ""}`}
              aria-label={t(`nav.${id}`)}
              aria-current={activeSection === id ? "page" : undefined}
              onClick={(e) => navigate(id, e.metaKey || e.ctrlKey)}
            >
              <Icon size={21} strokeWidth={1.65} />
              <span className="rail-tooltip">{t(`nav.${id}`)}</span>
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          <button
            className={`rail-button ${activeSection === "settings" ? "active" : ""}`}
            aria-label={t("nav.settings")}
            aria-current={activeSection === "settings" ? "page" : undefined}
            onClick={(e) => navigate("settings", e.metaKey || e.ctrlKey)}
          >
            <Settings2 size={20} strokeWidth={1.6} />
            <span className="rail-tooltip">{t("nav.settings")}</span>
          </button>
        </div>
      </nav>
      <div className={`workspace-body${activeSection === "ranking" ? " ranking-workspace" : ""}`}>
        {hasFolders && (
          <aside
            className={`folder-shell ${workspace.folderOpen ? "" : "collapsed ranking-hidden"}`}
            aria-label={t("app.groupSidebar")}
          >
            {workspace.folderOpen && (
              <LibrarySidebar
                className="ranking-library-sidebar"
                ariaLabel={t("ranking.sidebarTitle")}
                searchId="ranking-library-search"
                searchValue={rankingSearch}
                onSearchChange={setRankingSearch}
                onAddWork={openRankingCreate}
                heading={t("ranking.sidebarMedia")}
                count={rankingState?.library.entries.length ?? 0}
                listAriaLabel={t("ranking.sidebarTitle")}
                items={[
                  ...(rankingState?.tiers ?? []).map((tier) => ({
                    id: `score:${tier.score}`,
                    label: String(tier.score),
                    count: tier.placedIds.length + tier.unplacedIds.length,
                    selected: rankingSidebarSection === `score:${tier.score}`,
                    onSelect: () => {
                      setRankingSidebarSection(`score:${tier.score}`);
                      setRankingNavigationRequest({ groupId: `score:${tier.score}`, score: tier.score });
                    },
                    buttonProps: {
                      className: `ranking-sidebar-tier${rankingSidebarDropTarget === tier.score ? " drop-active" : ""}`,
                      "data-ranking-drop-score": tier.score,
                      title: t("ranking.sidebarDropTarget", { score: tier.score }),
                      onDragOver: (event: ReactDragEvent<HTMLButtonElement>) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setRankingSidebarDropTarget(tier.score);
                      },
                      onDragLeave: () => setRankingSidebarDropTarget(null),
                      onDrop: (event: ReactDragEvent<HTMLButtonElement>) => dropRankingEntryInSidebar(event, tier.score),
                    },
                  })),
                  {
                    id: "planned",
                    label: t("library.ui.group.planned"),
                    count: rankingState?.library.entries.filter((entry) => entry.disposition === "planned").length ?? 0,
                    selected: rankingSidebarSection === "planned",
                    separatorBefore: true,
                    onSelect: () => {
                      setRankingSidebarSection("planned");
                      setRankingNavigationRequest({ groupId: "planned", score: null });
                    },
                  },
                  {
                    id: "dropped",
                    label: t("library.ui.group.dropped"),
                    count: rankingState?.library.entries.filter((entry) => entry.disposition === "dropped").length ?? 0,
                    selected: rankingSidebarSection === "dropped",
                    onSelect: () => {
                      setRankingSidebarSection("dropped");
                      setRankingNavigationRequest({ groupId: "dropped", score: null });
                    },
                  },
                  {
                    id: "unrated",
                    label: t("library.ui.group.unrated"),
                    count: rankingState?.unscoredIds.length ?? 0,
                    selected: rankingSidebarSection === "unrated",
                    separatorBefore: true,
                    buttonProps: { className: "ranking-sidebar-tier unrated" },
                    onSelect: () => {
                      setRankingSidebarSection("unrated");
                      setRankingNavigationRequest({ groupId: "unrated", score: null });
                    },
                  },
                ]}
              />
            )}
          </aside>
        )}
        {workspace.folderOpen && !hideSidebars && activeSection !== "ranking" && activeSection !== "library" && (
          <aside className="folder-shell app-empty-left-sidebar" aria-label={t("app.leftSidebar")}>
            <div>
              <span>{t("app.leftSidebar")}</span>
              <button
                className="icon-button"
                aria-label={t("app.closeLeftSidebar")}
                onClick={() => updateWorkspace({ ...workspaceRef.current!, folderOpen: false })}
              >
                <X size={16} />
              </button>
            </div>
            <div className="details-empty left-sidebar-empty">
              <PanelLeft size={29} strokeWidth={1} />
              <h3>{t("app.emptyLeftSidebar")}</h3>
              <p>{t("app.emptyLeftSidebarBody")}</p>
            </div>
          </aside>
        )}
        <main className="main-region">
          {saveError && (
            <div className="save-error" role="alert">
              <span>{saveError}</span>
              <button
                onClick={() => setSaveError("")}
                aria-label={t("app.dismissError")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <SupportReminder />
          <div
            className="content-scroll"
            ref={contentRef}
            id="main-content"
            tabIndex={-1}
          >
            {activeSection === "home" ? (
              <Home
                state={state}
                avatar={avatar}
                save={saveHome}
                preferences={savePrefs}
                uploadAvatar={uploadAvatar}
                removeAvatar={removeAvatar}
                criterionLabels={
                  libraryState
                    ? Object.fromEntries(
                        libraryState.criteria
                          .filter((item) => !item.archivedAt)
                          .map((item) => [item.id, item.name]),
                      )
                    : undefined
                }
                libraryEntries={libraryState?.entries}
                mediaTypes={
                  libraryState?.mediaTypes
                    .filter((item) => !item.archivedAt)
                    .map(({ id, name, criterionIds }) => ({
                      id,
                      name,
                      criterionIds,
                    })) ?? []
                }
              />
            ) : activeSection === "library" ? (
              libraryState ? (
                <Library
                  key={activeTab.id}
                  state={libraryState}
                  rankingTiers={libraryRankingTiers}
                  onSaveEntry={saveLibraryEntry}
                  onDeleteEntry={deleteLibraryEntry}
                  onSaveTag={createLibraryTag}
                  onSaveCover={saveLibraryCover}
                  onLoadCover={libraryBridge.loadEntryCover}
                  onExport={async (path) =>
                    void (await bridge.exportLibraryArchive(path))
                  }
                  onImport={restoreArchive}
                  isNative={bridge.native}
                  onLibraryMutation={mutateLibrary}
                  graphics={state?.preferences.graphics ?? "auto"}
                  scenesEnabled={state?.preferences.scenesEnabled ?? true}
                  sceneViewKey={activeTab.id}
                  reducedMotion={Boolean(
                    state?.preferences.reducedMotion === "on" ||
                      (state?.preferences.reducedMotion === "system" &&
                        systemReduced),
                  )}
                  onGraphicsChange={(graphics) => savePrefs({ graphics })}
                  sidebarOpen={workspace.folderOpen}
                  detailsOpen={workspace.detailsOpen}
                  detailsWidth={detailsWidth}
                  onDetailsOpenChange={(open) =>
                    updateWorkspace({
                      ...workspaceRef.current!,
                      detailsOpen: open,
                    })
                  }
                  onDetailsWidthChange={(width) => {
                    setDetailsWidth(width);
                    updateWorkspace({
                      ...workspaceRef.current!,
                      detailsWidth: width,
                    });
                  }}
                  initialView={
                    libraryViews.current[activeTab.id] ??
                    activeTab.libraryView ??
                    undefined
                  }
                  onViewChange={onLibraryViewChange}
                />
              ) : (
                <div className="library-load-state">
                  <BookOpen size={30} strokeWidth={1.2} />
                  <h1>{t("app.openingLibrary")}</h1>
                  {libraryLoadError && <p role="alert">{libraryLoadError}</p>}
                  {libraryLoadError && (
                    <button
                      className="button primary"
                      onClick={() => {
                        setLibraryLoadError("");
                        void libraryBridge
                          .loadLibrary()
                          .then((loaded) => {
                            libraryStateRef.current = loaded;
                            setLibraryState(loaded);
                          })
                          .catch((error) =>
                            setLibraryLoadError(bridge.errorMessage(error)),
                          );
                      }}
                    >
                      {t("common.tryAgain")}
                    </button>
                  )}
                </div>
              )
            ) : activeSection === "ranking" ? (
              <Ranking
                state={rankingState}
                onMoveEntry={moveRankingEntry}
                onUndoMove={undoRankingMove}
                onStartSession={startRankingSession}
                onNextDuel={getNextRankingDuel}
                onAnswerDuel={answerRankingDuel}
                onHasRetractableDuel={hasRetractableRankingDuel}
                onUndoDuel={undoRankingDuel}
                onConfirmBinaryPlacement={confirmRankingPlacement}
                onEndSession={endRankingSession}
                onRefresh={refreshRanking}
                onLoadCover={libraryBridge.loadEntryCover}
                onSelectEntry={setSelectedRankingEntryId}
                onEditEntry={(entryId) => {
                  const entry = rankingState?.library.entries.find((item) => item.id === entryId);
                  if (entry) openRankingEdit(entry);
                }}
                onDetailsOpenChange={(open) => updateWorkspace({ ...workspaceRef.current!, detailsOpen: open })}
                searchQuery={rankingSearch}
                onSearchQueryChange={setRankingSearch}
                navigationRequest={rankingNavigationRequest}
                lastCreatedEntryId={rankingCreatedEntryId}
              />
            ) : activeSection === "analytics" ? (
              <Analytics
                key={activeTab.id}
                viewKey={`${activeTab.id}:${analyticsOpenCounts.current[activeTab.id] ?? 0}`}
                state={rankingState}
                onMoveEntry={moveRankingEntry}
                onEditEntry={(entryId) => {
                  const entry = rankingState?.library.entries.find((item) => item.id === entryId);
                  if (entry) openRankingEdit(entry);
                }}
                onOpenLibrary={() => navigate("library")}
                onOpenRanking={() => navigate("ranking")}
                confirmations={analyticsConfirmations}
                onConfirmReview={confirmAnalyticsReview}
                onResetReviews={resetAnalyticsReviews}
                error={libraryLoadError}
                onRetry={refreshRanking}
              />
            ) : activeSection === "recap" ? (
              <Recap
                state={rankingState}
                preferences={state.preferences}
                onPreferences={savePrefs}
                onOpenLibrary={() => navigate("library")}
                onOpenRanking={() => navigate("ranking")}
                error={libraryLoadError}
                onRetry={refreshRanking}
              />
            ) : activeSection === "settings" ? (
              <Settings
                preferences={state.preferences}
                onPreferences={savePrefs}
                onRestore={restoreArchive}
                onReset={resetAllWorkspaceData}
                onResetRanking={resetMediaRanking}
              />
            ) : (
              <div className="empty-section">
                <SectionIcon size={34} strokeWidth={1} />
                <h1>{t(`nav.${activeSection}`)}</h1>
                <p>{t("app.future")}</p>
                <span>{t("app.futureBody")}</span>
              </div>
            )}
          </div>
          {!bridge.native && (
            <div className="preview-bar">
              <ShieldCheck size={11} />
              {t("app.preview")}
            </div>
          )}
        </main>
        {workspace.detailsOpen && activeSection === "ranking" && rankingState && (
          <LibraryDetailsPanel
            className="ranking-context-panel"
            width={detailsWidth}
            ariaLabel={t("library.ui.workDetails")}
            title={t("library.ui.details")}
            onClose={() => updateWorkspace({ ...workspaceRef.current!, detailsOpen: false })}
            resizer={rankingPanelResizer}
          >
            {selectedRankingEntry ? (
              <LibraryWorkDetails
                entry={selectedRankingEntry}
                state={rankingState.library}
                rankIndex={rankingRankIndex}
                coverUrl={rankingCoverUrl}
                onEdit={() => openRankingEdit(selectedRankingEntry)}
                onDelete={() => {
                  if (!window.confirm(t("library.ui.confirmMoveToTrash", { title: selectedRankingEntry.title }))) return;
                  void deleteLibraryEntry(selectedRankingEntry.id).then(() => {
                    return refreshRanking();
                  }).then(() => {
                    setSelectedRankingEntryId(null);
                    updateWorkspace({ ...workspaceRef.current!, detailsOpen: false });
                  }).catch((error) => setSaveError(bridge.errorMessage(error)));
                }}
              />
            ) : (
              <div className="library-details-empty">
                <BookOpen size={27} strokeWidth={1.2} />
                <h2>{t("library.ui.collectionAtGlance")}</h2>
                <p>{t("library.ui.selectWorkDetails")}</p>
              </div>
            )}
          </LibraryDetailsPanel>
        )}
        {workspace.detailsOpen && !hideSidebars && activeSection !== "library" && activeSection !== "ranking" && (
          <aside
            className="details-shell"
            style={{ width: detailsWidth }}
            aria-label={t("app.detailsPanel")}
          >
            <div
              className="resize-handle"
              role="separator"
              aria-label={t("app.resizeDetailsPanel")}
              aria-orientation="vertical"
              aria-valuemin={240}
              aria-valuemax={440}
              aria-valuenow={detailsWidth}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const width = Math.max(
                    240,
                    Math.min(
                      440,
                      detailsWidth + (e.key === "ArrowLeft" ? 10 : -10),
                    ),
                  );
                  setDetailsWidth(width);
                  updateWorkspace({ ...workspace, detailsWidth: width });
                }
              }}
              onPointerDown={(e) => {
                const handle = e.currentTarget,
                  start = e.clientX,
                  width = detailsWidth;
                handle.setPointerCapture(e.pointerId);
                let next = width;
                const move = (event: PointerEvent) => {
                  next = Math.max(
                    240,
                    Math.min(440, width + start - event.clientX),
                  );
                  setDetailsWidth(next);
                };
                const up = () => {
                  handle.removeEventListener("pointermove", move);
                  handle.removeEventListener("pointerup", up);
                  updateWorkspace({
                    ...workspaceRef.current!,
                    detailsWidth: next,
                  });
                };
                handle.addEventListener("pointermove", move);
                handle.addEventListener("pointerup", up, { once: true });
              }}
            />
            <header>
              <span>{t("app.detailsPanel")}</span>
              <button
                className="icon-button"
                aria-label={t("app.closeDetailsPanel")}
                onClick={() =>
                  updateWorkspace({ ...workspace, detailsOpen: false })
                }
              >
                <X size={16} />
              </button>
            </header>
            <div className="details-empty">
              <PanelRight size={29} strokeWidth={1} />
              <h3>{t("app.emptyPanel")}</h3>
              <p>{t("app.emptyPanelBody")}</p>
            </div>
          </aside>
        )}
      </div>
      {rankingEditorEntry && libraryState && (
        <LibraryEntryEditor
          key={rankingEditorEntry.id}
          entry={rankingEditorEntry}
          state={libraryState}
          isNew={rankingEditorIsNew}
          busy={rankingEditorBusy}
          error={rankingEditorError}
          hasCoverStorage
          onCancel={() => setRankingEditorEntry(null)}
          onSave={(entry, coverFile) => void saveRankingEditor(entry, coverFile)}
          onCreateTag={createLibraryTag}
        />
      )}
    </div>
  );
}
