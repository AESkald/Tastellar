use image::GenericImageView;
use tastellar_storage::{
    catalog_capabilities, download_catalog_cover, search_catalog, steam_owned_games,
    CatalogCoverDownload, ProviderSession, SearchCatalogInput,
};
use tastellar_storage::import::SteamImportOptions;

fn check_catalog(session: &ProviderSession, label: &str, provider: &str, query: &str, media_type: &str) {
    let result = search_catalog(session, SearchCatalogInput {
        query: query.into(),
        media_type_id: Some(media_type.into()),
        providers: vec![provider.into()],
        year: None,
        page: None,
        external_id: None,
        external_id_provider: None,
    });
    match result {
        Err(error) => println!("{label}: search=error code={} reason={}", error.code(), error),
        Ok(result) => {
            let count = result.results.len();
            let cover = result.results.iter().find_map(|candidate| candidate.remote_cover.as_ref());
            let Some(cover) = cover else {
                println!("{label}: search=ok results={count} cover=none");
                return;
            };
            match download_catalog_cover(&cover.provider, &cover.url) {
                Err(error) => println!("{label}: search=ok results={count} cover=error code={} reason={}", error.code(), error),
                Ok(CatalogCoverDownload { mime_type, bytes }) => match image::load_from_memory(&bytes) {
                    Ok(image) => {
                        let (width, height) = image.dimensions();
                        println!("{label}: search=ok results={count} cover=ok mime={mime_type} dimensions={width}x{height} bytes={}", bytes.len());
                    }
                    Err(_) => println!("{label}: search=ok results={count} cover=downloaded image=decode_error mime={mime_type} bytes={}", bytes.len()),
                },
            }
        }
    }
}

fn configured_steam_id(config: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(config)
        .ok()?
        .as_array()?
        .iter()
        .find(|row| row.get("provider").and_then(serde_json::Value::as_str) == Some("steam"))?
        .get("steamId64")
        .and_then(serde_json::Value::as_str)
        .filter(|steam_id| !steam_id.is_empty())
        .map(str::to_owned)
}

fn main() {
    let config = std::fs::read_to_string(".runtime/provider-credentials.json")
        .expect("private provider configuration is unavailable");
    let session = ProviderSession::from_private_config_json(&config)
        .expect("private provider configuration is invalid");
    let steam_id = configured_steam_id(&config)
        .or_else(|| std::env::var("TASTELLAR_TEST_STEAM_ID").ok());
    drop(config);
    if std::env::var_os("ONLY_OPEN_LIBRARY").is_some() {
        check_catalog(&session, "Open Library Mother retry", "openLibrary", "Mother", "literature");
        return;
    }
    for provider in catalog_capabilities(&session) {
        if matches!(provider.provider.as_str(), "tmdb" | "igdb" | "googleBooks") {
            println!("{}: configured={}", provider.provider, provider.configured);
        }
    }

    check_catalog(&session, "TMDB Arcane", "tmdb", "Arcane", "tv-series");
    check_catalog(&session, "IGDB Celeste", "igdb", "Celeste", "games");
    check_catalog(&session, "Google Books Mother", "googleBooks", "Mother", "literature");
    check_catalog(&session, "Open Library Mother", "openLibrary", "Mother", "literature");

    if let Some(steam_id) = steam_id {
        match steam_owned_games(&session, &SteamImportOptions {
            steam_id,
            include_played_free_games: false,
        }) {
            Ok(games) => println!("Steam owned-games: status=ok count={}", games.len()),
            Err(error) => println!("Steam owned-games: status=error code={}", error.code()),
        }
    } else {
        println!("Steam owned-games: status=skipped");
    }
}
