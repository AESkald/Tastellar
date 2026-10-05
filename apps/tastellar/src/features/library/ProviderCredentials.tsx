import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Eye, EyeOff, KeyRound } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { ExternalLink } from "../../shared/ui/ExternalLink";
import {
  announceCatalogCapabilitiesChanged,
  catalogCapabilities,
  configureProviderCredentials,
} from "../../shared/bridge/catalogBridge";
import type {
  CatalogCapability,
  CatalogProvider,
  ProviderCredentialInput,
} from "../../shared/bridge/catalogTypes";
import { t } from "../../shared/ui/i18n";
import "./provider-credentials.css";

type CredentialProvider = Exclude<CatalogProvider, "openLibrary">;
type CredentialField = "apiKey" | "clientId" | "clientSecret";
type CredentialValues = Partial<Record<CredentialField, string>>;

const credentialProviders: Array<{
  provider: CredentialProvider;
  label: string;
  fields: Array<{
    key: CredentialField;
    label: string;
    secret: boolean;
    autoComplete: "off" | "new-password";
  }>;
  help: string;
  linkLabel: string;
  link: string;
  secondaryLinkLabel?: string;
  secondaryLink?: string;
}> = [
  {
    provider: "tmdb",
    label: "TMDb",
    fields: [
      {
        key: "apiKey",
        label: "library.catalog.tmdbToken",
        secret: true,
        autoComplete: "new-password",
      },
    ],
    help: "library.catalog.tmdbCredentialHelp",
    linkLabel: "library.catalog.tmdbCredentialLink",
    link: "https://www.themoviedb.org/settings/api",
  },
  {
    provider: "igdb",
    label: "IGDB",
    fields: [
      {
        key: "clientId",
        label: "library.catalog.igdbClientId",
        secret: true,
        autoComplete: "off",
      },
      {
        key: "clientSecret",
        label: "library.catalog.igdbClientSecret",
        secret: true,
        autoComplete: "new-password",
      },
    ],
    help: "library.catalog.igdbCredentialHelp",
    linkLabel: "library.catalog.igdbCredentialLink",
    link: "https://dev.twitch.tv/console/apps",
  },
  {
    provider: "googleBooks",
    label: "Google Books",
    fields: [
      {
        key: "apiKey",
        label: "library.catalog.googleBooksKey",
        secret: true,
        autoComplete: "new-password",
      },
    ],
    help: "library.catalog.googleBooksCredentialHelp",
    linkLabel: "library.catalog.googleBooksCredentialLink",
    link: "https://console.cloud.google.com/apis/credentials",
    secondaryLinkLabel: "library.catalog.googleBooksEnableLink",
    secondaryLink: "https://console.cloud.google.com/apis/library/books.googleapis.com",
  },
  {
    provider: "steam",
    label: "Steam",
    fields: [
      {
        key: "apiKey",
        label: "library.catalog.steamKey",
        secret: true,
        autoComplete: "new-password",
      },
    ],
    help: "library.catalog.steamCredentialHelp",
    linkLabel: "library.catalog.steamCredentialLink",
    link: "https://steamcommunity.com/dev/apikey",
  },
];

export function makeProviderCredentialInput(
  provider: CredentialProvider,
  values: CredentialValues,
): ProviderCredentialInput | null {
  if (provider === "igdb") {
    const clientId = values.clientId?.trim() ?? "";
    const clientSecret = values.clientSecret?.trim() ?? "";
    return clientId && clientSecret
      ? { provider, clientId, clientSecret }
      : null;
  }
  const apiKey = values.apiKey?.trim() ?? "";
  return apiKey ? { provider, apiKey } : null;
}

export function ProviderCredentials({
  capabilities,
  onCapabilitiesChange,
  initialProvider = "tmdb",
  buttonStyle = "text",
  buttonTestId = "provider-api-settings",
}: {
  capabilities: CatalogCapability[];
  onCapabilitiesChange?: (capabilities: CatalogCapability[]) => void;
  initialProvider?: CredentialProvider;
  buttonStyle?: "text" | "secondary";
  buttonTestId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] =
    useState<CredentialProvider>(initialProvider);

  return (
    <>
      <button
        type="button"
        className={
          buttonStyle === "secondary"
            ? "button secondary provider-api-settings-trigger"
            : "text-button provider-api-settings-trigger"
        }
        data-testid={buttonTestId}
        onClick={() => {
          setActiveProvider(initialProvider);
          setOpen(true);
        }}
      >
        <KeyRound size={14} /> {t("library.catalog.apiSettings")}
      </button>
      {open && (
        <ProviderCredentialsDialog
          capabilities={capabilities}
          onCapabilitiesChange={onCapabilitiesChange}
          initialProvider={activeProvider}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ProviderCredentialsDialog({
  capabilities,
  onCapabilitiesChange,
  initialProvider,
  onClose,
}: {
  capabilities: CatalogCapability[];
  onCapabilitiesChange?: (capabilities: CatalogCapability[]) => void;
  initialProvider: CredentialProvider;
  onClose: () => void;
}) {
  const [currentCapabilities, setCurrentCapabilities] = useState(capabilities);
  const [activeProvider, setActiveProvider] =
    useState<CredentialProvider>(initialProvider);
  const [values, setValues] = useState<Record<CredentialProvider, CredentialValues>>({
    tmdb: {},
    igdb: {},
    googleBooks: {},
    steam: {},
  });
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const desktop = isTauri();
  const onCapabilitiesChangeRef = useRef(onCapabilitiesChange);
  useEffect(() => {
    onCapabilitiesChangeRef.current = onCapabilitiesChange;
  }, [onCapabilitiesChange]);
  useEffect(() => {
    setCurrentCapabilities(capabilities);
  }, [capabilities]);

  const applyCapabilities = useCallback(
    (next: CatalogCapability[]) => {
      setCurrentCapabilities(next);
      onCapabilitiesChangeRef.current?.(next);
    },
    [],
  );

  const refreshCapabilities = useCallback(async () => {
    const next = await catalogCapabilities();
    applyCapabilities(next);
    return next;
  }, [applyCapabilities]);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void catalogCapabilities()
        .then((next) => {
          if (mounted) applyCapabilities(next);
        })
        .catch(() => undefined);
    };
    const handleChanged = (event: Event) => {
      const detail = (event as CustomEvent<CatalogCapability[]>).detail;
      if (Array.isArray(detail)) applyCapabilities(detail);
      else refresh();
    };
    refresh();
    window.addEventListener(
      "tastellar:catalog-capabilities-changed",
      handleChanged,
    );
    return () => {
      mounted = false;
      window.removeEventListener(
        "tastellar:catalog-capabilities-changed",
        handleChanged,
      );
    };
  }, [applyCapabilities]);

  const save = async (provider: CredentialProvider) => {
    const input = makeProviderCredentialInput(provider, values[provider]);
    if (!input) {
      setError(t("library.catalog.credentialsRequired"));
      setFeedback("");
      return;
    }
    if (!desktop) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await configureProviderCredentials(input);
      setValues((current) => ({ ...current, [provider]: {} }));
      setFeedback(t("library.catalog.credentialsStored"));
      try {
        const next = await refreshCapabilities();
        announceCatalogCapabilitiesChanged(next);
      } catch {
        setFeedback(t("library.catalog.credentialsStoredRefreshFailed"));
      }
    } catch {
      setError(t("library.catalog.credentialsFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: CredentialProvider) => {
    if (!desktop) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await configureProviderCredentials({ provider, clear: true });
      setValues((current) => ({ ...current, [provider]: {} }));
      setFeedback(t("library.catalog.credentialsRemoved"));
      try {
        const next = await refreshCapabilities();
        announceCatalogCapabilitiesChanged(next);
      } catch {
        setFeedback(t("library.catalog.credentialsRemovedRefreshFailed"));
      }
    } catch {
      setError(t("library.catalog.credentialsFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("library.catalog.apiSettings")}
      description={t("library.catalog.apiSettingsDescription")}
      onClose={onClose}
      busy={busy}
      className="provider-credentials-modal"
    >
      <div className="provider-credentials-body" data-testid="provider-credentials-modal">
        {!desktop && (
          <p className="provider-credentials-notice" role="status">
            {t("library.catalog.credentialsDesktopOnly")}
          </p>
        )}
        <div className="provider-credential-list" aria-label={t("library.catalog.apiProviders")}>
          {credentialProviders.map((provider) => {
            const configured = Boolean(
              currentCapabilities.find(
                (item) => item.provider === provider.provider,
              )?.configured,
            );
            const selected = activeProvider === provider.provider;
            const panelId = `provider-credential-panel-${provider.provider}`;
            return (
              <section
                key={provider.provider}
                className={`provider-credential-card${selected ? " active" : ""}`}
                data-testid={`provider-credential-card-${provider.provider}`}
              >
                <button
                  className="provider-credential-heading"
                  type="button"
                  aria-expanded={selected}
                  aria-controls={panelId}
                  onClick={() => {
                    setActiveProvider(provider.provider);
                    setError("");
                    setFeedback("");
                  }}
                >
                  <span>
                    {selected ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    <strong>{provider.label}</strong>
                  </span>
                  <small className={configured ? "configured" : "unconfigured"}>
                    {t(
                      configured
                        ? "library.catalog.credentialsSaved"
                        : "library.catalog.credentialsNotSet",
                    )}
                  </small>
                </button>
                {selected && (
                  <div
                    className="provider-credential-content"
                    id={panelId}
                    aria-label={provider.label}
                  >
                    <p>{t(provider.help)}</p>
                    <ExternalLink href={provider.link}>
                      {t(provider.linkLabel)} <span aria-hidden="true">↗</span>
                    </ExternalLink>
                    {provider.secondaryLink && provider.secondaryLinkLabel && (
                      <ExternalLink href={provider.secondaryLink}>
                        {t(provider.secondaryLinkLabel)} <span aria-hidden="true">↗</span>
                      </ExternalLink>
                    )}
                    <div className="provider-credential-fields">
                      {provider.fields.map((field) => {
                        const revealKey = `${provider.provider}-${field.key}`;
                        const visible = Boolean(revealed[revealKey]);
                        return (
                          <label
                            className="field provider-credential-field"
                            key={field.key}
                          >
                            <span>{t(field.label)}</span>
                            <span className="provider-credential-input-row">
                              <input
                                data-testid={`provider-credential-field-${provider.provider}-${field.key}`}
                                type={field.secret && !visible ? "password" : "text"}
                                value={values[provider.provider][field.key] ?? ""}
                                onChange={(event) => {
                                  setValues((current) => ({
                                    ...current,
                                    [provider.provider]: {
                                      ...current[provider.provider],
                                      [field.key]: event.target.value,
                                    },
                                  }));
                                  setError("");
                                  setFeedback("");
                                }}
                                autoComplete={field.autoComplete}
                                spellCheck={false}
                                maxLength={8192}
                                placeholder={
                                  configured
                                    ? t("library.catalog.replaceCredentialHint")
                                    : t("library.catalog.enterCredentialHint")
                                }
                                disabled={busy || !desktop}
                              />
                              {field.secret && (
                                <button
                                  type="button"
                                  className="provider-credential-reveal"
                                  data-testid={`provider-credential-reveal-${provider.provider}-${field.key}`}
                                  aria-label={t(
                                    visible
                                      ? "library.catalog.hideCredential"
                                      : "library.catalog.showCredential",
                                    { field: t(field.label) },
                                  )}
                                  aria-pressed={visible}
                                  onClick={() =>
                                    setRevealed((current) => ({
                                      ...current,
                                      [revealKey]: !current[revealKey],
                                    }))
                                  }
                                >
                                  {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {configured && (
                      <p className="provider-credential-saved-note">
                        {t("library.catalog.savedCredentialReplaceNote")}
                      </p>
                    )}
                    {error && selected && (
                      <p className="error-message" role="alert">{error}</p>
                    )}
                    {feedback && selected && (
                      <p className="success-message" role="status">{feedback}</p>
                    )}
                    <div className="provider-credential-actions">
                      {configured && (
                        <button
                          type="button"
                          className="text-button danger-link"
                          data-testid="provider-credential-remove"
                          disabled={busy || !desktop}
                          onClick={() => void remove(provider.provider)}
                        >
                          {t("library.catalog.removeCredentials")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="button primary"
                        data-testid="provider-credential-save"
                        disabled={
                          busy ||
                          !desktop ||
                          !makeProviderCredentialInput(
                            provider.provider,
                            values[provider.provider],
                          )
                        }
                        onClick={() => void save(provider.provider)}
                      >
                        {busy
                          ? t("library.catalog.savingCredentials")
                          : t("library.catalog.saveCredentials")}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <p className="provider-credentials-open-library">
          {t("library.catalog.openLibraryNoCredential")}
        </p>
      </div>
    </Modal>
  );
}
