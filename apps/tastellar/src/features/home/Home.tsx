import { useMemo, useState, useRef } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  HelpCircle,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
  SlidersHorizontal,
  Camera,
} from "lucide-react";
import type {
  HomeState,
  HomePatch,
  Preferences,
} from "../../shared/bridge/types";
import type {
  Entry as LibraryEntry,
  MediaType as LibraryMediaType,
} from "../../shared/bridge/libraryTypes";
import { errorMessage, copyText } from "../../shared/bridge/client";
import { Modal } from "../../shared/ui/Modal";
import { SelectControl } from "../../shared/ui/SelectControl";
import { t } from "../../shared/ui/i18n";
import { criteria as defaultCriteriaMessages } from "./criteria";
import { TasteChart, EmptyConstellation } from "./TasteChart";
import { deriveTasteRadar } from "./domain/taste";
import {
  buildRecommendationPrompt,
  type RecommendationEntryEvidence,
  type RecommendationPromptOptions,
} from "./domain/prompt";
const defaultCriteria = Object.fromEntries(
  Object.entries(defaultCriteriaMessages).map(([id, key]) => [id, t(key)]),
);
export interface HomeProps {
  state: HomeState;
  avatar: string | null;
  save: (patch: HomePatch) => Promise<void>;
  preferences: (patch: Partial<Preferences>) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  removeAvatar: () => Promise<void>;
  criterionLabels?: Record<string, string>;
  libraryEntries?: LibraryEntry[];
  mediaTypes?: Array<Pick<LibraryMediaType, "id" | "name" | "criterionIds">>;
}
export function Home({
  state,
  avatar,
  save,
  preferences,
  uploadAvatar,
  removeAvatar,
  criterionLabels = defaultCriteria,
  libraryEntries,
  mediaTypes = [],
}: HomeProps) {
  const libraryEntryData = libraryEntries ?? [];
  const [editor, setEditor] = useState<
    "profile" | "qualities" | "guidelines" | "prompt" | "help" | null
  >(null);
  const recommendationEntries = useMemo<RecommendationEntryEvidence[]>(() => {
    const typesById = new Map(mediaTypes.map((type) => [type.id, type]));
    return libraryEntryData.map((entry) => {
      const type = entry.mediaTypeId
        ? typesById.get(entry.mediaTypeId)
        : undefined;
      const activeCriterionIds = new Set(type?.criterionIds ?? []);
      const criterionScores = Object.fromEntries(
        Object.entries(entry.criterionRatings).filter(
          ([criterionId]) =>
            activeCriterionIds.has(criterionId) &&
            Boolean(criterionLabels[criterionId]),
        ),
      );
      return {
        id: entry.id,
        title: entry.title,
        disposition: entry.disposition,
        mediaType: type?.name ?? null,
        releaseYear: entry.releaseDate?.year ?? null,
        overallRating: entry.overallRating,
        criterionScores,
        reviewText: entry.reviewText,
      };
    });
  }, [libraryEntryData, mediaTypes, criterionLabels]);
  const mode = state.preferences.radarMode;
  const radar = deriveTasteRadar({
    entries: recommendationEntries
      .filter((entry) => entry.disposition === "experienced")
      .map((entry) => ({
        id: entry.id,
        overallRating: entry.overallRating ?? null,
        criterionScores: entry.criterionScores ?? {},
      })),
    criterionLabels,
    tasteInputs: state.tasteInputs,
    selectedCriterionIds: state.preferences.visibleCriteria,
  });
  const explicit = mode === "explicit";
  const active = explicit ? radar.explicit : radar.derived;
  const hasChart = explicit
    ? active.axes.length > 0
    : radar.derived.mode !== "empty";
  const guidelineCount = Object.values(state.guidelines).filter((v) =>
    v.trim(),
  ).length;
  const describedScores = Array.from({ length: 10 }, (_, i) => 10 - i).filter(
    (score) => state.guidelines[score]?.trim(),
  );
  const initials = (
    state.profile.nickname.trim().slice(0, 2) || "✦"
  ).toUpperCase();
  return (
    <div className="home-page page-enter">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{t("home.eyebrow")}</span>
          <h1>{t("home.title")}</h1>
          <p>{t("home.subtitle")}</p>
        </div>
        <span className="privacy-badge">
          <ShieldCheck size={14} />
          {t("app.local")}
        </span>
      </header>
      <section className="profile-card" aria-label={t("home.localProfile")}>
        <div className="profile-orbit-clip" aria-hidden="true">
          <div className="profile-orbits">
            <i />
            <i />
            <i />
            <span>✦</span>
            <b />
            <em />
          </div>
        </div>
        <div className="profile-main">
          <button
            className={`avatar ${avatar ? "has-image" : ""}`}
            aria-label={t("home.editProfile")}
            onClick={() => setEditor("profile")}
          >
            {avatar ? <img src={avatar} alt="" /> : <span>{initials}</span>}
            <span className="avatar-edit">
              <Camera size={13} />
            </span>
          </button>
          <div className="profile-copy">
            <span className="micro-label">{t("home.localProfile")}</span>
            <h2>{state.profile.nickname || t("home.profileDefault")}</h2>
            <p>{state.profile.statedTastes || t("home.profileEmpty")}</p>
          </div>
        </div>
        <button
          className="button profile-edit secondary"
          onClick={() => setEditor("profile")}
        >
          <Pencil size={14} />
          {t("home.editProfile")}
        </button>
        <div className="profile-bottom">
          <span>
            <i className="status-dot" /> {t("home.profileSpace")}
          </span>
          <span>{t("home.personalSpace")}</span>
        </div>
      </section>
      <div className="home-grid">
        <section className="card taste-card">
          <div className="card-heading">
            <div>
              <h2>{t("home.tasteTitle")}</h2>
              <p>{t("home.tasteSubtitle")}</p>
            </div>
            <button
              className="icon-button"
              title={t("home.tasteEdit")}
              aria-label={t("home.tasteEdit")}
              onClick={() => setEditor("qualities")}
            >
              <SlidersHorizontal size={17} />
            </button>
          </div>
          <div className="segmented" aria-label={t("home.chartSource")}>
            <button
              aria-pressed={explicit}
              className={explicit ? "selected" : ""}
              onClick={() =>
                void preferences({ radarMode: "explicit" }).catch(
                  () => undefined,
                )
              }
            >
              {t("home.explicit")}
            </button>
            <button
              aria-pressed={!explicit}
              className={!explicit ? "selected" : ""}
              onClick={() =>
                void preferences({ radarMode: "derived" }).catch(
                  () => undefined,
                )
              }
            >
              {t("home.derived")}
            </button>
          </div>
          {hasChart ? (
            <>
              <TasteChart axes={active.axes} />
              <details className="chart-values">
                <summary>
                  {t("home.allQualityScores")}{" "}
                  <span>{active.allAxes.length}</span>
                </summary>
                <dl>
                  {active.allAxes.map((axis) => (
                    <div key={axis.criterionId}>
                      <dt>{axis.label}</dt>
                      <dd>
                        {axis.value?.toFixed(
                          Number.isInteger(axis.value) ? 0 : 1,
                        )}{" "}
                        / 10
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <p className="chart-caption">
                {t(explicit ? "home.explicitNote" : "home.derivedNote")}
              </p>
            </>
          ) : (
            <div className="taste-empty">
              <EmptyConstellation />
              <h3>{t(explicit ? "home.tasteEmpty" : "home.derivedEmpty")}</h3>
              <p>
                {t(explicit ? "home.tasteEmptyBody" : "home.derivedEmptyBody")}
              </p>
              <button
                className="button secondary"
                onClick={() => setEditor("qualities")}
              >
                <Plus size={15} />
                {t("home.tasteAction")}
              </button>
              {!explicit && (
                <span className="quiet-count">
                  {t("home.noQualifyingFavorites")}
                </span>
              )}
            </div>
          )}
        </section>
        <section className="card philosophy-card">
          <div className="card-heading">
            <div>
              <h2>{t("home.guidelinesTitle")}</h2>
              <p>{t("home.guidelinesSubtitle")}</p>
            </div>
            <span className="small-orbit" aria-hidden="true">
              ✧
            </span>
          </div>
          <p className="card-description">{t("home.guidelinesBody")}</p>
          <div className="score-preview">
            {(describedScores.length ? describedScores : [10, 9, 8, 7]).map(
              (score) => (
                <button
                  className="score-row"
                  key={score}
                  onClick={() => setEditor("guidelines")}
                >
                  <span className="score-number">
                    {score}
                    <small>/10</small>
                  </span>
                  <span
                    className={
                      state.guidelines[score]?.trim()
                        ? "score-description"
                        : "score-description undefined"
                    }
                  >
                    {state.guidelines[score]?.trim() ||
                      t("home.guidelineEmpty")}
                  </span>
                  <Pencil size={12} />
                </button>
              ),
            )}
          </div>
          <div className="philosophy-footer">
            <span>{t("home.guidelinesCount", { count: guidelineCount })}</span>
            <button
              className="text-button"
              onClick={() => setEditor("guidelines")}
            >
              {t(guidelineCount ? "home.editScale" : "home.defineScale")}
              <ArrowUpRight size={15} />
            </button>
          </div>
        </section>
      </div>
      <section className="discovery-card">
        <div className="discovery-symbol" aria-hidden="true">
          <Sparkles size={30} strokeWidth={1.2} />
        </div>
        <div className="discovery-copy">
          <span className="eyebrow">{t("home.promptEyebrow")}</span>
          <h2>{t("home.promptTitle")}</h2>
          <p>{t("home.promptBody")}</p>
        </div>
        <div className="discovery-actions">
          <div>
            <button
              className="button primary"
              onClick={() => setEditor("prompt")}
            >
              <Sparkles size={15} />
              {t("home.promptButton")}
            </button>
            <button
              className="icon-button"
              onClick={() => setEditor("help")}
              aria-label={t("home.promptHelp")}
              title={t("home.promptHelp")}
            >
              <HelpCircle size={17} />
            </button>
          </div>
          <span>
            <ShieldCheck size={12} />
            {t("home.promptFootnote")}
          </span>
        </div>
      </section>
      <footer className="home-footer">
        <span className="brand-spark">✦</span>
        {t("home.footer")}
      </footer>
      {editor === "profile" && (
        <ProfileEditor
          state={state}
          avatar={avatar}
          save={save}
          uploadAvatar={uploadAvatar}
          removeAvatar={removeAvatar}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "qualities" && (
        <QualityEditor
          state={state}
          save={save}
          preferences={preferences}
          criterionLabels={criterionLabels}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "guidelines" && (
        <GuidelineEditor
          state={state}
          save={save}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "prompt" && (
        <PromptPreview
          state={state}
          criterionLabels={criterionLabels}
          entries={recommendationEntries}
          libraryEntryCount={libraryEntries?.length ?? null}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "help" && (
        <Modal title={t("home.promptHelp")} onClose={() => setEditor(null)}>
          <div className="modal-body prose">
            <div className="help-symbol">
              <Sparkles size={30} />
            </div>
            <p>{t("home.promptHelpBody")}</p>
            <ol>
              <li>{t("home.helpProfileStep")}</li>
              <li>{t("home.helpPreviewStep")}</li>
              <li>{t("home.helpCopyStep")}</li>
            </ol>
          </div>
          <div className="modal-actions">
            <button className="button primary" onClick={() => setEditor(null)}>
              {t("common.done")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ProfileEditor({
  state,
  avatar,
  save,
  uploadAvatar,
  removeAvatar,
  onClose,
}: Pick<
  HomeProps,
  "state" | "avatar" | "save" | "uploadAvatar" | "removeAvatar"
> & { onClose: () => void }) {
  const [nickname, setNickname] = useState(state.profile.nickname),
    [tastes, setTastes] = useState(state.profile.statedTastes);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty =
    nickname !== state.profile.nickname ||
    tastes !== state.profile.statedTastes;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save({
        profile: { ...state.profile, nickname, statedTastes: tastes },
        guidelines: state.guidelines,
        tasteInputs: state.tasteInputs,
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function image(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await uploadAvatar(file);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  return (
    <Modal
      title={t("home.profileTitle")}
      description={t("home.profileDescription")}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="avatar-settings">
            <div className="avatar large">
              {avatar ? (
                <img src={avatar} alt={t("home.avatar")} />
              ) : (
                <span>✦</span>
              )}
            </div>
            <div>
              <button
                className="button secondary small"
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {t("home.addAvatar")}
              </button>
              {avatar && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await removeAvatar();
                    } catch (e) {
                      setError(errorMessage(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("home.removeAvatar")}
                </button>
              )}
              <p className="field-hint">
                {t("home.avatarHelp")} {t("home.imageChangesSave")}
              </p>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void image(e.target.files?.[0])}
              />
            </div>
          </div>
          <label className="field">
            <span>{t("home.nickname")}</span>
            <input
              autoFocus
              value={nickname}
              maxLength={100}
              placeholder={t("home.nicknamePlaceholder")}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("home.tastes")}</span>
            <textarea
              value={tastes}
              maxLength={20000}
              rows={5}
              placeholder={t("home.tastesPlaceholder")}
              onChange={(e) => setTastes(e.target.value)}
            />
            <small>{t("home.tastesHelp")}</small>
          </label>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={(e) =>
              e.currentTarget
                .closest("dialog")
                ?.dispatchEvent(
                  new Event("cancel", { bubbles: false, cancelable: true }),
                )
            }
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? t("app.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function QualityEditor({
  state,
  save,
  preferences,
  criterionLabels,
  onClose,
}: Pick<HomeProps, "state" | "save" | "preferences" | "criterionLabels"> & {
  onClose: () => void;
}) {
  const labels = criterionLabels ?? defaultCriteria;
  const [values, setValues] = useState({ ...state.tasteInputs });
  const [visible, setVisible] = useState([
    ...state.preferences.visibleCriteria,
  ]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty =
    JSON.stringify(values) !== JSON.stringify(state.tasteInputs) ||
    JSON.stringify(visible) !== JSON.stringify(state.preferences.visibleCriteria);
  return (
    <Modal
      title={t("home.qualityDialog")}
      description={t("home.qualityDialogBody")}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (Object.keys(values).length > 0 && visible.length === 0) {
            setError(t("home.qualityChartError"));
            return;
          }
          setBusy(true);
          try {
            await save({
              profile: state.profile,
              guidelines: state.guidelines,
              tasteInputs: values,
            });
            await preferences({
              visibleCriteria: visible,
            });
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body qualities-editor">
          {Object.entries(labels).map(([id, label]) => (
            <div
              className={`quality-row ${values[id] ? "active" : ""}`}
              key={id}
            >
              <div className="quality-title">
                <label>
                  <input
                    type="checkbox"
                    checked={!!values[id]}
                    onChange={(e) => {
                      const next = { ...values };
                      if (e.target.checked) {
                        next[id] = 5;
                        if (visible.length < 8) setVisible([...visible, id]);
                      } else {
                        delete next[id];
                        setVisible(visible.filter((v) => v !== id));
                      }
                      setValues(next);
                    }}
                  />
                  {label}
                </label>
                {values[id] && (
                  <label className="axis-toggle" title={t("home.visibleAxes")}>
                    <input
                      type="checkbox"
                      aria-label={t("home.showQualityOnChart", {
                        quality: label,
                      })}
                      checked={visible.includes(id)}
                      disabled={!visible.includes(id) && visible.length >= 8}
                      onChange={(e) =>
                        setVisible(
                          e.target.checked
                            ? [...visible, id]
                            : visible.filter((v) => v !== id),
                        )
                      }
                    />
                    <span>{t("home.chartLabel")}</span>
                  </label>
                )}
              </div>
              {values[id] && (
                <div className="quality-range">
                  <span>{t("home.less")}</span>
                  <input
                    aria-label={t("home.qualityImportance", { quality: label })}
                    type="range"
                    min="1"
                    max="10"
                    value={values[id]}
                    onChange={(e) =>
                      setValues({ ...values, [id]: Number(e.target.value) })
                    }
                  />
                  <span>{t("home.more")}</span>
                  <output>
                    {values[id]}
                    <small>/10</small>
                  </output>
                </div>
              )}
            </div>
          ))}
          <p className="field-hint">{t("home.axesHelp")}</p>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <span className="field-hint">
            {t("home.qualitiesSelected", { count: Object.keys(values).length })}
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? t("app.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function GuidelineEditor({
  state,
  save,
  onClose,
}: Pick<HomeProps, "state" | "save"> & { onClose: () => void }) {
  const [guidelines, setGuidelines] = useState({ ...state.guidelines }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={t("home.guidelinesDialog")}
      description={t("home.guidelinesDialogBody")}
      onClose={onClose}
      dirty={JSON.stringify(guidelines) !== JSON.stringify(state.guidelines)}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save({
              profile: state.profile,
              tasteInputs: state.tasteInputs,
              guidelines,
            });
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body guidelines-editor">
          {Array.from({ length: 10 }, (_, i) => 10 - i).map((score) => (
            <label key={score} className="guideline-field">
              <span>
                {score}
                <small>/10</small>
              </span>
              <textarea
                rows={2}
                maxLength={20000}
                aria-label={t("home.scoreDefinitionLabel", { score })}
                placeholder={t("home.guidelinePlaceholder")}
                value={guidelines[score] ?? ""}
                onChange={(e) =>
                  setGuidelines({ ...guidelines, [score]: e.target.value })
                }
              />
            </label>
          ))}
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button className="button primary" disabled={busy}>
            {busy ? t("app.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PromptPreview({
  state,
  criterionLabels,
  entries,
  libraryEntryCount,
  onClose,
}: {
  state: HomeState;
  criterionLabels: Record<string, string>;
  entries: RecommendationEntryEvidence[];
  libraryEntryCount: number | null;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<RecommendationPromptOptions>({
    includeProfile: true,
    includeReviews: true,
    includeMediaType: false,
    exploreOtherMedia: false,
    recommendationCount: 10,
  });
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState("");
  const result = useMemo(() => {
    try {
      return {
        prompt: buildRecommendationPrompt({
          profile: state.profile,
          guidelines: state.guidelines,
          tasteInputs: state.tasteInputs,
          criterionLabels,
          entries,
          libraryLoaded: libraryEntryCount !== null,
          options,
          message: t,
        }),
        error: "",
      };
    } catch (e) {
      return { prompt: null, error: errorMessage(e) };
    }
  }, [state, options, criterionLabels, entries, libraryEntryCount]);
  async function copy() {
    if (!result.prompt) return;
    try {
      await copyText(result.prompt.text);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError(t("home.copyError"));
    }
  }
  return (
    <Modal
      title={t("home.promptPreview")}
      description={t("home.promptPreviewBody")}
      onClose={onClose}
      wide
    >
      <div className="modal-body prompt-body">
        <div className="prompt-options">
          {(
            ["includeProfile", "includeReviews", "includeMediaType", "exploreOtherMedia"] as const
          ).map((key) => (
            <label className="check-label" key={key}>
              <input
                type="checkbox"
                checked={!!options[key]}
                onChange={(e) => {
                  setOptions({ ...options, [key]: e.target.checked });
                  setCopied(false);
                }}
              />
              {t(`home.${key === "exploreOtherMedia" ? "exploreMedia" : key === "includeMediaType" ? "includeMediaType" : key}`)}
            </label>
          ))}
          <div className="prompt-numbers">
            <label className="field">
              <span>{t("home.recommendationCount")}</span>
              <SelectControl
                value={options.recommendationCount ?? 10}
                menuWidth="trigger"
                onValueChange={(value) => {
                  setOptions({
                    ...options,
                    recommendationCount: Number(value),
                  });
                  setCopied(false);
                }}
              >
                {[5, 10, 15, 20].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </SelectControl>
            </label>
          </div>
        </div>
        {libraryEntryCount === 0 && (
          <p className="notice">
            <ShieldCheck size={15} />
            {t("home.noLibraryYet")}
          </p>
        )}
        {libraryEntryCount === null && (
          <p className="notice">
            <ShieldCheck size={15} />
            {t("home.libraryUnavailable")}
          </p>
        )}
        {result.error ? (
          <p className="error-message" role="alert">
            {result.error} {t("home.promptGenerationErrorHint")}
          </p>
        ) : (
          <>
            <textarea
              className="prompt-preview"
              aria-label={t("home.recommendationPromptLabel")}
              readOnly
              value={result.prompt?.text}
              onClick={() => void copy()}
            />
            <div className="prompt-meta">
              <span>
                {t("home.characterCount", {
                  count: result.prompt?.characterCount ?? 0,
                })}
              </span>
              <span>
                {t("home.promptCoverage", {
                  included: result.prompt?.included.entries ?? 0,
                  omitted: result.prompt?.omitted.entries ?? 0,
                })}
              </span>
            </div>
          </>
        )}
        {copyError && (
          <p className="error-message" role="alert">
            {copyError}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <span className="field-hint" aria-live="polite">
          {copied ? t("home.copied") : t("home.promptFootnote")}
        </span>
        <button
          className="button primary"
          disabled={!result.prompt}
          onClick={() => void copy()}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
          {t(copied ? "home.copied" : "home.copy")}
        </button>
      </div>
    </Modal>
  );
}
