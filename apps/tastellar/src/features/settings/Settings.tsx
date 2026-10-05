import { useEffect, useRef, useState } from "react";
import {
  Check,
  Keyboard,
  Monitor,
  Moon,
  Sun,
  BookOpen,
  Palette,
  ShieldCheck,
  Layout,
  Info,
  ArrowUpRight,
  Trash2,
  Heart,
} from "lucide-react";
import type { Preferences, Theme, Workspace } from "../../shared/bridge/types";
import {
  native,
  exportLibraryArchive,
  errorMessage,
} from "../../shared/bridge/client";
import { ImportExportPanel } from "./ImportExportPanel";
import { t } from "../../shared/ui/i18n";
import { Modal } from "../../shared/ui/Modal";
import { SelectControl } from "../../shared/ui/SelectControl";
import { ExternalLink } from "../../shared/ui/ExternalLink";
import "./support.css";
import {
  DEFAULT_TAB_SHORTCUTS,
  shortcutAllowed,
  shortcutFromEvent,
  shortcutLabel,
} from "../../app/shortcuts";
const themes: { id: Theme; icon: typeof Sun }[] = [
  { id: "system", icon: Monitor },
  { id: "light", icon: Sun },
  { id: "dark", icon: Moon },
  { id: "dusk", icon: Palette },
  { id: "reading", icon: BookOpen },
];
export function Settings({
  preferences,
  onPreferences,
  onRestore,
  onReset,
  onResetRanking,
}: {
  preferences: Preferences;
  onPreferences: (patch: Partial<Preferences>) => Promise<void>;
  onRestore: (path: string) => Promise<void>;
  onReset: () => Promise<void>;
  onResetRanking: () => Promise<void>;
}) {
  const [page, setPage] = useState<
    "appearance" | "workspace" | "data" | "about"
  >("appearance");
  const [capture, setCapture] = useState<
    "previousTabShortcut" | "nextTabShortcut" | null
  >(null);
  const [error, setError] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [rankingResetOpen, setRankingResetOpen] = useState(false);
  const [rankingResetBusy, setRankingResetBusy] = useState(false);
  const [rankingResetError, setRankingResetError] = useState("");
  const [rankingResetNotice, setRankingResetNotice] = useState("");
  const update = async (patch: Partial<Preferences>) => {
    setError("");
    try {
      await onPreferences(patch);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const captureRef = useRef(capture);
  const preferencesRef = useRef(preferences);
  const updateRef = useRef(update);
  captureRef.current = capture;
  preferencesRef.current = preferences;
  updateRef.current = update;
  useEffect(() => {
    const captureShortcut = (event: KeyboardEvent) => {
      const key = captureRef.current;
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapture(null);
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      const other =
        key === "previousTabShortcut"
          ? preferencesRef.current.nextTabShortcut
          : preferencesRef.current.previousTabShortcut;
      if (!shortcutAllowed(shortcut, other)) {
        setError(t("settings.shortcutInvalid"));
        return;
      }
      void updateRef.current({ [key]: shortcut });
      setCapture(null);
    };
    window.addEventListener("keydown", captureShortcut, true);
    return () => window.removeEventListener("keydown", captureShortcut, true);
  }, []);
  const confirmReset = async () => {
    setResetBusy(true);
    setResetError("");
    try {
      await onReset();
      setResetOpen(false);
      setResetBusy(false);
    } catch (cause) {
      setResetError(errorMessage(cause));
      setResetBusy(false);
    }
  };
  const confirmRankingReset = async () => {
    setRankingResetBusy(true);
    setRankingResetError("");
    try {
      await onResetRanking();
      setRankingResetOpen(false);
      setRankingResetNotice(t("settings.resetRankingDone"));
      setRankingResetBusy(false);
    } catch (cause) {
      setRankingResetError(errorMessage(cause));
      setRankingResetBusy(false);
    }
  };
  return (
    <div className="settings-page page-enter">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{t("settings.eyebrow")}</span>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.subtitle")}</p>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.categories")}>
          {(
            [
              { id: "appearance", icon: Palette },
              { id: "workspace", icon: Layout },
              { id: "data", icon: ShieldCheck },
              { id: "about", icon: Info },
            ] as const
          ).map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
            >
              <Icon size={17} />
              {id === "data"
                ? t("settings.dataPrivacyLabel")
                : id === "about"
                  ? t("settings.aboutLabel")
                  : t(`settings.${id}`)}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {page === "appearance" && (
            <>
              <section className="settings-section">
                <h2>{t("settings.appearance")}</h2>
                <p>{t("settings.appearanceBody")}</p>
                <div className="theme-options">
                  {themes.map(({ id, icon: Icon }) => (
                    <button
                      key={id}
                      className={`theme-option ${preferences.theme === id || (id === "reading" && preferences.theme === "forest") ? "selected" : ""}`}
                      aria-pressed={
                        preferences.theme === id ||
                        (id === "reading" && preferences.theme === "forest")
                      }
                      onClick={() => void update({ theme: id })}
                    >
                      <div className={`theme-swatch theme-${id}`}>
                        <div className="mini-rail">
                          <i />
                          <i />
                          <i />
                        </div>
                        <div className="mini-window">
                          <div />
                          <span />
                          <span />
                        </div>
                        {preferences.theme === id && (
                          <span className="theme-check">
                            <Check size={12} />
                          </span>
                        )}
                      </div>
                      <strong>
                        <Icon size={13} />
                        {t(`settings.${id}`)}
                      </strong>
                      <small>{t(`settings.${id}Body`)}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-section">
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.textSize")}</h3>
                    <p>{t("settings.textSizeBody")}</p>
                  </div>
                  <SelectControl
                    aria-label={t("settings.textSize")}
                    value={preferences.textScale}
                    onValueChange={(value) =>
                      void update({ textScale: Number(value) })
                    }
                  >
                    <option value="0.9">{t("settings.textCompact")}</option>
                    <option value="1">{t("settings.textDefault")}</option>
                    <option value="1.1">{t("settings.textComfortable")}</option>
                    <option value="1.2">{t("settings.textLarge")}</option>
                  </SelectControl>
                </div>
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.motion")}</h3>
                    <p>{t("settings.motionBody")}</p>
                  </div>
                  <SelectControl
                    aria-label={t("settings.motion")}
                    value={preferences.reducedMotion}
                    onValueChange={(value) =>
                      void update({
                        reducedMotion: value as Preferences["reducedMotion"],
                      })
                    }
                  >
                    <option value="system">{t("settings.motionSystem")}</option>
                    <option value="on">{t("settings.motionOn")}</option>
                    <option value="off">{t("settings.motionOff")}</option>
                  </SelectControl>
                </div>
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.scenes")}</h3>
                    <p>{t("settings.scenesBody")}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={preferences.scenesEnabled}
                    aria-label={t("settings.scenes")}
                    className={`switch ${preferences.scenesEnabled ? "on" : ""}`}
                    onClick={() => void update({ scenesEnabled: !preferences.scenesEnabled })}
                  >
                    <i />
                  </button>
                </div>
              </section>
              <div className="settings-note">
                <Sparkle />
                {t("settings.atmosphereNote")}
              </div>
            </>
          )}
          {page === "workspace" && (
            <>
              <section className="settings-section">
                <h2>{t("settings.workspace")}</h2>
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.restore")}</h3>
                    <p>{t("settings.restoreBody")}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={preferences.restoreTabs}
                    aria-label={t("settings.restore")}
                    className={`switch ${preferences.restoreTabs ? "on" : ""}`}
                    onClick={() =>
                      void update({ restoreTabs: !preferences.restoreTabs })
                    }
                  >
                    <i />
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.rememberSidebarsPerTab")}</h3>
                    <p>{t("settings.rememberSidebarsPerTabBody")}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={preferences.rememberSidebarsPerTab}
                    aria-label={t("settings.rememberSidebarsPerTab")}
                    className={`switch ${preferences.rememberSidebarsPerTab ? "on" : ""}`}
                    onClick={() => void update({ rememberSidebarsPerTab: !preferences.rememberSidebarsPerTab })}
                  >
                    <i />
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.startup")}</h3>
                    <p>{t("settings.startupBody")}</p>
                  </div>
                  <SelectControl
                    aria-label={t("settings.startup")}
                    value={preferences.startupSection}
                    disabled={preferences.restoreTabs}
                    onValueChange={(value) =>
                      void update({
                        startupSection: value as Preferences["startupSection"],
                      })
                    }
                  >
                    {[
                      "home",
                      "library",
                      "ranking",
                      "analytics",
                      "recap",
                      "settings",
                    ].map((section) => (
                      <option key={section} value={section}>
                        {t(`nav.${section}`)}
                      </option>
                    ))}
                  </SelectControl>
                </div>
              </section>
              <section className="settings-section">
                <h2>
                  <Keyboard size={18} />
                  {t("settings.shortcuts")}
                </h2>
                <p>{t("settings.shortcutsBody")}</p>
                {(["previousTabShortcut", "nextTabShortcut"] as const).map(
                  (key, i) => (
                    <div className="setting-row" key={key}>
                      <h3>
                        {t(i === 0 ? "settings.leftTab" : "settings.rightTab")}
                      </h3>
                      <button
                        className={`shortcut-key ${capture === key ? "recording" : ""}`}
                        onClick={() => setCapture(key)}
                        onBlur={() => setCapture(null)}
                      >
                        {capture === key
                          ? t("settings.capture")
                          : shortcutLabel(preferences[key])}
                      </button>
                    </div>
                  ),
                )}
                <button
                  className="text-button"
                  onClick={() =>
                    void update({
                      ...DEFAULT_TAB_SHORTCUTS,
                    })
                  }
                >
                  {t("settings.resetShortcuts")}
                </button>
              </section>
            </>
          )}
          {page === "data" && (
            <>
              <section className="settings-section data-card">
                <div className="data-emblem">
                  <ShieldCheck size={32} strokeWidth={1.3} />
                </div>
                <h2>{t("settings.data")}</h2>
                <p>{t("settings.dataBody")}</p>
                <ImportExportPanel
                  isNative={native}
                  onExport={async (path) =>
                    void (await exportLibraryArchive(path))
                  }
                  onImport={onRestore}
                />
              </section>
              <section className="settings-section data-reset-section">
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.resetRanking")}</h3>
                    <p>{t("settings.resetRankingBody")}</p>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => {
                      setRankingResetError("");
                      setRankingResetNotice("");
                      setRankingResetOpen(true);
                    }}
                  >
                    {t("settings.resetRanking")}
                  </button>
                </div>
                {rankingResetNotice && (
                  <p className="success-message" role="status">
                    {rankingResetNotice}
                  </p>
                )}
              </section>
              <section className="settings-section data-reset-section">
                <div className="setting-row">
                  <div>
                    <h3>{t("settings.resetWorkspace")}</h3>
                    <p>{t("settings.resetWorkspaceBody")}</p>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => {
                      setResetError("");
                      setResetOpen(true);
                    }}
                  >
                    {t("settings.resetWorkspace")}
                  </button>
                </div>
              </section>
              <div className="privacy-facts">
                <div>
                  <Check size={15} />
                  <span>{t("settings.privacyNoAccount")}</span>
                </div>
                <div>
                  <Check size={15} />
                  <span>{t("settings.privacyNoUploads")}</span>
                </div>
                <div>
                  <Check size={15} />
                  <span>{t("settings.privacyNoTracking")}</span>
                </div>
              </div>
            </>
          )}
          {page === "about" && (
            <section className="settings-section about-card">
              <div className="about-logo">✦</div>
              <h2>Tastellar</h2>
              <span>{t("settings.version")}</span>
              <p>{t("settings.aboutBody")}</p>
              <div className="build-label">
                <span className="status-dot" />
                {t("settings.about")}
              </div>
              <section
                className="about-credits"
                aria-labelledby="about-credits-heading"
              >
                <h3 id="about-credits-heading">
                  {t("settings.providerCreditsTitle")}
                </h3>
                <ul className="provider-credit-list">
                  <li className="provider-credit-tmdb">
                    <ExternalLink
                      className="tmdb-logo-link"
                      href="https://www.themoviedb.org"
                      aria-label={t("settings.tmdbLogoAlt")}
                    >
                      <img
                        src="/tmdb-logo.svg"
                        alt={t("settings.tmdbLogoAlt")}
                      />
                    </ExternalLink>
                    <p>{t("settings.tmdbAttribution")}</p>
                  </li>
                  <li>
                    <span>{t("settings.openLibraryCredit")}</span>
                    <ExternalLink href="https://openlibrary.org">
                      Open Library <ArrowUpRight size={13} aria-hidden="true" />
                    </ExternalLink>
                  </li>
                  <li>
                    <span>{t("settings.googleBooksCredit")}</span>
                    <ExternalLink href="https://books.google.com">
                      Google Books <ArrowUpRight size={13} aria-hidden="true" />
                    </ExternalLink>
                  </li>
                  <li>
                    <span>{t("settings.igdbCredit")}</span>
                    <ExternalLink href="https://www.igdb.com">
                      IGDB <ArrowUpRight size={13} aria-hidden="true" />
                    </ExternalLink>
                  </li>
                  <li>
                    <span>{t("settings.steamImportCredit")}</span>
                    <ExternalLink href="https://steamcommunity.com/dev/apiterms">
                      Steam API terms{" "}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </ExternalLink>
                  </li>
                </ul>
              </section>
              <div className="settings-support-card">
                <Heart size={18} aria-hidden="true" />
                <div>
                  <h3>{t("settings.supportTitle")}</h3>
                  <p>{t("settings.supportBody")}</p>
                  <ExternalLink href="https://boosty.to/tastellar">
                    {t("settings.supportAction")}{" "}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </ExternalLink>
                  <ExternalLink
                    className="support-url"
                    href="https://boosty.to/tastellar"
                  >
                    boosty.to/tastellar
                  </ExternalLink>
                </div>
              </div>
            </section>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      {resetOpen && (
        <Modal
          title={t("settings.resetConfirmTitle")}
          description={t("settings.resetConfirmBody")}
          onClose={() => setResetOpen(false)}
          dirty={resetBusy}
          busy={resetBusy}
        >
          {resetError && (
            <p className="error-message reset-error" role="alert">
              {resetError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setResetOpen(false)}
              disabled={resetBusy}
            >
              {t("settings.cancelReset")}
            </button>
            <button
              className="button danger"
              type="button"
              onClick={() => void confirmReset()}
              disabled={resetBusy}
            >
              <Trash2 size={15} />
              {resetBusy
                ? t("settings.resetProgress")
                : t("settings.resetConfirmAction")}
            </button>
          </div>
        </Modal>
      )}
      {rankingResetOpen && (
        <Modal
          title={t("settings.resetRankingConfirmTitle")}
          description={t("settings.resetRankingConfirmBody")}
          onClose={() => setRankingResetOpen(false)}
          dirty={rankingResetBusy}
          busy={rankingResetBusy}
        >
          {rankingResetError && (
            <p className="error-message reset-error" role="alert">
              {rankingResetError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setRankingResetOpen(false)}
              disabled={rankingResetBusy}
            >
              {t("settings.cancelReset")}
            </button>
            <button
              className="button danger"
              type="button"
              onClick={() => void confirmRankingReset()}
              disabled={rankingResetBusy}
            >
              <Trash2 size={15} />
              {rankingResetBusy
                ? t("settings.resetRankingProgress")
                : t("settings.resetRankingConfirmAction")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Sparkle() {
  return <span aria-hidden="true">✧</span>;
}
