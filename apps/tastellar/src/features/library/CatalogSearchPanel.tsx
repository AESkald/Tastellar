import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { MediaType } from "../../shared/bridge/libraryTypes";
import type {
  CatalogCapability,
  CatalogSearchResult,
} from "../../shared/bridge/catalogTypes";
import { searchCatalog } from "../../shared/bridge/catalogBridge";
import { SelectControl } from "../../shared/ui/SelectControl";
import { ExternalLink } from "../../shared/ui/ExternalLink";
import { t } from "../../shared/ui/i18n";
import {
  enabledCatalogProviders,
  preferredCatalogProvider,
  rememberCatalogProvider,
} from "../../shared/bridge/catalogPreferences";
import "./catalog-search.css";

function CatalogResultCover({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  if (!url || failed) return <span aria-hidden="true">✦</span>;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function CatalogSearchPanel({
  mediaTypes,
  initialQuery,
  initialYear,
  initialExternalId,
  initialExternalIdProvider,
  initialMediaTypeId,
  capabilities,
  onSelect,
}: {
  mediaTypes: MediaType[];
  initialQuery: string;
  initialYear?: number | null;
  initialExternalId?: string | null;
  initialExternalIdProvider?: string | null;
  initialMediaTypeId?: string | null;
  capabilities: CatalogCapability[];
  onSelect: (result: CatalogSearchResult) => void;
  onCapabilitiesChange?: (capabilities: CatalogCapability[]) => void;
}) {
  const [providerCapabilities, setProviderCapabilities] =
    useState(capabilities);
  useEffect(() => setProviderCapabilities(capabilities), [capabilities]);
  const [query, setQuery] = useState(initialQuery);
  const queryEdited = useRef(false);
  const [mediaTypeId, setMediaTypeId] = useState(initialMediaTypeId ?? "");
  const [provider, setProvider] = useState<string>(() =>
    preferredCatalogProvider(capabilities, initialMediaTypeId),
  );
  const mediaTypeEdited = useRef(false);
  const [year, setYear] = useState(initialYear ? String(initialYear) : "");
  const [started, setStarted] = useState(false);
  const [useExternalId, setUseExternalId] = useState(
    Boolean(initialExternalId),
  );
  const [searchVersion, setSearchVersion] = useState(0);
  const [page, setPage] = useState<string | null>(null);
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  const requestId = useRef(0);
  const enabledProviders = enabledCatalogProviders(
    providerCapabilities,
    mediaTypeId,
  );
  const selectedCapability = providerCapabilities.find(
    (item) => item.provider === provider,
  );
  const visibleMediaTypes = selectedCapability
    ? mediaTypes.filter(
        (item) =>
          !item.archivedAt && selectedCapability.mediaTypeIds.includes(item.id),
      )
    : mediaTypes.filter((item) => !item.archivedAt);
  useEffect(() => {
    const nextProvider = preferredCatalogProvider(
      providerCapabilities,
      mediaTypeId,
      provider,
    );
    if (nextProvider === provider) return;
    setProvider(nextProvider);
    if (nextProvider) rememberCatalogProvider(nextProvider);
    setPage(null);
    setResults([]);
    setNextPage(null);
  }, [providerCapabilities, mediaTypeId, provider]);
  useEffect(() => {
    if (!queryEdited.current) setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    if (!mediaTypeEdited.current) setMediaTypeId(initialMediaTypeId ?? "");
  }, [initialMediaTypeId]);
  const providers = provider ? [provider] : [];
  const parsedYear = /^\d{4}$/.test(year) ? Number(year) : null;

  useEffect(() => {
    const id = ++requestId.current;
    if (
      !started ||
      (query.trim().length < 2 && !useExternalId) ||
      !providers.length
    ) {
      setResults([]);
      setNextPage(null);
      setBusy(false);
      setLoadingMore(false);
      setWarnings([]);
      return;
    }
    const timer = window.setTimeout(
      () => {
        setBusy(true);
        setLoadingMore(Boolean(page));
        setError("");
        void searchCatalog({
          query: query.trim(),
          mediaTypeId: mediaTypeId || null,
          providers,
          year: parsedYear,
          page,
          ...(useExternalId && initialExternalId
            ? {
                externalId: initialExternalId,
                externalIdProvider: initialExternalIdProvider ?? null,
              }
            : {}),
        })
          .then((response) => {
            if (requestId.current !== id) return;
            setResults((current) => {
              const incoming = page
                ? [...current, ...response.results]
                : response.results;
              const seen = new Set<string>();
              return incoming.filter((result) => {
                const key = `${result.provider}:${result.mediaType}:${result.id}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
            });
            setNextPage(response.nextPage);
            setWarnings((current) =>
              page
                ? [...new Set([...current, ...(response.warnings ?? [])])]
                : (response.warnings ?? []),
            );
          })
          .catch(() => {
            if (requestId.current === id)
              setError(t("library.catalog.searchFailed"));
          })
          .finally(() => {
            if (requestId.current === id) {
              setBusy(false);
              setLoadingMore(false);
            }
          });
      },
      page ? 0 : 280,
    );
    return () => window.clearTimeout(timer);
  }, [
    started,
    useExternalId,
    searchVersion,
    query,
    provider,
    mediaTypeId,
    year,
    parsedYear,
    page,
    initialExternalId,
    initialExternalIdProvider,
  ]);

  const runSearch = () => {
    const value = query.trim();
    if ((value.length < 2 && !useExternalId) || !providers.length) return;
    queryEdited.current = true;
    setStarted(true);
    setSearchVersion((version) => version + 1);
    setPage(null);
    setResults([]);
    setNextPage(null);
    setWarnings([]);
  };

  const handleQueryChange = (value: string) => {
    queryEdited.current = true;
    setQuery(value);
    setUseExternalId(false);
    setPage(null);
    if (started) {
      setResults([]);
      setNextPage(null);
      setWarnings([]);
    }
  };

  return (
    <section
      className="catalog-search-panel"
      aria-label={t("library.catalog.searchLabel")}
    >
      <form
        className="catalog-search-controls"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <label className="field catalog-search-query">
          <span>{t("library.catalog.query")}</span>
          <input
            data-testid="catalog-search-input"
            type="search"
            minLength={useExternalId ? 0 : 2}
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder={t("library.catalog.queryPlaceholder")}
          />
        </label>
        <div className="catalog-search-filters">
          <label className="field">
            <span>{t("library.catalog.source")}</span>
            <SelectControl
              value={provider}
              onValueChange={(value) => {
                setProvider(value);
                rememberCatalogProvider(value);
                setPage(null);
                setResults([]);
                setNextPage(null);
              }}
              data-testid="catalog-provider-filter"
            >
              {!enabledProviders.some((item) => item.provider === provider) && (
                <option value="">{t("library.catalog.noProviderReady")}</option>
              )}
              {enabledProviders.map((item) => (
                <option key={item.provider} value={item.provider}>
                  {item.label}
                </option>
              ))}
            </SelectControl>
          </label>
          <label className="field">
            <span>{t("library.catalog.mediaType")}</span>
            <SelectControl
              value={mediaTypeId}
              onValueChange={(value) => {
                mediaTypeEdited.current = true;
                setMediaTypeId(value);
                setPage(null);
                setResults([]);
              }}
            >
              <option value="">{t("library.catalog.allMediaTypes")}</option>
              {visibleMediaTypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectControl>
          </label>
          <label className="field catalog-year-field">
            <span>{t("library.catalog.year")}</span>
            <input
              inputMode="numeric"
              maxLength={4}
              value={year}
              onChange={(event) => {
                setYear(event.target.value.replace(/\D/g, "").slice(0, 4));
                setPage(null);
                setResults([]);
              }}
              placeholder="—"
            />
          </label>
        </div>
        <button
          type="submit"
          className="button primary"
          disabled={
            (query.trim().length < 2 && !useExternalId) ||
            !providers.length ||
            busy
          }
        >
          <Search size={14} />{" "}
          {busy && !loadingMore
            ? t("library.catalog.searching")
            : t("library.catalog.search")}
        </button>
      </form>

      {providerCapabilities.length > 0 && (
        <div className="catalog-provider-disclosure">
          <button
            type="button"
            className="text-button"
            onClick={() => setShowProviders((value) => !value)}
            aria-expanded={showProviders}
          >
            {showProviders ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
            {t("library.catalog.providersAndPrivacy")}
          </button>
          {showProviders && (
            <ul>
              {providerCapabilities.map((item) => (
                <li key={item.provider}>
                  <strong>{item.label}</strong>
                  <span>
                    {item.enabled
                      ? t("library.catalog.providerReady")
                      : item.reason || t("library.catalog.providerUnavailable")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p>{t("library.catalog.queryPrivacy")}</p>
        </div>
      )}

      {!enabledProviders.length ? (
        <p className="catalog-search-empty">
          {t("library.catalog.noProviderReady")}
        </p>
      ) : !started ? (
        <p className="catalog-search-empty">
          {t("library.catalog.searchHint")}
        </p>
      ) : busy && !results.length ? (
        <p className="catalog-search-empty" role="status">
          {t("library.catalog.searching")}
        </p>
      ) : error && !results.length ? (
        <p className="catalog-search-empty" role="alert">
          {error}
        </p>
      ) : results.length ? (
        <>
          {warnings.length > 0 && (
            <p className="catalog-search-warning" role="status">
              {t("library.catalog.partialResults")}
            </p>
          )}
          {error && (
            <p className="catalog-search-warning" role="alert">
              {error}
            </p>
          )}
          <div className="catalog-result-list" aria-live="polite">
            {results.map((result) => {
              const key = `${result.provider}:${result.mediaType}:${result.id}`;
              const capability = providerCapabilities.find(
                (item) => item.provider === result.provider,
              );
              return (
                <article
                  key={key}
                  className={`catalog-result-card ${selectedResult === key ? "selected" : ""}`}
                  data-testid={`catalog-result-${result.provider}-${result.id}`}
                >
                  <div className="catalog-result-cover">
                    <CatalogResultCover
                      url={result.coverMode !== "none" ? result.coverUrl : null}
                    />
                  </div>
                  <div className="catalog-result-copy">
                    <strong>{result.title}</strong>
                    {result.originalTitle &&
                      result.originalTitle !== result.title && (
                        <span>{result.originalTitle}</span>
                      )}
                    <small>
                      {[
                        result.year,
                        result.mediaType,
                        result.creators.join(", "),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    <small className="catalog-result-source">
                      {capability?.label ?? result.provider}
                    </small>
                    {result.coverUrl && (
                      <small>
                        {result.coverMode === "persistReference"
                          ? t("library.catalog.coverCanBeSelected")
                          : t("library.catalog.coverPreviewOnly")}
                      </small>
                    )}
                  </div>
                  <div className="catalog-result-actions">
                    {result.sourceUrl && (
                      <ExternalLink
                        href={result.sourceUrl}
                        aria-label={t("library.catalog.openSource", {
                          provider: capability?.label ?? result.provider,
                        })}
                      >
                        <ArrowUpRight size={14} />
                      </ExternalLink>
                    )}
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        setSelectedResult(key);
                        onSelect(result);
                      }}
                    >
                      {t("library.catalog.useDetails")}
                    </button>
                  </div>
                </article>
              );
            })}
            {nextPage && (
              <button
                data-testid="catalog-load-more"
                type="button"
                className="button secondary catalog-load-more"
                onClick={() => setPage(nextPage)}
                disabled={busy}
              >
                {loadingMore
                  ? t("library.catalog.loadingMore")
                  : t("library.catalog.loadMore")}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="catalog-search-empty">{t("library.catalog.noResults")}</p>
      )}
    </section>
  );
}
