//! Explicit, read-only catalog search clients.
//!
//! Credentials live only in `ProviderSession` for the lifetime of the native
//! app process. Search is user initiated; requests go only to fixed provider
//! hosts. Results contain provider references and bounded metadata, never full
//! API payloads or downloaded artwork.

use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::Url;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::StorageError;
use tastellar_domain::ExternalIdentity;

const MAX_QUERY_CHARS: usize = 180;
const MAX_PAGE_SIZE: u32 = 10;
const MAX_PROVIDER_RESULTS: usize = 8;
const MAX_PAGE: u32 = 100;
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_COVER_DOWNLOAD_BYTES: u64 = 10 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const USER_AGENT: &str = "Tastellar/0.4 (desktop catalog lookup)";
const TMDB_ATTRIBUTION: &str =
    "This product uses the TMDB API but is not endorsed or certified by TMDB.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogProvider {
    Tmdb,
    OpenLibrary,
    GoogleBooks,
    Igdb,
    Steam,
}

impl CatalogProvider {
    pub fn key(self) -> &'static str {
        match self {
            Self::Tmdb => "tmdb",
            Self::OpenLibrary => "openLibrary",
            Self::GoogleBooks => "googleBooks",
            Self::Igdb => "igdb",
            Self::Steam => "steam",
        }
    }

    fn cover_key(self) -> &'static str {
        self.identity_provider()
    }

    fn identity_provider(self) -> &'static str {
        match self {
            Self::Tmdb => "tmdb",
            Self::OpenLibrary => "openlibrary",
            Self::GoogleBooks => "googlebooks",
            Self::Igdb => "igdb",
            Self::Steam => "steam",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "tmdb" => Some(Self::Tmdb),
            "openLibrary" | "openlibrary" => Some(Self::OpenLibrary),
            "googleBooks" | "googlebooks" => Some(Self::GoogleBooks),
            "igdb" => Some(Self::Igdb),
            "steam" => Some(Self::Steam),
            _ => None,
        }
    }

    fn searchable(self) -> bool {
        !matches!(self, Self::Steam)
    }

    fn supports_default_type(self, media_type_id: &str) -> bool {
        match self {
            Self::Tmdb => matches!(media_type_id, "films" | "tv-series" | "anime"),
            Self::OpenLibrary | Self::GoogleBooks => {
                matches!(media_type_id, "literature" | "comic")
            }
            Self::Igdb => media_type_id == "games",
            Self::Steam => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCapability {
    pub provider: String,
    pub label: String,
    pub enabled: bool,
    pub configured: bool,
    pub reason: Option<String>,
    pub media_type_ids: Vec<String>,
    pub terms_url: Option<String>,
    pub attribution_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCandidate {
    pub provider: String,
    pub id: String,
    pub entity_kind: String,
    pub media_type: String,
    pub title: String,
    pub original_title: Option<String>,
    pub creators: Vec<String>,
    pub year: Option<i32>,
    pub suggested_media_type_id: Option<String>,
    pub identities: Vec<ExternalIdentity>,
    pub cover_url: Option<String>,
    /// `persistReference` means the provider returned a safe, provider-hosted
    /// URL reference. It never means that image bytes can be downloaded or
    /// embedded in an archive.
    pub cover_mode: String,
    pub cover_provider: Option<String>,
    pub remote_cover: Option<tastellar_domain::RemoteCoverReference>,
    pub attribution: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchCatalogInput {
    pub query: String,
    pub media_type_id: Option<String>,
    pub providers: Vec<String>,
    pub year: Option<i32>,
    /// Opaque provider page map returned by the previous call.
    pub page: Option<String>,
    pub external_id: Option<String>,
    pub external_id_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogResult {
    pub results: Vec<CatalogCandidate>,
    pub next_page: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCredentialInput {
    pub provider: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub steam_id64: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub clear: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialState {
    pub provider: String,
    pub configured: bool,
    pub session_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamOwnedGame {
    pub app_id: String,
    pub name: String,
    pub playtime_forever: Option<u64>,
    pub playtime_2weeks: Option<u64>,
    /// Steam doesn't include this per-game in GetOwnedGames; `None` is unknown.
    pub free_to_play: Option<bool>,
}

/// Separate from persistent storage so slow HTTP calls do not hold the
/// SQLite/global-storage lock. Dropping the Tauri-managed state clears secrets.
#[derive(Default)]
pub struct ProviderSession {
    credentials: Mutex<HashMap<CatalogProvider, ProviderCredentials>>,
}

enum ProviderCredentials {
    ApiKey {
        api_key: String,
    },
    Steam {
        api_key: String,
        steam_id64: String,
    },
    Igdb {
        client_id: String,
        client_secret: String,
        cached_token: Option<(String, Instant)>,
    },
}

struct CredentialSnapshot {
    api_key: Option<String>,
    steam_id64: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

pub struct CatalogCoverDownload {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

impl ProviderSession {
    /// Load app-owned provider credentials embedded by the local desktop build.
    /// The input file is never returned or logged; only validated credentials
    /// are kept in process memory.
    pub fn from_private_config_json(value: &str) -> Result<Self, StorageError> {
        let inputs: Vec<ProviderCredentialInput> = serde_json::from_str(value).map_err(|_| {
            StorageError::Validation("Private provider configuration is invalid".into())
        })?;
        if inputs.len() > 8 {
            return Err(StorageError::Validation(
                "Private provider configuration is invalid".into(),
            ));
        }
        let session = Self::default();
        let mut providers = std::collections::HashSet::new();
        for input in inputs {
            let provider = CatalogProvider::parse(&input.provider).ok_or_else(|| {
                StorageError::Validation("Private provider configuration is invalid".into())
            })?;
            if !providers.insert(provider) {
                return Err(StorageError::Validation(
                    "Private provider configuration is invalid".into(),
                ));
            }
            configure_provider_credentials(&session, input)?;
        }
        Ok(session)
    }

    fn snapshot(
        &self,
        provider: CatalogProvider,
    ) -> Result<Option<CredentialSnapshot>, StorageError> {
        let guard = self.credentials.lock().map_err(|_| {
            StorageError::Validation("Provider session state is unavailable".into())
        })?;
        Ok(guard.get(&provider).map(|credentials| match credentials {
            ProviderCredentials::ApiKey { api_key } => CredentialSnapshot {
                api_key: Some(api_key.clone()),
                steam_id64: None,
                client_id: None,
                client_secret: None,
            },
            ProviderCredentials::Steam {
                api_key,
                steam_id64,
            } => CredentialSnapshot {
                api_key: Some(api_key.clone()),
                steam_id64: Some(steam_id64.clone()),
                client_id: None,
                client_secret: None,
            },
            ProviderCredentials::Igdb {
                client_id,
                client_secret,
                ..
            } => CredentialSnapshot {
                api_key: None,
                steam_id64: None,
                client_id: Some(client_id.clone()),
                client_secret: Some(client_secret.clone()),
            },
        }))
    }

    fn igdb_token(&self, client: &Client) -> Result<String, StorageError> {
        let (client_id, client_secret, cached) = {
            let guard = self.credentials.lock().map_err(|_| {
                StorageError::Validation("Provider session state is unavailable".into())
            })?;
            match guard.get(&CatalogProvider::Igdb) {
                Some(ProviderCredentials::Igdb {
                    client_id,
                    client_secret,
                    cached_token,
                }) => (
                    client_id.clone(),
                    client_secret.clone(),
                    cached_token.as_ref().and_then(|(token, expires)| {
                        (*expires > Instant::now() + Duration::from_secs(15)).then(|| token.clone())
                    }),
                ),
                _ => {
                    return Err(StorageError::Validation(
                        "IGDB credentials are not configured in this app".into(),
                    ))
                }
            }
        };
        if let Some(token) = cached {
            return Ok(token);
        }

        #[derive(Deserialize)]
        struct TokenReply {
            access_token: String,
            expires_in: u64,
        }
        let response: TokenReply =
            send_json(client.post("https://id.twitch.tv/oauth2/token").form(&[
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("grant_type", "client_credentials"),
            ]))?;
        let token = response.access_token;
        let expiry = Instant::now() + Duration::from_secs(response.expires_in.min(60 * 60 * 24));
        let mut guard = self.credentials.lock().map_err(|_| {
            StorageError::Validation("Provider session state is unavailable".into())
        })?;
        if let Some(ProviderCredentials::Igdb { cached_token, .. }) =
            guard.get_mut(&CatalogProvider::Igdb)
        {
            *cached_token = Some((token.clone(), expiry));
        }
        Ok(token)
    }
}

pub fn configure_provider_credentials(
    session: &ProviderSession,
    input: ProviderCredentialInput,
) -> Result<ProviderCredentialState, StorageError> {
    let provider = CatalogProvider::parse(&input.provider)
        .ok_or_else(|| StorageError::Validation("Unsupported catalog provider".into()))?;
    let mut guard = session
        .credentials
        .lock()
        .map_err(|_| StorageError::Validation("Provider session state is unavailable".into()))?;
    if input.clear {
        guard.remove(&provider);
        return Ok(ProviderCredentialState {
            provider: provider.key().into(),
            configured: matches!(provider, CatalogProvider::OpenLibrary),
            session_only: true,
        });
    }

    let invalid_secret = |value: Option<&String>| {
        value.is_none_or(|secret| {
            let value = secret.trim();
            value.len() < 8 || value.len() > 512 || value.chars().any(char::is_control)
        })
    };
    let credentials = match provider {
        CatalogProvider::Tmdb | CatalogProvider::GoogleBooks => {
            if invalid_secret(input.api_key.as_ref()) {
                return Err(StorageError::Validation(
                    "Enter a valid provider API key".into(),
                ));
            }
            ProviderCredentials::ApiKey {
                api_key: input.api_key.unwrap().trim().to_string(),
            }
        }
        CatalogProvider::Steam => {
            if invalid_secret(input.api_key.as_ref()) {
                return Err(StorageError::Validation(
                    "Enter a valid Steam Web API key".into(),
                ));
            }
            let steam_id = input
                .steam_id64
                .as_deref()
                .and_then(normalize_steam_id)
                .ok_or_else(|| {
                    StorageError::Validation("Enter a SteamID64 or public profile URL".into())
                })?;
            ProviderCredentials::Steam {
                api_key: input.api_key.unwrap().trim().to_string(),
                steam_id64: steam_id,
            }
        }
        CatalogProvider::Igdb => {
            if invalid_secret(input.client_id.as_ref())
                || invalid_secret(input.client_secret.as_ref())
            {
                return Err(StorageError::Validation(
                    "Enter a valid IGDB client ID and client secret".into(),
                ));
            }
            ProviderCredentials::Igdb {
                client_id: input.client_id.unwrap().trim().to_string(),
                client_secret: input.client_secret.unwrap().trim().to_string(),
                cached_token: None,
            }
        }
        CatalogProvider::OpenLibrary => {
            return Err(StorageError::Validation(
                "Open Library does not use provider credentials".into(),
            ));
        }
    };
    guard.insert(provider, credentials);
    Ok(ProviderCredentialState {
        provider: provider.key().into(),
        configured: true,
        session_only: true,
    })
}

pub fn catalog_capabilities(session: &ProviderSession) -> Vec<CatalogCapability> {
    let configured = |provider| session.snapshot(provider).ok().flatten().is_some();
    let tmdb = configured(CatalogProvider::Tmdb);
    let google = configured(CatalogProvider::GoogleBooks);
    let igdb = configured(CatalogProvider::Igdb);
    let steam = configured(CatalogProvider::Steam);
    vec![
        CatalogCapability {
            provider: "tmdb".into(),
            label: "TMDb".into(),
            enabled: tmdb,
            configured: tmdb,
            reason: (!tmdb).then(|| "TMDb is unavailable in this app build.".into()),
            media_type_ids: vec!["films".into(), "tv-series".into(), "anime".into()],
            terms_url: Some("https://www.themoviedb.org/api-terms-of-use".into()),
            attribution_text: Some(TMDB_ATTRIBUTION.into()),
        },
        CatalogCapability {
            provider: "openLibrary".into(),
            label: "Open Library".into(),
            enabled: true,
            configured: true,
            reason: None,
            media_type_ids: vec!["literature".into(), "comic".into()],
            terms_url: Some("https://openlibrary.org/developers/api".into()),
            attribution_text: Some("Open Library".into()),
        },
        CatalogCapability {
            provider: "googleBooks".into(),
            label: "Google Books".into(),
            enabled: google,
            configured: google,
            reason: (!google).then(|| "Google Books is unavailable in this app build.".into()),
            media_type_ids: vec!["literature".into(), "comic".into()],
            terms_url: Some("https://developers.google.com/books/terms".into()),
            attribution_text: Some("Google Books".into()),
        },
        CatalogCapability {
            provider: "igdb".into(),
            label: "IGDB".into(),
            enabled: igdb,
            configured: igdb,
            reason: (!igdb).then(|| "IGDB is unavailable in this app build.".into()),
            media_type_ids: vec!["games".into()],
            terms_url: Some("https://api-docs.igdb.com/".into()),
            attribution_text: Some("Data from IGDB".into()),
        },
        CatalogCapability {
            provider: "steam".into(),
            label: "Steam".into(),
            enabled: false,
            configured: steam,
            reason: Some("Steam owned-games import is supported separately.".into()),
            media_type_ids: vec!["games".into()],
            terms_url: Some("https://steamcommunity.com/dev/apiterms".into()),
            attribution_text: Some("Steam".into()),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SearchCursor {
    query: String,
    media_type_id: Option<String>,
    year: Option<i32>,
    providers: Vec<String>,
    external_id: Option<String>,
    external_id_provider: Option<String>,
    next_pages: BTreeMap<String, u32>,
}

pub fn search_catalog(
    session: &ProviderSession,
    input: SearchCatalogInput,
) -> Result<SearchCatalogResult, StorageError> {
    validate_search(&input)?;
    let mut providers = applicable_providers(
        normalize_providers(&input.providers)?,
        input.external_id_provider.as_deref(),
    );
    if let Some(media_type_id) = input.media_type_id.as_deref().filter(|media_type_id| {
        matches!(
            *media_type_id,
            "films" | "tv-series" | "anime" | "literature" | "comic" | "games"
        )
    }) {
        providers.retain(|provider| provider.supports_default_type(media_type_id));
    }
    if providers.is_empty() {
        return Err(StorageError::Validation(
            "The selected catalog source cannot look up this identifier.".into(),
        ));
    }
    let mut cursor = if let Some(encoded) = input.page.as_deref() {
        if encoded.len() > 8192 {
            return Err(StorageError::Validation(
                "Catalog page cursor is invalid".into(),
            ));
        }
        serde_json::from_str::<SearchCursor>(encoded)
            .map_err(|_| StorageError::Validation("Catalog page cursor is invalid".into()))?
    } else {
        SearchCursor {
            query: input.query.trim().into(),
            media_type_id: input.media_type_id.clone(),
            year: input.year,
            providers: providers
                .iter()
                .map(|provider| provider.key().into())
                .collect(),
            external_id: input.external_id.clone(),
            external_id_provider: input.external_id_provider.clone(),
            next_pages: providers
                .iter()
                .map(|provider| (provider.key().to_string(), 1))
                .collect(),
        }
    };
    if cursor.query != input.query.trim()
        || cursor.media_type_id != input.media_type_id
        || cursor.year != input.year
        || cursor.providers
            != providers
                .iter()
                .map(|provider| provider.key().to_string())
                .collect::<Vec<_>>()
        || cursor.external_id != input.external_id
        || cursor.external_id_provider != input.external_id_provider
    {
        return Err(StorageError::Validation(
            "Catalog search changed; start a new search.".into(),
        ));
    }

    let client = api_client()?;
    let mut results_by_provider = Vec::new();
    let mut any_provider_succeeded = false;
    let mut warnings = Vec::new();
    let mut next_pages = BTreeMap::new();
    for provider in providers {
        let Some(page) = cursor.next_pages.get(provider.key()).copied() else {
            continue;
        };
        if page == 0 || page > MAX_PAGE {
            return Err(StorageError::Validation(
                "Catalog page is out of range".into(),
            ));
        }
        let response = match provider {
            CatalogProvider::Tmdb => search_tmdb(session, &client, &input, page),
            CatalogProvider::OpenLibrary => search_open_library(&client, &input, page),
            CatalogProvider::GoogleBooks => search_google_books(session, &client, &input, page),
            CatalogProvider::Igdb => search_igdb(session, &client, &input, page),
            CatalogProvider::Steam => Err(StorageError::Validation(
                "Steam catalog search is not supported; use owned-games import.".into(),
            )),
        };
        match response {
            Ok((mut found, next)) => {
                any_provider_succeeded = true;
                if let Some(next) = next.filter(|next| *next <= MAX_PAGE) {
                    next_pages.insert(provider.key().to_string(), next);
                }
                if let Some(year) = input.year {
                    found.retain(|candidate| {
                        candidate.year == Some(year)
                            || candidate_matches_requested_identity(
                                candidate,
                                input.external_id.as_deref(),
                                input.external_id_provider.as_deref(),
                            )
                    });
                }
                found.truncate(MAX_PROVIDER_RESULTS);
                results_by_provider.push(found);
            }
            Err(error) if !any_provider_succeeded && providers_len_from_cursor(&cursor) == 1 => {
                return Err(error);
            }
            Err(_) => warnings.push(format!(
                "{} search did not complete. Try that source again.",
                provider.label()
            )),
        }
    }
    // Preserve each provider's relevance ranking while showing a sample from
    // every selected source before deeper results from any source.
    let mut results = Vec::new();
    for rank in 0..MAX_PROVIDER_RESULTS {
        for provider_results in &results_by_provider {
            if let Some(candidate) = provider_results.get(rank) {
                results.push(candidate.clone());
            }
        }
    }
    cursor.next_pages = next_pages;
    let next_page =
        if cursor.next_pages.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&cursor).map_err(|_| {
                StorageError::Validation("Catalog pagination is unavailable".into())
            })?)
        };
    Ok(SearchCatalogResult {
        results,
        next_page,
        warnings,
    })
}

impl CatalogProvider {
    fn label(self) -> &'static str {
        match self {
            Self::Tmdb => "TMDb",
            Self::OpenLibrary => "Open Library",
            Self::GoogleBooks => "Google Books",
            Self::Igdb => "IGDB",
            Self::Steam => "Steam",
        }
    }
}

fn providers_len_from_cursor(cursor: &SearchCursor) -> usize {
    cursor.providers.len()
}

fn normalize_providers(values: &[String]) -> Result<Vec<CatalogProvider>, StorageError> {
    let mut result = Vec::new();
    for value in values {
        let provider = CatalogProvider::parse(value.trim())
            .ok_or_else(|| StorageError::Validation("Unsupported catalog provider".into()))?;
        if !provider.searchable() || result.contains(&provider) {
            return Err(StorageError::Validation(
                "Catalog source is unavailable or duplicated".into(),
            ));
        }
        result.push(provider);
    }
    if result.is_empty() || result.len() > 4 {
        return Err(StorageError::Validation(
            "Choose one or more supported catalog sources".into(),
        ));
    }
    Ok(result)
}

fn validate_search(input: &SearchCatalogInput) -> Result<(), StorageError> {
    let query = input.query.trim();
    if query.chars().count() > MAX_QUERY_CHARS
        || query.chars().any(char::is_control)
        || (query.len() < 2 && input.external_id.is_none())
    {
        return Err(StorageError::Validation(
            "Enter a title with at least two characters.".into(),
        ));
    }
    if input
        .year
        .is_some_and(|year| !(1800..=2200).contains(&year))
    {
        return Err(StorageError::Validation("Search year is invalid".into()));
    }
    if let Some(id) = input.external_id.as_deref() {
        let valid = match input.external_id_provider.as_deref() {
            Some("imdb") => valid_imdb_id(id),
            Some("isbn") => normalize_isbn(id).is_some(),
            _ => false,
        };
        let has_source = match input.external_id_provider.as_deref() {
            Some("imdb") => input.providers.iter().any(|provider| provider == "tmdb"),
            Some("isbn") => input.providers.iter().any(|provider| {
                matches!(
                    provider.as_str(),
                    "openLibrary" | "openlibrary" | "googleBooks" | "googlebooks"
                )
            }),
            _ => false,
        };
        if !valid || !has_source {
            return Err(StorageError::Validation(
                "Use a valid IMDb ID with TMDb or a valid ISBN with a book catalog.".into(),
            ));
        }
    } else if input.external_id_provider.is_some() {
        return Err(StorageError::Validation(
            "External ID provider requires an external ID.".into(),
        ));
    }
    Ok(())
}

fn valid_imdb_id(value: &str) -> bool {
    value.strip_prefix("tt").is_some_and(|digits| {
        (7..=12).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    })
}

fn normalize_isbn(value: &str) -> Option<String> {
    let normalized: String = value
        .chars()
        .filter(|character| *character != '-' && !character.is_whitespace())
        .collect();
    match normalized.len() {
        10 => {
            let bytes = normalized.as_bytes();
            if !bytes[..9].iter().all(|byte| byte.is_ascii_digit())
                || !(bytes[9].is_ascii_digit() || bytes[9] == b'X' || bytes[9] == b'x')
            {
                return None;
            }
            let sum: u32 = bytes[..9]
                .iter()
                .enumerate()
                .map(|(index, byte)| u32::from(*byte - b'0') * (10 - index as u32))
                .sum::<u32>()
                + match bytes[9] {
                    b'X' | b'x' => 10,
                    digit => u32::from(digit - b'0'),
                };
            (sum % 11 == 0).then(|| normalized.to_ascii_uppercase())
        }
        13 => {
            if !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let bytes = normalized.as_bytes();
            let sum: u32 = bytes[..12]
                .iter()
                .enumerate()
                .map(|(index, byte)| u32::from(*byte - b'0') * if index % 2 == 0 { 1 } else { 3 })
                .sum();
            let check_digit = (10 - (sum % 10)) % 10;
            (u32::from(bytes[12] - b'0') == check_digit).then_some(normalized)
        }
        _ => None,
    }
}

fn candidate_matches_requested_identity(
    candidate: &CatalogCandidate,
    external_id: Option<&str>,
    external_id_provider: Option<&str>,
) -> bool {
    let (Some(external_id), Some(provider)) = (external_id, external_id_provider) else {
        return false;
    };
    candidate.identities.iter().any(|identity| {
        if identity.provider != provider {
            return false;
        }
        if provider == "isbn" {
            normalize_isbn(&identity.external_id) == normalize_isbn(external_id)
        } else {
            identity.external_id == external_id
        }
    })
}

fn applicable_providers(
    providers: Vec<CatalogProvider>,
    external_id_provider: Option<&str>,
) -> Vec<CatalogProvider> {
    match external_id_provider {
        Some("imdb") => providers
            .into_iter()
            .filter(|provider| *provider == CatalogProvider::Tmdb)
            .collect(),
        Some("isbn") => providers
            .into_iter()
            .filter(|provider| {
                matches!(
                    provider,
                    CatalogProvider::OpenLibrary | CatalogProvider::GoogleBooks
                )
            })
            .collect(),
        _ => providers,
    }
}

fn api_client() -> Result<Client, StorageError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| StorageError::Validation("Could not start the catalog request.".into()))
}

/// Download a cover only from a provider image URL that the catalog layer
/// itself could have produced. Redirects are disabled and the response is
/// bounded before it is handed to the asset store for image validation.
pub fn download_catalog_cover(
    provider: &str,
    value: &str,
) -> Result<CatalogCoverDownload, StorageError> {
    let provider = CatalogProvider::parse(provider)
        .ok_or_else(|| StorageError::Validation("This cover source is not supported".into()))?;
    let url = trusted_cover_url(provider, value)
        .ok_or_else(|| StorageError::Validation("This cover source is not supported".into()))?;
    respect_catalog_cover_rate_limit();
    let client = api_client()?;
    let response = client
        .get(url.clone())
        .send()
        .map_err(|_| StorageError::Validation("The cover could not be downloaded".into()))?;
    let response = if response.status().is_redirection() {
        if provider != CatalogProvider::OpenLibrary {
            return Err(StorageError::Validation(
                "The cover provider returned an unsafe redirect".into(),
            ));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 2048)
            .ok_or_else(|| {
                StorageError::Validation("The cover provider returned an unsafe redirect".into())
            })?;
        let destination = url.join(location).map_err(|_| {
            StorageError::Validation("The cover provider returned an unsafe redirect".into())
        })?;
        if let Some(archive_entry) = open_library_archive_download(&url, &destination) {
            let archive_response = client.get(destination.clone()).send().map_err(|_| {
                StorageError::Validation("The cover could not be downloaded".into())
            })?;
            if archive_response.status().is_redirection() {
                let archive_location = archive_response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| value.len() <= 2048)
                    .ok_or_else(|| {
                        StorageError::Validation(
                            "The cover provider returned an unsafe redirect".into(),
                        )
                    })?;
                let image_url = destination.join(archive_location).map_err(|_| {
                    StorageError::Validation(
                        "The cover provider returned an unsafe redirect".into(),
                    )
                })?;
                if !trusted_open_library_redirect(&url, &image_url, Some(&archive_entry)) {
                    return Err(StorageError::Validation(
                        "The cover provider returned an unsafe redirect".into(),
                    ));
                }
                client.get(image_url).send().map_err(|_| {
                    StorageError::Validation("The cover could not be downloaded".into())
                })?
            } else {
                archive_response
            }
        } else if trusted_open_library_redirect(&url, &destination, None) {
            client
                .get(destination)
                .send()
                .map_err(|_| StorageError::Validation("The cover could not be downloaded".into()))?
        } else {
            return Err(StorageError::Validation(
                "The cover provider returned an unsafe redirect".into(),
            ));
        }
    } else {
        response
    };
    if !response.status().is_success() {
        return Err(StorageError::Validation(
            "The cover provider did not return an image".into(),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_COVER_DOWNLOAD_BYTES)
    {
        return Err(StorageError::Validation(
            "The cover is larger than 10 MB".into(),
        ));
    }
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "image/png" | "image/jpeg" | "image/webp"))
        .ok_or_else(|| {
            StorageError::Validation("The cover provider did not return an image".into())
        })?;
    let mut bytes = Vec::new();
    response
        .take(MAX_COVER_DOWNLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| StorageError::Validation("The cover could not be downloaded".into()))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_COVER_DOWNLOAD_BYTES {
        return Err(StorageError::Validation(
            "The cover is larger than 10 MB or empty".into(),
        ));
    }
    Ok(CatalogCoverDownload { mime_type, bytes })
}

fn respect_catalog_cover_rate_limit() {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let lock = LAST.get_or_init(|| Mutex::new(None));
    if let Ok(mut previous) = lock.lock() {
        if let Some(previous) = *previous {
            let elapsed = previous.elapsed();
            if elapsed < Duration::from_secs(1) {
                thread::sleep(Duration::from_secs(1) - elapsed);
            }
        }
        *previous = Some(Instant::now());
    }
}

fn trusted_cover_url(provider: CatalogProvider, value: &str) -> Option<Url> {
    if value.len() > 4096 {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let trusted_host = match provider {
        CatalogProvider::Tmdb => url.host_str() == Some("image.tmdb.org"),
        CatalogProvider::OpenLibrary => url.host_str() == Some("covers.openlibrary.org"),
        CatalogProvider::GoogleBooks => matches!(
            url.host_str(),
            Some("books.google.com" | "books.googleusercontent.com")
        ),
        CatalogProvider::Igdb => url.host_str() == Some("images.igdb.com"),
        CatalogProvider::Steam => matches!(
            url.host_str(),
            Some("shared.akamai.steamstatic.com" | "cdn.akamai.steamstatic.com")
        ),
    };
    if url.scheme() != "https"
        || !trusted_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    if url.query().is_some_and(|query| query.len() > 4096) || url.fragment().is_some() {
        return None;
    }
    let safe_query = match provider {
        CatalogProvider::GoogleBooks => url.query().is_some(),
        CatalogProvider::Steam => {
            let pairs = url.query_pairs().collect::<Vec<_>>();
            pairs.is_empty()
                || (pairs.len() == 1
                    && pairs[0].0 == "t"
                    && !pairs[0].1.is_empty()
                    && pairs[0].1.len() <= 20
                    && pairs[0].1.bytes().all(|byte| byte.is_ascii_digit()))
        }
        _ => url.query().is_none(),
    };
    if !safe_query {
        return None;
    }
    let path = url.path();
    let safe_path = match provider {
        CatalogProvider::Tmdb => {
            let mut parts = path.strip_prefix("/t/p/")?.split('/');
            let size = parts.next()?;
            let image = parts.collect::<Vec<_>>().join("/");
            matches!(
                size,
                "w45"
                    | "w92"
                    | "w154"
                    | "w185"
                    | "w300"
                    | "w342"
                    | "w500"
                    | "w780"
                    | "w1280"
                    | "h632"
                    | "original"
            ) && safe_provider_image_path(&image)
        }
        CatalogProvider::OpenLibrary => {
            let id = path.strip_prefix("/b/id/")?.strip_suffix(".jpg")?;
            let (digits, size) = id.split_once('-')?;
            !digits.is_empty()
                && digits.bytes().all(|byte| byte.is_ascii_digit())
                && matches!(size, "S" | "M" | "L")
        }
        CatalogProvider::GoogleBooks => path == "/books/content" && url.query().is_some(),
        CatalogProvider::Igdb => {
            let image = path
                .strip_prefix("/igdb/image/upload/t_cover_big_2x/")
                .or_else(|| path.strip_prefix("/igdb/image/upload/t_cover_big/"))?;
            let id = image.strip_suffix(".jpg")?;
            !id.is_empty()
                && id.len() <= 120
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        }
        CatalogProvider::Steam => safe_steam_cover_path(path),
    };
    if !safe_path {
        return None;
    }
    Some(url)
}

fn safe_steam_cover_path(path: &str) -> bool {
    let Some(rest) = path
        .strip_prefix("/store_item_assets/steam/apps/")
        .or_else(|| path.strip_prefix("/steam/apps/"))
    else {
        return false;
    };
    let mut parts = rest.split('/');
    let Some(app_id) = parts.next() else {
        return false;
    };
    if app_id.is_empty() || app_id.len() > 12 || !app_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let assets = parts.collect::<Vec<_>>();
    if !(1..=2).contains(&assets.len())
        || assets
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return false;
    }
    if assets.len() == 2 && (assets[0].len() != 40 || !assets[0].bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return false;
    }
    let file = assets[assets.len() - 1];
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 160
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        && matches!(extension, "jpg" | "jpeg" | "png" | "webp")
}

fn safe_provider_image_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 300
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/_-.".contains(&byte))
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn open_library_cover_parts(source: &Url) -> Option<(&str, &str, String)> {
    if source.scheme() != "https" || source.host_str() != Some("covers.openlibrary.org") {
        return None;
    }
    let id_size = source.path().strip_prefix("/b/id/")?.strip_suffix(".jpg")?;
    let (id, size) = id_size.split_once('-')?;
    if id.is_empty()
        || !id.bytes().all(|byte| byte.is_ascii_digit())
        || !matches!(size, "S" | "M" | "L")
    {
        return None;
    }
    let bucket = id.parse::<u64>().ok()? / 10_000;
    Some((id, size, bucket.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenLibraryArchiveEntry {
    item: String,
    archive: String,
    image: String,
}

#[cfg(test)]
fn trusted_open_library_download_redirect(source: &Url, destination: &Url) -> bool {
    open_library_archive_download(source, destination).is_some()
}

fn open_library_archive_download(
    source: &Url,
    destination: &Url,
) -> Option<OpenLibraryArchiveEntry> {
    if destination.scheme() != "https"
        || destination.host_str() != Some("archive.org")
        || !destination.username().is_empty()
        || destination.password().is_some()
        || destination.port().is_some()
        || destination.query().is_some()
        || destination.fragment().is_some()
    {
        return None;
    }
    let segments = destination.path_segments()?;
    let segments = segments.collect::<Vec<_>>();
    if segments.len() != 4 || segments[0] != "download" {
        return None;
    }
    valid_open_library_archive_entry(source, segments[1], segments[2], segments[3]).then(|| {
        OpenLibraryArchiveEntry {
            item: segments[1].into(),
            archive: segments[2].into(),
            image: segments[3].into(),
        }
    })
}

fn trusted_open_library_redirect(
    source: &Url,
    destination: &Url,
    expected_entry: Option<&OpenLibraryArchiveEntry>,
) -> bool {
    let Some((id, size, _bucket)) = open_library_cover_parts(source) else {
        return false;
    };
    let Some(host) = destination.host_str() else {
        return false;
    };
    let Some(shard) = host
        .strip_suffix(".us.archive.org")
        .and_then(|value| value.strip_prefix("ia"))
    else {
        return false;
    };
    if shard.len() != 6
        || !shard.bytes().all(|byte| byte.is_ascii_digit())
        || destination.path() != "/view_archive.php"
    {
        return false;
    }
    if destination.scheme() != "https"
        || !destination.username().is_empty()
        || destination.password().is_some()
        || destination.port().is_some()
        || destination.fragment().is_some()
    {
        return false;
    }
    let expected_file = format!("{id}-{size}.jpg");
    let mut archive = None;
    let mut file = None;
    for (key, value) in destination.query_pairs() {
        match key.as_ref() {
            "archive" if archive.is_none() => archive = Some(value.into_owned()),
            "file" if file.is_none() => file = Some(value.into_owned()),
            "archive" | "file" => return false,
            _ => return false,
        }
    }
    let archive_path_is_valid = archive.as_deref().is_some_and(|value| {
        let Some(value) = value.strip_prefix('/') else {
            return false;
        };
        let Some((partition, item_path)) = value.split_once("/items/") else {
            return false;
        };
        let Some((item, archive)) = item_path.split_once('/') else {
            return false;
        };
        !partition.is_empty()
            && partition.len() <= 6
            && partition.bytes().all(|byte| byte.is_ascii_digit())
            && if let Some(expected) = expected_entry {
                item == expected.item
                    && archive == expected.archive
                    && file.as_deref() == Some(expected.image.as_str())
            } else {
                valid_open_library_archive_entry(source, item, archive, &expected_file)
            }
    });
    archive_path_is_valid
        && (expected_entry.is_some() || file.as_deref() == Some(expected_file.as_str()))
}

fn valid_open_library_archive_entry(source: &Url, item: &str, archive: &str, image: &str) -> bool {
    let Some((id, size, bucket)) = open_library_cover_parts(source) else {
        return false;
    };
    let Some(image_id_size) = image.strip_suffix(".jpg") else {
        return false;
    };
    let Some((image_id, image_size)) = image_id_size.split_once('-') else {
        return false;
    };
    if image_size != size
        || image_id.is_empty()
        || !image_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let legacy_item = format!("olcovers{bucket}");
    if item == legacy_item {
        return image_id == id && archive == format!("{item}-{size}.zip");
    }
    let Some(partition) = item.strip_prefix("l_covers_") else {
        return false;
    };
    let Some(archive_partition) = archive
        .strip_prefix(&format!("{item}_"))
        .and_then(|value| value.strip_suffix(".zip"))
    else {
        return false;
    };
    !partition.is_empty()
        && partition.bytes().all(|byte| byte.is_ascii_digit())
        && !archive_partition.is_empty()
        && archive_partition.bytes().all(|byte| byte.is_ascii_digit())
}

fn provider_url(value: &str) -> Result<Url, StorageError> {
    Url::parse(value)
        .map_err(|_| StorageError::Validation("Catalog request URL could not be built.".into()))
}

fn tmdb_search_url(
    kind: &str,
    query: &str,
    year: Option<i32>,
    page: u32,
) -> Result<Url, StorageError> {
    let endpoint = match kind {
        "movie" => "https://api.themoviedb.org/3/search/movie",
        "tv" => "https://api.themoviedb.org/3/search/tv",
        _ => {
            return Err(StorageError::Validation(
                "Unsupported TMDb search type.".into(),
            ))
        }
    };
    let mut url = provider_url(endpoint)?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("query", query)
            .append_pair("include_adult", "false")
            .append_pair("page", &page.to_string());
        if let Some(year) = year {
            pairs.append_pair(
                if kind == "movie" {
                    "year"
                } else {
                    "first_air_date_year"
                },
                &year.to_string(),
            );
        }
    }
    Ok(url)
}

fn open_library_search_url(query: &str, year: Option<i32>, page: u32) -> Result<Url, StorageError> {
    let mut url = provider_url("https://openlibrary.org/search.json")?;
    let search_query = if let Some(isbn) = normalize_isbn(query) {
        format!("isbn:{isbn}")
    } else if let Some(year) = year {
        let escaped = query.trim().replace('\\', "\\\\").replace('"', "\\\"");
        format!("title:\"{escaped}\" AND first_publish_year:{year}")
    } else {
        query.trim().to_string()
    };
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("q", &search_query)
            .append_pair(
                "fields",
                "key,title,author_name,first_publish_year,cover_i,isbn",
            )
            .append_pair("limit", &MAX_PAGE_SIZE.to_string())
            .append_pair("page", &page.to_string());
    }
    Ok(url)
}

fn google_books_search_url(query: &str, page: u32, api_key: &str) -> Result<Url, StorageError> {
    let mut url = provider_url("https://www.googleapis.com/books/v1/volumes")?;
    let query = normalize_isbn(query)
        .map(|isbn| format!("isbn:{isbn}"))
        .unwrap_or_else(|| query.trim().to_string());
    let start_index = (page - 1).saturating_mul(MAX_PAGE_SIZE);
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("key", api_key)
        .append_pair("startIndex", &start_index.to_string())
        .append_pair("maxResults", &MAX_PAGE_SIZE.to_string())
        .append_pair(
            "fields",
            "totalItems,items(id,volumeInfo(title,authors,publishedDate,industryIdentifiers,imageLinks(thumbnail),infoLink))",
        );
    Ok(url)
}

fn send_json<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, StorageError> {
    let response = request
        .send()
        .map_err(|_| StorageError::Validation("Catalog request failed or timed out.".into()))?;
    decode_json(response)
}

fn decode_json<T: DeserializeOwned>(response: Response) -> Result<T, StorageError> {
    if !response.status().is_success() {
        return Err(StorageError::Validation(format!(
            "Catalog provider returned HTTP {}.",
            response.status().as_u16()
        )));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| StorageError::Validation("Catalog response could not be read.".into()))?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(StorageError::Validation(
            "Catalog response exceeded the size limit.".into(),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| StorageError::Validation("Catalog response was not valid JSON.".into()))
}

fn trim_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= 4096)
        .map(ToOwned::to_owned)
}

fn https_url_on_host(value: &str, host: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then_some(url)
}

fn creators_from_array(value: Option<&Value>, limit: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= 160)
        .take(limit)
        .map(ToOwned::to_owned)
        .collect()
}

fn tmdb_cover(path: Option<&Value>) -> Option<String> {
    let path = path.and_then(Value::as_str)?.trim();
    let relative = path.strip_prefix('/')?;
    if relative.is_empty()
        || relative.len() > 300
        || !relative
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/-_.".contains(&byte))
        || relative
            .split('/')
            .any(|part| part == ".." || part.is_empty())
    {
        return None;
    }
    Some(format!("https://image.tmdb.org/t/p/w500/{relative}"))
}

fn open_library_cover(value: Option<&Value>) -> Option<String> {
    let id = value.and_then(Value::as_i64)?;
    (id > 0).then(|| format!("https://covers.openlibrary.org/b/id/{id}-L.jpg"))
}

fn google_books_cover(value: Option<&Value>) -> Option<String> {
    let value = value.and_then(Value::as_str)?.trim();
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return None;
    }
    let secure = value
        .strip_prefix("http://")
        .map(|rest| format!("https://{rest}"));
    let normalized = secure.as_deref().unwrap_or(value);
    let url = https_url_on_host(normalized, "books.google.com")
        .or_else(|| https_url_on_host(normalized, "books.googleusercontent.com"))?;
    (url.path() == "/books/content" && url.query().is_some()).then(|| url.to_string())
}

fn igdb_cover(image_id: Option<&Value>) -> Option<String> {
    let image_id = image_id.and_then(Value::as_str)?.trim();
    if image_id.is_empty()
        || image_id.len() > 120
        || !image_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return None;
    }
    Some(format!(
        "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/{image_id}.jpg"
    ))
}

fn identity(
    provider: &str,
    entity_kind: &str,
    external_id: &str,
    source_url: Option<String>,
) -> ExternalIdentity {
    ExternalIdentity {
        provider: provider.into(),
        entity_kind: entity_kind.into(),
        external_id: external_id.into(),
        source_url,
    }
}

fn attach_cover(
    candidate: &mut CatalogCandidate,
    provider: CatalogProvider,
    url: Option<String>,
    source_url: Option<String>,
    attribution: Option<String>,
) {
    candidate.cover_url = url.clone();
    candidate.cover_mode = if url.is_some() {
        "persistReference"
    } else {
        "none"
    }
    .into();
    candidate.cover_provider = url.as_ref().map(|_| provider.key().into());
    candidate.remote_cover = url.map(|url| tastellar_domain::RemoteCoverReference {
        provider: provider.cover_key().into(),
        url,
        source_url,
        attribution,
    });
}

fn candidate(
    provider: CatalogProvider,
    id: String,
    entity_kind: &str,
    media_type: &str,
    title: String,
    original_title: Option<String>,
    creators: Vec<String>,
    year: Option<i32>,
    suggested_media_type_id: Option<String>,
    source_url: Option<String>,
    identities: Vec<ExternalIdentity>,
    attribution: &str,
) -> CatalogCandidate {
    CatalogCandidate {
        provider: provider.key().into(),
        id,
        entity_kind: entity_kind.into(),
        media_type: media_type.into(),
        title,
        original_title,
        creators,
        year,
        suggested_media_type_id,
        identities,
        cover_url: None,
        cover_mode: "none".into(),
        cover_provider: None,
        remote_cover: None,
        attribution: Some(attribution.into()),
        source_url,
    }
}

fn suggested_type(media_type_id: Option<&str>, fallback: &str) -> Option<String> {
    Some(media_type_id.unwrap_or(fallback).into())
}

fn tmdb_year(raw: Option<&Value>) -> Option<i32> {
    let raw = raw.and_then(Value::as_str)?;
    raw.get(0..4)?.parse::<i32>().ok().filter(|year| *year > 0)
}

fn open_library_year(raw: Option<&Value>) -> Option<i32> {
    raw.and_then(Value::as_i64)
        .and_then(|year| i32::try_from(year).ok())
        .filter(|year| (0..=2200).contains(year))
}

fn from_tmdb_item(
    item: &Value,
    is_tv: bool,
    selected_type: Option<&str>,
    imdb_id: Option<&str>,
) -> Option<CatalogCandidate> {
    let id = item.get("id")?.as_i64()?.to_string();
    let title = trim_string(item.get(if is_tv { "name" } else { "title" }))?;
    let original_title = trim_string(item.get(if is_tv {
        "original_name"
    } else {
        "original_title"
    }));
    let year = tmdb_year(item.get(if is_tv {
        "first_air_date"
    } else {
        "release_date"
    }));
    let entity_kind = if is_tv { "tv" } else { "movie" };
    let source_url = Some(format!("https://www.themoviedb.org/{entity_kind}/{id}"));
    let mut identities = vec![identity("tmdb", entity_kind, &id, source_url.clone())];
    if let Some(imdb_id) = imdb_id {
        identities.push(identity("imdb", "title", imdb_id, None));
    }
    let default_type = match selected_type {
        Some("anime") => "anime",
        _ if has_tmdb_animation_genre(item) => "anime",
        _ if is_tv => "tv-series",
        _ => "films",
    };
    let mut result = candidate(
        CatalogProvider::Tmdb,
        id,
        entity_kind,
        entity_kind,
        title,
        original_title,
        Vec::new(),
        year,
        suggested_type(selected_type, default_type),
        source_url,
        identities,
        TMDB_ATTRIBUTION,
    );
    let cover_url = tmdb_cover(item.get("poster_path"));
    let cover_source = result.source_url.clone();
    attach_cover(
        &mut result,
        CatalogProvider::Tmdb,
        cover_url,
        cover_source,
        Some(TMDB_ATTRIBUTION.into()),
    );
    Some(result)
}

fn has_tmdb_animation_genre(item: &Value) -> bool {
    item.get("genre_ids")
        .and_then(Value::as_array)
        .is_some_and(|genres| genres.iter().any(|genre| genre.as_i64() == Some(16)))
}

fn search_tmdb(
    session: &ProviderSession,
    client: &Client,
    input: &SearchCatalogInput,
    page: u32,
) -> Result<(Vec<CatalogCandidate>, Option<u32>), StorageError> {
    let credentials = session.snapshot(CatalogProvider::Tmdb)?.ok_or_else(|| {
        StorageError::Validation("TMDb API token is not configured in this app".into())
    })?;
    let token = credentials.api_key.ok_or_else(|| {
        StorageError::Validation("TMDb API token is not configured in this app".into())
    })?;
    let selected = input.media_type_id.as_deref();
    let mut query_types = Vec::new();
    if input.external_id.is_some() {
        query_types.push(("find", ""));
    } else {
        match selected {
            Some("films") => query_types.push(("movie", "movie")),
            Some("tv-series") => query_types.push(("tv", "tv")),
            Some("anime") => {
                query_types.push(("movie", "movie"));
                query_types.push(("tv", "tv"));
            }
            _ => {
                query_types.push(("movie", "movie"));
                query_types.push(("tv", "tv"));
            }
        }
    }
    let mut all = Vec::new();
    let mut any_next = false;
    for (kind, response_kind) in query_types {
        let request = if kind == "find" {
            let id = input.external_id.as_deref().unwrap_or_default();
            let mut url = provider_url(&format!("https://api.themoviedb.org/3/find/{id}"))?;
            url.query_pairs_mut()
                .append_pair("external_source", "imdb_id");
            client.get(url).bearer_auth(token.as_str())
        } else {
            client
                .get(tmdb_search_url(kind, input.query.trim(), input.year, page)?)
                .bearer_auth(token.as_str())
        };
        let body: Value = send_json(request)?;
        if kind == "find" {
            let imdb_id = input.external_id.as_deref();
            for (is_tv, key) in [(false, "movie_results"), (true, "tv_results")] {
                if selected == Some("films") && is_tv || selected == Some("tv-series") && !is_tv {
                    continue;
                }
                if let Some(items) = body.get(key).and_then(Value::as_array) {
                    for item in items.iter().take(MAX_PAGE_SIZE as usize) {
                        if selected == Some("anime") && !has_tmdb_animation_genre(item) {
                            continue;
                        }
                        if let Some(candidate) = from_tmdb_item(item, is_tv, selected, imdb_id) {
                            all.push(candidate);
                        }
                    }
                }
            }
            continue;
        }
        let total_pages = body.get("total_pages").and_then(Value::as_u64).unwrap_or(0) as u32;
        any_next |= page < total_pages;
        if let Some(items) = body.get("results").and_then(Value::as_array) {
            for item in items.iter().take(MAX_PAGE_SIZE as usize) {
                if selected == Some("anime") && !has_tmdb_animation_genre(item) {
                    continue;
                }
                if let Some(mut candidate) =
                    from_tmdb_item(item, response_kind == "tv", selected, None)
                {
                    if selected == Some("anime") {
                        candidate.suggested_media_type_id = Some("anime".into());
                    }
                    all.push(candidate);
                }
            }
        }
    }
    Ok((all, any_next.then_some(page + 1)))
}

fn search_open_library(
    client: &Client,
    input: &SearchCatalogInput,
    page: u32,
) -> Result<(Vec<CatalogCandidate>, Option<u32>), StorageError> {
    respect_open_library_rate_limit();
    let query = input.external_id.as_deref().unwrap_or(input.query.trim());
    let body: Value = send_json(client.get(open_library_search_url(query, input.year, page)?))?;
    let docs = body.get("docs").and_then(Value::as_array);
    let mut results = Vec::new();
    if let Some(docs) = docs {
        for doc in docs.iter().take(MAX_PAGE_SIZE as usize) {
            let Some(key) = trim_string(doc.get("key")) else {
                continue;
            };
            let Some(title) = trim_string(doc.get("title")) else {
                continue;
            };
            let id = key.trim_matches('/').to_string();
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/_-".contains(&b))
            {
                continue;
            }
            let source_url = Some(format!("https://openlibrary.org/{id}"));
            let year = open_library_year(doc.get("first_publish_year"));
            let entity_kind = if id.starts_with("works/") {
                "work"
            } else {
                "edition"
            };
            let mut identities = vec![identity(
                "openlibrary",
                entity_kind,
                &id,
                source_url.clone(),
            )];
            if let Some(isbns) = doc.get("isbn").and_then(Value::as_array) {
                for isbn in isbns.iter().take(8).filter_map(Value::as_str) {
                    if let Some(isbn) = normalize_isbn(isbn) {
                        identities.push(identity(
                            "isbn",
                            if isbn.len() == 10 {
                                "isbn_10"
                            } else {
                                "isbn_13"
                            },
                            &isbn,
                            source_url.clone(),
                        ));
                    }
                }
            }
            let mut result = candidate(
                CatalogProvider::OpenLibrary,
                id.clone(),
                entity_kind,
                "book",
                title,
                None,
                creators_from_array(doc.get("author_name"), 5),
                year,
                suggested_type(input.media_type_id.as_deref(), "literature"),
                source_url.clone(),
                identities,
                "Open Library",
            );
            attach_cover(
                &mut result,
                CatalogProvider::OpenLibrary,
                open_library_cover(doc.get("cover_i")),
                source_url,
                Some("Open Library".into()),
            );
            results.push(result);
        }
    }
    let total = body
        .get("numFound")
        .and_then(Value::as_u64)
        .or_else(|| body.get("num_found").and_then(Value::as_u64))
        .unwrap_or(0);
    let next = (u64::from(page) * u64::from(MAX_PAGE_SIZE) < total).then_some(page + 1);
    Ok((results, next))
}

fn respect_open_library_rate_limit() {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let lock = LAST.get_or_init(|| Mutex::new(None));
    if let Ok(mut previous) = lock.lock() {
        if let Some(previous) = *previous {
            let elapsed = previous.elapsed();
            if elapsed < Duration::from_secs(1) {
                thread::sleep(Duration::from_secs(1) - elapsed);
            }
        }
        *previous = Some(Instant::now());
    }
}

fn search_google_books(
    session: &ProviderSession,
    client: &Client,
    input: &SearchCatalogInput,
    page: u32,
) -> Result<(Vec<CatalogCandidate>, Option<u32>), StorageError> {
    let credentials = session
        .snapshot(CatalogProvider::GoogleBooks)?
        .ok_or_else(|| {
            StorageError::Validation("Google Books API key is not configured in this app".into())
        })?;
    let api_key = credentials.api_key.ok_or_else(|| {
        StorageError::Validation("Google Books API key is not configured in this app".into())
    })?;
    let start_index = (page - 1).saturating_mul(MAX_PAGE_SIZE);
    let query = input.external_id.as_deref().unwrap_or(input.query.trim());
    let body: Value =
        send_json(client.get(google_books_search_url(query, page, api_key.as_str())?))?;
    let mut results = Vec::new();
    if let Some(items) = body.get("items").and_then(Value::as_array) {
        for item in items.iter().take(MAX_PAGE_SIZE as usize) {
            let Some(id) = trim_string(item.get("id")) else {
                continue;
            };
            if id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                continue;
            }
            let info = item.get("volumeInfo").unwrap_or(&Value::Null);
            let Some(title) = trim_string(info.get("title")) else {
                continue;
            };
            let published = trim_string(info.get("publishedDate"));
            let year = published
                .as_deref()
                .and_then(|value| value.get(0..4))
                .and_then(|value| value.parse::<i32>().ok());
            let source_url = trim_string(info.get("infoLink"))
                .filter(|value| value.starts_with("https://books.google.com/"))
                .or_else(|| Some(format!("https://books.google.com/books?id={id}")));
            let mut identities = vec![identity("googlebooks", "volume", &id, source_url.clone())];
            if let Some(ids) = info.get("industryIdentifiers").and_then(Value::as_array) {
                for identifier in ids.iter().take(4) {
                    let Some(kind) = trim_string(identifier.get("type")) else {
                        continue;
                    };
                    let Some(code) = trim_string(identifier.get("identifier")) else {
                        continue;
                    };
                    if code.len() <= 32
                        && code
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-".contains(&b))
                    {
                        identities.push(identity(
                            "isbn",
                            &kind.to_lowercase(),
                            &code,
                            source_url.clone(),
                        ));
                    }
                }
            }
            let mut result = candidate(
                CatalogProvider::GoogleBooks,
                id,
                "volume",
                "book",
                title,
                None,
                creators_from_array(info.get("authors"), 5),
                year,
                suggested_type(input.media_type_id.as_deref(), "literature"),
                source_url.clone(),
                identities,
                "Google Books",
            );
            attach_cover(
                &mut result,
                CatalogProvider::GoogleBooks,
                google_books_cover(
                    info.get("imageLinks")
                        .and_then(|links| links.get("thumbnail")),
                ),
                source_url,
                Some("Google Books".into()),
            );
            results.push(result);
        }
    }
    let total = body.get("totalItems").and_then(Value::as_u64).unwrap_or(0);
    let next = (u64::from(start_index + MAX_PAGE_SIZE) < total).then_some(page + 1);
    Ok((results, next))
}

fn search_igdb(
    session: &ProviderSession,
    client: &Client,
    input: &SearchCatalogInput,
    page: u32,
) -> Result<(Vec<CatalogCandidate>, Option<u32>), StorageError> {
    let token = session.igdb_token(client)?;
    let snapshot = session.snapshot(CatalogProvider::Igdb)?.ok_or_else(|| {
        StorageError::Validation("IGDB credentials are not configured in this app".into())
    })?;
    let client_id = snapshot
        .client_id
        .ok_or_else(|| StorageError::Validation("IGDB client ID is missing.".into()))?;
    let offset = (page - 1).saturating_mul(MAX_PAGE_SIZE);
    let query = format!(
        "search \"{}\"; fields id,name,slug,first_release_date,cover.image_id; limit {}; offset {};",
        input.query.trim().replace('\\', "\\\\").replace('"', "\\\""),
        MAX_PAGE_SIZE,
        offset
    );
    let response = client
        .post("https://api.igdb.com/v4/games")
        .header("Client-ID", client_id.as_str())
        .bearer_auth(token.as_str())
        .header("Content-Type", "text/plain")
        .body(query)
        .send()
        .map_err(|_| StorageError::Validation("IGDB request failed or timed out.".into()))?;
    let body: Vec<Value> = decode_json(response)?;
    let has_more = body.len() == MAX_PAGE_SIZE as usize;
    let mut results = Vec::new();
    for item in body.into_iter().take(MAX_PAGE_SIZE as usize) {
        let Some(id) = item
            .get("id")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
        else {
            continue;
        };
        let Some(title) = trim_string(item.get("name")) else {
            continue;
        };
        let slug = trim_string(item.get("slug"));
        let source_url = slug
            .as_deref()
            .filter(|slug| {
                slug.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-".contains(&b))
            })
            .map(|slug| format!("https://www.igdb.com/games/{slug}"));
        let year = item
            .get("first_release_date")
            .and_then(Value::as_i64)
            .and_then(unix_year);
        let mut result = candidate(
            CatalogProvider::Igdb,
            id.clone(),
            "game",
            "game",
            title,
            None,
            Vec::new(),
            year,
            Some("games".into()),
            source_url.clone(),
            vec![identity("igdb", "game", &id, source_url.clone())],
            "Data from IGDB",
        );
        attach_cover(
            &mut result,
            CatalogProvider::Igdb,
            igdb_cover(item.get("cover").and_then(|cover| cover.get("image_id"))),
            source_url,
            Some("Data from IGDB".into()),
        );
        results.push(result);
    }
    Ok((results, has_more.then_some(page + 1)))
}

fn unix_year(timestamp: i64) -> Option<i32> {
    if timestamp < 0 || timestamp > 32_503_680_000 {
        return None;
    }
    // Civil-from-days conversion, with Unix day zero at 1970-01-01.
    let days = timestamp / 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    i32::try_from(year).ok()
}

#[derive(Debug, PartialEq, Eq)]
enum SteamProfileIdentifier {
    SteamId64(String),
    Vanity(String),
}

fn parse_steam_profile_identifier(value: &str) -> Option<SteamProfileIdentifier> {
    let value = value.trim();
    if value.len() == 17 && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(SteamProfileIdentifier::SteamId64(value.into()));
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(
            url.host_str(),
            Some("steamcommunity.com" | "www.steamcommunity.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let mut segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.last() == Some(&"") {
        segments.pop();
    }
    if segments.len() != 2 {
        return None;
    }
    match (segments[0], segments[1]) {
        ("profiles", id) if id.len() == 17 && id.bytes().all(|byte| byte.is_ascii_digit()) => {
            Some(SteamProfileIdentifier::SteamId64(id.into()))
        }
        ("id", vanity)
            if !vanity.is_empty()
                && vanity.len() <= 64
                && vanity.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                }) =>
        {
            Some(SteamProfileIdentifier::Vanity(vanity.into()))
        }
        _ => None,
    }
}

fn normalize_steam_id(value: &str) -> Option<String> {
    match parse_steam_profile_identifier(value)? {
        SteamProfileIdentifier::SteamId64(id) => Some(id),
        SteamProfileIdentifier::Vanity(_) => None,
    }
}

fn resolve_steam_profile_id(
    client: &Client,
    api_key: &str,
    profile: SteamProfileIdentifier,
) -> Result<String, StorageError> {
    match profile {
        SteamProfileIdentifier::SteamId64(id) => Ok(id),
        SteamProfileIdentifier::Vanity(vanity) => {
            let mut url =
                provider_url("https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/")?;
            url.query_pairs_mut()
                .append_pair("key", api_key)
                .append_pair("vanityurl", &vanity);
            let body: Value = send_json(client.get(url))?;
            let response = body.get("response").ok_or_else(|| {
                StorageError::Validation(
                    "Steam could not resolve this profile link. Check the profile URL and try again."
                        .into(),
                )
            })?;
            if response.get("success").and_then(Value::as_i64) != Some(1) {
                return Err(StorageError::Validation(
                    "Steam could not resolve this profile link. Check the vanity URL and try again."
                        .into(),
                ));
            }
            response
                .get("steamid")
                .and_then(Value::as_str)
                .and_then(normalize_steam_id)
                .ok_or_else(|| {
                    StorageError::Validation(
                        "Steam returned an invalid profile ID. Check the profile link and try again."
                            .into(),
                    )
                })
        }
    }
}

/// Fetches the public owned-games list for the supplied Steam profile. The
/// profile may be the configured account or another profile with public game details.
pub fn steam_owned_games(
    session: &ProviderSession,
    input: &crate::import::SteamImportOptions,
) -> Result<Vec<SteamOwnedGame>, StorageError> {
    let credentials = session.snapshot(CatalogProvider::Steam)?.ok_or_else(|| {
        StorageError::Validation("Steam credentials are not configured in this app.".into())
    })?;
    let api_key = credentials.api_key.ok_or_else(|| {
        StorageError::Validation("Steam credentials are not configured in this app.".into())
    })?;
    let configured_id = credentials.steam_id64.ok_or_else(|| {
        StorageError::Validation("Steam profile is not configured in this app.".into())
    })?;
    let profile = if input.steam_id.trim().is_empty() {
        SteamProfileIdentifier::SteamId64(configured_id)
    } else {
        parse_steam_profile_identifier(&input.steam_id).ok_or_else(|| {
            StorageError::Validation(
                "Enter a SteamID64 or a steamcommunity.com profile URL.".into(),
            )
        })?
    };
    let client = api_client()?;
    let requested_id = resolve_steam_profile_id(&client, &api_key, profile)?;
    let mut url = provider_url("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/")?;
    url.query_pairs_mut()
        .append_pair("key", &api_key)
        .append_pair("steamid", &requested_id)
        .append_pair("include_appinfo", "true")
        .append_pair(
            "include_played_free_games",
            if input.include_played_free_games {
                "true"
            } else {
                "false"
            },
        );
    let body: Value = send_json(client.get(url))?;
    parse_steam_owned_games(&body)
}

fn parse_steam_owned_games(body: &Value) -> Result<Vec<SteamOwnedGame>, StorageError> {
    let response = body.get("response").and_then(Value::as_object).ok_or_else(|| {
        StorageError::Validation(
            "Steam returned no library data. Check the API key and make sure Game details privacy is Public."
                .into(),
        )
    })?;
    let Some(games) = response.get("games").and_then(Value::as_array) else {
        if response.get("game_count").and_then(Value::as_u64) == Some(0) {
            return Ok(Vec::new());
        }
        return Err(StorageError::Validation(
            "Steam returned no game list. Check that Game details privacy is Public and the profile link is correct."
                .into(),
        ));
    };
    if games.len() > 20_000 {
        return Err(StorageError::Validation(
            "Steam returned more than 20,000 games; narrow the import at Steam and retry.".into(),
        ));
    }
    Ok(games
        .iter()
        .filter_map(|game| {
            let app_id = game.get("appid")?.as_u64()?;
            if app_id == 0 {
                return None;
            }
            let name = game.get("name")?.as_str()?.trim();
            if name.is_empty() || name.chars().count() > 300 || name.chars().any(char::is_control) {
                return None;
            }
            Some(SteamOwnedGame {
                app_id: app_id.to_string(),
                name: name.to_string(),
                playtime_forever: game.get("playtime_forever").and_then(Value::as_u64),
                playtime_2weeks: game.get("playtime_2weeks").and_then(Value::as_u64),
                free_to_play: game.get("free_to_play").and_then(Value::as_bool),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_names_are_normalized_for_domain_identity_validation() {
        assert_eq!(
            CatalogProvider::OpenLibrary.identity_provider(),
            "openlibrary"
        );
        assert_eq!(
            CatalogProvider::GoogleBooks.identity_provider(),
            "googlebooks"
        );
        for provider in [
            "openlibrary",
            "googlebooks",
            "tmdb",
            "imdb",
            "steam",
            "igdb",
        ] {
            assert!(provider.bytes().all(|byte| byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || b"._-".contains(&byte)));
        }
    }

    #[test]
    fn provider_credentials_are_session_only_and_never_echoed() {
        let session = ProviderSession::default();
        let configured = configure_provider_credentials(
            &session,
            ProviderCredentialInput {
                provider: "tmdb".into(),
                api_key: Some("fixture-token-never-return-this".into()),
                steam_id64: None,
                client_id: None,
                client_secret: None,
                clear: false,
            },
        )
        .unwrap();
        assert!(configured.configured);
        assert!(configured.session_only);
        let serialized = serde_json::to_string(&configured).unwrap();
        assert!(!serialized.contains("fixture-token-never-return-this"));
        let tmdb = catalog_capabilities(&session)
            .into_iter()
            .find(|capability| capability.provider == "tmdb")
            .unwrap();
        assert!(tmdb.enabled);

        let cleared = configure_provider_credentials(
            &session,
            ProviderCredentialInput {
                provider: "tmdb".into(),
                api_key: None,
                steam_id64: None,
                client_id: None,
                client_secret: None,
                clear: true,
            },
        )
        .unwrap();
        assert!(!cleared.configured);
        assert!(
            !catalog_capabilities(&session)
                .into_iter()
                .find(|capability| capability.provider == "tmdb")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn external_id_lookup_only_accepts_valid_imdb_ids_for_tmdb() {
        assert!(valid_imdb_id("tt0068646"));
        assert!(!valid_imdb_id("https://imdb.com/title/tt0068646/"));
        assert!(!valid_imdb_id("tt../../1"));
        let input = SearchCatalogInput {
            query: "ignored".into(),
            media_type_id: None,
            providers: vec!["tmdb".into()],
            year: None,
            page: None,
            external_id: Some("tt0068646".into()),
            external_id_provider: Some("imdb".into()),
        };
        assert!(validate_search(&input).is_ok());
    }

    #[test]
    fn tmdb_imdb_find_keeps_tmdb_kind_but_uses_canonical_imdb_title_identity() {
        let item = serde_json::json!({
            "id": 98,
            "title": "Synthetic title",
            "original_title": "Synthetic title",
            "release_date": "2004-06-01",
            "poster_path": "/fixture-poster.jpg"
        });
        let found = from_tmdb_item(&item, false, Some("films"), Some("tt99000001")).unwrap();
        assert_eq!(found.media_type, "movie");
        assert_eq!(found.suggested_media_type_id.as_deref(), Some("films"));
        assert!(found.identities.iter().any(|identity| {
            identity.provider == "tmdb"
                && identity.entity_kind == "movie"
                && identity.external_id == "98"
        }));
        assert!(found.identities.iter().any(|identity| {
            identity.provider == "imdb"
                && identity.entity_kind == "title"
                && identity.external_id == "tt99000001"
        }));
        tastellar_domain::validate_external_identities(&found.identities).unwrap();
        tastellar_domain::validate_remote_cover(found.remote_cover.as_ref().unwrap()).unwrap();
    }

    #[test]
    fn animation_media_type_requires_tmdb_animation_genre() {
        assert!(has_tmdb_animation_genre(
            &serde_json::json!({ "genre_ids": [16, 12] })
        ));
        assert!(!has_tmdb_animation_genre(
            &serde_json::json!({ "genre_ids": [28, 12] })
        ));
        assert!(!has_tmdb_animation_genre(
            &serde_json::json!({ "genre_ids": [] })
        ));
    }

    #[test]
    fn isbn_inputs_are_check_digit_validated_and_scoped_to_book_sources() {
        assert_eq!(
            normalize_isbn("0-306-40615-2").as_deref(),
            Some("0306406152")
        );
        assert_eq!(
            normalize_isbn("978-0-306-40615-7").as_deref(),
            Some("9780306406157")
        );
        assert!(normalize_isbn("9780306406158").is_none());
        let input = SearchCatalogInput {
            query: "ignored".into(),
            media_type_id: Some("literature".into()),
            providers: vec!["openLibrary".into(), "googleBooks".into(), "tmdb".into()],
            year: None,
            page: None,
            external_id: Some("978-0-306-40615-7".into()),
            external_id_provider: Some("isbn".into()),
        };
        assert!(validate_search(&input).is_ok());
        let sources = applicable_providers(
            normalize_providers(&input.providers).unwrap(),
            input.external_id_provider.as_deref(),
        );
        assert_eq!(
            sources,
            vec![CatalogProvider::OpenLibrary, CatalogProvider::GoogleBooks]
        );
    }

    #[test]
    fn exact_isbn_match_survives_source_year_mismatch_without_trusting_other_ids() {
        let exact = candidate(
            CatalogProvider::OpenLibrary,
            "works/fixture".into(),
            "work",
            "book",
            "Fixture book".into(),
            None,
            vec![],
            Some(2002),
            Some("literature".into()),
            None,
            vec![identity("isbn", "isbn_13", "9780306406157", None)],
            "Open Library",
        );
        let other_id = candidate(
            CatalogProvider::OpenLibrary,
            "works/other".into(),
            "work",
            "book",
            "Other book".into(),
            None,
            vec![],
            Some(1998),
            Some("literature".into()),
            None,
            vec![identity("isbn", "isbn_13", "9781861972712", None)],
            "Open Library",
        );
        let requested_isbn = "978-0-306-40615-7";
        let retained = [exact, other_id]
            .into_iter()
            .filter(|candidate| {
                candidate.year == Some(2020)
                    || candidate_matches_requested_identity(
                        candidate,
                        Some(requested_isbn),
                        Some("isbn"),
                    )
            })
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].id, "works/fixture");
        assert!(candidate_matches_requested_identity(
            &retained[0],
            Some(requested_isbn),
            Some("isbn")
        ));
    }

    #[test]
    fn default_media_types_only_search_compatible_catalogs() {
        let selected = vec![
            CatalogProvider::Tmdb,
            CatalogProvider::OpenLibrary,
            CatalogProvider::GoogleBooks,
            CatalogProvider::Igdb,
        ];
        assert_eq!(
            selected
                .iter()
                .copied()
                .filter(|provider| provider.supports_default_type("comic"))
                .collect::<Vec<_>>(),
            vec![CatalogProvider::OpenLibrary, CatalogProvider::GoogleBooks]
        );
        assert_eq!(
            selected
                .iter()
                .copied()
                .filter(|provider| provider.supports_default_type("games"))
                .collect::<Vec<_>>(),
            vec![CatalogProvider::Igdb]
        );
        assert_eq!(
            selected
                .iter()
                .copied()
                .filter(|provider| provider.supports_default_type("anime"))
                .collect::<Vec<_>>(),
            vec![CatalogProvider::Tmdb]
        );
    }

    #[test]
    fn provider_request_urls_use_one_requested_page_and_scoped_year_filters() {
        let tmdb = tmdb_search_url("movie", "fixture title", Some(1998), 2).unwrap();
        let pairs: Vec<_> = tmdb.query_pairs().into_owned().collect();
        assert_eq!(pairs.iter().filter(|(key, _)| key == "page").count(), 1);
        assert_eq!(pairs.iter().find(|(key, _)| key == "page").unwrap().1, "2");
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "year").unwrap().1,
            "1998"
        );

        let open = open_library_search_url("fixture title", Some(2001), 3).unwrap();
        let pairs: Vec<_> = open.query_pairs().into_owned().collect();
        assert_eq!(pairs.iter().filter(|(key, _)| key == "page").count(), 1);
        assert_eq!(pairs.iter().find(|(key, _)| key == "page").unwrap().1, "3");
        let query = &pairs.iter().find(|(key, _)| key == "q").unwrap().1;
        assert!(query.contains("first_publish_year:2001"));

        let open_isbn = open_library_search_url("978-0-306-40615-7", None, 2).unwrap();
        assert_eq!(
            open_isbn
                .query_pairs()
                .find(|(key, _)| key == "q")
                .unwrap()
                .1,
            "isbn:9780306406157"
        );
        let google = google_books_search_url("978-0-306-40615-7", 2, "fictional-api-key").unwrap();
        let google_pairs: Vec<_> = google.query_pairs().into_owned().collect();
        assert_eq!(
            google_pairs
                .iter()
                .find(|(key, _)| key == "startIndex")
                .unwrap()
                .1,
            "10"
        );
        assert_eq!(
            google_pairs.iter().find(|(key, _)| key == "q").unwrap().1,
            "isbn:9780306406157"
        );
    }

    #[test]
    fn pagination_cursor_is_bound_to_search_parameters() {
        let session = ProviderSession::default();
        let first = SearchCatalogInput {
            query: "fixture title".into(),
            media_type_id: Some("films".into()),
            providers: vec!["openLibrary".into()],
            year: Some(2019),
            page: None,
            external_id: None,
            external_id_provider: None,
        };
        let cursor = SearchCursor {
            query: first.query.clone(),
            media_type_id: first.media_type_id.clone(),
            year: first.year,
            providers: vec!["openLibrary".into()],
            external_id: None,
            external_id_provider: None,
            next_pages: BTreeMap::from([("openLibrary".into(), 2)]),
        };
        let page = serde_json::to_string(&cursor).unwrap();
        let mut changed = first;
        changed.query = "different title".into();
        changed.page = Some(page);
        assert!(search_catalog(&session, changed).is_err());
    }

    #[test]
    fn provider_image_paths_are_whitelisted_and_reference_only() {
        assert!(tmdb_cover(Some(&Value::String("/poster/path.jpg".into()))).is_some());
        assert!(tmdb_cover(Some(&Value::String("//evil.test/p.jpg".into()))).is_none());
        assert!(open_library_cover(Some(&Value::from(42)))
            .unwrap()
            .starts_with("https://covers.openlibrary.org/"));
        assert!(google_books_cover(Some(&Value::String(
            "http://books.google.com/books/content?id=fixture".into()
        )))
        .unwrap()
        .starts_with("https://books.google.com/"));
        assert!(
            google_books_cover(Some(&Value::String("https://evil.test/image.jpg".into())))
                .is_none()
        );
        assert!(igdb_cover(Some(&Value::String("cover-fixture_01".into())))
            .unwrap()
            .starts_with("https://images.igdb.com/"));
        assert!(igdb_cover(Some(&Value::String("https://evil.test/cover.jpg".into()))).is_none());

        let mut result = candidate(
            CatalogProvider::OpenLibrary,
            "works/fixture".into(),
            "work",
            "book",
            "Fixture title".into(),
            None,
            Vec::new(),
            Some(2020),
            Some("literature".into()),
            Some("https://openlibrary.org/works/fixture".into()),
            Vec::new(),
            "Open Library",
        );
        let source_url = result.source_url.clone();
        attach_cover(
            &mut result,
            CatalogProvider::OpenLibrary,
            open_library_cover(Some(&Value::from(42))),
            source_url,
            Some("Open Library".into()),
        );
        assert_eq!(
            result.remote_cover.as_ref().unwrap().provider,
            "openlibrary"
        );
        tastellar_domain::validate_remote_cover(result.remote_cover.as_ref().unwrap()).unwrap();
    }

    #[test]
    fn open_library_cover_redirects_are_bound_to_the_requested_image() {
        let cover = Url::parse("https://covers.openlibrary.org/b/id/5695211-L.jpg").unwrap();
        let archive_download =
            Url::parse("https://archive.org/download/olcovers569/olcovers569-L.zip/5695211-L.jpg")
                .unwrap();
        let archive_view = Url::parse(
            "https://ia800401.us.archive.org/view_archive.php?archive=/19/items/olcovers569/olcovers569-L.zip&file=5695211-L.jpg",
        )
        .unwrap();

        assert!(trusted_open_library_download_redirect(
            &cover,
            &archive_download
        ));
        assert!(trusted_open_library_redirect(&cover, &archive_view, None));
        let current_archive_download =
            Url::parse("https://archive.org/download/l_covers_1/l_covers_1_2.zip/5695211-L.jpg")
                .unwrap();
        let current_archive_view = Url::parse(
            "https://ia800401.us.archive.org/view_archive.php?archive=/19/items/l_covers_1/l_covers_1_2.zip&file=5695211-L.jpg",
        )
        .unwrap();
        assert!(trusted_open_library_download_redirect(
            &cover,
            &current_archive_download
        ));
        let current_entry = open_library_archive_download(&cover, &current_archive_download)
            .expect("current Open Library archive link should be accepted");
        assert!(trusted_open_library_redirect(
            &cover,
            &current_archive_view,
            Some(&current_entry)
        ));
        assert!(!trusted_open_library_download_redirect(
            &cover,
            &Url::parse("https://archive.org/download/olcovers569/olcovers569-L.zip/5695212-L.jpg")
                .unwrap()
        ));
        assert!(trusted_open_library_download_redirect(
            &cover,
            &Url::parse("https://archive.org/download/l_covers_1/l_covers_1_2.zip/5695212-L.jpg")
                .unwrap()
        ));
        let alias_image_download =
            Url::parse("https://archive.org/download/l_covers_1/l_covers_1_2.zip/888-L.jpg")
                .unwrap();
        let alias_entry = open_library_archive_download(&cover, &alias_image_download)
            .expect("Open Library may alias an image through its trusted redirect");
        let alias_view = Url::parse(
            "https://ia800401.us.archive.org/view_archive.php?archive=/19/items/l_covers_1/l_covers_1_2.zip&file=888-L.jpg",
        )
        .unwrap();
        assert!(trusted_open_library_redirect(
            &cover,
            &alias_view,
            Some(&alias_entry)
        ));
        let wrong_alias_view = Url::parse(
            "https://ia800401.us.archive.org/view_archive.php?archive=/19/items/l_covers_1/l_covers_1_2.zip&file=889-L.jpg",
        )
        .unwrap();
        assert!(!trusted_open_library_redirect(
            &cover,
            &wrong_alias_view,
            Some(&alias_entry)
        ));
        assert!(!trusted_open_library_redirect(
            &cover,
            &Url::parse(
                "https://ia800401.us.archive.org/view_archive.php?archive=/3/items/olcovers569/olcovers569-L.zip&file=5695212-L.jpg"
            )
            .unwrap(),
            None
        ));
        assert!(!trusted_open_library_redirect(
            &cover,
            &Url::parse(
                "https://ia800401.us.archive.org/view_archive.php?archive=/items/olcovers569/olcovers569-L.zip&file=5695211-L.jpg"
            )
            .unwrap(),
            None
        ));
        assert!(!trusted_open_library_redirect(
            &cover,
            &Url::parse(
                "https://ia800401.us.archive.org/view_archive.php?archive=/3/items/olcovers569/olcovers569-L.zip&file=5695211-L.jpg&url=https://example.com"
            )
            .unwrap(),
            None
        ));
    }

    #[test]
    fn steam_profile_parser_accepts_numeric_and_vanity_profile_urls() {
        assert_eq!(
            normalize_steam_id("76561198000000001").as_deref(),
            Some("76561198000000001")
        );
        assert_eq!(
            normalize_steam_id("https://steamcommunity.com/profiles/76561198000000001/").as_deref(),
            Some("76561198000000001")
        );
        assert_eq!(
            parse_steam_profile_identifier(
                "https://www.steamcommunity.com/id/some-name/?l=english"
            ),
            Some(SteamProfileIdentifier::Vanity("some-name".into()))
        );
        assert!(normalize_steam_id("https://steamcommunity.com/id/some-name").is_none());
        assert!(
            parse_steam_profile_identifier("https://steamcommunity.com.evil.test/id/name")
                .is_none()
        );
        assert!(parse_steam_profile_identifier("https://steamcommunity.com:444/id/name").is_none());
        assert!(normalize_steam_id("1234567890123456").is_none());
    }

    #[test]
    fn steam_owned_game_parser_preserves_playtime_and_unknown_free_status() {
        let body = serde_json::json!({
            "response": {
                "game_count": 2,
                "games": [
                    { "appid": 42, "name": "Fixture game", "playtime_forever": 120, "playtime_2weeks": 15 },
                    { "appid": 43, "name": "Another fixture", "playtime_forever": 0 }
                ]
            }
        });
        let games = parse_steam_owned_games(&body).unwrap();
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].app_id, "42");
        assert_eq!(games[0].playtime_forever, Some(120));
        assert_eq!(games[0].playtime_2weeks, Some(15));
        assert_eq!(games[0].free_to_play, None);
        assert_eq!(games[1].playtime_forever, Some(0));
    }

    #[test]
    fn steam_owned_game_parser_distinguishes_an_empty_library_from_hidden_game_details() {
        assert!(
            parse_steam_owned_games(&serde_json::json!({"response":{"game_count":0}}))
                .unwrap()
                .is_empty()
        );
        let error = parse_steam_owned_games(&serde_json::json!({"response":{}})).unwrap_err();
        assert!(error.to_string().contains("Game details privacy is Public"));
    }

    #[test]
    fn every_remote_cover_reference_in_the_enriched_save_passes_provider_validation() {
        #[derive(Deserialize)]
        struct FixtureRef {
            provider: String,
            url: String,
        }

        let refs: Vec<FixtureRef> = serde_json::from_str(include_str!(
            "../tests/fixtures/recap_remote_cover_references.json"
        ))
        .unwrap();
        assert_eq!(refs.len(), 67);
        for cover in refs {
            let provider = CatalogProvider::parse(&cover.provider)
                .unwrap_or_else(|| panic!("unknown fixture provider: {}", cover.provider));
            assert!(
                trusted_cover_url(provider, &cover.url).is_some(),
                "saved {} cover URL was rejected: {}",
                cover.provider,
                cover.url
            );
        }
    }

    #[test]
    fn provider_cover_validation_accepts_standard_image_transforms_and_rejects_unsafe_urls() {
        for size in [
            "w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "h632",
            "original",
        ] {
            let url = format!("https://image.tmdb.org/t/p/{size}/poster.jpg");
            assert!(
                trusted_cover_url(CatalogProvider::Tmdb, &url).is_some(),
                "{url}"
            );
        }

        for url in [
            "http://image.tmdb.org/t/p/w500/poster.jpg",
            "https://image.tmdb.org.evil.test/t/p/w500/poster.jpg",
            "https://image.tmdb.org/t/p/w999/poster.jpg",
            "https://image.tmdb.org/t/p/w500/../poster.jpg",
            "https://image.tmdb.org/t/p/w500/poster.jpg?redirect=https://evil.test",
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/not-an-id/header.jpg?t=123",
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/42/%2e%2e/header.jpg?t=123",
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/42/header.jpg?t=123&url=https://evil.test",
            "https://shared.akamai.steamstatic.com.evil.test/store_item_assets/steam/apps/42/header.jpg?t=123",
        ] {
            let provider = if url.contains("image.tmdb.org") {
                CatalogProvider::Tmdb
            } else {
                CatalogProvider::Steam
            };
            assert!(
                trusted_cover_url(provider, url).is_none(),
                "unsafe URL accepted: {url}"
            );
        }

        assert!(
            trusted_cover_url(
                CatalogProvider::Steam,
                "https://cdn.akamai.steamstatic.com/steam/apps/42/library_600x900_2x.jpg"
            )
            .is_some()
        );
        assert!(trusted_cover_url(
            CatalogProvider::Steam,
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/42/header.jpg?t=1234567890"
        )
        .is_some());
    }
}
