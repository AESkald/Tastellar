import { useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Plus,
  Save,
  Tags,
  Trash2,
} from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { SelectControl } from "../../shared/ui/SelectControl";
import {
  archiveCriterion,
  archiveMediaType,
  deleteTag,
  errorMessage,
  mergeTags,
  saveEntry,
  saveCriterion,
  saveMediaType,
  saveTag,
} from "../../shared/bridge/libraryBridge";
import type {
  CriterionDraft,
  LibraryState,
  MediaTypeDraft,
  MediaTypeIconKey,
} from "../../shared/bridge/libraryTypes";
import { t } from "../../shared/ui/i18n";
import { criterionName, mediaTypeName, MediaTypeIcon, mediaTypeIconChoices } from "./MediaTypeIcon";

type EditorSection = "types" | "criteria" | "tags";
type Commit = (
  operation: (current: LibraryState) => Promise<LibraryState>,
  message: string,
) => Promise<LibraryState | null>;

export function VocabularyEditor({
  state,
  mutateLibrary,
  onClose,
}: {
  state: LibraryState;
  mutateLibrary: (
    operation: (current: LibraryState) => Promise<LibraryState>,
  ) => Promise<LibraryState>;
  onClose: () => void;
}) {
  const [section, setSection] = useState<EditorSection>("types");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function commit(
    operation: (current: LibraryState) => Promise<LibraryState>,
    message: string,
  ): Promise<LibraryState | null> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await mutateLibrary(operation);
      setNotice(message);
      return next;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("library.vocabulary.title")}
      description={t("library.vocabulary.description")}
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="modal-body">
        <div
          className="library-vocabulary-tabs"
          role="tablist"
          aria-label={t("library.vocabulary.categories")}
        >
          {(
            [
              ["types", "library.vocabulary.mediaTypes"],
              ["criteria", "library.vocabulary.criteria"],
              ["tags", "library.vocabulary.tags"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={section === id ? "active" : ""}
              onClick={() => {
                setSection(id);
                setError("");
                setNotice("");
              }}
            >
          {t(label)}
            </button>
          ))}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="form-success" role="status">
            {notice}
          </div>
        )}
        <div hidden={section !== "types"}>
          <MediaTypeEditor state={state} busy={busy} commit={commit} />
        </div>
        <div hidden={section !== "criteria"}>
          <CriterionEditor state={state} busy={busy} commit={commit} />
        </div>
        <div hidden={section !== "tags"}>
          <TagEditor state={state} busy={busy} commit={commit} />
        </div>
      </div>
      <div className="modal-actions">
        <button
          className="button secondary"
          type="button"
          onClick={onClose}
          disabled={busy}
        >
          {t("library.vocabulary.done")}
        </button>
      </div>
    </Modal>
  );
}

function MediaTypeEditor({
  state,
  busy,
  commit,
}: {
  state: LibraryState;
  busy: boolean;
  commit: Commit;
}) {
  const activeTypes = state.mediaTypes.filter((item) => !item.archivedAt);
  const activeCriteria = state.criteria.filter((item) => !item.archivedAt);
  const [draft, setDraft] = useState<MediaTypeDraft | null>(null);
  const [deletingTypeId, setDeletingTypeId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const selected = activeTypes.find((item) => item.id === draft?.id);
  const affectedEntries = deletingTypeId
    ? state.entries.filter((entry) => entry.mediaTypeId === deletingTypeId)
    : [];

  function edit(id: string) {
    const type = activeTypes.find((item) => item.id === id);
    if (!type) return;
    setDraft({
      id: type.id,
      name: type.name,
      sortOrder: type.sortOrder,
      criterionIds: [...type.criterionIds],
      iconKey: type.iconKey,
    });
    setDeletingTypeId(null);
    setConfirmClear(false);
  }

  function create() {
    setDraft({
      id: crypto.randomUUID(),
      name: "",
      sortOrder: activeTypes.length,
      criterionIds: [],
      iconKey: "shape-circle",
    });
    setDeletingTypeId(null);
    setConfirmClear(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await commit(
      (current) => saveMediaType(current.revision, draft),
      t("library.vocabulary.typeSaved"),
    );
  }

  async function archive() {
    if (!deletingTypeId) return;
    const item = state.mediaTypes.find((entry) => entry.id === deletingTypeId);
    const result = await commit(
      (current) =>
        archiveMediaType(current.revision, deletingTypeId, confirmClear),
      item ? t("library.vocabulary.typeArchivedNamed", { name: mediaTypeName(item.id, item.name) }) : t("library.vocabulary.typeArchived"),
    );
    if (!result) return;
    setDeletingTypeId(null);
    setConfirmClear(false);
    setDraft(null);
  }

  return (
    <div className="library-vocabulary-layout">
      <section className="library-vocabulary-list" aria-label={t("library.vocabulary.mediaTypes")}>
        <div className="library-vocabulary-list-heading">
          <h3>{t("library.vocabulary.mediaTypes")}</h3>
          <button
            className="button secondary small"
            type="button"
            onClick={create}
            disabled={busy}
          >
            <Plus size={14} /> {t("library.vocabulary.addType")}
          </button>
        </div>
        {activeTypes.map((type) => (
          <div
            className={`library-vocabulary-item ${selected?.id === type.id ? "selected" : ""}`}
            key={type.id}
          >
            <button type="button" onClick={() => edit(type.id)} disabled={busy}>
              <strong className="library-vocabulary-type-name">
                <MediaTypeIcon iconKey={type.iconKey} />
                {mediaTypeName(type.id, type.name)}
              </strong>
              <small>
                {t("library.vocabulary.criterionCount", { count: type.criterionIds.length })} ·{" "}
                {
                  state.entries.filter((entry) => entry.mediaTypeId === type.id)
                    .length
                }{" "}
                {t(state.entries.filter((entry) => entry.mediaTypeId === type.id).length === 1 ? "library.ui.work" : "library.ui.works")}
              </small>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("library.vocabulary.archiveNamed", { name: mediaTypeName(type.id, type.name) })}
              onClick={() => {
                setDeletingTypeId(type.id);
                setConfirmClear(false);
                setDraft(null);
              }}
              disabled={busy}
            >
              <Archive size={15} />
            </button>
          </div>
        ))}
        {activeTypes.length === 0 && (
          <p className="field-hint">{t("library.vocabulary.noActiveTypes")}</p>
        )}
      </section>

      <section className="library-vocabulary-form">
        {draft ? (
          <form onSubmit={submit}>
            <h3>{t(selected ? "library.vocabulary.editType" : "library.vocabulary.newType")}</h3>
            <label className="field">
              <span>{t("library.vocabulary.name")}</span>
              <input
                required
                maxLength={100}
                value={draft.name}
                autoFocus
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <fieldset className="library-media-icon-picker">
              <legend>{t("library.mediaTypeIcon")}</legend>
              <p className="field-hint">{t("library.mediaTypeIconHint")}</p>
              <div className="library-media-icon-options" role="radiogroup" aria-label={t("library.mediaTypeIcon")}>
                {mediaTypeIconChoices.map(({ key, labelKey }) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={draft.iconKey === key}
                    aria-label={t(labelKey)}
                    title={t(labelKey)}
                    className={draft.iconKey === key ? "selected" : ""}
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, iconKey: key as MediaTypeIconKey })}
                  >
                    <MediaTypeIcon iconKey={key} size={18} />
                    <span>{t(labelKey)}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="field">
              <span>{t("library.vocabulary.displayOrder")}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={draft.sortOrder}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    sortOrder: Math.max(0, Number(event.target.value) || 0),
                  })
                }
              />
            </label>
            <fieldset className="library-criteria-picker">
              <legend>{t("library.vocabulary.scoringCriteria")}</legend>
              <p className="field-hint">
                {t("library.vocabulary.criteriaHint")}
              </p>
              {activeCriteria.map((criterion) => {
                const index = draft.criterionIds.indexOf(criterion.id);
                return (
                  <div className="library-criterion-choice" key={criterion.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={index >= 0}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            criterionIds:
                              index < 0
                                ? [...draft.criterionIds, criterion.id]
                                : draft.criterionIds.filter(
                                    (id) => id !== criterion.id,
                                  ),
                          })
                        }
                      />
                      <span>{criterionName(criterion.id, criterion.name)}</span>
                    </label>
                    {index >= 0 && (
                      <span className="library-criterion-order">
                        {index + 1}
                        <button
                          type="button"
                          aria-label={t("library.vocabulary.moveUp", { name: criterionName(criterion.id, criterion.name) })}
                          disabled={busy || index === 0}
                          onClick={() =>
                            reorderCriterion(draft, setDraft, index, index - 1)
                          }
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={t("library.vocabulary.moveDown", { name: criterionName(criterion.id, criterion.name) })}
                          disabled={
                            busy || index === draft.criterionIds.length - 1
                          }
                          onClick={() =>
                            reorderCriterion(draft, setDraft, index, index + 1)
                          }
                        >
                          <ArrowDown size={13} />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
              {activeCriteria.length === 0 && (
                <p className="field-hint">
                  {t("library.vocabulary.addCriterionFirst")}
                </p>
              )}
            </fieldset>
            <div className="library-vocabulary-actions">
              <button
                className="button primary"
                type="submit"
                disabled={busy || !draft.name.trim()}
              >
                <Save size={14} /> {t("library.vocabulary.saveType")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setDraft(null)}
                disabled={busy}
              >
                {t("library.vocabulary.cancel")}
              </button>
            </div>
          </form>
        ) : deletingTypeId ? (
          <div className="library-vocabulary-impact">
            <h3>{t("library.vocabulary.archiveTypeQuestion")}</h3>
            <p>
              {t("library.vocabulary.archiveTypeDescription")}
            </p>
            {affectedEntries.length > 0 ? (
              <>
                <strong>
                  {t("library.vocabulary.workCount", { count: affectedEntries.length })}
                </strong>
                <ul aria-label={t("library.vocabulary.affectedWorks")}>
                  {affectedEntries.map((entry) => (
                    <li key={entry.id}>{entry.title}</li>
                  ))}
                </ul>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmClear}
                    onChange={(event) => setConfirmClear(event.target.checked)}
                  />
                  <span>{t("library.vocabulary.clearTypeFromWorks")}</span>
                </label>
              </>
            ) : (
              <p>
                {t("library.vocabulary.noEntriesUseType")}
              </p>
            )}
            <div className="library-vocabulary-actions">
              <button
                className="button danger"
                type="button"
                onClick={() => void archive()}
                disabled={busy || (affectedEntries.length > 0 && !confirmClear)}
              >
                {t("library.vocabulary.archiveType")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setDeletingTypeId(null)}
                disabled={busy}
              >
                {t("library.vocabulary.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="library-vocabulary-empty">
            <Tags size={23} />
            <p>{t("library.vocabulary.selectTypeHint")}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function reorderCriterion(
  draft: MediaTypeDraft,
  setDraft: (draft: MediaTypeDraft) => void,
  from: number,
  to: number,
) {
  const criterionIds = [...draft.criterionIds];
  [criterionIds[from], criterionIds[to]] = [
    criterionIds[to],
    criterionIds[from],
  ];
  setDraft({ ...draft, criterionIds });
}

function CriterionEditor({
  state,
  busy,
  commit,
}: {
  state: LibraryState;
  busy: boolean;
  commit: Commit;
}) {
  const activeCriteria = state.criteria.filter((item) => !item.archivedAt);
  const [draft, setDraft] = useState<CriterionDraft | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const activeTypes = state.mediaTypes.filter((item) => !item.archivedAt);
  const impactedTypes = archiveId
    ? activeTypes.filter((type) => type.criterionIds.includes(archiveId))
    : [];
  const usedTypeIds = new Set(
    impactedTypes
      .filter((type) =>
        state.entries.some((entry) => entry.mediaTypeId === type.id),
      )
      .map((type) => type.id),
  );
  const affectedEntries = archiveId
    ? state.entries.filter(
        (entry) => entry.mediaTypeId && usedTypeIds.has(entry.mediaTypeId),
      )
    : [];
  const selected = activeCriteria.find((item) => item.id === draft?.id);
  const selectedTypes = draft
    ? activeTypes.filter((type) => type.criterionIds.includes(draft.id))
    : [];

  function edit(id: string) {
    const item = activeCriteria.find((criterion) => criterion.id === id);
    if (!item) return;
    setDraft({
      id: item.id,
      name: item.name,
      description: item.description,
      sortOrder: item.sortOrder,
    });
    setArchiveId(null);
    setConfirmArchive(false);
  }
  function create() {
    setDraft({
      id: crypto.randomUUID(),
      name: "",
      description: null,
      sortOrder: state.criteria.length,
    });
    setArchiveId(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await commit(
      (current) => saveCriterion(current.revision, draft),
      t("library.vocabulary.criterionSaved"),
    );
  }
  async function archive() {
    if (!archiveId) return;
    const item = state.criteria.find((criterion) => criterion.id === archiveId);
    const result = await commit(
      (current) =>
        archiveCriterion(current.revision, archiveId, confirmArchive),
      item ? t("library.vocabulary.criterionArchivedNamed", { name: criterionName(item.id, item.name) }) : t("library.vocabulary.criterionArchived"),
    );
    if (!result) return;
    setArchiveId(null);
    setConfirmArchive(false);
    setDraft(null);
  }

  return (
    <div className="library-vocabulary-layout">
      <section
        className="library-vocabulary-list"
        aria-label={t("library.vocabulary.scoringCriteria")}
      >
        <div className="library-vocabulary-list-heading">
          <h3>{t("library.vocabulary.criteria")}</h3>
          <button
            className="button secondary small"
            type="button"
            onClick={create}
            disabled={busy}
          >
            <Plus size={14} /> {t("library.vocabulary.addCriterion")}
          </button>
        </div>
        {activeCriteria.map((item) => (
          <div
            className={`library-vocabulary-item ${selected?.id === item.id ? "selected" : ""}`}
            key={item.id}
          >
            <button type="button" onClick={() => edit(item.id)} disabled={busy}>
              <strong>{criterionName(item.id, item.name)}</strong>
              <small>
                {
                  activeTypes.filter((type) =>
                    type.criterionIds.includes(item.id),
                  ).length
                }{" "}
                {t(activeTypes.filter((type) => type.criterionIds.includes(item.id)).length === 1 ? "library.vocabulary.mediaTypeSingular" : "library.vocabulary.mediaTypePlural")}
              </small>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("library.vocabulary.archiveNamed", { name: criterionName(item.id, item.name) })}
              onClick={() => {
                setArchiveId(item.id);
                setConfirmArchive(false);
                setDraft(null);
              }}
              disabled={busy}
            >
              <Archive size={15} />
            </button>
          </div>
        ))}
      </section>
      <section className="library-vocabulary-form">
        {draft ? (
          <form onSubmit={submit}>
            <h3>{t(selected ? "library.vocabulary.editCriterion" : "library.vocabulary.newCriterion")}</h3>
            <label className="field">
              <span>{t("library.vocabulary.name")}</span>
              <input
                required
                maxLength={100}
                autoFocus
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>
                {t("library.vocabulary.descriptionOptional")} <small>({t("library.vocabulary.optional")})</small>
              </span>
              <textarea
                maxLength={20_000}
                rows={4}
                value={draft.description ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    description: event.target.value || null,
                  })
                }
              />
            </label>
            <label className="field">
              <span>{t("library.vocabulary.displayOrder")}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={draft.sortOrder}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    sortOrder: Math.max(0, Number(event.target.value) || 0),
                  })
                }
              />
            </label>
            {selectedTypes.length > 0 && (
              <p className="field-hint">
                {t("library.vocabulary.usedBy", { types: selectedTypes.map((type) => mediaTypeName(type.id, type.name)).join(", ") })}
              </p>
            )}
            <div className="library-vocabulary-actions">
              <button
                className="button primary"
                type="submit"
                disabled={busy || !draft.name.trim()}
              >
                <Save size={14} /> {t("library.vocabulary.saveCriterion")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setDraft(null)}
                disabled={busy}
              >
                {t("library.vocabulary.cancel")}
              </button>
            </div>
          </form>
        ) : archiveId ? (
          <div className="library-vocabulary-impact">
            <h3>{t("library.vocabulary.archiveCriterionQuestion")}</h3>
            <p>
              {t("library.vocabulary.criterionArchiveDescription")}
            </p>
            {usedTypeIds.size > 0 ? (
              <>
                <strong>
                  {t("library.vocabulary.criterionAffectedSummary", { typeCount: usedTypeIds.size, workCount: affectedEntries.length })}
                </strong>
                <p>
                  {t("library.vocabulary.removedFromForms", { types: impactedTypes.map((type) => mediaTypeName(type.id, type.name)).join(", ") })}
                </p>
                <ul aria-label={t("library.vocabulary.affectedWorks")}>
                  {affectedEntries.map((entry) => (
                    <li key={entry.id}>{entry.title}</li>
                  ))}
                </ul>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmArchive}
                    onChange={(event) =>
                      setConfirmArchive(event.target.checked)
                    }
                  />
                  <span>{t("library.vocabulary.removeCriterionFromTypes")}</span>
                </label>
              </>
            ) : impactedTypes.length > 0 ? (
              <>
                <p>
                  {t("library.vocabulary.noEntriesUseMediaTypes")}
                </p>
                <p>{impactedTypes.map((type) => mediaTypeName(type.id, type.name)).join(", ")}</p>
              </>
            ) : (
              <p>
                {t("library.vocabulary.noTypeSelectsCriterion")}
              </p>
            )}
            <div className="library-vocabulary-actions">
              <button
                className="button danger"
                type="button"
                onClick={() => void archive()}
                disabled={busy || (usedTypeIds.size > 0 && !confirmArchive)}
              >
                {t("library.vocabulary.archiveCriterion")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setArchiveId(null)}
                disabled={busy}
              >
                {t("library.vocabulary.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="library-vocabulary-empty">
            <Tags size={23} />
            <p>{t("library.vocabulary.selectCriterionHint")}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function TagEditor({
  state,
  busy,
  commit,
}: {
  state: LibraryState;
  busy: boolean;
  commit: Commit;
}) {
  const [tagId, setTagId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [showMergePreview, setShowMergePreview] = useState(false);
  const [undoDelete, setUndoDelete] = useState<{
    id: string;
    name: string;
    entryIds: string[];
  } | null>(null);
  const activeTags = useMemo(
    () => [...state.tags].sort((a, b) => a.name.localeCompare(b.name)),
    [state.tags],
  );
  const source = activeTags.find((item) => item.id === mergeSource);
  const target = activeTags.find((item) => item.id === mergeTarget);
  const affectedEntries = source
    ? state.entries.filter((entry) => entry.tagIds.includes(source.id))
    : [];

  function edit(id: string) {
    const item = state.tags.find((tag) => tag.id === id);
    if (!item) return;
    setTagId(item.id);
    setName(item.name);
    setShowMergePreview(false);
  }
  function create() {
    setTagId(null);
    setName("");
    setShowMergePreview(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedId = tagId ?? crypto.randomUUID();
    await commit(
      (current) => saveTag(current.revision, { id: normalizedId, name }),
      t(tagId ? "library.vocabulary.tagRenamed" : "library.vocabulary.tagCreated"),
    );
    setTagId(normalizedId);
  }
  async function remove(id: string) {
    const item = state.tags.find((tag) => tag.id === id);
    if (!item) return;
    const result = await commit(
      (current) => deleteTag(current.revision, id),
      t("library.vocabulary.tagRemovedNamed", { name: item.name }),
    );
    if (result) {
      setUndoDelete({
        id: item.id,
        name: item.name,
        entryIds: state.entries
          .filter((entry) => entry.tagIds.includes(id))
          .map((entry) => entry.id),
      });
      if (tagId === id) create();
    }
  }
  async function undo() {
    if (!undoDelete) return;
    const deleted = undoDelete;
    const result = await commit(async (current) => {
      let next = await saveTag(current.revision, {
        id: deleted.id,
        name: deleted.name,
      });
      for (const entryId of deleted.entryIds) {
        const entry = next.entries.find((item) => item.id === entryId);
        if (!entry) continue;
        next = await saveEntry(next.revision, {
          id: entry.id,
          title: entry.title,
          disposition: entry.disposition,
          mediaTypeId: entry.mediaTypeId,
          overallRating: entry.overallRating,
          coverAssetId: entry.coverAssetId,
          releaseDate: entry.releaseDate,
          reviewText: entry.reviewText,
          shortLabel: entry.shortLabel,
          criterionRatings: entry.criterionRatings,
          tagIds: [...new Set([...entry.tagIds, deleted.id])],
        });
      }
      return next;
    }, t("library.vocabulary.tagRestoredNamed", { name: deleted.name }));
    if (result) setUndoDelete(null);
  }
  async function merge() {
    if (!source || !target) return;
    const result = await commit(
      (current) => mergeTags(current.revision, source.id, target.id),
      t("library.vocabulary.tagsMergedNamed", { source: source.name, target: target.name }),
    );
    if (!result) return;
    setMergeSource("");
    setMergeTarget("");
    setShowMergePreview(false);
    if (tagId === source.id) create();
  }

  return (
    <div className="library-tags-layout">
      <section className="library-vocabulary-list" aria-label={t("library.vocabulary.tags")}>
        <div className="library-vocabulary-list-heading">
          <h3>{t("library.vocabulary.tags")}</h3>
          <button
            className="button secondary small"
            type="button"
            onClick={create}
            disabled={busy}
          >
            <Plus size={14} /> {t("library.vocabulary.addTag")}
          </button>
        </div>
        {activeTags.map((tag) => (
          <div
            className={`library-vocabulary-item ${tagId === tag.id ? "selected" : ""}`}
            key={tag.id}
          >
            <button type="button" onClick={() => edit(tag.id)} disabled={busy}>
              <strong>{tag.name}</strong>
              <small>
                {
                  state.entries.filter((entry) => entry.tagIds.includes(tag.id))
                    .length
                }{" "}
                {t(state.entries.filter((entry) => entry.tagIds.includes(tag.id)).length === 1 ? "library.ui.work" : "library.ui.works")}
              </small>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("library.vocabulary.deleteTag", { name: tag.name })}
              onClick={() => void remove(tag.id)}
              disabled={busy}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {activeTags.length === 0 && (
          <p className="field-hint">
            {t("library.vocabulary.emptyTagsHint")}
          </p>
        )}
        {undoDelete && (
          <div className="library-tag-undo" role="status">
            <span>{t("library.vocabulary.tagRemoved")}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => void undo()}
              disabled={busy}
            >
              {t("library.vocabulary.undo")}
            </button>
          </div>
        )}
      </section>
      <section className="library-vocabulary-form">
        <form onSubmit={submit}>
          <h3>{t(tagId ? "library.vocabulary.renameTag" : "library.vocabulary.createTag")}</h3>
          <label className="field">
            <span>{t("library.vocabulary.name")}</span>
            <input
              required
              maxLength={100}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="library-vocabulary-actions">
            <button
              className="button primary"
              type="submit"
              disabled={busy || !name.trim()}
            >
              <Save size={14} /> {t(tagId ? "library.vocabulary.saveTag" : "library.vocabulary.createTag")}
            </button>
          </div>
        </form>
        <div className="library-tag-merge">
          <h3>{t("library.vocabulary.mergeTags")}</h3>
          <p>
            {t("library.vocabulary.mergeTagsDescription")}
          </p>
          <label className="field">
            <span>{t("library.vocabulary.mergeFrom")}</span>
            <SelectControl
              value={mergeSource}
              onValueChange={(value) => {
                setMergeSource(value);
                setShowMergePreview(false);
              }}
            >
              <option value="">{t("library.vocabulary.chooseTag")}</option>
              {activeTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </SelectControl>
          </label>
          <label className="field">
            <span>{t("library.vocabulary.mergeInto")}</span>
            <SelectControl
              value={mergeTarget}
              onValueChange={(value) => {
                setMergeTarget(value);
                setShowMergePreview(false);
              }}
            >
              <option value="">{t("library.vocabulary.chooseTag")}</option>
              {activeTags
                .filter((tag) => tag.id !== mergeSource)
                .map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
            </SelectControl>
          </label>
          {showMergePreview && source && target && (
            <div className="library-vocabulary-impact">
              <strong>
                {t("library.vocabulary.workCount", { count: affectedEntries.length })}
              </strong>
              <ul aria-label={t("library.vocabulary.worksAffectedByMerge")}>
                {affectedEntries.map((entry) => (
                  <li key={entry.id}>{entry.title}</li>
                ))}
              </ul>
              <div className="library-vocabulary-actions">
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void merge()}
                  disabled={busy}
                >
                  {t("library.vocabulary.confirmMerge")}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setShowMergePreview(false)}
                  disabled={busy}
                >
                  {t("library.vocabulary.cancel")}
                </button>
              </div>
            </div>
          )}
          {!showMergePreview && (
            <button
              className="button secondary"
              type="button"
              onClick={() => setShowMergePreview(true)}
              disabled={busy || !source || !target}
            >
              {t("library.vocabulary.previewMerge")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
