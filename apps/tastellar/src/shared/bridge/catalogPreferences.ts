import type { CatalogCapability, CatalogProvider } from "./catalogTypes";

const LAST_PROVIDER_KEY = "tastellar.catalog.lastProvider";

function readLastCatalogProvider(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROVIDER_KEY);
  } catch {
    return null;
  }
}

export function rememberCatalogProvider(provider: string): void {
  try {
    window.localStorage.setItem(LAST_PROVIDER_KEY, provider);
  } catch {
    // The preference is optional when storage is unavailable.
  }
}

export function catalogProviderSupportsMediaType(
  capability: CatalogCapability,
  mediaTypeId?: string | null,
): boolean {
  return !mediaTypeId || capability.mediaTypeIds.includes(mediaTypeId);
}

export function enabledCatalogProviders(
  capabilities: CatalogCapability[],
  mediaTypeId?: string | null,
): CatalogCapability[] {
  return capabilities.filter(
    (item) =>
      item.enabled &&
      item.provider !== "steam" &&
      catalogProviderSupportsMediaType(item, mediaTypeId),
  );
}

export function preferredCatalogProvider(
  capabilities: CatalogCapability[],
  mediaTypeId?: string | null,
  currentProvider?: string | null,
): CatalogProvider | "" {
  const eligible = enabledCatalogProviders(capabilities, mediaTypeId);
  if (!eligible.length) return "";
  const last = readLastCatalogProvider();
  const preferred = [currentProvider, last].find((provider) =>
    eligible.some((item) => item.provider === provider),
  );
  const provider = eligible.find((item) => item.provider === preferred)?.provider ?? eligible[0].provider;
  return provider;
}
