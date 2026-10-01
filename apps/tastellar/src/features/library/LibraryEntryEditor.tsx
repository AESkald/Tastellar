import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ImagePlus, Star, Tag as TagIcon } from "lucide-react";
import { errorMessage } from "../../shared/bridge/client";
import type {
  Entry as LibraryEntry,
  LibraryState,
  Tag as LibraryTag,
  Criterion as LibraryCriterion,
} from "../../shared/bridge/libraryTypes";
import { Modal } from "../../shared/ui/Modal";
import { SelectControl } from "../../shared/ui/SelectControl";
import { criterionName, mediaTypeName } from "./MediaTypeIcon";
import { t } from "../../shared/ui/i18n";

export function createEmptyLibraryEntry(): LibraryEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    importOrder: null,
    title: "",
    disposition: "planned",
    mediaTypeId: null,
    overallRating: null,
    coverAssetId: null,
    releaseDate: null,
    reviewText: "",
    shortLabel: null,
    tagIds: [],
    criterionRatings: {},
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

export function readLibraryCover(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(t("library.ui.imageReadError")));
    reader.readAsDataURL(file);
  });
}

export interface LibraryEntryEditorProps {
  entry: LibraryEntry;
  state: LibraryState;
  isNew: boolean;
  busy: boolean;
  error: string;
  hasCoverStorage: boolean;
  onCancel: () => void;
  onSave: (entry: LibraryEntry, coverFile: File | null) => void | Promise<void>;
  onCreateTag: (name: string) => Promise<LibraryTag>;
}

export function LibraryEntryEditor({
  entry,
  state,
  isNew,
  busy,
  error,
  hasCoverStorage,
  onCancel,
  onSave,
  onCreateTag,
}: LibraryEntryEditorProps) {
  const [draft, setDraft] = useState({
    ...entry,
    shortLabel: entry.shortLabel ?? "",
  });
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [tagError, setTagError] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [monthText, setMonthText] = useState(
    entry.releaseDate?.month ? String(entry.releaseDate.month) : "",
  );
  const [dayText, setDayText] = useState(
    entry.releaseDate?.day ? String(entry.releaseDate.day) : "",
  );
  const [clearedRating, setClearedRating] = useState<number | null>(null);
  const originalDraft = useRef(
    JSON.stringify({ ...entry, shortLabel: entry.shortLabel ?? "" }),
  );
  const activeType = state.mediaTypes.find(
    (type) => type.id === draft.mediaTypeId,
  );
  const activeCriteria = (activeType?.criterionIds ?? [])
    .map((id) => state.criteria.find((criterion) => criterion.id === id))
    .filter((criterion): criterion is LibraryCriterion =>
      Boolean(criterion && !criterion.archivedAt),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const activeIds = new Set(activeCriteria.map((criterion) => criterion.id));
  const retainedCriteria = state.criteria.filter(
    (criterion) =>
      draft.criterionRatings[criterion.id] && !activeIds.has(criterion.id),
  );
  const previewUrl = useMemo(
    () => (coverFile ? URL.createObjectURL(coverFile) : null),
    [coverFile],
  );
  useEffect(() => {
    setCoverPreview(previewUrl);
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  const update = (patch: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setTagError(t("library.ui.enterTitle"));
      return;
    }
    const year = draft.releaseDate?.year;
    if (year && monthText) {
      const month = Number(monthText);
      const day = dayText ? Number(dayText) : undefined;
      if (
        month < 1 ||
        month > 12 ||
        (day && (day < 1 || day > new Date(year, month, 0).getDate()))
      ) {
        setTagError(t("library.ui.validReleaseDate"));
        return;
      }
      update({
        releaseDate: {
          year,
          month,
          ...(day ? { day } : {}),
          precision: day ? "day" : "month",
        },
      });
    }
    onSave(
      {
        ...draft,
        title: draft.title.trim(),
        disposition:
          draft.overallRating === null ? draft.disposition : "experienced",
        releaseDate: year
          ? monthText
            ? {
                year,
                month: Number(monthText),
                ...(dayText ? { day: Number(dayText) } : {}),
                precision: dayText ? "day" : "month",
              }
            : { year, precision: "year" }
          : null,
      },
      coverFile,
    );
  };
  const createTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    setTagBusy(true);
    setTagError("");
    try {
      const tag = await onCreateTag(name);
      update({ tagIds: [...new Set([...draft.tagIds, tag.id])] });
      setNewTagName("");
    } catch (cause) {
      setTagError(errorMessage(cause));
    } finally {
      setTagBusy(false);
    }
  };
  return (
    <Modal
      title={t(isNew ? "library.ui.addWork" : "library.ui.editWork")}
      description={
        isNew
          ? t("library.ui.addWorkDescription")
          : t("library.ui.editWorkDescription")
      }
      onClose={onCancel}
      dirty={
        JSON.stringify(draft) !== originalDraft.current || Boolean(coverFile)
      }
      busy={busy}
      wide
    >
      <form className="entry-editor-form" onSubmit={submit}>
        <div className="entry-editor-scroll">
          <label className="field">
            <span>
              {t("library.ui.titleRequired")} <i aria-hidden="true">*</i>
            </span>
            <input
              autoFocus
              maxLength={500}
              required
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              placeholder={t("library.ui.workTitle")}
            />
          </label>
          <div className="entry-editor-row">
            <label className="field">
              <span>{t("library.ui.mediaType")}</span>
              <SelectControl
                value={draft.mediaTypeId ?? ""}
                onValueChange={(value) =>
                  update({ mediaTypeId: value || null })
                }
              >
                <option value="">{t("library.ui.noType")}</option>
                {state.mediaTypes
                  .filter((type) => !type.archivedAt)
                  .map((type) => (
                    <option key={type.id} value={type.id}>
                      {mediaTypeName(type.id, type.name)}
                    </option>
                  ))}
              </SelectControl>
            </label>
            <label className="field">
              <span>{t("library.ui.disposition")}</span>
              <SelectControl
                value={draft.disposition}
                onValueChange={(value) => {
                  const disposition = value as LibraryEntry["disposition"];
                  if (
                    disposition !== "experienced" &&
                    draft.overallRating !== null
                  )
                    setClearedRating(draft.overallRating);
                  update({
                    disposition,
                    ...(disposition === "experienced"
                      ? {}
                      : { overallRating: null }),
                  });
                }}
              >
                <option value="planned">{t("library.ui.group.planned")}</option>
                <option value="experienced">
                  {t("library.ui.alreadyExperienced")}
                </option>
                <option value="dropped">{t("library.ui.group.dropped")}</option>
              </SelectControl>
            </label>
          </div>
          {clearedRating !== null && (
            <p className="entry-editor-note rating-cleared-note">
              {t("library.ui.ratingCleared", { rating: clearedRating })}
            </p>
          )}
          <div className="entry-editor-row">
            <label className="field">
              <span>{t("library.ui.overallRatingTitle")}</span>
              <SelectControl
                value={draft.overallRating ?? ""}
                onValueChange={(value) => {
                  const rating = value ? Number(value) : null;
                  update({
                    overallRating: rating,
                    ...(rating !== null
                      ? { disposition: "experienced" as const }
                      : {}),
                  });
                  if (rating !== null) setClearedRating(null);
                }}
              >
                <option value="">{t("library.ui.notRated")}</option>
                {Array.from({ length: 10 }, (_, index) => index + 1).map(
                  (score) => (
                    <option key={score} value={score}>
                      {score} / 10
                    </option>
                  ),
                )}
              </SelectControl>
            </label>
            <div className="field release-date-field">
              <span>{t("library.ui.releaseDate")}</span>
              <div className="release-date-inputs">
                <input
                  aria-label={t("library.ui.releaseYearLabel")}
                  inputMode="numeric"
                  placeholder={t("library.ui.year")}
                  maxLength={4}
                  value={draft.releaseDate?.year ?? ""}
                  onChange={(event) => {
                    const year = Number(
                      event.target.value.replace(/\D/g, "").slice(0, 4),
                    );
                    update({
                      releaseDate: year ? { year, precision: "year" } : null,
                    });
                    setMonthText("");
                    setDayText("");
                  }}
                />
                <input
                  aria-label={t("library.ui.releaseMonthOptional")}
                  inputMode="numeric"
                  placeholder={t("library.ui.month")}
                  min={1}
                  max={12}
                  disabled={!draft.releaseDate}
                  value={monthText}
                  onChange={(event) => {
                    setMonthText(
                      event.target.value.replace(/\D/g, "").slice(0, 2),
                    );
                    setDayText("");
                  }}
                />
                <input
                  aria-label={t("library.ui.releaseDayOptional")}
                  inputMode="numeric"
                  placeholder={t("library.ui.day")}
                  min={1}
                  max={31}
                  disabled={!draft.releaseDate || !monthText}
                  value={dayText}
                  onChange={(event) =>
                    setDayText(
                      event.target.value.replace(/\D/g, "").slice(0, 2),
                    )
                  }
                />
              </div>
            </div>
          </div>
          <label className="field">
            <span>
              {t("library.ui.shortLabel")}{" "}
              <small>{t("library.shortLabelHint")}</small>
            </span>
            <input
              maxLength={100}
              value={draft.shortLabel ?? ""}
              onChange={(event) => update({ shortLabel: event.target.value })}
              placeholder={t("library.ui.shortLabelPlaceholder")}
            />
          </label>
          <div className="entry-editor-section">
            <div className="entry-section-heading">
              <div>
                <Star size={15} />
                <strong>{t("library.ui.criterionScores")}</strong>
              </div>
              <span>{t("library.ui.optionalScale")}</span>
            </div>
            {activeCriteria.length ? (
              <div className="criterion-editor-grid">
                {activeCriteria.map((criterion) => (
                  <label key={criterion.id} className="criterion-editor-field">
                    <span>{criterionName(criterion.id, criterion.name)}</span>
                    <SelectControl
                      value={draft.criterionRatings[criterion.id] ?? ""}
                      onValueChange={(value) => {
                        const ratings = { ...draft.criterionRatings };
                        if (value) ratings[criterion.id] = Number(value);
                        else delete ratings[criterion.id];
                        update({ criterionRatings: ratings });
                      }}
                    >
                      <option value="">{t("library.ui.notScored")}</option>
                      {Array.from({ length: 10 }, (_, index) => index + 1).map(
                        (score) => (
                          <option key={score} value={score}>
                            {score}
                          </option>
                        ),
                      )}
                    </SelectControl>
                  </label>
                ))}
              </div>
            ) : (
              <p className="entry-editor-note">
                {t("library.ui.chooseTypeForCriteria")}
              </p>
            )}
            {retainedCriteria.length > 0 && (
              <details className="editor-retained-scores">
                <summary>
                  {t("library.ui.previousCriteriaCount", {
                    count: retainedCriteria.length,
                  })}
                </summary>
                <div>
                  {retainedCriteria.map((criterion) => (
                    <span key={criterion.id}>
                      {criterionName(criterion.id, criterion.name)}:{" "}
                      {draft.criterionRatings[criterion.id]}
                      /10
                    </span>
                  ))}
                </div>
              </details>
            )}
          </div>
          <div className="entry-editor-section">
            <div className="entry-section-heading">
              <div>
                <TagIcon size={15} />
                <strong>{t("library.ui.tags")}</strong>
              </div>
              <span>{t("library.ui.optional")}</span>
            </div>
            {state.tags.length > 0 ? (
              <div className="tag-picker">
                {state.tags.map((tag) => (
                  <label
                    key={tag.id}
                    className={draft.tagIds.includes(tag.id) ? "selected" : ""}
                  >
                    <input
                      type="checkbox"
                      checked={draft.tagIds.includes(tag.id)}
                      onChange={() =>
                        update({
                          tagIds: draft.tagIds.includes(tag.id)
                            ? draft.tagIds.filter((id) => id !== tag.id)
                            : [...draft.tagIds, tag.id],
                        })
                      }
                    />
                    <span>{tag.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="entry-editor-note">
                {t("library.ui.emptyTagList")}
              </p>
            )}
            <div className="create-tag-inline">
              <input
                value={newTagName}
                maxLength={100}
                onChange={(event) => setNewTagName(event.target.value)}
                placeholder={t("library.ui.createTag")}
                aria-label={t("library.ui.newTagName")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createTag();
                  }
                }}
              />
              <button
                type="button"
                className="button secondary"
                disabled={!newTagName.trim() || tagBusy}
                onClick={() => void createTag()}
              >
                {tagBusy ? t("library.ui.adding") : t("library.ui.addTag")}
              </button>
            </div>
          </div>
          <div className="entry-editor-section">
            <div className="entry-section-heading">
              <div>
                <ImagePlus size={15} />
                <strong>{t("library.ui.cover")}</strong>
              </div>
              <span>{t("library.ui.optional")}</span>
            </div>
            <label className="cover-upload-control">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (!file) return;
                  if (!hasCoverStorage) {
                    setTagError(t("library.ui.coverStorageUnavailable"));
                    return;
                  }
                  if (
                    !["image/png", "image/jpeg", "image/webp"].includes(
                      file.type,
                    ) ||
                    file.size > 25 * 1024 * 1024
                  ) {
                    setTagError(t("library.ui.invalidCover"));
                    return;
                  }
                  setCoverFile(file);
                  setTagError("");
                }}
              />
              <ImagePlus size={17} />
              <span>
                {coverFile
                  ? coverFile.name
                  : draft.coverAssetId
                    ? t("library.ui.replaceCover")
                    : t("library.ui.chooseCover")}
              </span>
              <small>{t("library.ui.coverHint")}</small>
            </label>
            {coverPreview && (
              <div className="cover-upload-preview">
                <img
                  src={coverPreview}
                  alt={t("library.ui.selectedCoverPreview")}
                />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setCoverFile(null)}
                >
                  {t("library.ui.removeSelectedImage")}
                </button>
              </div>
            )}
          </div>
          <label className="field">
            <span>{t("library.yourThoughts")}</span>
            <textarea
              maxLength={100000}
              rows={4}
              value={draft.reviewText}
              onChange={(event) => update({ reviewText: event.target.value })}
              placeholder={t("library.yourThoughtsPlaceholder")}
            />
          </label>
          {(tagError || error) && (
            <p className="error-message" role="alert">
              {error || tagError}
            </p>
          )}
        </div>
        <footer className="modal-actions">
          <span className="field-hint">{t("app.saved")}</span>
          <button
            type="button"
            className="button secondary"
            data-modal-close-request
            disabled={busy}
          >
            {t("library.vocabulary.cancel")}
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? t("library.ui.saving") : t("library.ui.saveWork")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
