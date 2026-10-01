import {
  CalendarDays,
  CircleHelp,
  ImagePlus,
  Star,
  Tag as TagIcon,
} from "lucide-react";
import type {
  Entry as LibraryEntry,
  LibraryState,
} from "../../shared/bridge/libraryTypes";
import { t } from "../../shared/ui/i18n";
import { criterionName, mediaTypeName, MediaTypeIcon } from "./MediaTypeIcon";
import type { LibraryRankIndex } from "./domain/rankDisplay";

function releaseText(
  date: NonNullable<LibraryEntry["releaseDate"]> | null,
): string {
  if (!date) return t("library.ui.unknownYear");
  if (date.precision === "year") return String(date.year);
  if (date.precision === "month")
    return `${date.year}-${String(date.month ?? 1).padStart(2, "0")}`;
  return `${date.year}-${String(date.month ?? 1).padStart(2, "0")}-${String(date.day ?? 1).padStart(2, "0")}`;
}

function formatDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime())
    ? t("library.ui.recentlyAdded")
    : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(parsed);
}

export interface LibraryWorkDetailsProps {
  entry: LibraryEntry;
  state: LibraryState;
  rankIndex: LibraryRankIndex;
  coverUrl: string | null;
  outsideFilters?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function LibraryWorkDetails({
  entry,
  state,
  rankIndex,
  coverUrl,
  outsideFilters = false,
  onEdit,
  onDelete,
}: LibraryWorkDetailsProps) {
  const type =
    state.mediaTypes.find((item) => item.id === entry.mediaTypeId) ?? null;
  const tags = state.tags.filter((tag) => entry.tagIds.includes(tag.id));
  const criteria = state.criteria;
  const sameScorePosition = rankIndex.withinScore.get(entry.id);
  const overallPosition = rankIndex.overall.get(entry.id);
  const activeCriterionIds = new Set(type?.criterionIds ?? []);
  const activeRatings = criteria
    .filter(
      (criterion) =>
        activeCriterionIds.has(criterion.id) &&
        entry.criterionRatings[criterion.id],
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const retainedRatings = criteria
    .filter(
      (criterion) =>
        !activeCriterionIds.has(criterion.id) &&
        entry.criterionRatings[criterion.id],
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="library-detail-content">
      {outsideFilters && (
        <div className="library-detail-notice">
          <CircleHelp size={14} />
          {t("library.ui.outsideResults")}
        </div>
      )}
      <div className="detail-cover-frame">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={t("library.ui.coverFor", { title: entry.title })}
          />
        ) : entry.coverAssetId ? (
          <span className="cover-unavailable">
            <ImagePlus size={20} />
            {t("library.ui.coverSaved")}
          </span>
        ) : (
          <span className="detail-cover-placeholder">
            <MediaTypeIcon iconKey={type?.iconKey} size={28} />
            <b>{entry.title.slice(0, 1).toUpperCase()}</b>
          </span>
        )}
      </div>
      <div className="detail-title-block">
        <span className="micro-label">
          {type
            ? mediaTypeName(type.id, type.name)
            : t("library.ui.noTypeUpper")}
          {entry.releaseDate ? ` · ${releaseText(entry.releaseDate)}` : ""}
        </span>
        <h2>{entry.title}</h2>
        <span className={`disposition-badge ${entry.disposition}`}>
          {entry.disposition === "planned"
            ? t("library.ui.group.planned")
            : entry.disposition === "dropped"
              ? t("library.ui.group.dropped")
              : entry.overallRating === null
                ? t("library.ui.experiencedUnrated")
                : t("library.ui.experienced")}
        </span>
      </div>
      {entry.overallRating !== null ? (
        <section className="detail-section score-detail">
          <span className="micro-label">{t("library.ui.overallRating")}</span>
          <strong>
            <Star size={19} fill="currentColor" />
            {entry.overallRating}
            <small>/10</small>
          </strong>
          {sameScorePosition !== undefined && overallPosition !== undefined && (
            <div className="detail-rank-grid">
              <span>
                {t("library.ui.withinScore")} <b>#{sameScorePosition}</b>
              </span>
              <span>
                {t("library.ui.overall")}{" "}
                <b>
                  #{overallPosition} of {rankIndex.totalPlaced}
                </b>
              </span>
              {rankIndex.totalPlaced > 1 && (
                <span>
                  {t("library.ui.topPercent")}{" "}
                  <b>
                    {Math.max(
                      0.1,
                      Math.round(
                        (overallPosition / rankIndex.totalPlaced) * 1000,
                      ) / 10,
                    )}
                    %
                  </b>
                </span>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="detail-section">
          <span className="micro-label">{t("library.ui.overallRating")}</span>
          <p className="detail-not-rated">{t("library.ui.notRated")}</p>
        </section>
      )}
      {tags.length > 0 && (
        <section className="detail-section">
          <span className="micro-label">
            <TagIcon size={12} /> {t("library.ui.tagsUpper")}
          </span>
          <div className="detail-tags">
            {tags.map((tag) => (
              <span key={tag.id}>{tag.name}</span>
            ))}
          </div>
        </section>
      )}
      {(activeRatings.length > 0 || retainedRatings.length > 0) && (
        <section className="detail-section">
          <span className="micro-label">
            {t("library.ui.criterionScoresUpper")}
          </span>
          <div className="detail-criteria-list">
            {activeRatings.map((criterion) => (
              <div key={criterion.id}>
                <span>{criterionName(criterion.id, criterion.name)}</span>
                <b>{entry.criterionRatings[criterion.id]}/10</b>
              </div>
            ))}
          </div>
          {retainedRatings.length > 0 && (
            <details className="retained-score-details">
              <summary>{t("library.ui.previousCriteria")}</summary>
              <div className="detail-criteria-list">
                {retainedRatings.map((criterion) => (
                  <div key={criterion.id}>
                    <span>{criterionName(criterion.id, criterion.name)}</span>
                    <b>{entry.criterionRatings[criterion.id]}/10</b>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}
      {entry.reviewText.trim() && (
        <section className="detail-section">
          <span className="micro-label">{t("library.yourThoughts")}</span>
          <p className="detail-prose">{entry.reviewText}</p>
        </section>
      )}
      <section className="detail-section entry-metadata">
        <span>
          <CalendarDays size={13} />
          {t("library.ui.addedDate", { date: formatDate(entry.createdAt) })}
        </span>
      </section>
      <div className="detail-actions">
        <button className="button primary" onClick={onEdit}>
          {t("library.ui.editWork")}
        </button>
        <button className="text-button danger-link" onClick={onDelete}>
          {t("library.ui.moveToTrash")}
        </button>
      </div>
    </div>
  );
}
