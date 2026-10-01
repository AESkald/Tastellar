import { t } from "../ui/i18n";

const PREVIEW_REVISION_KEY = "tastellar.preview.revision.v1";

function readStoredRevision(): number {
  try {
    const stored = typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(PREVIEW_REVISION_KEY);
    const revision = stored === null ? 0 : Number(stored);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  } catch {
    return 0;
  }
}

function storeRevision(value: number) {
  try {
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(PREVIEW_REVISION_KEY, String(value));
  } catch {
    // Private browsing can disable session storage; the in-memory preview still works.
  }
}

let revision = readStoredRevision();

export function currentPreviewRevision(): number {
  return revision;
}

export function commitPreviewRevision(expectedRevision: number): number {
  if (expectedRevision !== revision) {
    throw new Error(t("error.concurrentEdit"));
  }
  revision += 1;
  storeRevision(revision);
  return revision;
}
