import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  CatalogCapability,
  CatalogSearchRequest,
  CatalogSearchResponse,
  ProviderCredentialInput,
  ProviderCredentialState,
} from "./catalogTypes";

const native = isTauri();

/**
 * Provider credentials are sent only to the desktop's in-memory Rust session.
 * This bridge deliberately has no browser-preview/localStorage fallback.
 */
export function configureProviderCredentials(
  input: ProviderCredentialInput,
): Promise<ProviderCredentialState> {
  if (!native) {
    return Promise.reject(
      new Error("Provider credentials can only be configured in the desktop app."),
    );
  }
  return invoke<ProviderCredentialState>("configure_provider_credentials", {
    input,
  });
}

export function catalogCapabilities(): Promise<CatalogCapability[]> {
  if (!native) {
    return Promise.resolve([
      {
        provider: "tmdb",
        label: "TMDb",
        enabled: false,
        configured: false,
        reason: "Catalog search is available in the desktop app.",
        mediaTypeIds: ["films", "tv-series", "anime"],
        termsUrl: "https://www.themoviedb.org/api-terms-of-use",
        attributionText:
          "This product uses the TMDB API but is not endorsed or certified by TMDB.",
      },
      {
        provider: "openLibrary",
        label: "Open Library",
        enabled: false,
        configured: false,
        reason: "Catalog search is available in the desktop app.",
        mediaTypeIds: ["literature", "comic"],
        termsUrl: "https://openlibrary.org/developers/api",
        attributionText: "Open Library",
      },
      {
        provider: "googleBooks",
        label: "Google Books",
        enabled: false,
        configured: false,
        reason: "Catalog search is available in the desktop app.",
        mediaTypeIds: ["literature", "comic"],
        termsUrl: "https://developers.google.com/books/terms",
        attributionText: "Google Books",
      },
      {
        provider: "igdb",
        label: "IGDB",
        enabled: false,
        configured: false,
        reason: "Catalog search is available in the desktop app.",
        mediaTypeIds: ["games"],
        termsUrl: "https://www.igdb.com/api",
        attributionText: "IGDB",
      },
      {
        provider: "steam",
        label: "Steam",
        enabled: false,
        configured: false,
        reason: "Steam catalog search is not available; owned-games import is separate.",
        mediaTypeIds: ["games"],
        termsUrl: "https://steamcommunity.com/dev/apiterms",
        attributionText: "Steam",
      },
    ]);
  }
  return invoke<CatalogCapability[]>("catalog_capabilities");
}

/**
 * Search is an explicit user action. The desktop backend talks to fixed,
 * provider-owned HTTPS endpoints and returns only the requested result page.
 */
export function searchCatalog(
  input: CatalogSearchRequest,
): Promise<CatalogSearchResponse> {
  if (!native) {
    return Promise.reject(
      new Error("Catalog search is available only in the desktop app."),
    );
  }
  return invoke<CatalogSearchResponse>("search_catalog", { input });
}
