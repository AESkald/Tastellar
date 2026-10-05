//! Local, review-before-commit imports. Uploaded data is parsed in memory; no
//! source files are extracted or retained after the staging session expires.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::Read,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use flate2::read::{DeflateDecoder, GzDecoder};
use quick_xml::{events::Event as XmlEvent, Reader as XmlReader};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tastellar_domain::{
    validate_external_identities, validate_remote_cover, Entry, ExternalIdentity, LibraryState,
    ReleaseDate, RemoteCoverReference,
};

use crate::{
    catalog::CatalogCoverDownload, now_epoch, now_nanos, now_rfc3339, Storage, StorageError,
};

pub const IMPORT_SCHEMA_VERSION: u32 = 1;
const MAX_UPLOAD_BYTES: usize = 12 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES: usize = 24 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES: usize = 32 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;
const MAX_IMPORTED_COVER_BYTES: usize = 80 * 1024 * 1024;
const MAX_CELL_CHARS: usize = 100_000;
const SESSION_LIFETIME: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportUpload {
    pub provider: String,
    pub file_name: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourceSummary {
    pub provider: String,
    pub source_name: String,
    pub row_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRating {
    pub value: f64,
    pub scale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProgress {
    pub unit: String,
    pub current: f64,
    pub total: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourceActivity {
    pub fingerprint: String,
    pub kind: String,
    pub date_fields: BTreeMap<String, String>,
    pub rating: Option<SourceRating>,
    pub rewatch: Option<bool>,
    pub tags: Vec<String>,
    pub has_review: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub entry_id: Option<String>,
    pub source_row_id: Option<String>,
    pub title: String,
    pub media_type_id: Option<String>,
    pub year: Option<i32>,
    pub provider: Option<String>,
    pub external_id: Option<String>,
    pub reason: String,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourceRow {
    pub row_id: String,
    pub provider: String,
    pub provider_media_type: Option<String>,
    pub external_id: Option<String>,
    #[serde(default)]
    pub source_identities: Vec<ExternalIdentity>,
    pub source_url: Option<String>,
    pub title: String,
    pub original_title: Option<String>,
    pub creators: Vec<String>,
    pub year: Option<i32>,
    pub release_date: Option<ReleaseDate>,
    pub source_status: Option<String>,
    pub source_rating: Option<SourceRating>,
    pub source_dates: BTreeMap<String, String>,
    pub source_activities: Vec<ImportSourceActivity>,
    #[serde(default)]
    pub source_metadata: BTreeMap<String, String>,
    #[serde(default)]
    pub review_text: Option<String>,
    pub tags: Vec<String>,
    pub progress: Option<SourceProgress>,
    pub suggested_media_type_id: Option<String>,
    pub exact_entry_id: Option<String>,
    pub candidates: Vec<ImportCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub schema_version: u32,
    pub session_id: String,
    pub expected_revision: i64,
    pub sources: Vec<ImportSourceSummary>,
    pub rows: Vec<ImportSourceRow>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRatingSelection {
    pub source_row_id: String,
    pub accept_native: bool,
    #[serde(default)]
    pub overwrite_existing_rating: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTagMapping {
    pub row_id: String,
    pub source_tag: String,
    pub action: String,
    pub tag_id: Option<String>,
    pub new_tag_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDecision {
    pub row_ids: Vec<String>,
    pub action: String,
    pub target_entry_id: Option<String>,
    pub title: Option<String>,
    pub media_type_id: Option<String>,
    pub disposition: Option<String>,
    #[serde(default)]
    pub import_reviews: bool,
    #[serde(default)]
    pub overwrite_existing_disposition: bool,
    #[serde(default)]
    pub overwrite_existing_review: bool,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub new_tag_names: Vec<String>,
    pub manual_overall_rating: Option<i32>,
    #[serde(default)]
    pub overwrite_existing_metadata: bool,
    #[serde(default)]
    pub rating_selections: Vec<ImportRatingSelection>,
    #[serde(default)]
    pub tag_mappings: Vec<ImportTagMapping>,
    #[serde(default)]
    pub enrichments: Vec<ImportEnrichment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEnrichment {
    pub source_row_id: String,
    pub title: String,
    pub release_date: Option<ReleaseDate>,
    #[serde(default)]
    pub external_identities: Vec<ExternalIdentity>,
    pub remote_cover: Option<RemoteCoverReference>,
    #[serde(default)]
    pub overwrite_existing_metadata: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRatingPolicy {
    pub mode: String,
    #[serde(default)]
    pub priority: Vec<String>,
    #[serde(default)]
    pub manual_selections: Vec<ManualRatingSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualRatingSelection {
    pub row_ids: Vec<String>,
    pub source_row_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitInput {
    pub schema_version: u32,
    pub session_id: String,
    pub expected_revision: i64,
    pub decisions: Vec<ImportDecision>,
    pub rating_policy: ImportRatingPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitResult {
    pub library: LibraryState,
    pub batch_id: String,
    pub created: usize,
    pub linked: usize,
    pub skipped: usize,
    #[serde(default)]
    pub cover_failures: Vec<ImportCoverFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCoverFailure {
    pub source_row_id: String,
    pub title: String,
    pub message: String,
    pub provider: String,
    pub url: String,
    #[serde(default)]
    pub entry_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportUndoResult {
    pub library: LibraryState,
    pub batch_id: String,
    pub created: usize,
    pub linked: usize,
    pub skipped: usize,
}

struct PreparedImportCover {
    hash: String,
    relative_path: String,
    mime_type: String,
    byte_length: usize,
    width: u32,
    height: u32,
}

fn register_import_cover(
    tx: &Transaction<'_>,
    cover: &PreparedImportCover,
) -> Result<(), StorageError> {
    tx.execute(
        "INSERT OR IGNORE INTO assets(hash,relative_path,mime_type,byte_length,width,height,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            cover.hash,
            cover.relative_path,
            cover.mime_type,
            cover.byte_length as i64,
            cover.width as i64,
            cover.height as i64,
            now_epoch(),
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamImportOptions {
    pub steam_id: String,
    #[serde(default)]
    pub include_played_free_games: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareImportInput {
    pub schema_version: u32,
    #[serde(default)]
    pub uploads: Vec<ImportUpload>,
    pub steam: Option<SteamImportOptions>,
}

#[derive(Debug, Clone)]
pub struct ImportSession {
    pub preview: ImportPreview,
    created_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportBatchEntry {
    entry_id: String,
    action: String,
    before: Option<EntrySnapshot>,
    after: EntrySnapshot,
    post_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntrySnapshot {
    pub(crate) entry: Entry,
    group_id: Option<String>,
    order_key: Option<String>,
    ranking_score: Option<i32>,
    ranking_placed: bool,
    #[serde(default)]
    ranking_boundaries: Vec<ImportBoundarySnapshot>,
    #[serde(default)]
    ranking_judgments: Vec<(String, bool)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ImportBoundarySnapshot {
    id: String,
    score: i32,
    first_id: String,
    second_id: String,
    preferred_id: String,
    weight: f64,
    protected: bool,
}

#[derive(Debug, Clone)]
pub struct CommittedImportBatch {
    pub id: String,
}

/// Public parser entry point used by fixture tests. It never opens paths or extracts files.
pub fn parse_import_uploads(
    uploads: &[ImportUpload],
) -> Result<(Vec<ImportSourceSummary>, Vec<ImportSourceRow>, Vec<String>), StorageError> {
    if uploads.is_empty() {
        return Err(StorageError::Validation(
            "Choose at least one import file".into(),
        ));
    }
    let mut decoded_total = 0usize;
    let mut expanded_total = 0usize;
    let mut summaries = Vec::new();
    let mut all_rows = Vec::new();
    let mut warnings = Vec::new();
    for (upload_index, upload) in uploads.iter().enumerate() {
        let provider = canonical_import_provider(&upload.provider)?;
        if upload.content_base64.len() > MAX_UPLOAD_BYTES.saturating_mul(4) / 3 + 8 {
            return Err(StorageError::Validation(
                "An import file is too large".into(),
            ));
        }
        let bytes = BASE64
            .decode(upload.content_base64.as_bytes())
            .map_err(|_| StorageError::Validation("An import file is not valid base64".into()))?;
        if bytes.len() > MAX_UPLOAD_BYTES {
            return Err(StorageError::Validation(
                "Each import file must be 12 MiB or smaller".into(),
            ));
        }
        decoded_total = decoded_total.saturating_add(bytes.len());
        if decoded_total > MAX_TOTAL_UPLOAD_BYTES {
            return Err(StorageError::Validation(
                "Combined import files must be 24 MiB or smaller".into(),
            ));
        }
        let file_name = safe_file_name(&upload.file_name);
        let mut local_warnings = Vec::new();
        let parsed = if provider == "letterboxd"
            && (file_name.ends_with(".zip") || bytes.starts_with(b"PK\x03\x04"))
        {
            expanded_total = expanded_total.saturating_add(bytes.len());
            let files = read_letterboxd_zip(&bytes)?;
            let consumed: usize = files.values().map(Vec::len).sum();
            expanded_total = expanded_total.saturating_add(consumed);
            if expanded_total > MAX_ZIP_EXPANDED_BYTES {
                return Err(StorageError::Validation(
                    "The expanded Letterboxd export exceeds 32 MiB".into(),
                ));
            }
            parse_letterboxd_files(upload_index, &files, &mut local_warnings)?
        } else if provider == "myAnimeList"
            && (file_name.ends_with(".xml")
                || file_name.ends_with(".xml.gz")
                || file_name.ends_with(".gz")
                || bytes.starts_with(&[0x1f, 0x8b]))
        {
            let xml_bytes = if file_name.ends_with(".gz") || bytes.starts_with(&[0x1f, 0x8b]) {
                let mut decoder = GzDecoder::new(&bytes[..]);
                let mut decoded = Vec::new();
                decoder
                    .take((MAX_UPLOAD_BYTES + 1) as u64)
                    .read_to_end(&mut decoded)?;
                if decoded.len() > MAX_UPLOAD_BYTES {
                    return Err(StorageError::Validation(
                        "Expanded MAL XML must be 12 MiB or smaller".into(),
                    ));
                }
                decoded
            } else {
                bytes
            };
            expanded_total = expanded_total.saturating_add(xml_bytes.len());
            if expanded_total > MAX_ZIP_EXPANDED_BYTES {
                return Err(StorageError::Validation(
                    "Expanded import data must be 32 MiB or smaller".into(),
                ));
            }
            let xml = std::str::from_utf8(&xml_bytes)
                .map_err(|_| StorageError::Validation("MAL XML is not UTF-8".into()))?;
            parse_mal_xml(upload_index, xml, &mut local_warnings)?
        } else if provider == "myAnimeList" && file_name.ends_with(".txt") {
            parse_mal_title_list(upload_index, &bytes, &mut local_warnings)?
        } else {
            if provider == "myAnimeList"
                && (file_name.ends_with(".xml") || file_name.ends_with(".gz"))
            {
                return Err(StorageError::Validation(
                    "MAL gzip/XML input is not valid XML".into(),
                ));
            }
            let csv = std::str::from_utf8(&bytes)
                .map_err(|_| StorageError::Validation(format!("{file_name} is not UTF-8 CSV")))?;
            parse_csv_rows(&provider, upload_index, csv, &mut local_warnings)?
        };
        summaries.push(ImportSourceSummary {
            provider: provider.clone(),
            source_name: file_name,
            row_count: parsed.len(),
            warnings: local_warnings.clone(),
        });
        if all_rows.len().saturating_add(parsed.len()) > MAX_ROWS {
            return Err(StorageError::Validation(
                "An import can contain up to 20,000 media rows".into(),
            ));
        }
        all_rows.extend(parsed);
        warnings.extend(local_warnings);
    }
    Ok((summaries, all_rows, warnings))
}

impl Storage {
    pub fn prepare_library_import(
        &mut self,
        input: PrepareImportInput,
    ) -> Result<ImportPreview, StorageError> {
        self.prepare_library_import_with_rows(input, Vec::new(), Vec::new())
    }

    pub fn prepare_library_import_with_rows(
        &mut self,
        input: PrepareImportInput,
        extra_rows: Vec<ImportSourceRow>,
        extra_sources: Vec<ImportSourceSummary>,
    ) -> Result<ImportPreview, StorageError> {
        if input.schema_version != IMPORT_SCHEMA_VERSION {
            return Err(StorageError::UnsupportedVersion);
        }
        if input.steam.is_some() {
            return Err(StorageError::Validation(
                "Steam import requires a configured Steam Web API session".into(),
            ));
        }
        self.expire_import_sessions();
        let (mut sources, mut rows, mut warnings) = if input.uploads.is_empty() {
            (Vec::new(), Vec::new(), Vec::new())
        } else {
            parse_import_uploads(&input.uploads)?
        };
        rows.extend(extra_rows);
        sources.extend(extra_sources);
        if rows.is_empty() {
            return Err(StorageError::Validation(
                "No media rows were found in the selected source".into(),
            ));
        }
        let library = self.load_library()?;
        populate_import_candidates(&mut rows, &library);
        let session_id = format!("import-{}", now_nanos());
        let preview = ImportPreview {
            schema_version: IMPORT_SCHEMA_VERSION,
            session_id: session_id.clone(),
            expected_revision: library.revision,
            sources,
            rows,
            warnings,
        };
        self.import_sessions.insert(
            session_id,
            ImportSession {
                preview: preview.clone(),
                created_at: Instant::now(),
            },
        );
        Ok(preview)
    }

    pub fn cancel_library_import(&mut self, session_id: &str) {
        self.import_sessions.remove(session_id);
    }

    pub fn commit_library_import(
        &mut self,
        input: ImportCommitInput,
    ) -> Result<ImportCommitResult, StorageError> {
        self.commit_library_import_with_catalog_covers(input, HashMap::new())
    }

    pub fn commit_library_import_with_catalog_covers(
        &mut self,
        input: ImportCommitInput,
        covers: HashMap<String, CatalogCoverDownload>,
    ) -> Result<ImportCommitResult, StorageError> {
        self.commit_library_import_with_catalog_covers_and_failures(input, covers, Vec::new())
    }

    pub fn commit_library_import_with_catalog_covers_and_failures(
        &mut self,
        input: ImportCommitInput,
        covers: HashMap<String, CatalogCoverDownload>,
        cover_failures: Vec<ImportCoverFailure>,
    ) -> Result<ImportCommitResult, StorageError> {
        if input.schema_version != IMPORT_SCHEMA_VERSION {
            return Err(StorageError::UnsupportedVersion);
        }
        self.expire_import_sessions();
        let session = self
            .import_sessions
            .get(&input.session_id)
            .cloned()
            .ok_or_else(|| {
                StorageError::Validation("Import preview expired. Prepare the files again.".into())
            })?;
        if input.expected_revision != session.preview.expected_revision {
            return Err(StorageError::Conflict);
        }
        let rows: HashMap<String, ImportSourceRow> = session
            .preview
            .rows
            .iter()
            .cloned()
            .map(|row| (row.row_id.clone(), row))
            .collect();
        validate_decisions(&input.decisions, &rows, &input.rating_policy)?;
        let mut failed_covers_by_row = HashMap::new();
        for failure in cover_failures {
            let selected = input.decisions.iter().any(|decision| {
                decision.action != "skip"
                    && decision.enrichments.iter().any(|enrichment| {
                        enrichment.source_row_id == failure.source_row_id
                            && enrichment.remote_cover.as_ref().is_some_and(|cover| {
                                cover.provider == failure.provider && cover.url == failure.url
                            })
                    })
            });
            if !selected
                || failure.title.trim().is_empty()
                || failure.title.chars().count() > 500
                || failure.message.trim().is_empty()
                || failure.message.chars().count() > 1000
                || failed_covers_by_row
                    .insert(failure.source_row_id.clone(), failure)
                    .is_some()
            {
                return Err(StorageError::Validation(
                    "A failed cover does not match a selected import item".into(),
                ));
            }
        }
        let mut total_cover_bytes = 0usize;
        let mut prepared_covers = HashMap::new();
        for (source_row_id, cover) in covers {
            let selected = input.decisions.iter().any(|decision| {
                decision.action != "skip"
                    && decision.enrichments.iter().any(|enrichment| {
                        enrichment.source_row_id == source_row_id
                            && enrichment.remote_cover.is_some()
                    })
            });
            if !selected {
                return Err(StorageError::Validation(
                    "A downloaded cover does not match a selected import item".into(),
                ));
            }
            total_cover_bytes = total_cover_bytes.saturating_add(cover.bytes.len());
            if total_cover_bytes > MAX_IMPORTED_COVER_BYTES {
                return Err(StorageError::Validation(
                    "Selected import covers exceed the 80 MB batch limit".into(),
                ));
            }
            let (extension, width, height) = crate::validate_image(&cover.mime_type, &cover.bytes)?;
            let hash = crate::hex_hash(&cover.bytes);
            let relative_path = format!("assets/{hash}.{extension}");
            self.stage_asset(&relative_path, &cover.bytes)?;
            if prepared_covers
                .insert(
                    source_row_id,
                    PreparedImportCover {
                        hash,
                        relative_path,
                        mime_type: cover.mime_type,
                        byte_length: cover.bytes.len(),
                        width,
                        height,
                    },
                )
                .is_some()
            {
                return Err(StorageError::Validation(
                    "Import contains duplicate cover selections".into(),
                ));
            }
        }
        let batch_id = format!("import-batch-{}", now_nanos());
        let now = now_rfc3339();
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, input.expected_revision)?;
        tx.execute("INSERT INTO import_batch(id,created_at,created_count,linked_count,skipped_count,undone) VALUES(?1,?2,0,0,0,0)", params![batch_id,now])?;
        let mut created = 0usize;
        let mut linked = 0usize;
        let mut skipped = 0usize;
        let mut library_changed = false;
        let mut snapshots: BTreeMap<String, ImportBatchEntry> = BTreeMap::new();
        let mut resolved_cover_failures = Vec::new();
        let mut reportable_cover_failures = HashSet::new();
        for decision in &input.decisions {
            if decision.action == "skip" {
                skipped += decision.row_ids.len();
                continue;
            }
            let source_rows: Vec<&ImportSourceRow> = decision
                .row_ids
                .iter()
                .map(|id| rows.get(id).unwrap())
                .collect();
            let (entry_id, before, is_new, metadata_changed, tags_changed) = if decision.action
                == "create"
            {
                let entry_id = format!("entry-import-{}", now_nanos());
                let enrichment = selected_enrichment(decision, &source_rows)?;
                let title = enrichment
                    .map(|item| item.title.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .or(decision.title.as_deref())
                    .unwrap_or(&source_rows[0].title)
                    .trim();
                if title.is_empty() || title.chars().count() > 500 {
                    return Err(StorageError::Validation(
                        "Choose a title between 1 and 500 characters".into(),
                    ));
                }
                // A new imported or searched work defaults to already experienced.
                // The review UI may still send an explicit planned/dropped choice.
                let disposition = decision.disposition.as_deref().unwrap_or("experienced");
                validate_disposition(disposition)?;
                let media_type_id = decision
                    .media_type_id
                    .as_deref()
                    .or(source_rows[0].suggested_media_type_id.as_deref());
                validate_media_type(&tx, media_type_id)?;
                let selected_rating = choose_rating(decision, &input.rating_policy, &source_rows);
                let rating = decision
                    .manual_overall_rating
                    .or_else(|| selected_rating.and_then(|(source, _)| rating_to_local(source)));
                let rating = if disposition == "experienced" {
                    rating
                } else {
                    None
                };
                let final_title = title.to_owned();
                let entry_id_owned = entry_id.clone();
                if let Some(score) = decision
                    .manual_overall_rating
                    .filter(|_| disposition == "experienced")
                {
                    if !(1..=10).contains(&score) {
                        return Err(StorageError::Validation(
                            "Your rating must be from 1 to 10".into(),
                        ));
                    }
                }
                let release_date = enrichment
                    .and_then(|item| item.release_date.as_ref())
                    .or(source_rows[0].release_date.as_ref());
                let downloaded_cover =
                    enrichment.and_then(|item| prepared_covers.get(&item.source_row_id));
                if let Some(cover) = downloaded_cover {
                    register_import_cover(&tx, cover)?;
                }
                if let Some(item) = enrichment.filter(|item| {
                    failed_covers_by_row.contains_key(&item.source_row_id)
                        && item.remote_cover.is_some()
                }) {
                    reportable_cover_failures.insert(item.source_row_id.clone());
                }
                let remote_cover = enrichment
                    .and_then(|item| item.remote_cover.as_ref())
                    .filter(|_| {
                        downloaded_cover.is_none()
                            && enrichment.map_or(true, |item| {
                                !failed_covers_by_row.contains_key(&item.source_row_id)
                            })
                    });
                let mut identities = collect_identities(&source_rows);
                if let Some(item) = enrichment {
                    identities.extend(item.external_identities.clone());
                }
                dedupe_identities(&mut identities);
                validate_external_identities(&identities)?;
                release_trashed_identity_owners(&tx, &identities)?;
                ensure_import_identity_owners(&tx, &identities, None)?;
                if let Some(cover) = remote_cover {
                    validate_remote_cover(cover)?;
                }
                tx.execute(
                    "INSERT INTO entry(id,title,disposition,media_type_id,overall_rating,cover_asset_id,release_year,release_month,release_day,release_precision,remote_cover_provider,remote_cover_url,remote_cover_source_url,remote_cover_attribution,created_at,updated_at,version,trashed_at,import_order) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,1,NULL,(SELECT COALESCE(MAX(import_order),-1)+1 FROM entry))",
                    params![entry_id_owned,final_title,disposition,media_type_id,rating,downloaded_cover.map(|cover| cover.hash.as_str()),release_date.map(|d|d.year),release_date.and_then(|d|d.month),release_date.and_then(|d|d.day),release_date.map(|d|d.precision.as_str()),remote_cover.map(|c|c.provider.as_str()),remote_cover.map(|c|c.url.as_str()),remote_cover.and_then(|c|c.source_url.as_deref()),remote_cover.and_then(|c|c.attribution.as_deref()),now],
                )?;
                if decision.import_reviews {
                    if let Some(review) = source_rows
                        .iter()
                        .find_map(|row| row.review_text.as_deref())
                        .filter(|value| !value.trim().is_empty())
                    {
                        tx.execute(
                            "UPDATE entry SET review_text=?1 WHERE id=?2",
                            params![review, entry_id],
                        )?;
                    }
                }
                for identity in identities {
                    tx.execute("INSERT INTO external_identity(provider,entity_kind,external_id,source_url,entry_id) VALUES(?1,?2,?3,?4,?5)",params![identity.provider,identity.entity_kind,identity.external_id,identity.source_url,entry_id])?;
                }
                let disposition_group = match (disposition, rating) {
                    ("planned", _) => "planned".to_owned(),
                    ("dropped", _) => "dropped".to_owned(),
                    ("experienced", Some(score)) => format!("rating-{score:02}"),
                    _ => "unrated".to_owned(),
                };
                if let Some(score) = rating {
                    tx.execute(
                        "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,0)",
                        params![entry_id, score],
                    )?;
                }
                let order_key = crate::ranking::next_order_key(&tx, &disposition_group)?;
                tx.execute(
                    "INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,?2,?3)",
                    params![entry_id, disposition_group, order_key],
                )?;
                let tags_changed = apply_import_tags(&tx, &entry_id, decision)?;
                created += 1;
                (entry_id, None, true, true, tags_changed)
            } else {
                let entry_id = decision
                    .target_entry_id
                    .as_deref()
                    .ok_or_else(|| {
                        StorageError::Validation("Choose an existing item to link".into())
                    })?
                    .to_owned();
                let before = load_entry_snapshot(&tx, &entry_id)?.ok_or_else(|| {
                    StorageError::Validation("The selected library item no longer exists".into())
                })?;
                let enrichment = selected_enrichment(decision, &source_rows)?;
                let title = if decision.overwrite_existing_metadata {
                    decision
                        .title
                        .as_deref()
                        .or_else(|| enrichment.map(|item| item.title.as_str()))
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                } else {
                    None
                };
                let selected_type = decision.media_type_id.as_deref().or_else(|| {
                    source_rows
                        .iter()
                        .find_map(|row| row.suggested_media_type_id.as_deref())
                });
                let media_type_id = if decision.overwrite_existing_metadata
                    || before.entry.media_type_id.is_none()
                {
                    selected_type
                } else {
                    None
                };
                let disposition = if decision.overwrite_existing_metadata
                    || decision.overwrite_existing_disposition
                {
                    decision.disposition.as_deref()
                } else {
                    None
                };
                if let Some(value) = disposition {
                    validate_disposition(value)?;
                }
                validate_media_type(&tx, media_type_id)?;
                let selected = choose_rating(decision, &input.rating_policy, &source_rows);
                let manual = decision.manual_overall_rating;
                if manual.is_some_and(|score| !(1..=10).contains(&score)) {
                    return Err(StorageError::Validation(
                        "Your rating must be from 1 to 10".into(),
                    ));
                }
                let rating =
                    manual.or_else(|| selected.and_then(|(source, _)| rating_to_local(source)));
                let final_disposition = disposition.unwrap_or(&before.entry.disposition);
                let selected_source_id = selected.map(|(_, source_id)| source_id);
                let can_overwrite = manual.is_some()
                    || selected_source_id.is_some_and(|source_id| {
                        decision.rating_selections.iter().any(|selection| {
                            selection.accept_native
                                && selection.overwrite_existing_rating
                                && selection.source_row_id == source_id
                        })
                    });
                let final_rating = if final_disposition != "experienced" {
                    None
                } else if before.entry.overall_rating.is_none() || can_overwrite {
                    rating.or(before.entry.overall_rating)
                } else {
                    before.entry.overall_rating
                };
                if final_rating.is_some() && final_disposition != "experienced" {
                    return Err(StorageError::Validation(
                        "A rated item must be marked experienced".into(),
                    ));
                }
                let final_title = title.unwrap_or(&before.entry.title);
                let final_type = media_type_id.or(before.entry.media_type_id.as_deref());
                let incoming_review = decision
                    .import_reviews
                    .then(|| {
                        source_rows
                            .iter()
                            .find_map(|row| row.review_text.as_deref())
                    })
                    .flatten()
                    .filter(|value| !value.trim().is_empty());
                let final_review = if incoming_review.is_some()
                    && (before.entry.review_text.trim().is_empty()
                        || decision.overwrite_existing_review)
                {
                    incoming_review.unwrap()
                } else {
                    before.entry.review_text.as_str()
                };
                let selected_release = enrichment
                    .and_then(|item| item.release_date.as_ref())
                    .or_else(|| source_rows.iter().find_map(|row| row.release_date.as_ref()));
                let release = if before.entry.release_date.is_none() {
                    selected_release
                } else if enrichment.is_some_and(|item| item.overwrite_existing_metadata) {
                    enrichment.and_then(|item| item.release_date.as_ref())
                } else {
                    None
                };
                let selected_cover = enrichment
                    .and_then(|item| item.remote_cover.as_ref())
                    .filter(|_| {
                        enrichment.is_some_and(|item| item.overwrite_existing_metadata)
                            || before.entry.cover_asset_id.is_none()
                    });
                if selected_cover.is_some()
                    && enrichment
                        .is_some_and(|item| failed_covers_by_row.contains_key(&item.source_row_id))
                {
                    if let Some(item) = enrichment {
                        reportable_cover_failures.insert(item.source_row_id.clone());
                    }
                }
                let cover = selected_cover.filter(|_| {
                    enrichment.map_or(true, |item| {
                        !failed_covers_by_row.contains_key(&item.source_row_id)
                    })
                });
                let downloaded_cover = cover.and_then(|_| {
                    enrichment.and_then(|item| prepared_covers.get(&item.source_row_id))
                });
                if let Some(cover) = downloaded_cover {
                    register_import_cover(&tx, cover)?;
                }
                if let Some(item) = enrichment {
                    validate_external_identities(&item.external_identities)?;
                    if let Some(cover) = &item.remote_cover {
                        validate_remote_cover(cover)?;
                    }
                }
                let metadata_changed = final_title != before.entry.title
                    || final_type != before.entry.media_type_id.as_deref()
                    || final_disposition != before.entry.disposition
                    || final_rating != before.entry.overall_rating
                    || final_review != before.entry.review_text
                    || release.is_some_and(|date| Some(date) != before.entry.release_date.as_ref())
                    || cover.is_some_and(|value| Some(value) != before.entry.remote_cover.as_ref())
                    || downloaded_cover.is_some_and(|value| {
                        Some(value.hash.as_str()) != before.entry.cover_asset_id.as_deref()
                    });
                if metadata_changed {
                    tx.execute(
                        "UPDATE entry SET title=?1,disposition=?2,media_type_id=?3,overall_rating=?4,review_text=?5,release_year=COALESCE(?6,release_year),release_month=CASE WHEN ?6 IS NULL THEN release_month ELSE ?7 END,release_day=CASE WHEN ?6 IS NULL THEN release_day ELSE ?8 END,release_precision=COALESCE(?9,release_precision),cover_asset_id=COALESCE(?14,cover_asset_id),remote_cover_provider=CASE WHEN ?14 IS NOT NULL THEN NULL ELSE COALESCE(?10,remote_cover_provider) END,remote_cover_url=CASE WHEN ?14 IS NOT NULL THEN NULL ELSE COALESCE(?11,remote_cover_url) END,remote_cover_source_url=CASE WHEN ?14 IS NOT NULL THEN NULL ELSE COALESCE(?12,remote_cover_source_url) END,remote_cover_attribution=CASE WHEN ?14 IS NOT NULL THEN NULL ELSE COALESCE(?13,remote_cover_attribution) END,updated_at=?15,version=version+1 WHERE id=?16 AND trashed_at IS NULL",
                        params![final_title,final_disposition,final_type,final_rating,final_review,release.map(|d|d.year),release.and_then(|d|d.month),release.and_then(|d|d.day),release.map(|d|d.precision.as_str()),cover.map(|c|c.provider.as_str()),cover.map(|c|c.url.as_str()),cover.and_then(|c|c.source_url.as_deref()),cover.and_then(|c|c.attribution.as_deref()),downloaded_cover.map(|value| value.hash.as_str()),now,entry_id],
                    )?;
                    if before.entry.overall_rating != final_rating
                        || before.entry.disposition != final_disposition
                    {
                        update_import_ranking(
                            &tx,
                            &entry_id,
                            before.entry.overall_rating,
                            final_rating,
                            &before,
                            final_disposition,
                        )?;
                    }
                }
                let tags_changed = apply_import_tags(&tx, &entry_id, decision)?;
                linked += 1;
                (
                    entry_id,
                    Some(before),
                    false,
                    metadata_changed,
                    tags_changed,
                )
            };

            for source_row_id in &decision.row_ids {
                if let Some(mut failure) = failed_covers_by_row.remove(source_row_id) {
                    if reportable_cover_failures.contains(source_row_id) {
                        failure.entry_id = Some(entry_id.clone());
                        resolved_cover_failures.push(failure);
                    }
                }
            }

            let mut row_changed = is_new || metadata_changed || tags_changed;
            let mut identities = collect_identities(&source_rows);
            if let Some(enrichment) = selected_enrichment(decision, &source_rows)? {
                identities.extend(enrichment.external_identities.clone());
            }
            dedupe_identities(&mut identities);
            validate_external_identities(&identities)?;
            for identity in identities {
                let owner: Option<String> = tx.query_row(
                    "SELECT entry_id FROM external_identity WHERE provider=?1 AND entity_kind=?2 AND external_id=?3",
                    params![identity.provider,identity.entity_kind,identity.external_id], |row| row.get(0),
                ).optional()?;
                if owner
                    .as_deref()
                    .is_some_and(|existing| existing != entry_id)
                {
                    return Err(StorageError::Validation(
                        "A source ID is already linked to a different library item".into(),
                    ));
                }
                let existing_source_url: Option<Option<String>> = tx.query_row(
                    "SELECT source_url FROM external_identity WHERE provider=?1 AND entity_kind=?2 AND external_id=?3 AND entry_id=?4",
                    params![identity.provider,identity.entity_kind,identity.external_id,entry_id], |row| row.get::<_, Option<String>>(0),
                ).optional()?;
                if existing_source_url.is_none() {
                    tx.execute("INSERT INTO external_identity(provider,entity_kind,external_id,source_url,entry_id) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(provider,entity_kind,external_id) DO UPDATE SET source_url=COALESCE(excluded.source_url,external_identity.source_url)", params![identity.provider,identity.entity_kind,identity.external_id,identity.source_url,entry_id])?;
                    row_changed = true;
                } else if existing_source_url.as_ref().is_some_and(Option::is_none)
                    && identity.source_url.is_some()
                {
                    tx.execute("UPDATE external_identity SET source_url=?1 WHERE provider=?2 AND entity_kind=?3 AND external_id=?4 AND entry_id=?5", params![identity.source_url,identity.provider,identity.entity_kind,identity.external_id,entry_id])?;
                    row_changed = true;
                }
            }
            let mut activities_changed = false;
            for source in &source_rows {
                for activity in &source.source_activities {
                    let provider = identity_provider(&source.provider);
                    let mut stored_activity = activity.clone();
                    if matches!(activity.kind.as_str(), "item" | "owned") {
                        stored_activity.fingerprint = snapshot_activity_fingerprint(
                            &source.provider,
                            source.external_id.as_deref().unwrap_or(&source.title),
                            activity,
                            source.source_status.as_deref(),
                            source.progress.as_ref(),
                            &source.source_metadata,
                            source.review_text.as_deref(),
                        );
                    }
                    let prior: Option<(String, Option<String>)> = tx.query_row(
                        "SELECT activity.entry_id,entry.trashed_at FROM import_source_activity AS activity JOIN entry ON entry.id=activity.entry_id WHERE activity.provider=?1 AND activity.fingerprint=?2",
                        params![provider,stored_activity.fingerprint], |row| Ok((row.get(0)?, row.get(1)?)),
                    ).optional()?;
                    if let Some((owner, trashed_at)) = prior {
                        if owner != entry_id {
                            if trashed_at.is_some() {
                                tx.execute(
                                    "DELETE FROM import_source_activity WHERE provider=?1 AND fingerprint=?2",
                                    params![provider,stored_activity.fingerprint],
                                )?;
                            } else {
                                return Err(StorageError::Validation(
                                    "This source activity is already linked to another library item"
                                        .into(),
                                ));
                            }
                        } else {
                            continue;
                        }
                    }
                    // Portable backups preserve source events but not the local
                    // deduplication index. Rebuild it from the stable event payload.
                    let archived: Option<(String, String)> = tx.query_row(
                        "SELECT event.entry_id,event.id FROM entry_event AS event JOIN entry ON entry.id=event.entry_id WHERE event.kind='external_source_activity' AND entry.trashed_at IS NULL AND json_extract(event.payload_json,'$.provider')=?1 AND json_extract(event.payload_json,'$.activity.fingerprint')=?2 LIMIT 1",
                        params![source.provider,stored_activity.fingerprint],
                        |row| Ok((row.get(0)?,row.get(1)?)),
                    ).optional()?;
                    if let Some((owner, event_id)) = archived {
                        if owner != entry_id {
                            return Err(StorageError::Validation(
                                "This source activity is already linked to another library item"
                                    .into(),
                            ));
                        }
                        tx.execute("INSERT OR IGNORE INTO import_source_activity(provider,fingerprint,entry_id,batch_id,event_id) VALUES(?1,?2,?3,?4,?5)", params![provider,stored_activity.fingerprint,entry_id,batch_id,event_id])?;
                        continue;
                    }
                    let event_id = format!("event-import-{}", now_nanos());
                    let payload = serde_json::json!({"provider":source.provider,"sourceId":source.external_id,"sourceUrl":source.source_url,"title":source.title,"providerMediaType":source.provider_media_type,"sourceStatus":source.source_status,"activity":stored_activity,"sourceDates":source.source_dates,"sourceProgress":source.progress,"sourceMetadata":source.source_metadata,"sourceReviewText":decision.import_reviews.then_some(source.review_text.as_deref()).flatten()});
                    tx.execute(
                        "INSERT INTO entry_event(id,entry_id,kind,occurred_at,recorded_at,source,payload_json) VALUES(?1,?2,'external_source_activity',?3,?3,?4,?5)",
                        params![event_id,entry_id,now,format!("import:{batch_id}"),serde_json::to_string(&payload)?],
                    )?;
                    tx.execute("INSERT INTO import_source_activity(provider,fingerprint,entry_id,batch_id,event_id) VALUES(?1,?2,?3,?4,?5)", params![provider,stored_activity.fingerprint,entry_id,batch_id,event_id])?;
                    activities_changed = true;
                }
            }
            row_changed |= activities_changed;
            if !is_new && row_changed && !metadata_changed {
                tx.execute(
                    "UPDATE entry SET updated_at=?1,version=version+1 WHERE id=?2",
                    params![now, entry_id],
                )?;
            }
            library_changed |= row_changed;
            let post_version: i64 = tx.query_row(
                "SELECT version FROM entry WHERE id=?1",
                [&entry_id],
                |row| row.get(0),
            )?;
            if row_changed {
                let after = load_entry_snapshot(&tx, &entry_id)?.ok_or_else(|| {
                    StorageError::Validation("Imported item could not be reloaded".into())
                })?;
                let record = ImportBatchEntry {
                    entry_id: entry_id.clone(),
                    action: if is_new {
                        "create".into()
                    } else {
                        "link".into()
                    },
                    before,
                    after,
                    post_version,
                };
                if snapshots.insert(entry_id.clone(), record).is_some() {
                    return Err(StorageError::Validation(
                        "An item may appear in only one decision group".into(),
                    ));
                }
            }
        }
        for record in snapshots.values() {
            tx.execute("INSERT INTO import_batch_entry(batch_id,entry_id,action,before_json,after_json,post_version) VALUES(?1,?2,?3,?4,?5,?6)", params![batch_id,record.entry_id,record.action,record.before.as_ref().map(serde_json::to_string).transpose()?,serde_json::to_string(&record.after)?,record.post_version])?;
        }
        tx.execute(
            "UPDATE import_batch SET created_count=?1,linked_count=?2,skipped_count=?3 WHERE id=?4",
            params![created as i64, linked as i64, skipped as i64, batch_id],
        )?;
        if library_changed {
            Self::commit_version(tx)?;
        } else {
            tx.commit()?;
        }
        let library = self.load_library()?;
        self.import_sessions.remove(&input.session_id);
        Ok(ImportCommitResult {
            library,
            batch_id,
            created,
            linked,
            skipped,
            cover_failures: resolved_cover_failures,
        })
    }

    pub fn undo_library_import(
        &mut self,
        batch_id: &str,
        expected_revision: i64,
    ) -> Result<ImportUndoResult, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let batch: Option<(i64, i64, i64, bool)> = tx.query_row("SELECT created_count,linked_count,skipped_count,undone FROM import_batch WHERE id=?1", [batch_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        let Some((created, linked, skipped, undone)) = batch else {
            return Err(StorageError::Validation(
                "This import receipt is no longer available".into(),
            ));
        };
        if undone {
            return Err(StorageError::Validation(
                "This import batch has already been undone".into(),
            ));
        }
        let mut statement = tx.prepare("SELECT entry_id,action,before_json,post_version,after_json FROM import_batch_entry WHERE batch_id=?1 ORDER BY entry_id")?;
        let records = statement
            .query_map([batch_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let restore_scores: HashMap<String, Option<i32>> = records
            .iter()
            .filter_map(|(id, _, before, _, _)| {
                before.as_deref().map(|json| {
                    serde_json::from_str::<EntrySnapshot>(json)
                        .map(|snapshot| (id.clone(), snapshot.entry.overall_rating))
                })
            })
            .collect::<Result<_, _>>()?;
        for (entry_id, action, _snapshot, post_version, after_json) in &records {
            let Some(current) = load_entry_snapshot(&tx, entry_id)? else {
                return Err(StorageError::Conflict);
            };
            let after: EntrySnapshot =
                serde_json::from_str(after_json.as_deref().ok_or_else(|| {
                    StorageError::Validation(
                        "This older import receipt cannot be safely undone".into(),
                    )
                })?)?;
            if current.entry.version != *post_version
                || canonical_snapshot(current) != canonical_snapshot(after)
            {
                return Err(StorageError::Conflict);
            }
            if import_undo_has_dependencies(&tx, entry_id, action == "create")? {
                return Err(StorageError::Conflict);
            }
            if action == "create" {
                let other_events: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM entry_event WHERE entry_id=?1 AND source<>?2)",
                    params![entry_id, format!("import:{batch_id}")],
                    |row| row.get(0),
                )?;
                if other_events {
                    return Err(StorageError::Conflict);
                }
            }
            if let Some(raw) = _snapshot.as_deref() {
                let before: EntrySnapshot = serde_json::from_str(raw)?;
                for boundary in &before.ranking_boundaries {
                    for id in [&boundary.first_id, &boundary.second_id] {
                        let score = if let Some(score) = restore_scores.get(id) {
                            *score
                        } else {
                            tx.query_row("SELECT overall_rating FROM entry WHERE id=?1 AND trashed_at IS NULL", [id], |row| row.get::<_,Option<i32>>(0)).optional()?.flatten()
                        };
                        if score != Some(boundary.score) {
                            return Err(StorageError::Conflict);
                        }
                    }
                }
            }
        }
        let changed = !records.is_empty();
        for (entry_id, action, before_json, _post_version, after_json) in records {
            let after: EntrySnapshot = serde_json::from_str(after_json.as_deref().unwrap())?;
            tx.execute(
                "DELETE FROM entry_event WHERE entry_id=?1 AND source=?2",
                params![entry_id, format!("import:{batch_id}")],
            )?;
            if action == "create" {
                tx.execute("DELETE FROM entry WHERE id=?1", [&entry_id])?;
            } else {
                let before: EntrySnapshot =
                    serde_json::from_str(before_json.as_deref().ok_or_else(|| {
                        StorageError::Validation("Import undo snapshot is incomplete".into())
                    })?)?;
                restore_entry_snapshot(&tx, &before)?;
            }
            if let Some(score) = after.entry.overall_rating {
                tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
                tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1", [score])?;
            }
        }
        tx.execute("UPDATE import_batch SET undone=1 WHERE id=?1", [batch_id])?;
        if changed {
            Self::commit_version(tx)?;
        } else {
            tx.commit()?;
        }
        let library = self.load_library()?;
        Ok(ImportUndoResult {
            library,
            batch_id: batch_id.to_owned(),
            created: created as usize,
            linked: linked as usize,
            skipped: skipped as usize,
        })
    }

    fn expire_import_sessions(&mut self) {
        self.import_sessions
            .retain(|_, session| session.created_at.elapsed() < SESSION_LIFETIME);
    }
}

impl ImportSourceRow {
    /// Convert one authorized Steam `GetOwnedGames` record into the same
    /// reviewable staging shape as uploaded rows. API data is never treated as
    /// a local completion status or rating.
    pub fn from_steam_owned_game(game: crate::catalog::SteamOwnedGame) -> Self {
        let source_id = game.app_id.clone();
        let source_url = format!("https://store.steampowered.com/app/{}/", game.app_id);
        let metadata = BTreeMap::from([
            (
                "playtimeForeverMinutes".into(),
                game.playtime_forever
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
            ),
            (
                "playtimeTwoWeeksMinutes".into(),
                game.playtime_2weeks
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
            ),
            (
                "freeToPlay".into(),
                game.free_to_play
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into()),
            ),
        ]);
        let dates = BTreeMap::new();
        let activity = make_activity(
            "steam",
            &source_id,
            "owned",
            &dates,
            None,
            &[],
            false,
            None,
            0,
        );
        Self {
            row_id: format!("steam:{}", game.app_id),
            provider: "steam".into(),
            provider_media_type: Some("game".into()),
            external_id: Some(source_id.clone()),
            source_identities: vec![ExternalIdentity {
                provider: "steam".into(),
                entity_kind: "game".into(),
                external_id: source_id,
                source_url: Some(source_url.clone()),
            }],
            source_url: Some(source_url),
            title: game.name,
            original_title: None,
            creators: Vec::new(),
            year: None,
            release_date: None,
            source_status: Some("owned".into()),
            source_rating: None,
            source_dates: dates,
            source_activities: vec![activity],
            source_metadata: metadata,
            review_text: None,
            tags: Vec::new(),
            progress: game.playtime_forever.map(|minutes| SourceProgress {
                unit: "minutes".into(),
                current: minutes as f64,
                total: None,
            }),
            suggested_media_type_id: Some("games".into()),
            exact_entry_id: None,
            candidates: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

fn canonical_import_provider(provider: &str) -> Result<String, StorageError> {
    match provider {
        "letterboxd" | "imdb" | "goodreads" | "myAnimeList" | "genericCsv" => {
            Ok(provider.to_owned())
        }
        _ => Err(StorageError::Validation("Unsupported import source".into())),
    }
}

fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("import.csv");
    let cleaned: String = base
        .chars()
        .filter(|ch| !ch.is_control())
        .take(180)
        .collect();
    if cleaned.is_empty() {
        "import.csv".into()
    } else {
        cleaned
    }
}

fn canonical_snapshot(mut snapshot: EntrySnapshot) -> EntrySnapshot {
    snapshot.entry.tag_ids.sort();
    snapshot.entry.external_identities.sort_by(|a, b| {
        (&a.provider, &a.entity_kind, &a.external_id, &a.source_url).cmp(&(
            &b.provider,
            &b.entity_kind,
            &b.external_id,
            &b.source_url,
        ))
    });
    snapshot
}

fn json_references_entry(value: &serde_json::Value, entry_id: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value == entry_id,
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_references_entry(value, entry_id)),
        serde_json::Value::Object(values) => values
            .values()
            .any(|value| json_references_entry(value, entry_id)),
        _ => false,
    }
}

/// Ranking and recap operations can reference an entry without changing its
/// version. Undo must never silently remove those references or their history.
fn import_undo_has_dependencies(
    tx: &Transaction<'_>,
    entry_id: &str,
    created: bool,
) -> Result<bool, StorageError> {
    let direct_session: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ranking_session WHERE (?2=1 OR status IN ('active','paused')) AND (candidate_id=?1 OR current_pivot_id=?1 OR presented_left_id=?1 OR presented_right_id=?1))",
        params![entry_id, created], |row| row.get(0),
    )?;
    if direct_session {
        return Ok(true);
    }
    let mut statement = tx.prepare("SELECT snapshot_order_json,filter_json FROM ranking_session WHERE ?1=1 OR status IN ('active','paused')")?;
    let session_json = statement.query_map([created], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for pair in session_json {
        let (order, filter) = pair?;
        for raw in [order, filter] {
            let value: serde_json::Value = serde_json::from_str(&raw)?;
            if json_references_entry(&value, entry_id) {
                return Ok(true);
            }
        }
    }
    if !created {
        return Ok(false);
    }
    let ranked: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ranking_judgment WHERE left_id=?1 OR right_id=?1) OR EXISTS(SELECT 1 FROM ranking_boundary WHERE first_id=?1 OR second_id=?1)",
        [entry_id], |row| row.get(0),
    )?;
    if ranked {
        return Ok(true);
    }
    let preferences: String =
        tx.query_row("SELECT json FROM preference WHERE id=1", [], |row| {
            row.get(0)
        })?;
    let preferences: serde_json::Value = serde_json::from_str(&preferences)?;
    if let Some(raw) = preferences
        .get("recapDrafts")
        .and_then(serde_json::Value::as_str)
    {
        let drafts: serde_json::Value = serde_json::from_str(raw)?;
        if json_references_entry(&drafts, entry_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parse_csv_rows(
    provider: &str,
    upload_index: usize,
    input: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<ImportSourceRow>, StorageError> {
    let records = parse_csv(input)?;
    let Some((headers, records)) = records.split_first() else {
        return Ok(Vec::new());
    };
    let headers: Vec<String> = headers
        .iter()
        .map(|header| header.trim_start_matches('\u{feff}').trim().to_owned())
        .collect();
    let mut rows = Vec::new();
    for (index, fields) in records.iter().enumerate() {
        if fields.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        let record: HashMap<String, String> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                (
                    h.to_ascii_lowercase(),
                    fields.get(i).cloned().unwrap_or_default(),
                )
            })
            .collect();
        if let Some(row) = record_to_import_row(provider, upload_index, index + 2, &record) {
            rows.push(row);
            if rows.len() > MAX_ROWS {
                return Err(StorageError::Validation(
                    "An import can contain up to 20,000 media rows".into(),
                ));
            }
        }
    }
    if rows.is_empty() {
        warnings.push("No media rows with a title were found.".into());
    }
    Ok(rows)
}

/// Reads the official MAL anime/manga list XML export. DTDs and declared
/// entities are rejected; the parser never resolves network or filesystem IDs.
fn parse_mal_xml(
    upload_index: usize,
    input: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<ImportSourceRow>, StorageError> {
    let mut reader = XmlReader::from_str(input);
    reader.config_mut().trim_text(true);
    let mut current_kind: Option<String> = None;
    let mut current_tag: Option<String> = None;
    let mut record = HashMap::<String, String>::new();
    let mut rows = Vec::new();
    let mut item_index = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| StorageError::Validation("MAL XML is malformed".into()))?;
        match event {
            XmlEvent::Start(start) => {
                let name = xml_local_name(start.name().as_ref())?;
                if name == "anime" || name == "manga" {
                    if current_kind.is_some() {
                        return Err(StorageError::Validation(
                            "MAL XML has nested media records".into(),
                        ));
                    }
                    current_kind = Some(name);
                    current_tag = None;
                    record.clear();
                } else if current_kind.is_some() {
                    current_tag = Some(name);
                }
            }
            XmlEvent::Empty(empty) => {
                let name = xml_local_name(empty.name().as_ref())?;
                if current_kind.is_some() {
                    record.entry(name).or_default();
                }
            }
            XmlEvent::Text(text) => {
                if let (Some(tag), Some(_)) = (&current_tag, &current_kind) {
                    let decoded = text.xml10_content();
                    let value = quick_xml::escape::unescape(&decoded).map_err(|_| {
                        StorageError::Validation(
                            "MAL XML contains an invalid entity reference".into(),
                        )
                    })?;
                    let field = record.entry(tag.clone()).or_default();
                    if field.len().saturating_add(value.len()) > MAX_CELL_CHARS {
                        return Err(StorageError::Validation(
                            "A MAL XML field exceeds 100,000 characters".into(),
                        ));
                    }
                    field.push_str(&value);
                }
            }
            XmlEvent::CData(text) => {
                if let (Some(tag), Some(_)) = (&current_tag, &current_kind) {
                    let value = text.xml10_content();
                    let field = record.entry(tag.clone()).or_default();
                    if field.len().saturating_add(value.len()) > MAX_CELL_CHARS {
                        return Err(StorageError::Validation(
                            "A MAL XML field exceeds 100,000 characters".into(),
                        ));
                    }
                    field.push_str(&value);
                }
            }
            XmlEvent::End(end) => {
                let name = xml_local_name(end.name().as_ref())?;
                if current_kind.as_deref() == Some(name.as_str()) {
                    let kind = current_kind.take().expect("record kind was checked");
                    current_tag = None;
                    let mut mapped = HashMap::new();
                    mapped.insert(
                        "title".into(),
                        record.get("series_title").cloned().unwrap_or_default(),
                    );
                    mapped.insert(
                        "mal id".into(),
                        if kind == "manga" {
                            record.get("series_mangadb_id")
                        } else {
                            record.get("series_animedb_id")
                        }
                        .cloned()
                        .unwrap_or_default(),
                    );
                    mapped.insert("type".into(), kind.clone());
                    let raw_status = record
                        .get("my_status")
                        .map(|value| value.trim())
                        .unwrap_or("");
                    let status = match (kind.as_str(), raw_status) {
                        ("anime", "1") => "watching",
                        ("anime", "2") => "completed",
                        ("anime", "3") => "on hold",
                        ("anime", "4") => "dropped",
                        ("anime", "6") => "plan to watch",
                        ("manga", "1") => "reading",
                        ("manga", "2") => "completed",
                        ("manga", "3") => "on hold",
                        ("manga", "4") => "dropped",
                        ("manga", "6") => "plan to read",
                        _ => raw_status,
                    };
                    mapped.insert("my status".into(), status.to_owned());
                    mapped.insert(
                        "my score".into(),
                        record.get("my_score").cloned().unwrap_or_default(),
                    );
                    if let Some(value) = record.get("series_start").filter(|value| value.len() >= 4)
                    {
                        mapped.insert("year".into(), value.chars().take(4).collect());
                    }
                    for (xml, column) in [
                        ("my_watched_episodes", "episodes watched"),
                        ("my_read_chapters", "chapters read"),
                        ("my_read_volumes", "volumes read"),
                        ("my_start_date", "start date"),
                        ("my_finish_date", "finish date"),
                        ("series_episodes", "episodes"),
                        ("series_chapters", "chapters"),
                        ("series_volumes", "volumes"),
                    ] {
                        if let Some(value) = record.get(xml) {
                            mapped.insert(column.into(), value.clone());
                        }
                    }
                    item_index += 1;
                    if let Some(mut row) =
                        record_to_import_row("myAnimeList", upload_index, item_index, &mapped)
                    {
                        row.provider_media_type = Some(kind.clone());
                        if let Some(id) = row.external_id.as_ref() {
                            if let Some(identity) = row.source_identities.first_mut() {
                                identity.entity_kind =
                                    if kind == "manga" { "manga" } else { "anime" }.into();
                                identity.external_id = id.clone();
                            }
                        }
                        for (source, target) in [
                            ("series_type", "malSeriesType"),
                            ("series_episodes", "seriesEpisodeCount"),
                            ("my_read_volumes", "readVolumes"),
                            ("my_watched_episodes", "watchedEpisodes"),
                            ("series_start", "seriesStart"),
                            ("series_end", "seriesEnd"),
                        ] {
                            if let Some(value) =
                                record.get(source).filter(|value| !value.trim().is_empty())
                            {
                                row.source_metadata
                                    .insert(target.into(), value.trim().into());
                            }
                        }
                        row.source_metadata
                            .insert("myAnimeListStatus".into(), raw_status.to_owned());
                        rows.push(row);
                        if rows.len() > MAX_ROWS {
                            return Err(StorageError::Validation(
                                "An import can contain up to 20,000 media rows".into(),
                            ));
                        }
                    }
                } else if current_kind.is_some() {
                    current_tag = None;
                }
            }
            XmlEvent::DocType(_) => {
                return Err(StorageError::Validation(
                    "MAL XML declarations with DTDs or entities are not supported".into(),
                ))
            }
            XmlEvent::Eof => break,
            _ => {}
        }
    }
    if current_kind.is_some() {
        return Err(StorageError::Validation(
            "MAL XML ended inside a media record".into(),
        ));
    }
    if rows.is_empty() {
        warnings.push("No MAL anime or manga rows with a title were found.".into());
    }
    Ok(rows)
}

fn parse_mal_title_list(
    upload_index: usize,
    bytes: &[u8],
    warnings: &mut Vec<String>,
) -> Result<Vec<ImportSourceRow>, StorageError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| StorageError::Validation("MAL title list is not UTF-8".into()))?;
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let title = line.trim().trim_start_matches('\u{feff}').trim();
        if title.is_empty() {
            continue;
        }
        if title.chars().count() > 500 {
            return Err(StorageError::Validation(
                "A title exceeds 500 characters".into(),
            ));
        }
        rows.push(ImportSourceRow {
            row_id: format!("myAnimeList:{upload_index}:{}", index + 1),
            provider: "myAnimeList".into(),
            provider_media_type: None,
            external_id: None,
            source_identities: Vec::new(),
            source_url: None,
            title: title.to_owned(),
            original_title: None,
            creators: Vec::new(),
            year: None,
            release_date: None,
            source_status: None,
            source_rating: None,
            source_dates: BTreeMap::new(),
            source_activities: Vec::new(),
            source_metadata: BTreeMap::new(),
            review_text: None,
            tags: Vec::new(),
            progress: None,
            suggested_media_type_id: None,
            exact_entry_id: None,
            candidates: Vec::new(),
            warnings: Vec::new(),
        });
        if rows.len() > MAX_ROWS {
            return Err(StorageError::Validation(
                "An import can contain up to 20,000 media rows".into(),
            ));
        }
    }
    if rows.is_empty() {
        warnings.push("No titles were found in the text list.".into());
    } else {
        warnings.push("Text lists contain titles only. Choose each media type and status; source IDs, dates, ratings and progress are unavailable.".into());
    }
    Ok(rows)
}

fn xml_local_name(name: &str) -> Result<String, StorageError> {
    Ok(name.rsplit(':').next().unwrap_or(name).to_ascii_lowercase())
}

fn parse_csv(input: &str) -> Result<Vec<Vec<String>>, StorageError> {
    let first_line = input.lines().next().unwrap_or_default();
    let tab_count = first_line.chars().filter(|ch| *ch == '\t').count();
    let comma_count = first_line.chars().filter(|ch| *ch == ',').count();
    let delimiter = if tab_count > comma_count && tab_count > 0 {
        '\t'
    } else {
        ','
    };
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut cell_chars = 0usize;
    let mut chars = input.chars().peekable();
    let mut quoted = false;
    let mut after_quote = false;
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                    cell_chars += 1;
                } else {
                    quoted = false;
                    after_quote = true;
                }
            } else {
                cell.push(ch);
                cell_chars += 1;
            }
        } else if after_quote {
            match ch {
                value if value == delimiter => {
                    row.push(std::mem::take(&mut cell));
                    cell_chars = 0;
                    after_quote = false;
                }
                '\r' | '\n' => {
                    row.push(std::mem::take(&mut cell));
                    cell_chars = 0;
                    if ch == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    if row.iter().any(|v| !v.trim().is_empty()) {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                    after_quote = false;
                }
                ' ' | '\t' => {}
                _ => {
                    return Err(StorageError::Validation(
                        "CSV contains characters after a closing quote".into(),
                    ))
                }
            }
        } else {
            match ch {
                '"' if cell.is_empty() => quoted = true,
                '"' => {
                    return Err(StorageError::Validation(
                        "CSV has a quote inside an unquoted value".into(),
                    ))
                }
                value if value == delimiter => {
                    row.push(std::mem::take(&mut cell));
                    cell_chars = 0;
                }
                '\r' | '\n' => {
                    row.push(std::mem::take(&mut cell));
                    cell_chars = 0;
                    if ch == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    if row.iter().any(|v| !v.trim().is_empty()) {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                }
                _ => {
                    cell.push(ch);
                    cell_chars += 1;
                }
            }
        }
        if cell_chars > MAX_CELL_CHARS {
            return Err(StorageError::Validation(
                "A CSV field exceeds 100,000 characters".into(),
            ));
        }
        if rows.len() > MAX_ROWS + 1 {
            return Err(StorageError::Validation(
                "An import can contain up to 20,000 media rows".into(),
            ));
        }
    }
    if quoted {
        return Err(StorageError::Validation(
            "CSV has an unclosed quoted field".into(),
        ));
    }
    if !cell.is_empty() || !row.is_empty() || after_quote {
        row.push(cell);
        if row.iter().any(|v| !v.trim().is_empty()) {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn record_to_import_row(
    provider: &str,
    upload_index: usize,
    row_num: usize,
    record: &HashMap<String, String>,
) -> Option<ImportSourceRow> {
    let title = get_cell(
        record,
        &[
            "title",
            "name",
            "original title",
            "originaltitle",
            "movie name",
            "series title",
        ],
    )?;
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    let original_title =
        get_cell(record, &["original title", "originaltitle"]).filter(|v| v.trim() != title);
    let year = get_cell(
        record,
        &[
            "year",
            "release year",
            "publication year",
            "original year",
            "original publication year",
            "year published",
        ],
    )
    .and_then(|v| parse_year(&v));
    let provider_type = get_cell(
        record,
        &["title type", "type", "media type", "media", "format"],
    );
    let book_id = get_cell(record, &["book id", "bookid"])
        .map(|value| unwrap_spreadsheet_value(&value))
        .filter(|v| !v.trim().is_empty());
    let isbn = ["isbn13", "isbn 13", "isbn-13", "isbn", "isbn10", "isbn 10"]
        .iter()
        .filter_map(|key| record.get(*key))
        .map(|value| normalize_isbn(&unwrap_spreadsheet_value(value)))
        .find(|value| valid_isbn(value));
    let external_id = if provider == "goodreads" {
        isbn.clone().or(book_id.clone())
    } else {
        get_cell(
            record,
            &[
                "const",
                "imdb id",
                "letterboxd uri",
                "mal id",
                "anime id",
                "manga id",
                "id",
            ],
        )
        .map(|value| unwrap_spreadsheet_value(&value))
        .filter(|v| !v.trim().is_empty())
    };
    let provider_media_type = provider_type
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    let source_rating = get_cell(
        record,
        &["your rating", "rating", "my rating", "score", "my score"],
    )
    .and_then(|v| parse_rating(&v))
    .filter(|value| *value > 0.0 || provider == "genericCsv")
    .map(|value| SourceRating {
        value,
        scale: rating_scale(provider),
    });
    let source_status = get_cell(
        record,
        &[
            "status",
            "watch status",
            "shelf",
            "exclusive shelf",
            "my status",
            "list status",
        ],
    );
    let source_dates = record
        .iter()
        .filter(|(key, value)| key.contains("date") && !value.trim().is_empty())
        .map(|(key, value)| (key.clone(), value.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let tags = get_cell(record, &["tags", "shelves", "genres"])
        .map(|v| split_labels(&v))
        .unwrap_or_default();
    let creators = get_cell(
        record,
        &[
            "authors",
            "author",
            "directors",
            "director",
            "creator",
            "artists",
        ],
    )
    .map(|v| split_creators(&v))
    .unwrap_or_default();
    let review_text = get_cell(record, &["my review", "review"])
        .map(|value| html_to_plain_text(&value))
        .filter(|value| !value.trim().is_empty());
    let source_metadata = collect_safe_source_metadata(record);
    let mut source_identities = Vec::new();
    if let Some(isbn) = &isbn {
        source_identities.push(ExternalIdentity {
            provider: "isbn".into(),
            entity_kind: "edition".into(),
            external_id: isbn.clone(),
            source_url: None,
        });
    }
    if let Some(book_id) = &book_id {
        if book_id.chars().all(|ch| ch.is_ascii_digit()) {
            source_identities.push(ExternalIdentity {
                provider: "goodreads".into(),
                entity_kind: "book".into(),
                external_id: book_id.clone(),
                source_url: Some(format!("https://www.goodreads.com/book/show/{book_id}")),
            });
        }
    }
    if source_identities.is_empty() {
        if let Some(id) = &external_id {
            let entity_kind = match provider {
                "imdb" => "title".into(),
                "letterboxd" => "film".into(),
                "myAnimeList"
                    if provider_media_type
                        .as_deref()
                        .is_some_and(|kind| kind.to_ascii_lowercase().contains("manga")) =>
                {
                    "manga".into()
                }
                "myAnimeList" => "anime".into(),
                _ => provider_media_type.clone().unwrap_or_else(|| "work".into()),
            };
            source_identities.push(ExternalIdentity {
                provider: identity_provider(provider).into(),
                entity_kind,
                external_id: id.clone(),
                source_url: None,
            });
        }
    }
    let source_url = match provider {
        "letterboxd" => external_id.clone().filter(|id| id.starts_with("https://")),
        "imdb" => external_id
            .clone()
            .filter(|id| id.starts_with("tt"))
            .map(|id| format!("https://www.imdb.com/title/{id}/")),
        "goodreads" => book_id
            .clone()
            .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
            .map(|id| format!("https://www.goodreads.com/book/show/{id}")),
        _ => None,
    };
    let genres = get_cell(record, &["genres", "genre"]);
    let media_type = map_media_type(provider, provider_media_type.as_deref(), genres.as_deref());
    let release_date = year.map(|year| ReleaseDate {
        year,
        month: None,
        day: None,
        precision: "year".into(),
    });
    let activity = if source_rating.is_some()
        || !source_dates.is_empty()
        || source_status.is_some()
        || review_text.is_some()
        || !source_metadata.is_empty()
    {
        vec![make_activity(
            provider,
            external_id.as_deref().unwrap_or(title),
            "item",
            &source_dates,
            source_rating.clone(),
            &tags,
            review_text.is_some(),
            None,
            0,
        )]
    } else {
        Vec::new()
    };
    Some(ImportSourceRow {
        row_id: format!("{provider}:{upload_index}:{row_num}"),
        provider: provider.into(),
        provider_media_type,
        external_id,
        source_identities,
        source_url,
        title: title.to_owned(),
        original_title,
        creators,
        year,
        release_date,
        source_status,
        source_rating,
        source_dates,
        source_activities: activity,
        tags,
        progress: progress(record),
        source_metadata,
        review_text,
        suggested_media_type_id: media_type,
        exact_entry_id: None,
        candidates: Vec::new(),
        warnings: Vec::new(),
    })
}

fn parse_letterboxd_files(
    upload_index: usize,
    files: &BTreeMap<String, Vec<u8>>,
    warnings: &mut Vec<String>,
) -> Result<Vec<ImportSourceRow>, StorageError> {
    let mut rows: BTreeMap<String, ImportSourceRow> = BTreeMap::new();
    let mut occurrence_counts = HashMap::<String, usize>::new();
    let mut next_row_number = 0usize;
    for (file_name, bytes) in files {
        let input = std::str::from_utf8(bytes)
            .map_err(|_| StorageError::Validation("Letterboxd CSV is not UTF-8".into()))?;
        let records = parse_csv(input)?;
        let Some((header, data)) = records.split_first() else {
            continue;
        };
        let headers: Vec<String> = header
            .iter()
            .map(|h| h.trim_start_matches('\u{feff}').trim().to_ascii_lowercase())
            .collect();
        for (index, fields) in data.iter().enumerate() {
            let record: HashMap<String, String> = headers
                .iter()
                .enumerate()
                .map(|(i, h)| (h.clone(), fields.get(i).cloned().unwrap_or_default()))
                .collect();
            let Some(uri) = get_cell(&record, &["letterboxd uri"]) else {
                continue;
            };
            let key = uri.trim().to_owned();
            if key.is_empty() {
                continue;
            }
            let title = get_cell(&record, &["name", "title"]).unwrap_or_else(|| key.clone());
            let year = get_cell(&record, &["year"]).and_then(|v| parse_year(&v));
            let rating = get_cell(&record, &["rating"])
                .and_then(|v| parse_rating(&v))
                .filter(|value| *value > 0.0)
                .map(|value| SourceRating {
                    value,
                    scale: "0.5-5".into(),
                });
            let dates: BTreeMap<String, String> = record
                .iter()
                .filter(|(k, v)| k.contains("date") && !v.trim().is_empty())
                .map(|(k, v)| (k.clone(), v.trim().to_owned()))
                .collect();
            let tags = get_cell(&record, &["tags"])
                .map(|v| split_labels(&v))
                .unwrap_or_default();
            let activity_kind = match file_name.as_str() {
                "watched.csv" => "watched",
                "diary.csv" => "diary",
                "ratings.csv" => "rating",
                "reviews.csv" => "review",
                "watchlist.csv" => "watchlist",
                _ => "other",
            };
            let has_review = activity_kind == "review"
                || get_cell(&record, &["review"]).is_some_and(|v| !v.trim().is_empty());
            let rewatch = get_cell(&record, &["rewatch"]).map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "yes" | "true" | "1"
                )
            });
            let base_fingerprint = activity_fingerprint_seed(
                "letterboxd",
                &key,
                activity_kind,
                &dates,
                rating.as_ref(),
                &tags,
                has_review,
                rewatch,
            );
            let ordinal = occurrence_counts
                .entry(base_fingerprint.clone())
                .or_default();
            *ordinal += 1;
            let occurrence = *ordinal;
            let external_id = Some(key.clone());
            let suggested = Some("films".into());
            if !rows.contains_key(&key) {
                next_row_number += 1;
            }
            let entry = rows.entry(key.clone()).or_insert_with(|| ImportSourceRow {
                row_id: format!("letterboxd:{upload_index}:{next_row_number}"),
                provider: "letterboxd".into(),
                provider_media_type: None,
                external_id: external_id.clone(),
                source_url: Some(key.clone()),
                title: title.clone(),
                original_title: None,
                source_identities: vec![ExternalIdentity {
                    provider: "letterboxd".into(),
                    entity_kind: "film".into(),
                    external_id: key.clone(),
                    source_url: Some(key.clone()),
                }],
                creators: get_cell(&record, &["directors", "director"])
                    .map(|v| split_creators(&v))
                    .unwrap_or_default(),
                year,
                release_date: year.map(|year| ReleaseDate {
                    year,
                    month: None,
                    day: None,
                    precision: "year".into(),
                }),
                source_status: None,
                source_rating: None,
                source_dates: BTreeMap::new(),
                source_activities: Vec::new(),
                source_metadata: BTreeMap::new(),
                review_text: None,
                tags: Vec::new(),
                progress: None,
                suggested_media_type_id: suggested,
                exact_entry_id: None,
                candidates: Vec::new(),
                warnings: Vec::new(),
            });
            if activity_kind == "review" {
                if let Some(review) = get_cell(&record, &["review"])
                    .map(|value| html_to_plain_text(&value))
                    .filter(|value| !value.trim().is_empty())
                {
                    if entry.review_text.as_deref().is_none_or(str::is_empty) {
                        entry.review_text = Some(review);
                    }
                }
            }
            if entry.source_rating.is_none() && rating.is_some() {
                entry.source_rating = rating.clone();
            }
            for (key, value) in &dates {
                entry.source_dates.insert(key.clone(), value.clone());
            }
            for tag in &tags {
                if !entry.tags.contains(tag) {
                    entry.tags.push(tag.clone());
                }
            }
            entry.source_activities.push(make_activity(
                "letterboxd",
                &key,
                activity_kind,
                &dates,
                rating,
                &tags,
                has_review,
                rewatch,
                occurrence,
            ));
            if activity_kind == "watched" || activity_kind == "diary" {
                entry.source_status = Some("watched".into());
            } else if activity_kind == "watchlist" && entry.source_status.is_none() {
                entry.source_status = Some("watchlist".into());
            }
            if entry.year.is_none() {
                entry.year = year;
                entry.release_date = year.map(|year| ReleaseDate {
                    year,
                    month: None,
                    day: None,
                    precision: "year".into(),
                });
            }
            if entry.title == key && !title.is_empty() {
                entry.title = title;
            }
            let _ = index;
            if rows.len() > MAX_ROWS {
                return Err(StorageError::Validation(
                    "An import can contain up to 20,000 media rows".into(),
                ));
            }
        }
    }
    if rows.is_empty() {
        warnings.push("No Letterboxd media rows were found in the selected export files.".into());
    }
    Ok(rows.into_values().collect())
}

fn read_letterboxd_zip(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, StorageError> {
    if bytes.len() < 22 {
        return Err(StorageError::Validation(
            "The Letterboxd ZIP is incomplete".into(),
        ));
    }
    let search_start = bytes.len().saturating_sub(65_557);
    let eocd = (search_start..bytes.len() - 3)
        .rev()
        .find(|&i| bytes.get(i..i + 4) == Some(b"PK\x05\x06"))
        .ok_or_else(|| StorageError::Validation("The selected ZIP archive is invalid".into()))?;
    let count = u16le(bytes, eocd + 10)? as usize;
    let central_size = u32le(bytes, eocd + 12)? as usize;
    let central_offset = u32le(bytes, eocd + 16)? as usize;
    if count > 200
        || central_offset
            .checked_add(central_size)
            .is_none_or(|end| end > bytes.len())
    {
        return Err(StorageError::Validation(
            "The Letterboxd ZIP directory is invalid".into(),
        ));
    }
    let allowed: HashSet<&str> = [
        "watched.csv",
        "ratings.csv",
        "diary.csv",
        "reviews.csv",
        "watchlist.csv",
    ]
    .into_iter()
    .collect();
    let mut files = BTreeMap::new();
    let mut pos = central_offset;
    let mut total = 0usize;
    for _ in 0..count {
        if bytes.get(pos..pos + 4) != Some(b"PK\x01\x02") {
            return Err(StorageError::Validation(
                "The Letterboxd ZIP directory is damaged".into(),
            ));
        }
        let flags = u16le(bytes, pos + 8)?;
        let method = u16le(bytes, pos + 10)?;
        let compressed = u32le(bytes, pos + 20)? as usize;
        let expanded = u32le(bytes, pos + 24)? as usize;
        let name_len = u16le(bytes, pos + 28)? as usize;
        let extra_len = u16le(bytes, pos + 30)? as usize;
        let comment_len = u16le(bytes, pos + 32)? as usize;
        let local_offset = u32le(bytes, pos + 42)? as usize;
        let header_end = pos
            .checked_add(46 + name_len + extra_len + comment_len)
            .ok_or_else(|| {
                StorageError::Validation("The Letterboxd ZIP directory is invalid".into())
            })?;
        if header_end > bytes.len() {
            return Err(StorageError::Validation(
                "The Letterboxd ZIP directory is truncated".into(),
            ));
        }
        let name = std::str::from_utf8(&bytes[pos + 46..pos + 46 + name_len]).unwrap_or("");
        let base_name = name.rsplit('/').next().unwrap_or(name);
        if allowed.contains(base_name) {
            if flags & 1 != 0 || flags & (1 << 6) != 0 {
                return Err(StorageError::Validation(
                    "Encrypted Letterboxd export archives are not supported".into(),
                ));
            }
            total = total.saturating_add(expanded);
            if total > MAX_ZIP_EXPANDED_BYTES || compressed > MAX_UPLOAD_BYTES {
                return Err(StorageError::Validation(
                    "The expanded Letterboxd export exceeds the safe import limit".into(),
                ));
            }
            if bytes.get(local_offset..local_offset + 4) != Some(b"PK\x03\x04") {
                return Err(StorageError::Validation(
                    "The Letterboxd ZIP entry is invalid".into(),
                ));
            }
            let local_name_len = u16le(bytes, local_offset + 26)? as usize;
            let local_extra_len = u16le(bytes, local_offset + 28)? as usize;
            let start = local_offset
                .checked_add(30 + local_name_len + local_extra_len)
                .ok_or_else(|| {
                    StorageError::Validation("The Letterboxd ZIP entry is invalid".into())
                })?;
            let end = start.checked_add(compressed).ok_or_else(|| {
                StorageError::Validation("The Letterboxd ZIP entry is invalid".into())
            })?;
            if end > bytes.len() {
                return Err(StorageError::Validation(
                    "The Letterboxd ZIP entry is truncated".into(),
                ));
            }
            let contents = match method {
                0 => bytes[start..end].to_vec(),
                8 => {
                    let mut decoder = DeflateDecoder::new(&bytes[start..end]);
                    let mut out = Vec::with_capacity(expanded.min(MAX_ZIP_EXPANDED_BYTES));
                    decoder
                        .take(MAX_ZIP_EXPANDED_BYTES as u64 + 1)
                        .read_to_end(&mut out)?;
                    out
                }
                _ => {
                    return Err(StorageError::Validation(
                        "The Letterboxd ZIP uses an unsupported compression method".into(),
                    ))
                }
            };
            if contents.len() != expanded || contents.len() > MAX_ZIP_EXPANDED_BYTES {
                return Err(StorageError::Validation(
                    "The Letterboxd ZIP entry exceeded its declared size".into(),
                ));
            }
            files.insert(base_name.to_owned(), contents);
        }
        pos = header_end;
    }
    Ok(files)
}

fn u16le(bytes: &[u8], offset: usize) -> Result<u16, StorageError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or_else(|| StorageError::Validation("The ZIP directory is truncated".into()))?
            .try_into()
            .unwrap(),
    ))
}
fn u32le(bytes: &[u8], offset: usize) -> Result<u32, StorageError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(|| StorageError::Validation("The ZIP directory is truncated".into()))?
            .try_into()
            .unwrap(),
    ))
}

fn get_cell(record: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        record
            .get(*key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    })
}
fn collect_safe_source_metadata(record: &HashMap<String, String>) -> BTreeMap<String, String> {
    const ALLOWED: &[&str] = &[
        "publication year",
        "original publication year",
        "original year",
        "year published",
        "publisher",
        "binding",
        "number of pages",
        "pages",
        "page count",
        "my watched episodes",
        "my read chapters",
        "my read volumes",
        "my rewatching episodes",
    ];
    record
        .iter()
        .filter(|(key, value)| ALLOWED.contains(&key.as_str()) && !value.trim().is_empty())
        .map(|(key, value)| (key.clone(), value.chars().take(500).collect()))
        .collect()
}
fn html_to_plain_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(16_384));
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' if !in_tag => {
                in_tag = true;
                output.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output = output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    output
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(100_000)
        .collect()
}
fn unwrap_spreadsheet_value(value: &str) -> String {
    let value = value.trim();
    if value.starts_with("=\"") && value.ends_with('"') && value.len() >= 3 {
        value[2..value.len() - 1].replace("\"\"", "\"")
    } else {
        value.to_owned()
    }
}
fn parse_year(value: &str) -> Option<i32> {
    let candidate = value.trim().chars().take(4).collect::<String>();
    let year = candidate.parse().ok()?;
    (1..=9999).contains(&year).then_some(year)
}
fn parse_rating(value: &str) -> Option<f64> {
    let rating = value.trim().parse::<f64>().ok()?;
    (rating.is_finite() && rating >= 0.0 && rating <= 10.0).then_some(rating)
}
fn rating_scale(provider: &str) -> String {
    match provider {
        "imdb" => "1-10",
        "letterboxd" => "0.5-5",
        "goodreads" => "0-5",
        "myAnimeList" => "0-10",
        _ => "unknown",
    }
    .into()
}
fn normalize_isbn(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_digit() || *ch == 'X' || *ch == 'x')
        .map(|ch| ch.to_ascii_uppercase())
        .collect()
}
fn valid_isbn(value: &str) -> bool {
    if value.len() == 13 && value.bytes().all(|byte| byte.is_ascii_digit()) {
        let sum: i32 = value
            .bytes()
            .enumerate()
            .map(|(i, byte)| (byte - b'0') as i32 * if i % 2 == 0 { 1 } else { 3 })
            .sum();
        sum % 10 == 0
    } else if value.len() == 10 {
        let mut sum = 0i32;
        for (i, byte) in value.bytes().enumerate() {
            let digit = if i == 9 && matches!(byte, b'X' | b'x') {
                10
            } else if byte.is_ascii_digit() {
                (byte - b'0') as i32
            } else {
                return false;
            };
            sum += digit * (10 - i as i32);
        }
        sum % 11 == 0
    } else {
        false
    }
}
fn split_labels(value: &str) -> Vec<String> {
    value
        .split([';', ',', '|'])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .take(100)
        .map(|v| v.chars().take(100).collect())
        .collect()
}
fn split_creators(value: &str) -> Vec<String> {
    value
        .split([';', '|'])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .take(100)
        .map(|v| v.chars().take(200).collect())
        .collect()
}
fn parse_count(value: &str) -> Option<u64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    (parsed.is_finite() && parsed >= 0.0 && parsed <= 10_000_000.0 && parsed.fract() == 0.0)
        .then_some(parsed as u64)
}
fn progress(record: &HashMap<String, String>) -> Option<SourceProgress> {
    let current = parse_count(&get_cell(
        record,
        &[
            "episodes watched",
            "chapters read",
            "volumes read",
            "progress",
            "played",
        ],
    )?)?;
    let total = get_cell(
        record,
        &[
            "episodes",
            "chapters",
            "volumes",
            "total episodes",
            "total chapters",
        ],
    )
    .and_then(|v| parse_count(&v));
    let unit = if record.contains_key("chapters read") || record.contains_key("chapters") {
        "chapters"
    } else if record.contains_key("volumes read") {
        "volumes"
    } else if record.contains_key("played") {
        "minutes"
    } else {
        "episodes"
    };
    Some(SourceProgress {
        unit: unit.into(),
        current: current as f64,
        total: total.map(|v| v as f64),
    })
}
fn map_media_type(
    provider: &str,
    provider_type: Option<&str>,
    provider_genres: Option<&str>,
) -> Option<String> {
    let kind = provider_type.unwrap_or("").to_ascii_lowercase();
    let genres = provider_genres.unwrap_or("");
    match provider {
        "letterboxd" => Some("films".into()),
        "imdb" => Some(
            if genres
                .split(|character: char| !character.is_ascii_alphanumeric())
                .any(|genre| genre.eq_ignore_ascii_case("animation"))
            {
                // Tastellar's Animation type intentionally includes anime and
                // western animation (for example, Arcane).
                "anime"
            } else if kind.contains("tv")
                || kind.contains("series")
                || kind.contains("episode")
                || kind.contains("mini")
            {
                "tv-series"
            } else {
                "films"
            }
            .into(),
        ),
        "goodreads" => Some("literature".into()),
        "myAnimeList" => Some(
            if kind.contains("manga") {
                "comic"
            } else {
                "anime"
            }
            .into(),
        ),
        _ => None,
    }
}
fn activity_fingerprint_seed(
    provider: &str,
    source_id: &str,
    kind: &str,
    dates: &BTreeMap<String, String>,
    rating: Option<&SourceRating>,
    tags: &[String],
    has_review: bool,
    rewatch: Option<bool>,
) -> String {
    serde_json::json!([provider, source_id, kind, dates, rating, tags, has_review, rewatch])
        .to_string()
}
fn make_activity(
    provider: &str,
    source_id: &str,
    kind: &str,
    dates: &BTreeMap<String, String>,
    rating: Option<SourceRating>,
    tags: &[String],
    has_review: bool,
    rewatch: Option<bool>,
    occurrence: usize,
) -> ImportSourceActivity {
    let seed = serde_json::json!([
        activity_fingerprint_seed(
            provider,
            source_id,
            kind,
            dates,
            rating.as_ref(),
            tags,
            has_review,
            rewatch
        ),
        occurrence
    ]);
    let digest = Sha256::digest(seed.to_string().as_bytes());
    ImportSourceActivity {
        fingerprint: hex_bytes(&digest[..16]),
        kind: kind.into(),
        date_fields: dates.clone(),
        rating,
        rewatch,
        tags: tags.to_vec(),
        has_review,
    }
}
fn snapshot_activity_fingerprint(
    provider: &str,
    source_id: &str,
    activity: &ImportSourceActivity,
    status: Option<&str>,
    progress: Option<&SourceProgress>,
    metadata: &BTreeMap<String, String>,
    opted_in_review: Option<&str>,
) -> String {
    let canonical = serde_json::json!([
        provider,
        source_id,
        activity.fingerprint,
        status,
        progress,
        metadata,
        opted_in_review
    ]);
    let digest = Sha256::digest(canonical.to_string().as_bytes());
    hex_bytes(&digest[..16])
}
fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn populate_import_candidates(rows: &mut [ImportSourceRow], library: &LibraryState) {
    let mut exact = HashMap::<(String, String, String), String>::new();
    let mut by_title = HashMap::<String, Vec<&Entry>>::new();
    for entry in &library.entries {
        for identity in &entry.external_identities {
            exact.insert(
                (
                    identity.provider.clone(),
                    identity.entity_kind.clone(),
                    identity.external_id.clone(),
                ),
                entry.id.clone(),
            );
        }
        by_title
            .entry(normalize_title(&entry.title))
            .or_default()
            .push(entry);
    }
    let type_ids: HashSet<&str> = library
        .media_types
        .iter()
        .map(|media_type| media_type.id.as_str())
        .collect();
    let mut staged =
        HashMap::<(String, Option<i32>), Vec<(String, String, Option<String>, String)>>::new();
    let mut staged_exact =
        HashMap::<(String, String, String), Vec<(String, String, Option<String>, String)>>::new();
    for row in rows.iter_mut() {
        let mut matched_ids = HashSet::new();
        for identity in &row.source_identities {
            if let Some(entry_id) = exact.get(&(
                identity.provider.clone(),
                identity.entity_kind.clone(),
                identity.external_id.clone(),
            )) {
                let entry = library.entries.iter().find(|entry| &entry.id == entry_id);
                row.exact_entry_id = Some(entry_id.clone());
                row.candidates.push(ImportCandidate {
                    entry_id: Some(entry_id.clone()),
                    source_row_id: None,
                    title: entry.map(|value| value.title.clone()).unwrap_or_default(),
                    media_type_id: entry.and_then(|value| value.media_type_id.clone()),
                    year: entry.and_then(|value| value.release_date.as_ref().map(|date| date.year)),
                    provider: Some(identity.provider.clone()),
                    external_id: Some(identity.external_id.clone()),
                    reason: "exact-id".into(),
                    confidence: "high".into(),
                });
                matched_ids.insert(entry_id.clone());
                break;
            }
        }
        for identity in &row.source_identities {
            if let Some(previous) = staged_exact.get(&(
                identity.provider.clone(),
                identity.entity_kind.clone(),
                identity.external_id.clone(),
            )) {
                for (source_row_id, title, media_type_id, provider) in previous.iter().take(10) {
                    row.candidates.push(ImportCandidate {
                        entry_id: None,
                        source_row_id: Some(source_row_id.clone()),
                        title: title.clone(),
                        media_type_id: media_type_id.clone(),
                        year: row.year,
                        provider: Some(provider.clone()),
                        external_id: Some(identity.external_id.clone()),
                        reason: "exact-id".into(),
                        confidence: "high".into(),
                    });
                }
            }
        }
        if row.candidates.is_empty() {
            let mut aliases = vec![row.title.as_str()];
            if let Some(original) = row.original_title.as_deref() {
                if original != row.title {
                    aliases.push(original);
                }
            }
            let mut seen_entry_ids = matched_ids;
            for alias in aliases {
                if let Some(matches) = by_title.get(&normalize_title(alias)) {
                    for entry in matches {
                        if !seen_entry_ids.insert(entry.id.clone()) {
                            continue;
                        }
                        if row
                            .suggested_media_type_id
                            .as_ref()
                            .is_some_and(|expected| {
                                entry
                                    .media_type_id
                                    .as_ref()
                                    .is_some_and(|actual| actual != expected)
                            })
                        {
                            continue;
                        }
                        let entry_year = entry.release_date.as_ref().map(|date| date.year);
                        let year_close = match (row.year, entry_year) {
                            (Some(left), Some(right)) => left.abs_diff(right) <= 1,
                            _ => false,
                        };
                        if year_close {
                            row.candidates.push(ImportCandidate {
                                entry_id: Some(entry.id.clone()),
                                source_row_id: None,
                                title: entry.title.clone(),
                                media_type_id: entry.media_type_id.clone(),
                                year: entry_year,
                                provider: None,
                                external_id: None,
                                reason: "title-year".into(),
                                confidence: "medium".into(),
                            });
                        }
                        if row.candidates.len() >= 10 {
                            break;
                        }
                    }
                }
            }
        }
        let compatible_same_batch = |candidate_type: &Option<String>| {
            row.suggested_media_type_id.as_ref().is_none_or(|expected| {
                candidate_type
                    .as_ref()
                    .is_none_or(|actual| actual == expected)
            })
        };
        let mut aliases = vec![row.title.as_str()];
        if let Some(original) = row.original_title.as_deref() {
            if original != row.title {
                aliases.push(original);
            }
        }
        let mut seen_staged = HashSet::new();
        for alias in &aliases {
            let title_key = (normalize_title(alias), row.year);
            if let Some(previous) = staged.get(&title_key) {
                for (source_row_id, title, media_type_id, provider) in previous.iter().take(10) {
                    if compatible_same_batch(media_type_id)
                        && seen_staged.insert(source_row_id.clone())
                    {
                        row.candidates.push(ImportCandidate {
                            entry_id: None,
                            source_row_id: Some(source_row_id.clone()),
                            title: title.clone(),
                            media_type_id: media_type_id.clone(),
                            year: row.year,
                            provider: Some(provider.clone()),
                            external_id: None,
                            reason: "same-batch".into(),
                            confidence: "medium".into(),
                        });
                    }
                }
            }
        }
        let staged_value = (
            row.row_id.clone(),
            row.title.clone(),
            row.suggested_media_type_id.clone(),
            row.provider.clone(),
        );
        staged
            .entry((normalize_title(&row.title), row.year))
            .or_default()
            .push(staged_value.clone());
        if let Some(original) = row
            .original_title
            .as_deref()
            .filter(|value| *value != row.title)
        {
            staged
                .entry((normalize_title(original), row.year))
                .or_default()
                .push(staged_value.clone());
        }
        for identity in &row.source_identities {
            staged_exact
                .entry((
                    identity.provider.clone(),
                    identity.entity_kind.clone(),
                    identity.external_id.clone(),
                ))
                .or_default()
                .push(staged_value.clone());
        }
        if row
            .suggested_media_type_id
            .as_deref()
            .is_some_and(|id| !type_ids.contains(id))
        {
            row.suggested_media_type_id = None;
            row.warnings
                .push("The suggested media type is not currently available.".into());
        }
    }
}
fn normalize_title(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn identity_provider(provider: &str) -> &str {
    match provider {
        "myAnimeList" => "myanimelist",
        "genericCsv" => "genericcsv",
        other => other,
    }
}

fn validate_decisions(
    decisions: &[ImportDecision],
    rows: &HashMap<String, ImportSourceRow>,
    policy: &ImportRatingPolicy,
) -> Result<(), StorageError> {
    if !matches!(
        policy.mode.as_str(),
        "priority" | "latestComparable" | "manual" | "preserveOnly"
    ) {
        return Err(StorageError::Validation("Unsupported rating policy".into()));
    }
    let mut seen_rows = HashSet::new();
    let mut seen_targets = HashSet::new();
    for decision in decisions {
        if decision.row_ids.is_empty() {
            return Err(StorageError::Validation(
                "Each import decision must include at least one row".into(),
            ));
        }
        if !matches!(decision.action.as_str(), "create" | "link" | "skip") {
            return Err(StorageError::Validation("Unsupported import action".into()));
        }
        if decision.action == "link" {
            let target = decision
                .target_entry_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    StorageError::Validation("Choose an existing item to link".into())
                })?;
            if !seen_targets.insert(target) {
                return Err(StorageError::Validation(
                    "Use one decision group per existing item".into(),
                ));
            }
        } else if decision.target_entry_id.is_some() {
            return Err(StorageError::Validation(
                "Only link decisions can target an existing item".into(),
            ));
        }
        if decision
            .manual_overall_rating
            .is_some_and(|score| !(1..=10).contains(&score))
        {
            return Err(StorageError::Validation(
                "Your rating must be from 1 to 10".into(),
            ));
        }
        for row_id in &decision.row_ids {
            if !rows.contains_key(row_id) || !seen_rows.insert(row_id) {
                return Err(StorageError::Validation(
                    "Import rows must be used exactly once".into(),
                ));
            }
        }
        let mut selected_ratings = HashSet::new();
        for selection in &decision.rating_selections {
            if !decision.row_ids.contains(&selection.source_row_id)
                || !selected_ratings.insert(selection.source_row_id.as_str())
            {
                return Err(StorageError::Validation(
                    "Rating choices must reference unique rows in this decision".into(),
                ));
            }
            if selection.accept_native
                && rows
                    .get(&selection.source_row_id)
                    .and_then(|row| row.source_rating.as_ref())
                    .and_then(normalized_source_rating)
                    .is_none()
            {
                return Err(StorageError::Validation(
                    "A selected source row has no comparable rating".into(),
                ));
            }
        }
        let mut mapped_tags = HashSet::new();
        for mapping in &decision.tag_mappings {
            if !decision.row_ids.contains(&mapping.row_id)
                || mapping.source_tag.trim().is_empty()
                || !mapped_tags.insert((mapping.row_id.as_str(), mapping.source_tag.as_str()))
            {
                return Err(StorageError::Validation(
                    "Source tag mappings must be unique and belong to this decision".into(),
                ));
            }
        }
        if decision.enrichments.len() > 1
            || decision
                .enrichments
                .iter()
                .any(|value| !decision.row_ids.contains(&value.source_row_id))
        {
            return Err(StorageError::Validation(
                "Choose at most one catalog match from rows in this group".into(),
            ));
        }
        if decision.action != "skip"
            && policy.mode != "preserveOnly"
            && decision.manual_overall_rating.is_none()
        {
            let group_rows: Vec<&ImportSourceRow> = decision
                .row_ids
                .iter()
                .filter_map(|id| rows.get(id))
                .collect();
            let accepts_score = decision
                .rating_selections
                .iter()
                .any(|selection| selection.accept_native);
            if accepts_score && choose_rating(decision, policy, &group_rows).is_none() {
                return Err(StorageError::Validation("Resolve the rating conflict, choose a source score, or preserve the existing score".into()));
            }
        }
        for enrichment in &decision.enrichments {
            if enrichment.title.trim().is_empty() || enrichment.title.chars().count() > 500 {
                return Err(StorageError::Validation(
                    "Catalog title must be 1–500 characters".into(),
                ));
            }
            validate_external_identities(&enrichment.external_identities)?;
            if let Some(cover) = &enrichment.remote_cover {
                validate_remote_cover(cover)?;
            }
        }
    }
    if seen_rows.len() != rows.len() {
        return Err(StorageError::Validation(
            "Review every import row before committing".into(),
        ));
    }
    let mut manual_keys = HashSet::new();
    for manual in &policy.manual_selections {
        if manual.row_ids.is_empty() || !manual.row_ids.contains(&manual.source_row_id) {
            return Err(StorageError::Validation(
                "Manual rating selections must name their source row".into(),
            ));
        }
        let mut canonical_ids = manual.row_ids.clone();
        canonical_ids.sort();
        if !manual_keys.insert((canonical_ids, manual.source_row_id.clone())) {
            return Err(StorageError::Validation(
                "Manual rating selections must be unique".into(),
            ));
        }
        let mut unique = HashSet::new();
        for row_id in &manual.row_ids {
            if !unique.insert(row_id) || !rows.contains_key(row_id) {
                return Err(StorageError::Validation(
                    "Manual rating selection references an unknown or duplicate row".into(),
                ));
            }
        }
        let row = rows.get(&manual.source_row_id).expect("validated above");
        if row
            .source_rating
            .as_ref()
            .and_then(normalized_source_rating)
            .is_none()
        {
            return Err(StorageError::Validation(
                "Choose a row with a comparable rating".into(),
            ));
        }
        let group = decisions
            .iter()
            .find(|decision| {
                manual
                    .row_ids
                    .iter()
                    .all(|row_id| decision.row_ids.contains(row_id))
            })
            .ok_or_else(|| {
                StorageError::Validation(
                    "Manual rating rows must belong to a single reviewed group".into(),
                )
            })?;
        if !group.rating_selections.iter().any(|selection| {
            selection.source_row_id == manual.source_row_id && selection.accept_native
        }) {
            return Err(StorageError::Validation(
                "The selected manual source rating must be accepted in the reviewed group".into(),
            ));
        }
    }
    Ok(())
}
fn validate_disposition(value: &str) -> Result<(), StorageError> {
    if matches!(value, "experienced" | "planned" | "dropped") {
        Ok(())
    } else {
        Err(StorageError::Validation(
            "Choose a valid media status".into(),
        ))
    }
}
fn validate_media_type(tx: &Transaction<'_>, value: Option<&str>) -> Result<(), StorageError> {
    if let Some(id) = value {
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media_type WHERE id=?1 AND archived_at IS NULL)",
            [id],
            |row| row.get(0),
        )?;
        if !active {
            return Err(StorageError::Validation(
                "Choose an active media type".into(),
            ));
        }
    }
    Ok(())
}
fn normalized_source_rating(rating: &SourceRating) -> Option<f64> {
    let value = rating.value;
    if !value.is_finite() {
        return None;
    }
    match rating.scale.as_str() {
        "0.5-5"
            if (0.5..=5.0).contains(&value)
                && ((value * 2.0).round() - value * 2.0).abs() < 1e-9 =>
        {
            Some(value * 2.0)
        }
        "0-5" | "1-5" if (1.0..=5.0).contains(&value) && value.fract() == 0.0 => Some(value * 2.0),
        "0-10" | "1-10" if (1.0..=10.0).contains(&value) && value.fract() == 0.0 => Some(value),
        // Zero is an unrated sentinel for these provider scales. Unknown scales
        // require an explicit local score, rather than an invented conversion.
        _ => None,
    }
}

/// Compare only documented IMDb rating calendar dates. An add/watch/finish
/// date, or an opaque Letterboxd `Date`, is never a rating timestamp.
fn comparable_rating_date(row: &ImportSourceRow) -> Option<(i32, u32, u32)> {
    if row.provider != "imdb" {
        return None;
    }
    let value = row.source_dates.get("date rated")?;
    if value.len() != 10 || !value.is_ascii() {
        return None;
    }
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;
    if !(1..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&day).then_some((year, month, day))
}

fn choose_rating<'a>(
    decision: &'a ImportDecision,
    policy: &'a ImportRatingPolicy,
    rows: &'a [&ImportSourceRow],
) -> Option<(f64, &'a str)> {
    if let Some(value) = decision.manual_overall_rating {
        return (1..=10)
            .contains(&value)
            .then_some((f64::from(value), "manual"));
    }
    if policy.mode == "preserveOnly" {
        return None;
    }
    let accepted: Vec<(&ImportSourceRow, &str, f64)> = decision
        .rating_selections
        .iter()
        .filter(|selection| selection.accept_native)
        .filter_map(|selection| {
            let row = rows
                .iter()
                .copied()
                .find(|row| row.row_id == selection.source_row_id)?;
            let value = normalized_source_rating(row.source_rating.as_ref()?)?;
            Some((row, selection.source_row_id.as_str(), value))
        })
        .collect();
    let manual = policy.manual_selections.iter().find(|selection| {
        selection
            .row_ids
            .iter()
            .any(|id| decision.row_ids.contains(id))
    });
    if let Some(selection) = manual {
        return accepted
            .iter()
            .find(|(_, id, _)| *id == selection.source_row_id)
            .map(|(_, id, value)| (*value, *id));
    }
    let first = accepted.first()?;
    if accepted
        .iter()
        .all(|(_, _, value)| (*value - first.2).abs() < 1e-9)
    {
        return Some((first.2, first.1));
    }
    match policy.mode.as_str() {
        "priority" => {
            let best = accepted
                .iter()
                .filter_map(|(row, _, _)| {
                    policy
                        .priority
                        .iter()
                        .position(|provider| provider == &row.provider)
                })
                .min()?;
            let choices: Vec<_> = accepted
                .iter()
                .filter(|(row, _, _)| {
                    policy
                        .priority
                        .iter()
                        .position(|provider| provider == &row.provider)
                        == Some(best)
                })
                .collect();
            let winner = choices.first()?;
            choices
                .iter()
                .all(|(_, _, value)| (*value - winner.2).abs() < 1e-9)
                .then_some((winner.2, winner.1))
        }
        "latestComparable" => {
            // Every competing score must have a comparable rating date. Never
            // silently discard an undated score to manufacture a newest one.
            let dates: Vec<_> = accepted
                .iter()
                .map(|(row, _, _)| comparable_rating_date(row))
                .collect::<Option<Vec<_>>>()?;
            let latest = dates.iter().max()?;
            let choices: Vec<_> = accepted
                .iter()
                .zip(&dates)
                .filter(|(_, date)| *date == latest)
                .map(|(value, _)| value)
                .collect();
            let winner = choices.first()?;
            choices
                .iter()
                .all(|(_, _, value)| (*value - winner.2).abs() < 1e-9)
                .then_some((winner.2, winner.1))
        }
        // Multiple different accepted scores need a source/value choice. File
        // order is not a manual policy and must not decide a conflict.
        _ => None,
    }
}

/// Input is already normalized; never clamp invalid or unknown provider scores.
fn rating_to_local(value: f64) -> Option<i32> {
    (value.is_finite() && (1.0..=10.0).contains(&value)).then(|| value.round() as i32)
}
fn collect_identities(rows: &[&ImportSourceRow]) -> Vec<ExternalIdentity> {
    let mut output = Vec::new();
    let mut unique = HashSet::new();
    for row in rows {
        for identity in &row.source_identities {
            if unique.insert((
                identity.provider.clone(),
                identity.entity_kind.clone(),
                identity.external_id.clone(),
            )) {
                output.push(identity.clone());
            }
        }
        // Parsed identities are authoritative. Do not add a second identity
        // under a CSV format name such as "movie" for the same source item.
        if !row.source_identities.is_empty() {
            continue;
        }
        if let Some(id) = row.external_id.as_ref().filter(|id| !id.trim().is_empty()) {
            let identity = ExternalIdentity {
                provider: if row.provider == "goodreads" && valid_isbn(id) {
                    "isbn".into()
                } else {
                    identity_provider(&row.provider).into()
                },
                entity_kind: if row.provider == "imdb" {
                    "title".into()
                } else if row.provider == "goodreads" && valid_isbn(id) {
                    "edition".into()
                } else if row.provider == "goodreads" {
                    "book".into()
                } else if row.provider == "letterboxd" {
                    "film".into()
                } else if row.provider == "steam" {
                    "game".into()
                } else if row.provider == "myAnimeList" {
                    if row
                        .provider_media_type
                        .as_deref()
                        .is_some_and(|kind| kind.to_ascii_lowercase().contains("manga"))
                    {
                        "manga"
                    } else {
                        "anime"
                    }
                    .into()
                } else {
                    row.provider_media_type
                        .clone()
                        .unwrap_or_else(|| "work".into())
                },
                external_id: id.clone(),
                source_url: row.source_url.clone(),
            };
            if unique.insert((
                identity.provider.clone(),
                identity.entity_kind.clone(),
                identity.external_id.clone(),
            )) {
                output.push(identity);
            }
        }
    }
    output
}

fn release_trashed_identity_owners(
    tx: &Transaction<'_>,
    identities: &[ExternalIdentity],
) -> Result<(), StorageError> {
    for identity in identities {
        let owner: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT identity.entry_id,entry.trashed_at FROM external_identity AS identity JOIN entry ON entry.id=identity.entry_id WHERE identity.provider=?1 AND identity.entity_kind=?2 AND identity.external_id=?3",
                params![identity.provider, identity.entity_kind, identity.external_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((entry_id, Some(_))) = owner {
            tx.execute(
                "DELETE FROM external_identity WHERE provider=?1 AND entity_kind=?2 AND external_id=?3 AND entry_id=?4",
                params![identity.provider, identity.entity_kind, identity.external_id, entry_id],
            )?;
            tx.execute(
                "DELETE FROM import_source_activity WHERE entry_id=?1",
                [&entry_id],
            )?;
        }
    }
    Ok(())
}

fn ensure_import_identity_owners(
    tx: &Transaction<'_>,
    identities: &[ExternalIdentity],
    expected_entry_id: Option<&str>,
) -> Result<(), StorageError> {
    for identity in identities {
        let owner: Option<String> = tx
            .query_row(
                "SELECT entry_id FROM external_identity WHERE provider=?1 AND entity_kind=?2 AND external_id=?3",
                params![identity.provider, identity.entity_kind, identity.external_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner
            .as_deref()
            .is_some_and(|owner| Some(owner) != expected_entry_id)
        {
            return Err(StorageError::Validation(
                "A selected source or catalog ID is already linked to another library item. Review the matching item or remove the duplicate catalog match.".into(),
            ));
        }
    }
    Ok(())
}

fn dedupe_identities(identities: &mut Vec<ExternalIdentity>) {
    let mut seen = HashSet::new();
    identities.retain(|identity| {
        seen.insert((
            identity.provider.clone(),
            identity.entity_kind.clone(),
            identity.external_id.clone(),
        ))
    });
}
fn selected_enrichment<'a>(
    decision: &'a ImportDecision,
    rows: &[&ImportSourceRow],
) -> Result<Option<&'a ImportEnrichment>, StorageError> {
    if decision.enrichments.len() > 1 {
        return Err(StorageError::Validation(
            "Choose at most one catalog match for a grouped item".into(),
        ));
    }
    let Some(enrichment) = decision.enrichments.first() else {
        return Ok(None);
    };
    if !decision.row_ids.contains(&enrichment.source_row_id)
        || !rows
            .iter()
            .any(|row| row.row_id == enrichment.source_row_id)
    {
        return Err(StorageError::Validation(
            "Catalog matches must belong to this import group".into(),
        ));
    }
    if enrichment.title.trim().is_empty() || enrichment.title.chars().count() > 500 {
        return Err(StorageError::Validation(
            "Catalog title must be 1–500 characters".into(),
        ));
    }
    validate_external_identities(&enrichment.external_identities)?;
    if let Some(cover) = &enrichment.remote_cover {
        validate_remote_cover(cover)?;
    }
    Ok(Some(enrichment))
}

fn apply_import_tags(
    tx: &Transaction<'_>,
    entry_id: &str,
    decision: &ImportDecision,
) -> Result<bool, StorageError> {
    let mut ids: BTreeSet<String> = tx
        .prepare("SELECT tag_id FROM entry_tag WHERE entry_id=?1")?
        .query_map([entry_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for id in &decision.tag_ids {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::Validation("Choose an existing tag".into()));
        }
        ids.insert(id.clone());
    }
    for name in &decision.new_tag_names {
        let clean = name.trim();
        if clean.is_empty() || clean.chars().count() > 100 || clean.chars().any(char::is_control) {
            return Err(StorageError::Validation(
                "Tag names must be 1–100 characters".into(),
            ));
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM tag WHERE normalized_name=?1",
                [crate::normalize_name(clean)],
                |row| row.get(0),
            )
            .optional()?;
        let id = if let Some(id) = existing {
            id
        } else {
            let id = format!("tag-import-{}", now_nanos());
            let now = now_rfc3339();
            tx.execute(
                "INSERT INTO tag(id,name,normalized_name,created_at,updated_at,version) VALUES(?1,?2,?3,?4,?4,1)",
                params![id, clean, crate::normalize_name(clean), now],
            )?;
            id
        };
        ids.insert(id);
    }
    for mapping in &decision.tag_mappings {
        if !decision.row_ids.contains(&mapping.row_id) || mapping.source_tag.trim().is_empty() {
            return Err(StorageError::Validation(
                "Source tag mapping is invalid".into(),
            ));
        }
        match mapping.action.as_str() {
            "ignore" => {}
            "existing" => {
                let id = mapping.tag_id.as_deref().ok_or_else(|| {
                    StorageError::Validation("Choose a tag for this source label".into())
                })?;
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)",
                    [id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Validation("Choose an existing tag".into()));
                }
                ids.insert(id.into());
            }
            "create" => {
                let name = mapping
                    .new_tag_name
                    .as_deref()
                    .ok_or_else(|| StorageError::Validation("Enter a tag name".into()))?
                    .trim();
                if name.is_empty() || name.chars().count() > 100 {
                    return Err(StorageError::Validation(
                        "Tag names must be 1–100 characters".into(),
                    ));
                }
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM tag WHERE normalized_name=?1",
                        [crate::normalize_name(name)],
                        |row| row.get(0),
                    )
                    .optional()?;
                let id = if let Some(id) = existing {
                    id
                } else {
                    let id = format!("tag-import-{}", now_nanos());
                    let now = now_rfc3339();
                    tx.execute("INSERT INTO tag(id,name,normalized_name,created_at,updated_at,version) VALUES(?1,?2,?3,?4,?4,1)",params![id,name,crate::normalize_name(name),now])?;
                    id
                };
                ids.insert(id);
            }
            _ => {
                return Err(StorageError::Validation(
                    "Unsupported source-tag action".into(),
                ))
            }
        }
    }
    let changed: BTreeSet<String> = tx
        .prepare("SELECT tag_id FROM entry_tag WHERE entry_id=?1")?
        .query_map([entry_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    if changed == ids {
        return Ok(false);
    }
    tx.execute("DELETE FROM entry_tag WHERE entry_id=?1", [entry_id])?;
    for id in ids {
        tx.execute(
            "INSERT INTO entry_tag(entry_id,tag_id) VALUES(?1,?2)",
            params![entry_id, id],
        )?;
    }
    Ok(true)
}

pub(crate) fn load_entry_snapshot(
    tx: &Transaction<'_>,
    entry_id: &str,
) -> Result<Option<EntrySnapshot>, StorageError> {
    let Some((version,title,disposition,media_type_id,rating,cover_asset_id,year,month,day,precision,review_text,short_label,created_at,updated_at,import_order))=tx.query_row("SELECT version,title,disposition,media_type_id,overall_rating,cover_asset_id,release_year,release_month,release_day,release_precision,review_text,short_label,created_at,updated_at,import_order FROM entry WHERE id=?1 AND trashed_at IS NULL",[entry_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<i32>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<i32>>(6)?,r.get::<_,Option<u8>>(7)?,r.get::<_,Option<u8>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,String>(10)?,r.get::<_,Option<String>>(11)?,r.get::<_,String>(12)?,r.get::<_,String>(13)?,r.get::<_,i64>(14)?))).optional()? else{return Ok(None)};
    let release_date = year.zip(precision).map(|(year, precision)| ReleaseDate {
        year,
        month,
        day,
        precision,
    });
    let mut criterion_ratings = BTreeMap::new();
    {
        let mut stmt =
            tx.prepare("SELECT criterion_id,score FROM criterion_rating WHERE entry_id=?1")?;
        for row in stmt.query_map([entry_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?))
        })? {
            let (k, v) = row?;
            criterion_ratings.insert(k, v);
        }
    }
    let mut tag_ids = Vec::new();
    {
        let mut stmt = tx.prepare("SELECT tag_id FROM entry_tag WHERE entry_id=?1")?;
        for row in stmt.query_map([entry_id], |r| r.get::<_, String>(0))? {
            tag_ids.push(row?);
        }
    }
    let mut external_identities = Vec::new();
    {
        let mut stmt=tx.prepare("SELECT provider,entity_kind,external_id,source_url FROM external_identity WHERE entry_id=?1")?;
        for row in stmt.query_map([entry_id], |r| {
            Ok(ExternalIdentity {
                provider: r.get(0)?,
                entity_kind: r.get(1)?,
                external_id: r.get(2)?,
                source_url: r.get(3)?,
            })
        })? {
            external_identities.push(row?);
        }
    }
    let remote_cover=tx.query_row("SELECT remote_cover_provider,remote_cover_url,remote_cover_source_url,remote_cover_attribution FROM entry WHERE id=?1",[entry_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional()?.and_then(|(provider,url,source_url,attribution)|provider.zip(url).map(|(provider,url)|RemoteCoverReference{provider,url,source_url,attribution}));
    let entry = Entry {
        id: entry_id.into(),
        import_order: Some(import_order),
        version,
        title,
        disposition,
        media_type_id,
        overall_rating: rating,
        cover_asset_id,
        release_date,
        review_text,
        external_identities,
        remote_cover,
        legacy_notes_text: None,
        legacy_notes_text_snake_case: None,
        short_label,
        criterion_ratings,
        tag_ids,
        created_at,
        updated_at,
    };
    let group = tx
        .query_row(
            "SELECT group_id,order_key FROM group_order WHERE entry_id=?1",
            [entry_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let ranking = tx
        .query_row(
            "SELECT score,placed FROM ranking_entry WHERE entry_id=?1",
            [entry_id],
            |r| Ok((r.get::<_, i32>(0)?, r.get::<_, bool>(1)?)),
        )
        .optional()?;
    let ranking_boundaries = {
        let mut statement = tx.prepare("SELECT id,score,first_id,second_id,preferred_id,weight,protected FROM ranking_boundary WHERE first_id=?1 OR second_id=?1 ORDER BY id")?;
        let values = statement
            .query_map([entry_id], |row| {
                Ok(ImportBoundarySnapshot {
                    id: row.get(0)?,
                    score: row.get(1)?,
                    first_id: row.get(2)?,
                    second_id: row.get(3)?,
                    preferred_id: row.get(4)?,
                    weight: row.get(5)?,
                    protected: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        values
    };
    let ranking_judgments = {
        let mut statement = tx.prepare(
            "SELECT id,retracted FROM ranking_judgment WHERE left_id=?1 OR right_id=?1 ORDER BY id",
        )?;
        let values = statement
            .query_map([entry_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        values
    };
    Ok(Some(EntrySnapshot {
        entry,
        group_id: group.as_ref().map(|v| v.0.clone()),
        order_key: group.map(|v| v.1),
        ranking_score: ranking.as_ref().map(|v| v.0),
        ranking_placed: ranking.map(|v| v.1).unwrap_or(false),
        ranking_boundaries,
        ranking_judgments,
    }))
}

fn update_import_ranking(
    tx: &Transaction<'_>,
    entry_id: &str,
    old: Option<i32>,
    new: Option<i32>,
    before: &EntrySnapshot,
    disposition: &str,
) -> Result<(), StorageError> {
    match new {
        Some(score) => {
            tx.execute("INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,0) ON CONFLICT(entry_id) DO UPDATE SET score=excluded.score,placed=0",params![entry_id,score])?;
        }
        None => {
            tx.execute("DELETE FROM ranking_entry WHERE entry_id=?1", [entry_id])?;
        }
    }
    let group = match (disposition, new) {
        ("planned", _) => "planned".into(),
        ("dropped", _) => "dropped".into(),
        ("experienced", Some(score)) => format!("rating-{score:02}"),
        _ => "unrated".into(),
    };
    let key = if old == new && before.group_id.as_deref() == Some(group.as_str()) {
        before
            .order_key
            .clone()
            .unwrap_or(crate::ranking::next_order_key(tx, &group)?)
    } else {
        crate::ranking::next_order_key(tx, &group)?
    };
    tx.execute("INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET group_id=excluded.group_id,order_key=excluded.order_key",params![entry_id,group,key])?;
    for score in [old, new].into_iter().flatten() {
        tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
        tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1",[score])?;
    }
    tx.execute(
        "DELETE FROM ranking_boundary WHERE first_id=?1 OR second_id=?1",
        [entry_id],
    )?;
    Ok(())
}

fn restore_entry_snapshot(
    tx: &Transaction<'_>,
    snapshot: &EntrySnapshot,
) -> Result<(), StorageError> {
    let e = &snapshot.entry;
    let release = e.release_date.as_ref();
    tx.execute("UPDATE entry SET title=?1,disposition=?2,media_type_id=?3,overall_rating=?4,cover_asset_id=?5,release_year=?6,release_month=?7,release_day=?8,release_precision=?9,review_text=?10,short_label=?11,remote_cover_provider=?12,remote_cover_url=?13,remote_cover_source_url=?14,remote_cover_attribution=?15,updated_at=?16,version=version+1 WHERE id=?17",params![e.title,e.disposition,e.media_type_id,e.overall_rating,e.cover_asset_id,release.map(|d|d.year),release.and_then(|d|d.month),release.and_then(|d|d.day),release.map(|d|d.precision.as_str()),e.review_text,e.short_label,e.remote_cover.as_ref().map(|c|c.provider.as_str()),e.remote_cover.as_ref().map(|c|c.url.as_str()),e.remote_cover.as_ref().and_then(|c|c.source_url.as_deref()),e.remote_cover.as_ref().and_then(|c|c.attribution.as_deref()),now_rfc3339(),e.id])?;
    tx.execute("DELETE FROM criterion_rating WHERE entry_id=?1", [&e.id])?;
    for (id, score) in &e.criterion_ratings {
        tx.execute("INSERT INTO criterion_rating(entry_id,criterion_id,score,recorded_at) VALUES(?1,?2,?3,?4)",params![e.id,id,score,now_rfc3339()])?;
    }
    tx.execute("DELETE FROM entry_tag WHERE entry_id=?1", [&e.id])?;
    for tag in &e.tag_ids {
        tx.execute(
            "INSERT INTO entry_tag(entry_id,tag_id) VALUES(?1,?2)",
            params![e.id, tag],
        )?;
    }
    tx.execute("DELETE FROM external_identity WHERE entry_id=?1", [&e.id])?;
    for id in &e.external_identities {
        tx.execute("INSERT INTO external_identity(provider,entity_kind,external_id,source_url,entry_id) VALUES(?1,?2,?3,?4,?5)",params![id.provider,id.entity_kind,id.external_id,id.source_url,e.id])?;
    }
    if let (Some(group), Some(key)) = (&snapshot.group_id, &snapshot.order_key) {
        tx.execute("INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET group_id=excluded.group_id,order_key=excluded.order_key",params![e.id,group,key])?;
    }
    match snapshot.ranking_score {
        Some(score) => {
            tx.execute("INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET score=excluded.score,placed=excluded.placed",params![e.id,score,snapshot.ranking_placed])?;
        }
        None => {
            tx.execute("DELETE FROM ranking_entry WHERE entry_id=?1", [&e.id])?;
        }
    }
    tx.execute(
        "DELETE FROM ranking_boundary WHERE first_id=?1 OR second_id=?1",
        [&e.id],
    )?;
    for boundary in &snapshot.ranking_boundaries {
        tx.execute("INSERT INTO ranking_boundary(id,score,first_id,second_id,preferred_id,weight,protected) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET score=excluded.score,first_id=excluded.first_id,second_id=excluded.second_id,preferred_id=excluded.preferred_id,weight=excluded.weight,protected=excluded.protected", params![boundary.id,boundary.score,boundary.first_id,boundary.second_id,boundary.preferred_id,boundary.weight,boundary.protected])?;
    }
    for score in [e.overall_rating].into_iter().flatten() {
        tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
        tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1",[score])?;
    }
    Ok(())
}
