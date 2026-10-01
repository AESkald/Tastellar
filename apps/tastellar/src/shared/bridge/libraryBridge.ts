import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  CriterionDraft,
  EntryDraft,
  LibraryState,
  MediaTypeDraft,
  MediaTypeIconKey,
  Tag,
} from "./libraryTypes";
import { localizedErrorMessage } from "../ui/errorMessage";
import { t } from "../ui/i18n";
import {
  commitPreviewRevision,
  currentPreviewRevision,
} from "./previewRevision";

const native = isTauri();
const criteriaSeed = [
  ["plot", "Plot"],
  ["world", "World"],
  ["characters", "Characters"],
  ["audiovisual", "Audiovisual presentation"],
  ["atmosphere", "Atmosphere"],
  ["gameplay", "Gameplay"],
  ["direction", "Direction"],
  ["acting", "Acting"],
  ["animation", "Animation"],
  ["writing-style", "Writing style"],
  ["ideas-message", "Ideas/Message"],
] as const;
const mediaSeed: ReadonlyArray<
  readonly [string, string, readonly string[], MediaTypeIconKey]
> = [
  [
    "literature",
    "Literature",
    ["plot", "world", "characters", "atmosphere", "writing-style", "ideas-message"],
    "book-open",
  ],
  [
    "anime",
    "Animation",
    [
      "plot",
      "world",
      "characters",
      "audiovisual",
      "atmosphere",
      "direction",
      "animation",
      "ideas-message",
    ],
    "clapperboard",
  ],
  [
    "games",
    "Games",
    ["gameplay", "plot", "world", "characters", "audiovisual", "atmosphere", "ideas-message"],
    "gamepad-2",
  ],
  [
    "films",
    "Films",
    [
      "plot",
      "world",
      "characters",
      "audiovisual",
      "atmosphere",
      "direction",
      "acting",
      "ideas-message",
    ],
    "film",
  ],
  [
    "tv-series",
    "TV series",
    [
      "plot",
      "world",
      "characters",
      "audiovisual",
      "atmosphere",
      "direction",
      "acting",
      "ideas-message",
    ],
    "tv",
  ],
  [
    "comic",
    "Comic",
    [
      "plot",
      "world",
      "characters",
      "writing-style",
      "ideas-message",
    ],
    "messages-square",
  ],
];

function createPreviewState(revision: number): LibraryState {
  const now = new Date().toISOString();
  return {
    revision,
    entries: [],
    mediaTypes: mediaSeed.map(([id, name, criterionIds, iconKey], sortOrder) => ({
      id,
      name,
      sortOrder,
      iconKey,
      criterionIds: [...criterionIds],
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    criteria: criteriaSeed.map(([id, name], sortOrder) => ({
      id,
      name,
      description: null,
      sortOrder,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    tags: [],
  };
}

const PREVIEW_LIBRARY_KEY = "tastellar.preview.library.v1";

function readPreviewLibrary(): LibraryState {
  try {
    const stored = typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(PREVIEW_LIBRARY_KEY);
    if (stored) {
      const value = JSON.parse(stored) as LibraryState;
      if (Array.isArray(value.entries) && Array.isArray(value.mediaTypes) && Array.isArray(value.criteria) && Array.isArray(value.tags))
        return {
          ...value,
          revision: currentPreviewRevision(),
          entries: value.entries.map((entry, index) => ({
            ...entry,
            importOrder: entry.importOrder ?? index,
          })),
        };
    }
  } catch {
    // Use an empty preview if session storage is unavailable or malformed.
  }
  return createPreviewState(currentPreviewRevision());
}

function persistPreviewLibrary() {
  try {
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(PREVIEW_LIBRARY_KEY, JSON.stringify(preview));
  } catch {
    // Keep the in-memory preview usable when session storage is unavailable.
  }
}

let preview: LibraryState = readPreviewLibrary();
const previewCovers = new Map<string, string>();

export function resetPreview(revision: number) {
  preview = createPreviewState(revision);
  previewCovers.clear();
  persistPreviewLibrary();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function change(
  command: string,
  args: Record<string, unknown>,
  expectedRevision: number,
  update: () => void,
): Promise<LibraryState> {
  if (native) return invoke<LibraryState>(command, args);
  if (expectedRevision !== currentPreviewRevision()) {
    throw new Error(t("error.concurrentEdit"));
  }
  update();
  preview.revision = commitPreviewRevision(expectedRevision);
  persistPreviewLibrary();
  return clone(preview);
}

export function loadLibrary(): Promise<LibraryState> {
  if (native) return invoke<LibraryState>("load_library");
  preview.revision = currentPreviewRevision();
  persistPreviewLibrary();
  return Promise.resolve(clone(preview));
}

export function saveEntry(expectedRevision: number, entry: EntryDraft) {
  return change(
    "save_entry",
    { expectedRevision, entry },
    expectedRevision,
    () => {
      const now = new Date().toISOString();
      const previous = preview.entries.find((item) => item.id === entry.id);
      const criterionRatings = { ...(previous?.criterionRatings ?? {}) };
      for (const [id, score] of Object.entries(entry.criterionRatings)) {
        if (score == null) delete criterionRatings[id];
        else criterionRatings[id] = score;
      }
      const next = {
        ...clone(entry),
        criterionRatings,
        importOrder:
          previous?.importOrder ??
          Math.max(-1, ...preview.entries.map((item) => item.importOrder ?? -1)) +
            1,
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      if (previous)
        preview.entries = preview.entries.map((item) =>
          item.id === entry.id ? next : item,
        );
      else preview.entries = [...preview.entries, next];
    },
  );
}

export function deleteEntry(expectedRevision: number, entryId: string) {
  return change(
    "delete_entry",
    { expectedRevision, entryId },
    expectedRevision,
    () => {
      preview.entries = preview.entries.filter((entry) => entry.id !== entryId);
    },
  );
}

export function saveMediaType(
  expectedRevision: number,
  mediaType: MediaTypeDraft,
) {
  return change(
    "save_media_type",
    { expectedRevision, mediaType },
    expectedRevision,
    () => {
      const now = new Date().toISOString();
      const previous = preview.mediaTypes.find(
        (item) => item.id === mediaType.id,
      );
      const next = {
        ...clone(mediaType),
        archivedAt: null,
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const index = preview.mediaTypes.findIndex(
        (item) => item.id === mediaType.id,
      );
      if (index < 0) preview.mediaTypes = [...preview.mediaTypes, next];
      else
        preview.mediaTypes = preview.mediaTypes.map((item) =>
          item.id === mediaType.id ? next : item,
        );
    },
  );
}

export function archiveMediaType(
  expectedRevision: number,
  typeId: string,
  confirmClearEntries = false,
) {
  return change(
    "archive_media_type",
    { expectedRevision, typeId, confirmClearEntries },
    expectedRevision,
    () => {
      const now = new Date().toISOString();
      preview.mediaTypes = preview.mediaTypes.map((item) =>
        item.id === typeId
          ? {
              ...item,
              archivedAt: now,
              updatedAt: now,
              version: item.version + 1,
            }
          : item,
      );
      preview.entries = preview.entries.map((entry) =>
        entry.mediaTypeId === typeId
          ? {
              ...entry,
              mediaTypeId: null,
              version: entry.version + 1,
              updatedAt: now,
            }
          : entry,
      );
    },
  );
}

export function saveCriterion(
  expectedRevision: number,
  criterion: CriterionDraft,
) {
  return change(
    "save_criterion",
    { expectedRevision, criterion },
    expectedRevision,
    () => {
      const now = new Date().toISOString();
      const previous = preview.criteria.find(
        (item) => item.id === criterion.id,
      );
      const next = {
        ...clone(criterion),
        archivedAt: null,
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const index = preview.criteria.findIndex(
        (item) => item.id === criterion.id,
      );
      if (index < 0) preview.criteria = [...preview.criteria, next];
      else
        preview.criteria = preview.criteria.map((item) =>
          item.id === criterion.id ? next : item,
        );
    },
  );
}

export function archiveCriterion(
  expectedRevision: number,
  criterionId: string,
  confirmRemoveFromTypes = false,
) {
  return change(
    "archive_criterion",
    { expectedRevision, criterionId, confirmRemoveFromTypes },
    expectedRevision,
    () => {
      const now = new Date().toISOString();
      preview.criteria = preview.criteria.map((item) =>
        item.id === criterionId
          ? {
              ...item,
              archivedAt: now,
              updatedAt: now,
              version: item.version + 1,
            }
          : item,
      );
      preview.mediaTypes = preview.mediaTypes.map((item) => ({
        ...item,
        criterionIds: item.archivedAt
          ? item.criterionIds
          : item.criterionIds.filter((id) => id !== criterionId),
      }));
    },
  );
}

export function saveTag(
  expectedRevision: number,
  tag: { id: string; name: string },
): Promise<LibraryState>;
export function saveTag(
  expectedRevision: number,
  id: string,
  name: string,
): Promise<LibraryState>;
export function saveTag(
  expectedRevision: number,
  tagOrId: { id: string; name: string } | string,
  maybeName?: string,
) {
  const tag =
    typeof tagOrId === "string"
      ? { id: tagOrId, name: maybeName ?? "" }
      : tagOrId;
  return change("save_tag", { expectedRevision, tag }, expectedRevision, () => {
    const now = new Date().toISOString();
    const previous = preview.tags.find((item) => item.id === tag.id);
    const next: Tag = {
      ...tag,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      version: (previous?.version ?? 0) + 1,
    };
    if (previous)
      preview.tags = preview.tags.map((item) =>
        item.id === tag.id ? next : item,
      );
    else preview.tags = [...preview.tags, next];
  });
}

export function mergeTags(
  expectedRevision: number,
  sourceId: string,
  targetId: string,
) {
  return change(
    "merge_tags",
    { expectedRevision, sourceId, targetId },
    expectedRevision,
    () => {
      preview.entries = preview.entries.map((entry) =>
        entry.tagIds.includes(sourceId)
          ? {
              ...entry,
              tagIds: [
                ...new Set([
                  ...entry.tagIds.filter((id) => id !== sourceId),
                  targetId,
                ]),
              ],
            }
          : entry,
      );
      preview.tags = preview.tags.filter((tag) => tag.id !== sourceId);
    },
  );
}

export function deleteTag(expectedRevision: number, tagId: string) {
  return change(
    "delete_tag",
    { expectedRevision, tagId },
    expectedRevision,
    () => {
      preview.tags = preview.tags.filter((tag) => tag.id !== tagId);
      preview.entries = preview.entries.map((entry) => ({
        ...entry,
        tagIds: entry.tagIds.filter((id) => id !== tagId),
      }));
    },
  );
}

export function saveEntryCover(
  expectedRevision: number,
  entryId: string,
  mimeType: string,
  base64: string,
) {
  return change(
    "save_entry_cover",
    { expectedRevision, entryId, mimeType, base64 },
    expectedRevision,
    () => {
      const now = new Date().toISOString();
      previewCovers.set(entryId, `data:${mimeType};base64,${base64}`);
      preview.entries = preview.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              coverAssetId: `preview:${entryId}`,
              updatedAt: now,
              version: entry.version + 1,
            }
          : entry,
      );
    },
  );
}

export function loadEntryCover(entryId: string): Promise<string | null> {
  return native
    ? invoke<string | null>("load_entry_cover", { entryId })
    : Promise.resolve(previewCovers.get(entryId) ?? null);
}

export function errorMessage(error: unknown): string {
  return localizedErrorMessage(error, "error.libraryFallback");
}
