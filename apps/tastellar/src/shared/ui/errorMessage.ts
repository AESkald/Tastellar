import { t } from "./i18n";

const errorKeys: Record<string, string> = {
  Validation: "error.validation",
  Conflict: "error.concurrentEdit",
  UnsupportedVersion: "error.unsupportedVersion",
  AssetUnavailable: "error.assetUnavailable",
  PermissionDenied: "error.permissionDenied",
  DiskFull: "error.diskFull",
  ResetCommittedCleanupPending: "error.resetCleanupPending",
  Internal: "error.internal",
};

function payload(error: unknown): unknown {
  if (typeof error === "object" && error && "code" in error) return error;
  if (error instanceof Error) {
    try {
      return JSON.parse(error.message);
    } catch {
      return error.message;
    }
  }
  if (typeof error === "string") {
    try {
      return JSON.parse(error);
    } catch {
      return error;
    }
  }
  return error;
}

export function localizedErrorMessage(
  error: unknown,
  fallbackKey:
    | "error.homeFallback"
    | "error.libraryFallback"
    | "error.archiveFallback",
): string {
  const value = payload(error);
  if (typeof value === "object" && value && "code" in value) {
    const key = errorKeys[String(value.code)];
    if (key) return t(key);
  }
  if (typeof value === "object" && value && "message" in value) {
    const message = value.message;
    if (typeof message === "string" && message) return message;
  }
  if (typeof value === "string" && value) return value;
  return t(fallbackKey);
}
