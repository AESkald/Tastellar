import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  initialState,
  type HomeState,
  type HomePatch,
  type Preferences,
  type Workspace,
} from "./types";
import {
  commitPreviewRevision,
  currentPreviewRevision,
} from "./previewRevision";
import { localizedErrorMessage } from "../ui/errorMessage";
import { t } from "../ui/i18n";
import { loadLibrary, resetPreview as resetLibraryPreview } from "./libraryBridge";
import type { LibraryState } from "./libraryTypes";

export interface WorkspaceResetResult {
  home: HomeState;
  library: LibraryState;
}
export const native = isTauri();
// A deliberately ephemeral preview adapter. Production records live only in SQLite.
let previewState = initialState();
let previewAvatar: string | null = null;
export async function loadHome(): Promise<HomeState> {
  if (native) return invoke("load_home");
  previewState.version = currentPreviewRevision();
  return structuredClone(previewState);
}
async function mutation(
  command: string,
  args: Record<string, unknown>,
  update: () => void,
): Promise<HomeState> {
  if (native) return invoke(command, args);
  if (args.expectedVersion !== currentPreviewRevision())
    throw new Error(t("error.concurrentEdit"));
  update();
  previewState.version = commitPreviewRevision(Number(args.expectedVersion));
  return structuredClone(previewState);
}
export function saveHome(expectedVersion: number, patch: HomePatch) {
  return mutation("save_home", { expectedVersion, ...patch }, () => {
    Object.assign(previewState, structuredClone(patch));
  });
}
export function savePreferences(
  expectedVersion: number,
  preferences: Preferences,
) {
  return mutation("save_preferences", { expectedVersion, preferences }, () => {
    previewState.preferences = structuredClone(preferences);
  });
}
export function saveWorkspace(expectedVersion: number, workspace: Workspace) {
  return mutation("save_workspace", { expectedVersion, workspace }, () => {
    previewState.workspace = structuredClone(workspace);
  });
}
export async function resetWorkspace(
  expectedVersion: number,
): Promise<WorkspaceResetResult> {
  if (native)
    return invoke<WorkspaceResetResult>("reset_workspace", { expectedVersion });
  const home = await mutation("reset_workspace", { expectedVersion }, () => {
    previewState = initialState();
    previewAvatar = null;
  });
  resetLibraryPreview(home.version);
  const library = await loadLibrary();
  return { home, library };
}
export function saveAvatar(
  expectedVersion: number,
  mimeType: string,
  base64: string,
) {
  return mutation("save_avatar", { expectedVersion, mimeType, base64 }, () => {
    previewAvatar = `data:${mimeType};base64,${base64}`;
    previewState.profile.avatarAssetId = "preview-avatar";
  });
}
export function removeAvatar(expectedVersion: number) {
  return mutation("remove_avatar", { expectedVersion }, () => {
    previewAvatar = null;
    previewState.profile.avatarAssetId = null;
  });
}
export function loadAvatar(): Promise<string | null> {
  return native ? invoke("load_avatar") : Promise.resolve(previewAvatar);
}
export const exportLibraryArchive = (path: string): Promise<{ path: string }> =>
  invoke("export_library_archive", { path });
export const importLibraryArchive = (
  path: string,
  expectedVersion: number,
): Promise<HomeState> =>
  invoke("import_library_archive", { path, expectedVersion });
export function errorMessage(error: unknown): string {
  return localizedErrorMessage(error, "error.homeFallback");
}

export async function copyText(text: string): Promise<void> {
  if (native) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}
