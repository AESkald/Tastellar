export type Section =
  "home" | "library" | "ranking" | "analytics" | "recap" | "settings";
export type Theme = "system" | "light" | "dark" | "dusk" | "forest" | "reading";
export interface Preferences {
  theme: Theme;
  textScale: number;
  reducedMotion: "system" | "on" | "off";
  graphics: "auto" | "low" | "medium" | "high" | "off";
  restoreTabs: boolean;
  startupSection: Section;
  previousTabShortcut: string;
  nextTabShortcut: string;
  radarMode: "explicit" | "derived";
  visibleCriteria: string[];
}
export interface WorkspaceTab {
  id: string;
  section: Section;
  title: string;
  scrollTop: number;
  libraryView?: LibraryViewSnapshot | null;
}
export interface LibraryViewFilters {
  mediaTypes: string[];
  tags: string[];
  tagMode: "any" | "all";
  minYear: string;
  maxYear: string;
  cover: "any" | "has" | "missing";
  criteriaComplete: boolean;
}
export interface LibraryViewSnapshot {
  activeGroupId: string;
  selectedEntryId: string | null;
  listMode: "covers" | "compact" | "table";
  searchText: string;
  includeReviewSearch: boolean;
  includeTagSearch: boolean;
  withinCurrentFilters: boolean;
  filters: LibraryViewFilters;
  tableColumns: string[];
  tableSort: "rank" | "title" | "year";
  panelMode: "details" | "filters" | "transfer";
  scrollTop: number;
}
export interface Workspace {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  railCollapsed: boolean;
  detailsOpen: boolean;
  detailsWidth: number;
  folderOpen: boolean;
}
export interface HomeState {
  version: number;
  profile: {
    nickname: string;
    statedTastes: string;
    avatarAssetId: string | null;
  };
  guidelines: Record<string, string>;
  tasteInputs: Record<string, number>;
  preferences: Preferences;
  workspace: Workspace;
}
export type HomePatch = Pick<
  HomeState,
  "profile" | "guidelines" | "tasteInputs"
>;
export const initialState = (): HomeState => ({
  version: 0,
  profile: { nickname: "", statedTastes: "", avatarAssetId: null },
  guidelines: Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [String(i + 1), ""]),
  ),
  tasteInputs: {},
  preferences: {
    theme: "dark",
    textScale: 1,
    reducedMotion: "system",
    graphics: "auto",
    restoreTabs: true,
    startupSection: "home",
    previousTabShortcut: "Alt+ArrowLeft",
    nextTabShortcut: "Alt+ArrowRight",
    radarMode: "explicit",
    visibleCriteria: [],
  },
  workspace: {
    tabs: [
      { id: "home-initial", section: "home", title: "Home", scrollTop: 0 },
    ],
    activeTabId: "home-initial",
    railCollapsed: true,
    detailsOpen: false,
    detailsWidth: 320,
    folderOpen: true,
  },
});
