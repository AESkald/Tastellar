export type CatalogProvider =
  | "tmdb"
  | "openLibrary"
  | "googleBooks"
  | "igdb"
  | "steam";

export interface CatalogCapability {
  provider: CatalogProvider;
  label: string;
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  mediaTypeIds: string[];
  termsUrl: string | null;
  attributionText: string | null;
}

export interface CatalogIdentity {
  provider: string;
  entityKind: string;
  externalId: string;
  sourceUrl: string | null;
}

export interface CatalogSearchResult {
  provider: CatalogProvider;
  id: string;
  mediaType: string;
  title: string;
  originalTitle: string | null;
  creators: string[];
  year: number | null;
  suggestedMediaTypeId: string | null;
  identities: CatalogIdentity[];
  coverUrl: string | null;
  coverMode: "none" | "transient" | "persistReference";
  coverProvider: CatalogProvider | null;
  remoteCover: CatalogRemoteCover | null;
  attribution: string | null;
  sourceUrl: string | null;
}

export interface CatalogRemoteCover {
  /** Lowercase value required by the persisted remote-cover validator. */
  provider: string;
  url: string;
  sourceUrl: string | null;
  attribution: string | null;
}

export interface CatalogSearchRequest {
  query: string;
  mediaTypeId: string | null;
  providers: string[];
  year: number | null;
  /** Opaque cursor returned by `searchCatalog`; do not interpret or persist it. */
  page: string | null;
  /** Optional namespaced ID lookup, currently used for IMDb → TMDb find. */
  externalId?: string | null;
  externalIdProvider?: string | null;
}

export interface CatalogSearchResponse {
  results: CatalogSearchResult[];
  nextPage: string | null;
  warnings?: string[];
}

export type ProviderCredentialInput =
  | { provider: "tmdb"; apiKey: string; clear?: false }
  | {
      provider: "steam";
      apiKey: string;
      steamId64?: string;
      clear?: false;
    }
  | {
      provider: "igdb";
      clientId: string;
      clientSecret: string;
      clear?: false;
    }
  | { provider: "googleBooks"; apiKey: string; clear?: false }
  | {
      provider: CatalogProvider;
      clear: true;
      apiKey?: never;
      steamId64?: never;
      clientId?: never;
      clientSecret?: never;
    };

export interface ProviderCredentialState {
  provider: CatalogProvider;
  configured: boolean;
  sessionOnly: false;
}
