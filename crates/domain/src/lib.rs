use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use thiserror::Error;

fn default_true() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

const DEFAULT_RECAP_DRAFTS: &str = r#"{"version":1,"drafts":[]}"#;
const MAX_RECAP_DRAFTS_BYTES: usize = 1024 * 1024;
const MAX_RECAP_DRAFT_COUNT: usize = 30;
const MAX_RECAP_SLOT_COUNT: usize = 300;

fn default_recap_drafts() -> String {
    DEFAULT_RECAP_DRAFTS.into()
}

fn is_default_recap_drafts(value: &String) -> bool {
    value == DEFAULT_RECAP_DRAFTS
}

fn bounded_json_string(value: Option<&serde_json::Value>, max_chars: usize) -> bool {
    value.is_some_and(|value| {
        value
            .as_str()
            .is_some_and(|text| !text.is_empty() && text.chars().count() <= max_chars)
    })
}

fn nullable_json_string(value: Option<&serde_json::Value>, max_chars: usize) -> bool {
    value.is_some_and(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|text| text.chars().count() <= max_chars)
    })
}

fn optional_nullable_json_string(value: Option<&serde_json::Value>, max_chars: usize) -> bool {
    value.is_none() || nullable_json_string(value, max_chars)
}

fn valid_recap_filter(value: Option<&serde_json::Value>) -> bool {
    let Some(filter) = value.and_then(serde_json::Value::as_object) else {
        return false;
    };
    let valid_tags = filter.get("tagIds").map_or(true, |ids| {
        ids.as_array().is_some_and(|ids| {
            ids.len() <= 100
                && ids.iter().all(|id| {
                    id.as_str()
                        .is_some_and(|value| !value.is_empty() && value.chars().count() <= 100)
                })
        })
    }) && filter
        .get("tagMode")
        .map_or(true, |mode| matches!(mode.as_str(), Some("any" | "all")));
    match filter.get("kind").and_then(serde_json::Value::as_str) {
        Some("all") => valid_tags,
        Some("types") => {
            filter
                .get("typeIds")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|ids| {
                    ids.len() <= 100
                        && ids.iter().all(|id| {
                            id.as_str().is_some_and(|value| {
                                !value.is_empty() && value.chars().count() <= 100
                            })
                        })
                })
                && valid_tags
        }
        _ => false,
    }
}

fn valid_recap_entry_snapshot(value: &serde_json::Value) -> bool {
    let Some(entry) = value.as_object() else {
        return false;
    };
    let valid_optional_id = |key: &str| {
        entry.get(key).is_some_and(|value| {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|text| !text.is_empty() && text.chars().count() <= 100)
        })
    };
    let valid_asset_id = entry.get("coverAssetId").is_some_and(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
    });
    bounded_json_string(entry.get("id"), 100)
        && bounded_json_string(entry.get("title"), 500)
        && valid_optional_id("mediaTypeId")
        && nullable_json_string(entry.get("mediaTypeName"), 500)
        && optional_nullable_json_string(entry.get("shortLabel"), 500)
        && optional_nullable_json_string(entry.get("iconKey"), 100)
        && entry.get("year").is_some_and(|year| {
            year.is_null() || year.as_i64().is_some_and(|year| (1..=9999).contains(&year))
        })
        && valid_asset_id
}

fn valid_recap_predicate(value: Option<&serde_json::Value>) -> bool {
    let Some(predicate) = value.and_then(serde_json::Value::as_object) else {
        return false;
    };
    match predicate.get("kind").and_then(serde_json::Value::as_str) {
        Some("any") => true,
        Some("year") => predicate
            .get("value")
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|year| (1..=9999).contains(&year)),
        Some("decade") => predicate
            .get("value")
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|decade| (0..=9990).contains(&decade) && decade % 10 == 0),
        Some("format") => bounded_json_string(predicate.get("value"), 100),
        _ => false,
    }
}

fn validate_recap_drafts_json(raw: &str) -> bool {
    if raw.len() > MAX_RECAP_DRAFTS_BYTES {
        return false;
    }
    let Ok(snapshot) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(snapshot) = snapshot.as_object() else {
        return false;
    };
    if snapshot.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return false;
    }
    let Some(drafts) = snapshot.get("drafts").and_then(serde_json::Value::as_array) else {
        return false;
    };
    if drafts.len() > MAX_RECAP_DRAFT_COUNT {
        return false;
    }

    let mut total_slots = 0usize;
    for draft in drafts {
        let Some(draft) = draft.as_object() else {
            return false;
        };
        let Some(slots) = draft.get("slots").and_then(serde_json::Value::as_array) else {
            return false;
        };
        total_slots = match total_slots.checked_add(slots.len()) {
            Some(count) if count <= MAX_RECAP_SLOT_COUNT => count,
            _ => return false,
        };
        if !bounded_json_string(draft.get("id"), 100)
            || draft.get("version").and_then(serde_json::Value::as_u64) != Some(1)
            || ![
                "topTen",
                "challengers",
                "grid3x3",
                "releaseYear",
                "decade",
                "format",
                "selection",
            ]
            .contains(
                &draft
                    .get("templateId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            )
            || !draft
                .get("libraryRevision")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|revision| revision >= 0)
            || !valid_recap_filter(draft.get("filter"))
            || ![
                "dark",
                "daylight",
                "dusk",
                "reading",
                // Keep accepting v1 styles so older backups remain lossless.
                "quiet",
                "paper",
                "editorial",
            ]
            .contains(
                &draft
                    .get("style")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            )
            || !["cover", "text", "mixed"].contains(
                &draft
                    .get("mode")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            )
            || !["portrait", "landscape"].contains(
                &draft
                    .get("orientation")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            )
            || !draft
                .get("showTitles")
                .is_some_and(serde_json::Value::is_boolean)
            || !draft
                .get("watermark")
                .is_some_and(serde_json::Value::is_boolean)
            || draft
                .get("showMediaTypes")
                .is_some_and(|show| !show.is_boolean())
            || !nullable_json_string(draft.get("heading"), 1000)
            || !nullable_json_string(draft.get("caption"), 1000)
            || !draft
                .get("rankingLabel")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|label| ["canonical", "mySelection"].contains(&label))
            || !bounded_json_string(draft.get("createdAt"), 100)
            || !bounded_json_string(draft.get("updatedAt"), 100)
            || draft
                .get("sourceFingerprint")
                .is_some_and(|fingerprint| !bounded_json_string(Some(fingerprint), 100))
        {
            return false;
        }
        for slot in slots {
            let Some(slot) = slot.as_object() else {
                return false;
            };
            let valid_page = slot
                .get("page")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|page| page <= 1000);
            let valid_rank = slot.get("rank").is_some_and(|rank| {
                rank.is_null()
                    || rank
                        .as_u64()
                        .is_some_and(|rank| rank > 0 && rank <= 1_000_000)
            });
            let valid_entry = slot
                .get("entry")
                .is_some_and(|entry| entry.is_null() || valid_recap_entry_snapshot(entry));
            let valid_population_count = slot.get("populationCount").map_or(true, |count| {
                count.as_u64().is_some_and(|count| count <= 1_000_000)
            });
            if !bounded_json_string(slot.get("id"), 100)
                || !valid_page
                || !valid_rank
                || !valid_entry
                || !valid_population_count
                || !valid_recap_predicate(slot.get("predicate"))
                || !nullable_json_string(slot.get("label"), 500)
                || !nullable_json_string(slot.get("titleOverride"), 500)
            {
                return false;
            }
        }
    }
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub nickname: String,
    pub stated_tastes: String,
    pub avatar_asset_id: Option<String>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            nickname: String::new(),
            stated_tastes: String::new(),
            avatar_asset_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub nickname: String,
    pub stated_tastes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub text_scale: f64,
    pub reduced_motion: String,
    pub graphics: String,
    #[serde(default = "default_true")]
    pub scenes_enabled: bool,
    #[serde(default = "default_true")]
    pub remember_sidebars_per_tab: bool,
    pub restore_tabs: bool,
    pub startup_section: String,
    pub previous_tab_shortcut: String,
    pub next_tab_shortcut: String,
    pub radar_mode: String,
    pub visible_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub analytics_boundary_reviews: Vec<String>,
    #[serde(
        default = "default_recap_drafts",
        skip_serializing_if = "is_default_recap_drafts"
    )]
    pub recap_drafts: String,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub recap_watermark: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            text_scale: 1.0,
            reduced_motion: "system".into(),
            graphics: "auto".into(),
            scenes_enabled: true,
            remember_sidebars_per_tab: true,
            restore_tabs: true,
            startup_section: "home".into(),
            previous_tab_shortcut: "Alt+ArrowLeft".into(),
            next_tab_shortcut: "Alt+ArrowRight".into(),
            radar_mode: "explicit".into(),
            visible_criteria: Vec::new(),
            analytics_boundary_reviews: Vec::new(),
            recap_drafts: default_recap_drafts(),
            recap_watermark: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab {
    pub id: String,
    pub section: String,
    pub title: String,
    pub scroll_top: f64,
    #[serde(default)]
    pub library_view: Option<LibraryViewSnapshot>,
    #[serde(default)]
    pub folder_open: Option<bool>,
    #[serde(default)]
    pub details_open: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryViewSnapshot {
    pub active_group_id: String,
    pub selected_entry_id: Option<String>,
    pub list_mode: String,
    pub search_text: String,
    pub include_review_search: bool,
    pub include_tag_search: bool,
    pub within_current_filters: bool,
    pub filters: LibraryViewFilters,
    pub table_columns: Vec<String>,
    pub table_sort: String,
    pub panel_mode: String,
    pub scroll_top: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryViewFilters {
    pub media_types: Vec<String>,
    pub tags: Vec<String>,
    pub tag_mode: String,
    pub min_year: String,
    pub max_year: String,
    pub cover: String,
    pub criteria_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<WorkspaceTab>,
    pub active_tab_id: Option<String>,
    pub rail_collapsed: bool,
    pub details_open: bool,
    pub details_width: f64,
    pub folder_open: bool,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            tabs: vec![WorkspaceTab {
                id: "home-1".into(),
                section: "home".into(),
                title: "Home".into(),
                scroll_top: 0.0,
                library_view: None,
                folder_open: None,
                details_open: None,
            }],
            active_tab_id: Some("home-1".into()),
            rail_collapsed: false,
            details_open: false,
            details_width: 320.0,
            folder_open: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HomeState {
    pub version: i64,
    pub profile: Profile,
    pub guidelines: BTreeMap<String, String>,
    pub taste_inputs: BTreeMap<String, i32>,
    pub preferences: Preferences,
    pub workspace: Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    pub revision: i64,
    pub entries: Vec<Entry>,
    pub media_types: Vec<MediaType>,
    pub criteria: Vec<Criterion>,
    pub tags: Vec<Tag>,
}

/// Ranking is a view over the same library revision. IDs refer to entries in
/// `library.entries`, so Library and Ranking never maintain separate copies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RankingState {
    pub revision: i64,
    pub library: LibraryState,
    pub unscored_ids: Vec<String>,
    pub tiers: Vec<RankingTierState>,
    pub active_session: Option<DuelSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RankingTierState {
    pub score: i32,
    pub placed_ids: Vec<String>,
    pub unplaced_ids: Vec<String>,
    pub input_sequence: i64,
    pub fitted_sequence: i64,
    pub pending_reconcile: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RankingPosition {
    pub kind: String,
    #[serde(default)]
    pub anchor_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuelSession {
    pub id: String,
    pub score: i32,
    pub status: String,
    pub mode: String,
    pub answered_count: i64,
    pub candidate_entry_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BinaryPlacementNextStep {
    Binary,
    OfferBinary,
    Normal,
    RequiresSubset,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BinaryPlacementResult {
    pub state: RankingState,
    pub next_step: BinaryPlacementNextStep,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuelPrompt {
    pub session_id: String,
    pub duel_id: String,
    pub kind: String,
    pub left_entry_id: String,
    pub right_entry_id: String,
    pub candidate_entry_id: Option<String>,
    pub step: Option<i32>,
    pub total_steps: Option<i32>,
    pub proposed_position: Option<i32>,
    pub tier_length: Option<i32>,
    pub previous_entry_id: Option<String>,
    pub next_entry_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DuelAnswer {
    LeftWin,
    RightWin,
    Tie,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Immutable source sequence used to keep unplaced Library items in import order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_order: Option<i64>,
    pub version: i64,
    pub title: String,
    pub disposition: String,
    pub media_type_id: Option<String>,
    pub overall_rating: Option<i32>,
    pub cover_asset_id: Option<String>,
    pub release_date: Option<ReleaseDate>,
    pub review_text: String,
    /// Provider-native identifiers are namespaced and travel with library exports.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub external_identities: Vec<ExternalIdentity>,
    /// Optional remote image reference. No third-party artwork bytes are embedded in backups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_cover: Option<RemoteCoverReference>,
    // Read and re-emit old portable archives faithfully for checksum validation.
    // This field is never written by current exports and is discarded on import.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "notesText")]
    #[doc(hidden)]
    pub legacy_notes_text: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "notes_text"
    )]
    #[doc(hidden)]
    pub legacy_notes_text_snake_case: Option<String>,
    pub short_label: Option<String>,
    pub criterion_ratings: BTreeMap<String, i32>,
    pub tag_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub id: String,
    pub title: String,
    pub disposition: String,
    pub media_type_id: Option<String>,
    pub overall_rating: Option<i32>,
    #[serde(default)]
    pub cover_asset_id: Option<String>,
    /// `None` means leave existing identities unchanged; explicit `Some(vec![])` clears them.
    #[serde(default)]
    pub external_identities: Option<Vec<ExternalIdentity>>,
    /// `Some` replaces an existing reference; omission preserves it. Clearing is an explicit
    /// draft flag so a cancelled editor never mutates the saved work.
    #[serde(default)]
    pub remote_cover: Option<RemoteCoverReference>,
    /// Explicitly clears an existing catalog cover in the same entry save transaction.
    #[serde(default)]
    pub clear_remote_cover: bool,
    pub release_date: Option<ReleaseDate>,
    #[serde(default)]
    pub review_text: String,
    pub short_label: Option<String>,
    #[serde(default)]
    pub criterion_ratings: BTreeMap<String, Option<i32>>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
}

/// A single atomic library edit applied to a selected set of entries.
/// `media_type_id` and `disposition` are optional patches; `trash` moves the
/// whole selection to the trash and cannot be combined with edits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchEntryUpdateInput {
    pub expected_revision: i64,
    #[serde(alias = "selectedIds")]
    pub entry_ids: Vec<String>,
    pub media_type_id: Option<String>,
    pub disposition: Option<String>,
    #[serde(default)]
    pub remove_covers: bool,
    #[serde(default)]
    pub trash: bool,
}

pub fn validate_batch_entry_update(input: &BatchEntryUpdateInput) -> Result<(), ValidationError> {
    if input.expected_revision < 0 {
        return Err(ValidationError::Invalid(
            "Library revision is invalid".into(),
        ));
    }
    if input.entry_ids.is_empty() || input.entry_ids.len() > 20_000 {
        return Err(ValidationError::Invalid(
            "Select between 1 and 20,000 library items".into(),
        ));
    }
    let mut ids = HashSet::with_capacity(input.entry_ids.len());
    if input
        .entry_ids
        .iter()
        .any(|id| id.trim().is_empty() || id.chars().count() > 100 || !ids.insert(id.as_str()))
    {
        return Err(ValidationError::Invalid(
            "The selected library item IDs are invalid".into(),
        ));
    }
    if input
        .media_type_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty() || id.chars().count() > 100)
    {
        return Err(ValidationError::Invalid("Choose a valid media type".into()));
    }
    if input
        .disposition
        .as_deref()
        .is_some_and(|value| !["experienced", "planned", "dropped"].contains(&value))
    {
        return Err(ValidationError::Invalid("Unsupported disposition".into()));
    }
    let has_edits =
        input.media_type_id.is_some() || input.disposition.is_some() || input.remove_covers;
    if input.trash && has_edits {
        return Err(ValidationError::Invalid(
            "Choose either edits or trash for a batch operation".into(),
        ));
    }
    if !input.trash && !has_edits {
        return Err(ValidationError::Invalid(
            "Choose at least one batch change".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalIdentity {
    pub provider: String,
    pub entity_kind: String,
    pub external_id: String,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCoverReference {
    pub provider: String,
    pub url: String,
    pub source_url: Option<String>,
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDate {
    pub year: i32,
    pub month: Option<u8>,
    pub day: Option<u8>,
    pub precision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaType {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    #[serde(default = "default_media_type_icon")]
    pub icon_key: String,
    pub criterion_ids: Vec<String>,
    pub archived_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTypeInput {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    #[serde(default = "default_media_type_icon")]
    pub icon_key: String,
    #[serde(default)]
    pub criterion_ids: Vec<String>,
}

fn default_media_type_icon() -> String {
    "shape-circle".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub archived_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CriterionInput {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Error)]
pub enum ValidationError {
    #[error("{0}")]
    Invalid(String),
}

pub fn validate_profile(input: &ProfileInput) -> Result<(), ValidationError> {
    if input.nickname.chars().count() > 100 {
        return Err(ValidationError::Invalid(
            "Nickname must be 100 characters or fewer".into(),
        ));
    }
    if input.stated_tastes.chars().count() > 20_000 {
        return Err(ValidationError::Invalid(
            "Taste description must be 20,000 characters or fewer".into(),
        ));
    }
    Ok(())
}

pub fn validate_guidelines(map: &BTreeMap<String, String>) -> Result<(), ValidationError> {
    if map.len() != 10 {
        return Err(ValidationError::Invalid(
            "Guidelines must contain scores 1 through 10".into(),
        ));
    }
    for score in 1..=10 {
        let Some(text) = map.get(&score.to_string()) else {
            return Err(ValidationError::Invalid(
                "Guidelines must contain scores 1 through 10".into(),
            ));
        };
        if text.chars().count() > 20_000 {
            return Err(ValidationError::Invalid(format!(
                "Guideline {score} must be 20,000 characters or fewer"
            )));
        }
    }
    Ok(())
}

pub fn validate_taste_inputs(map: &BTreeMap<String, i32>) -> Result<(), ValidationError> {
    if map.len() > 1000 {
        return Err(ValidationError::Invalid("Too many taste inputs".into()));
    }
    for (id, importance) in map {
        if id.trim().is_empty() || id.chars().count() > 100 || !(1..=10).contains(importance) {
            return Err(ValidationError::Invalid(
                "Taste inputs need an ID and importance from 1 to 10".into(),
            ));
        }
    }
    Ok(())
}

pub fn validate_entry(input: &EntryInput) -> Result<(), ValidationError> {
    if input.id.trim().is_empty() || input.id.chars().count() > 100 {
        return Err(ValidationError::Invalid("Entry ID is invalid".into()));
    }
    if input.title.trim().is_empty() || input.title.chars().count() > 500 {
        return Err(ValidationError::Invalid(
            "Title is required and must be 500 characters or fewer".into(),
        ));
    }
    if !["experienced", "planned", "dropped"].contains(&input.disposition.as_str()) {
        return Err(ValidationError::Invalid("Unsupported disposition".into()));
    }
    if input
        .overall_rating
        .is_some_and(|rating| !(1..=10).contains(&rating))
    {
        return Err(ValidationError::Invalid(
            "Rating must be from 1 to 10".into(),
        ));
    }
    if input.overall_rating.is_some() && input.disposition != "experienced" {
        return Err(ValidationError::Invalid(
            "Rated entries must be marked experienced".into(),
        ));
    }
    if input.review_text.chars().count() > 100_000 {
        return Err(ValidationError::Invalid(
            "Your thoughts must be 100,000 characters or fewer".into(),
        ));
    }
    if input
        .short_label
        .as_ref()
        .is_some_and(|value| value.chars().count() > 100)
    {
        return Err(ValidationError::Invalid(
            "Short label must be 100 characters or fewer".into(),
        ));
    }
    if let Some(date) = &input.release_date {
        validate_release_date(date)?;
    }
    if let Some(identities) = &input.external_identities {
        validate_external_identities(identities)?;
    }
    if let Some(cover) = &input.remote_cover {
        validate_remote_cover(cover)?;
    }
    if input.clear_remote_cover && input.remote_cover.is_some() {
        return Err(ValidationError::Invalid(
            "Choose a remote cover or clear it, not both".into(),
        ));
    }
    if input.criterion_ratings.len() > 1000
        || input.criterion_ratings.iter().any(|(id, score)| {
            id.trim().is_empty()
                || id.chars().count() > 100
                || score.is_some_and(|value| !(1..=10).contains(&value))
        })
    {
        return Err(ValidationError::Invalid(
            "Criterion scores need valid IDs and scores from 1 to 10".into(),
        ));
    }
    let mut tags = HashSet::new();
    if input.tag_ids.len() > 1000
        || input
            .tag_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.chars().count() > 100 || !tags.insert(id))
    {
        return Err(ValidationError::Invalid(
            "Invalid or duplicate entry tag".into(),
        ));
    }
    Ok(())
}

pub fn validate_external_identities(
    identities: &[ExternalIdentity],
) -> Result<(), ValidationError> {
    if identities.len() > 100 {
        return Err(ValidationError::Invalid(
            "Too many external media IDs".into(),
        ));
    }
    let mut unique = HashSet::new();
    for identity in identities {
        let provider = identity.provider.trim();
        let entity_kind = identity.entity_kind.trim();
        let external_id = identity.external_id.trim();
        if provider.is_empty()
            || provider.len() > 50
            || !provider.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
            })
            || entity_kind.is_empty()
            || entity_kind.chars().count() > 64
            || entity_kind.chars().any(char::is_control)
            || external_id.is_empty()
            || external_id.chars().count() > 256
            || external_id.chars().any(char::is_control)
            || !unique.insert((
                provider.to_string(),
                entity_kind.to_string(),
                external_id.to_string(),
            ))
            || identity
                .source_url
                .as_ref()
                .is_some_and(|url| !valid_https_url(url, 2048))
        {
            return Err(ValidationError::Invalid(
                "External media IDs must have unique, valid provider identities".into(),
            ));
        }
    }
    Ok(())
}

pub fn validate_remote_cover(cover: &RemoteCoverReference) -> Result<(), ValidationError> {
    let hosts: &[&str] = match cover.provider.as_str() {
        "tmdb" => &["image.tmdb.org"],
        "openlibrary" => &["covers.openlibrary.org"],
        "googlebooks" => &["books.google.com", "books.googleusercontent.com"],
        "igdb" => &["images.igdb.com"],
        "steam" => &[
            "shared.akamai.steamstatic.com",
            "cdn.akamai.steamstatic.com",
        ],
        _ => &[],
    };
    if hosts.is_empty()
        || !valid_https_url_for_hosts(&cover.url, 4096, hosts)
        || cover
            .source_url
            .as_ref()
            .is_some_and(|url| !valid_https_url(url, 2048))
        || cover.attribution.as_ref().is_some_and(|value| {
            value.chars().count() > 1000 || value.chars().any(char::is_control)
        })
    {
        return Err(ValidationError::Invalid(
            "Remote cover reference is unsupported or unsafe".into(),
        ));
    }
    Ok(())
}

fn valid_https_url(value: &str, max_len: usize) -> bool {
    valid_https_url_for_hosts(value, max_len, &[])
}

fn valid_https_url_for_hosts(value: &str, max_len: usize, allowed_hosts: &[&str]) -> bool {
    if value.chars().count() > max_len || value.chars().any(char::is_control) {
        return false;
    }
    let Some(authority_and_path) = value.strip_prefix("https://") else {
        return false;
    };
    let authority = authority_and_path
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || authority.contains(':') {
        return false;
    }
    let host = authority.to_ascii_lowercase();
    if allowed_hosts.is_empty() {
        return host.contains('.') && !host.starts_with('.') && !host.ends_with('.');
    }
    allowed_hosts.iter().any(|allowed| host == *allowed)
}

pub fn validate_media_type(input: &MediaTypeInput) -> Result<(), ValidationError> {
    validate_vocabulary(&input.id, &input.name)?;
    if input.sort_order < 0 || input.criterion_ids.len() > 1000 {
        return Err(ValidationError::Invalid(
            "Invalid media type order or criteria".into(),
        ));
    }
    if ![
        "book-open",
        "clapperboard",
        "gamepad-2",
        "film",
        "tv",
        "message-circle",
        "messages-square",
        "shape-circle",
        "shape-square",
        "shape-triangle",
        "shape-diamond",
        "shape-hexagon",
        "shape-pentagon",
        "shape-octagon",
        "shape-star",
        "shape-shapes",
        "shape-grid",
    ]
    .contains(&input.icon_key.as_str())
    {
        return Err(ValidationError::Invalid(
            "Choose a supported media type icon".into(),
        ));
    }
    let mut criteria = HashSet::new();
    if input
        .criterion_ids
        .iter()
        .any(|id| id.trim().is_empty() || id.chars().count() > 100 || !criteria.insert(id))
    {
        return Err(ValidationError::Invalid(
            "Media type criteria must have unique valid IDs".into(),
        ));
    }
    Ok(())
}

pub fn validate_criterion(input: &CriterionInput) -> Result<(), ValidationError> {
    validate_vocabulary(&input.id, &input.name)?;
    if input.sort_order < 0
        || input
            .description
            .as_ref()
            .is_some_and(|description| description.chars().count() > 20_000)
    {
        return Err(ValidationError::Invalid("Invalid criterion details".into()));
    }
    Ok(())
}

pub fn validate_tag(input: &TagInput) -> Result<(), ValidationError> {
    validate_vocabulary(&input.id, &input.name)
}

fn validate_vocabulary(id: &str, name: &str) -> Result<(), ValidationError> {
    if id.trim().is_empty() || id.chars().count() > 100 {
        return Err(ValidationError::Invalid("Vocabulary ID is invalid".into()));
    }
    if name.trim().is_empty() || name.chars().count() > 100 {
        return Err(ValidationError::Invalid(
            "Name is required and must be 100 characters or fewer".into(),
        ));
    }
    Ok(())
}

pub fn validate_release_date(date: &ReleaseDate) -> Result<(), ValidationError> {
    let valid = match date.precision.as_str() {
        "year" => date.month.is_none() && date.day.is_none(),
        "month" => date.month.is_some_and(|month| (1..=12).contains(&month)) && date.day.is_none(),
        "day" => {
            let Some(month) = date.month else {
                return Err(ValidationError::Invalid("Invalid release date".into()));
            };
            let Some(day) = date.day else {
                return Err(ValidationError::Invalid("Invalid release date".into()));
            };
            let leap = date.year % 4 == 0 && (date.year % 100 != 0 || date.year % 400 == 0);
            let max_day = match month {
                1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                4 | 6 | 9 | 11 => 30,
                2 if leap => 29,
                2 => 28,
                _ => 0,
            };
            (1..=max_day).contains(&day)
        }
        _ => false,
    };
    if date.year < 1 || date.year > 9999 || !valid {
        return Err(ValidationError::Invalid("Invalid release date".into()));
    }
    Ok(())
}

pub fn validate_preferences(p: &Preferences) -> Result<(), ValidationError> {
    if !["system", "light", "dark", "dusk", "forest", "reading"].contains(&p.theme.as_str())
        || !p.text_scale.is_finite()
        || !(0.9..=1.2).contains(&p.text_scale)
        || !["system", "on", "off"].contains(&p.reduced_motion.as_str())
        || !["auto", "low", "medium", "high", "off"].contains(&p.graphics.as_str())
        || ![
            "home",
            "library",
            "ranking",
            "analytics",
            "recap",
            "settings",
        ]
        .contains(&p.startup_section.as_str())
        || !["explicit", "derived"].contains(&p.radar_mode.as_str())
        || p.visible_criteria.len() > 8
        || p.visible_criteria
            .iter()
            .any(|id| id.is_empty() || id.chars().count() > 100)
        || p.analytics_boundary_reviews.len() > 1000
        || p.analytics_boundary_reviews
            .iter()
            .any(|fingerprint| fingerprint.is_empty() || fingerprint.chars().count() > 500)
        || !validate_recap_drafts_json(&p.recap_drafts)
        || p.previous_tab_shortcut.is_empty()
        || p.next_tab_shortcut.is_empty()
        || p.previous_tab_shortcut == p.next_tab_shortcut
        || p.previous_tab_shortcut.len() > 100
        || p.next_tab_shortcut.len() > 100
    {
        return Err(ValidationError::Invalid(
            "Unsupported preference value".into(),
        ));
    }
    Ok(())
}

pub fn validate_workspace(w: &Workspace) -> Result<(), ValidationError> {
    if w.tabs.is_empty() || w.tabs.len() > 50 {
        return Err(ValidationError::Invalid(
            "Workspace needs 1 to 50 tabs".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for tab in &w.tabs {
        if tab.id.is_empty()
            || tab.id.len() > 100
            || !seen.insert(&tab.id)
            || ![
                "home",
                "library",
                "ranking",
                "analytics",
                "recap",
                "settings",
            ]
            .contains(&tab.section.as_str())
            || tab.title.chars().count() > 100
            || !tab.scroll_top.is_finite()
            || !(0.0..=1_000_000.0).contains(&tab.scroll_top)
            || tab.library_view.as_ref().is_some_and(|view| {
                view.active_group_id.len() > 100
                    || view
                        .selected_entry_id
                        .as_ref()
                        .is_some_and(|id| id.len() > 100)
                    || !["covers", "compact", "table"].contains(&view.list_mode.as_str())
                    || view.search_text.chars().count() > 500
                    || view.table_columns.len() > 20
                    || view.table_columns.iter().any(|column| column.len() > 100)
                    // `canonical` remains accepted for workspaces saved by older
                    // clients; new Library views persist the rank-based `rank` key.
                    || !["rank", "canonical", "title", "year"]
                        .contains(&view.table_sort.as_str())
                    || !["details", "filters", "transfer"].contains(&view.panel_mode.as_str())
                    || !view.scroll_top.is_finite()
                    || !(0.0..=1_000_000.0).contains(&view.scroll_top)
                    || view.filters.media_types.len() > 100
                    || view.filters.tags.len() > 500
                    || !["any", "all"].contains(&view.filters.tag_mode.as_str())
                    || !["any", "has", "missing"].contains(&view.filters.cover.as_str())
                    || [&view.filters.min_year, &view.filters.max_year]
                        .iter()
                        .any(|value| value.len() > 20)
            })
        {
            return Err(ValidationError::Invalid("Invalid workspace tab".into()));
        }
    }
    if !w.active_tab_id.as_ref().is_some_and(|id| seen.contains(id)) {
        return Err(ValidationError::Invalid(
            "Active tab is missing from workspace".into(),
        ));
    }
    if !w.details_width.is_finite() || !(240.0..=1000.0).contains(&w.details_width) {
        return Err(ValidationError::Invalid(
            "Details width is outside supported bounds".into(),
        ));
    }
    Ok(())
}

pub fn blank_guidelines() -> BTreeMap<String, String> {
    (1..=10)
        .map(|score| (score.to_string(), String::new()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_preferences_and_tabs_default_scene_and_sidebar_settings_safely() {
        let preferences: Preferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "textScale": 1.0,
            "reducedMotion": "system",
            "graphics": "auto",
            "restoreTabs": true,
            "startupSection": "home",
            "previousTabShortcut": "Alt+ArrowLeft",
            "nextTabShortcut": "Alt+ArrowRight",
            "radarMode": "explicit",
            "visibleCriteria": []
        }))
        .unwrap();
        assert!(preferences.scenes_enabled);
        assert!(preferences.remember_sidebars_per_tab);
        assert!(preferences.analytics_boundary_reviews.is_empty());
        assert_eq!(preferences.recap_drafts, DEFAULT_RECAP_DRAFTS);
        assert!(preferences.recap_watermark);

        let tab: WorkspaceTab = serde_json::from_value(serde_json::json!({
            "id": "legacy-tab",
            "section": "library",
            "title": "Library",
            "scrollTop": 0.0
        }))
        .unwrap();
        assert_eq!(tab.folder_open, None);
        assert_eq!(tab.details_open, None);
    }

    fn recap_draft_fixture() -> serde_json::Value {
        serde_json::json!({
            "id": "draft-1",
            "version": 1,
            "templateId": "topTen",
            "libraryRevision": 12,
            "filter": { "kind": "all" },
            "style": "quiet",
            "mode": "cover",
            "orientation": "portrait",
            "showTitles": true,
            "watermark": true,
            "heading": "My top ten",
            "caption": "",
            "rankingLabel": "canonical",
            "sourceFingerprint": "v1-0123456789abcdef",
            "slots": [{
                "id": "slot-1",
                "page": 0,
                "entry": {
                    "id": "entry-1",
                    "title": "A story",
                    "mediaTypeId": "film",
                    "mediaTypeName": "Films",
                    "year": 2024,
                    "coverAssetId": "a".repeat(64)
                },
                "rank": 1,
                "label": null,
                "populationCount": 5,
                "titleOverride": null,
                "predicate": { "kind": "any" }
            }],
            "createdAt": "2026-10-03T00:00:00.000Z",
            "updatedAt": "2026-10-03T00:00:00.000Z"
        })
    }

    #[test]
    fn recap_draft_preferences_validate_versioned_bounded_snapshots() {
        let mut preferences = Preferences::default();
        let valid = serde_json::json!({
            "version": 1,
            "drafts": [recap_draft_fixture()]
        });
        preferences.recap_drafts = serde_json::to_string(&valid).unwrap();
        assert!(validate_preferences(&preferences).is_ok());

        let mut current = recap_draft_fixture();
        current["style"] = serde_json::json!("daylight");
        current["mode"] = serde_json::json!("text");
        current["showMediaTypes"] = serde_json::json!(false);
        current["slots"][0]["entry"]["shortLabel"] = serde_json::json!("A story");
        current["slots"][0]["entry"]["iconKey"] = serde_json::json!("book-open");
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [current]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_ok());

        let mut invalid_population_count = recap_draft_fixture();
        invalid_population_count["slots"][0]["populationCount"] = serde_json::json!(-1);
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [invalid_population_count]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_err());

        for filter in [
            serde_json::json!({ "kind": "all", "tagIds": ["tag-a", "tag-b"], "tagMode": "any" }),
            serde_json::json!({ "kind": "types", "typeIds": ["film"], "tagIds": ["tag-a", "tag-b"], "tagMode": "all" }),
            serde_json::json!({ "kind": "all", "tagIds": [] }),
            serde_json::json!({ "kind": "types", "typeIds": ["film"] }),
        ] {
            let mut tagged = recap_draft_fixture();
            tagged["filter"] = filter;
            preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
                "version": 1,
                "drafts": [tagged]
            }))
            .unwrap();
            assert!(validate_preferences(&preferences).is_ok());
        }

        for filter in [
            serde_json::json!({ "kind": "all", "tagIds": ["tag-a"], "tagMode": "or" }),
            serde_json::json!({ "kind": "all", "tagIds": [""] }),
            serde_json::json!({ "kind": "all", "tagIds": ["x".repeat(101)] }),
            serde_json::json!({ "kind": "all", "tagIds": vec!["tag"; 101] }),
            serde_json::json!({ "kind": "types", "typeIds": ["film"], "tagIds": "tag-a" }),
        ] {
            let mut tagged = recap_draft_fixture();
            tagged["filter"] = filter;
            preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
                "version": 1,
                "drafts": [tagged]
            }))
            .unwrap();
            assert!(validate_preferences(&preferences).is_err());
        }

        let mut malformed_optional = recap_draft_fixture();
        malformed_optional["showMediaTypes"] = serde_json::json!("yes");
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [malformed_optional]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_err());

        let mut oversized_label = recap_draft_fixture();
        oversized_label["slots"][0]["entry"]["shortLabel"] = serde_json::json!("x".repeat(501));
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [oversized_label]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_err());

        let mut legacy = recap_draft_fixture();
        legacy.as_object_mut().unwrap().remove("sourceFingerprint");
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [legacy]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_ok());

        let mut oversized_fingerprint = recap_draft_fixture();
        oversized_fingerprint["sourceFingerprint"] = serde_json::json!("x".repeat(101));
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [oversized_fingerprint]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_err());

        for invalid in [
            serde_json::json!({ "version": 2, "drafts": [] }),
            serde_json::json!({ "version": 1, "drafts": [serde_json::json!({})] }),
            serde_json::json!({ "version": 1, "drafts": vec![recap_draft_fixture(); MAX_RECAP_DRAFT_COUNT + 1] }),
        ] {
            preferences.recap_drafts = serde_json::to_string(&invalid).unwrap();
            assert!(validate_preferences(&preferences).is_err());
        }

        let mut too_many_slots = recap_draft_fixture();
        too_many_slots["slots"] = serde_json::json!(vec![
            too_many_slots["slots"][0].clone();
            MAX_RECAP_SLOT_COUNT + 1
        ]);
        preferences.recap_drafts = serde_json::to_string(&serde_json::json!({
            "version": 1,
            "drafts": [too_many_slots]
        }))
        .unwrap();
        assert!(validate_preferences(&preferences).is_err());

        preferences.recap_drafts = format!(
            "{}{}",
            DEFAULT_RECAP_DRAFTS,
            " ".repeat(MAX_RECAP_DRAFTS_BYTES)
        );
        assert!(validate_preferences(&preferences).is_err());
    }

    #[test]
    fn rating_inputs_enforce_bounds_and_missing_axes() {
        let mut inputs = BTreeMap::new();
        inputs.insert("story".into(), 1);
        assert!(validate_taste_inputs(&inputs).is_ok());
        inputs.insert("visuals".into(), 11);
        assert!(validate_taste_inputs(&inputs).is_err());
    }

    #[test]
    fn workspace_cannot_point_at_missing_tab() {
        let mut w = Workspace::default();
        w.active_tab_id = Some("missing".into());
        assert!(validate_workspace(&w).is_err());
    }

    #[test]
    fn legacy_private_notes_spellings_are_read_only_compatibility_fields() {
        for field in ["notesText", "notes_text"] {
            let mut value = serde_json::json!({
                "id": "entry-1",
                "version": 1,
                "title": "A story",
                "disposition": "planned",
                "mediaTypeId": null,
                "overallRating": null,
                "coverAssetId": null,
                "releaseDate": null,
                "reviewText": "",
                "shortLabel": null,
                "criterionRatings": {},
                "tagIds": [],
                "createdAt": "2020-01-01T00:00:00Z",
                "updatedAt": "2020-01-01T00:00:00Z"
            });
            value[field] = serde_json::Value::String("legacy note".into());
            let entry: Entry = serde_json::from_value(value).unwrap();
            let captured = if field == "notesText" {
                entry.legacy_notes_text.as_deref()
            } else {
                entry.legacy_notes_text_snake_case.as_deref()
            };
            assert_eq!(captured, Some("legacy note"));
            let current_json = serde_json::to_value(entry).unwrap();
            assert_eq!(
                current_json.get(field).and_then(|value| value.as_str()),
                Some("legacy note")
            );
        }
    }

    #[test]
    fn release_dates_keep_partial_precision_without_inventing_months() {
        assert!(validate_release_date(&ReleaseDate {
            year: 2024,
            month: None,
            day: None,
            precision: "year".into(),
        })
        .is_ok());
        assert!(validate_release_date(&ReleaseDate {
            year: 2024,
            month: Some(2),
            day: Some(29),
            precision: "day".into(),
        })
        .is_ok());
        assert!(validate_release_date(&ReleaseDate {
            year: 2023,
            month: Some(2),
            day: Some(29),
            precision: "day".into(),
        })
        .is_err());
    }

    #[test]
    fn entry_validation_requires_consistent_rating_and_disposition() {
        let mut entry = EntryInput {
            id: "entry-1".into(),
            title: "A text-only work".into(),
            disposition: "planned".into(),
            media_type_id: None,
            overall_rating: Some(8),
            cover_asset_id: None,
            external_identities: None,
            remote_cover: None,
            clear_remote_cover: false,
            release_date: None,
            review_text: String::new(),
            short_label: None,
            criterion_ratings: BTreeMap::new(),
            tag_ids: Vec::new(),
        };
        assert!(validate_entry(&entry).is_err());
        entry.disposition = "experienced".into();
        assert!(validate_entry(&entry).is_ok());
    }

    #[test]
    fn media_type_and_criterion_validation_reject_duplicate_or_invalid_assignments() {
        let mut media_type = MediaTypeInput {
            id: "media-1".into(),
            name: "  Graphic novels  ".into(),
            sort_order: 0,
            icon_key: "shape-circle".into(),
            criterion_ids: vec!["story".into(), "visuals".into()],
        };
        assert!(validate_media_type(&media_type).is_ok());
        media_type.criterion_ids.push("story".into());
        assert!(validate_media_type(&media_type).is_err());
        media_type.criterion_ids = vec!["story".into()];
        media_type.sort_order = -1;
        assert!(validate_media_type(&media_type).is_err());

        let mut criterion = CriterionInput {
            id: "story".into(),
            name: "Story quality".into(),
            description: Some("How well the story works".into()),
            sort_order: 1,
        };
        assert!(validate_criterion(&criterion).is_ok());
        criterion.description = Some("x".repeat(20_001));
        assert!(validate_criterion(&criterion).is_err());
    }

    #[test]
    fn tags_and_entry_metadata_require_unique_identifiers_and_valid_scores() {
        assert!(validate_tag(&TagInput {
            id: "tag-1".into(),
            name: "  Comfort watch  ".into(),
        })
        .is_ok());
        assert!(validate_tag(&TagInput {
            id: "tag-1".into(),
            name: "   ".into(),
        })
        .is_err());

        let mut entry = EntryInput {
            id: "entry-1".into(),
            title: "A complete story".into(),
            disposition: "experienced".into(),
            media_type_id: Some("literature".into()),
            overall_rating: Some(8),
            cover_asset_id: None,
            external_identities: None,
            remote_cover: None,
            clear_remote_cover: false,
            release_date: Some(ReleaseDate {
                year: 2024,
                month: Some(2),
                day: Some(29),
                precision: "day".into(),
            }),
            review_text: "A good read".into(),
            short_label: Some("Spring read".into()),
            criterion_ratings: BTreeMap::from([
                ("plot".into(), Some(8)),
                ("world".into(), Some(9)),
            ]),
            tag_ids: vec!["tag-a".into(), "tag-b".into()],
        };
        assert!(validate_entry(&entry).is_ok());
        entry.tag_ids.push("tag-a".into());
        assert!(validate_entry(&entry).is_err());
        entry.tag_ids = vec!["tag-a".into()];
        entry.criterion_ratings.insert("plot".into(), Some(11));
        assert!(validate_entry(&entry).is_err());
    }
}
