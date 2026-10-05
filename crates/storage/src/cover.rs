use super::*;
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

const CACHE_BYTES: usize = 32 * 1024 * 1024;
type CacheKey = (PathBuf, String, u32, u32, u64, Option<SystemTime>);
static COVER_CACHE: OnceLock<Mutex<VecDeque<(CacheKey, String)>>> = OnceLock::new();

/// Image decoding and resizing can run after releasing the database lock.
pub struct CoverImageJob {
    key: CacheKey,
    bytes: Option<Vec<u8>>,
    cached: Option<String>,
}

impl CoverImageJob {
    pub fn render(self) -> Result<String, StorageError> {
        if let Some(cached) = self.cached {
            return Ok(cached);
        }
        let image = image::load_from_memory(self.bytes.as_deref().unwrap_or_default())
            .map_err(|_| StorageError::AssetUnavailable)?;
        let mut derivative = Cursor::new(Vec::new());
        image
            .thumbnail(self.key.2, self.key.3)
            .write_to(&mut derivative, ImageFormat::Png)
            .map_err(|_| StorageError::AssetUnavailable)?;
        let source = format!(
            "data:image/png;base64,{}",
            BASE64.encode(derivative.into_inner())
        );
        if let Ok(mut cache) = COVER_CACHE.get_or_init(Default::default).lock() {
            cache.retain(|(key, _)| key != &self.key);
            if source.len() <= CACHE_BYTES {
                while cache.iter().map(|(_, value)| value.len()).sum::<usize>() + source.len()
                    > CACHE_BYTES
                {
                    cache.pop_front();
                }
                cache.push_back((self.key, source.clone()));
            }
        }
        Ok(source)
    }
}

impl Storage {
    pub fn prepare_entry_cover(
        &self,
        entry_id: &str,
    ) -> Result<Option<CoverImageJob>, StorageError> {
        let asset: Option<(String, String)> = self.conn.query_row(
            "SELECT a.hash,a.relative_path FROM assets a JOIN entry e ON e.cover_asset_id=a.hash WHERE e.id=?1 AND e.trashed_at IS NULL",
            [entry_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        asset
            .map(|(hash, relative)| self.prepare_cover(&hash, &relative, 900, 1200))
            .transpose()
    }

    pub fn prepare_recap_cover(
        &self,
        asset_id: &str,
    ) -> Result<Option<CoverImageJob>, StorageError> {
        let relative: Option<String> = self
            .conn
            .query_row(
                "SELECT relative_path FROM assets WHERE hash=?1",
                [asset_id],
                |row| row.get(0),
            )
            .optional()?;
        relative
            .map(|relative| self.prepare_cover(asset_id, &relative, 1600, 1920))
            .transpose()
    }

    fn prepare_cover(
        &self,
        hash: &str,
        relative: &str,
        width: u32,
        height: u32,
    ) -> Result<CoverImageJob, StorageError> {
        let filename = Path::new(relative);
        if hash.len() != 64
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || filename.components().count() != 2
            || filename.parent() != Some(Path::new("assets"))
            || !filename.file_name().is_some_and(|name| {
                ["png", "jpg", "webp"]
                    .iter()
                    .any(|ext| name == format!("{hash}.{ext}").as_str())
            })
        {
            return Err(StorageError::AssetUnavailable);
        }
        let metadata = self
            .root
            .join(relative)
            .symlink_metadata()
            .map_err(|_| StorageError::AssetUnavailable)?;
        if !metadata.file_type().is_file() {
            return Err(StorageError::AssetUnavailable);
        }
        let key = (
            self.root.clone(),
            hash.to_owned(),
            width,
            height,
            metadata.len(),
            metadata.modified().ok(),
        );
        let cached = {
            COVER_CACHE
                .get_or_init(Default::default)
                .lock()
                .ok()
                .and_then(|cache| {
                    cache
                        .iter()
                        .find(|(stored, _)| stored == &key)
                        .map(|(_, value)| value.clone())
                })
        };
        let bytes = if cached.is_none() {
            Some(self.read_asset(hash, relative)?)
        } else {
            None
        };
        Ok(CoverImageJob { key, bytes, cached })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "tastellar-cover-{name}-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn saved_cover(root: &Path) -> (Storage, String, PathBuf) {
        let mut storage = Storage::open(root).unwrap();
        let library = storage.load_library().unwrap();
        let library = storage
            .save_entry(
                library.revision,
                EntryInput {
                    id: "cover-entry".into(),
                    title: "Cover entry".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("literature".into()),
                    overall_rating: Some(9),
                    cover_asset_id: None,
                    external_identities: None,
                    remote_cover: None,
                    clear_remote_cover: false,
                    release_date: None,
                    review_text: String::new(),
                    short_label: None,
                    criterion_ratings: BTreeMap::new(),
                    tag_ids: Vec::new(),
                },
            )
            .unwrap();

        let image = image::DynamicImage::new_rgb8(1800, 2400);
        let mut cursor = Cursor::new(Vec::new());
        image.write_to(&mut cursor, ImageFormat::Png).unwrap();
        let bytes = cursor.into_inner();
        let state = storage
            .save_entry_cover(
                library.revision,
                "cover-entry",
                "image/png",
                &BASE64.encode(&bytes),
            )
            .unwrap();
        let hash = state
            .entries
            .iter()
            .find(|entry| entry.id == "cover-entry")
            .and_then(|entry| entry.cover_asset_id.clone())
            .unwrap();
        let path = root.join("assets").join(format!("{hash}.png"));
        (storage, hash, path)
    }

    #[test]
    fn prepared_cover_job_renders_after_storage_is_dropped() {
        let root = root("unlocked-render");
        let (storage, _, _) = saved_cover(&root);
        let job = storage.prepare_entry_cover("cover-entry").unwrap().unwrap();
        drop(storage);

        let data_url = job.render().unwrap();
        let encoded = data_url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = BASE64.decode(encoded).unwrap();
        let image = image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap();
        assert_eq!(image.to_rgba8().dimensions(), (900, 1200));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn warm_cover_cache_rejects_tampered_and_missing_original_assets() {
        let root = root("cache-source-validation");
        let (storage, hash, path) = saved_cover(&root);
        let data_url = storage
            .prepare_recap_cover(&hash)
            .unwrap()
            .unwrap()
            .render()
            .unwrap();
        let encoded = data_url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = BASE64.decode(encoded).unwrap();
        let rendered = image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap();
        assert_eq!(rendered.to_rgba8().dimensions(), (1440, 1920));

        fs::write(&path, b"tampered original").unwrap();
        assert!(matches!(
            storage.prepare_recap_cover(&hash),
            Err(StorageError::AssetUnavailable)
        ));

        // The derivative is still present in the process cache, but absence of
        // the authoritative original must never turn it into a resurrected asset.
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            storage.prepare_recap_cover(&hash),
            Err(StorageError::AssetUnavailable)
        ));
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
