use super::*;

impl Storage {
    /// Resolve the immutable asset captured by a recap, including after an entry edit.
    pub fn load_recap_cover(&self, asset_id: &str) -> Result<Option<String>, StorageError> {
        self.prepare_recap_cover(asset_id)?
            .map(CoverImageJob::render)
            .transpose()
    }

    /// Write only a bounded PNG to the explicitly selected destination, staged beside it.
    pub fn export_recap_image(
        &self,
        path: &str,
        base64: &str,
    ) -> Result<ExportResult, StorageError> {
        if base64.len() > 96 * 1024 * 1024 {
            return Err(StorageError::Validation("Recap image is too large".into()));
        }
        let bytes = BASE64
            .decode(base64)
            .map_err(|_| StorageError::Validation("Invalid recap image".into()))?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(StorageError::Validation("Recap export must be PNG".into()));
        }
        let reader = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Png);
        let (width, height) = reader
            .into_dimensions()
            .map_err(|_| StorageError::Validation("Invalid recap PNG".into()))?;
        if width == 0 || height == 0 || width > 4096 || height > 4096 {
            return Err(StorageError::Validation(
                "Recap dimensions exceed 4096 pixels".into(),
            ));
        }
        let destination = Path::new(path);
        if destination
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("png"))
        {
            return Err(StorageError::Validation("Choose a PNG filename".into()));
        }
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| StorageError::Validation("Choose a destination folder".into()))?;
        let staged = parent.join(format!(
            ".tastellar-recap-{}-{}.tmp",
            std::process::id(),
            now_nanos()
        ));
        let result = (|| -> Result<(), std::io::Error> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&staged, destination)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&staged);
            return Err(error.into());
        }
        Ok(ExportResult {
            path: path.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn png_base64(width: u32, height: u32, color: [u8; 4]) -> String {
        let mut output = Cursor::new(Vec::new());
        let image = ImageBuffer::from_pixel(width, height, Rgba(color));
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        BASE64.encode(output.into_inner())
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tastellar-recap-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn export_rejects_bad_png_data_and_dimensions() {
        let root = temp_root("invalid");
        fs::create_dir_all(&root).unwrap();
        let storage = Storage::open(&root).unwrap();
        let destination = root.join("recap.png");
        fs::write(&destination, b"keep this file").unwrap();

        for (input, expected) in [
            (BASE64.encode(b"not a png"), "Recap export must be PNG"),
            (
                png_base64(4097, 1, [20, 40, 80, 255]),
                "Recap dimensions exceed 4096 pixels",
            ),
        ] {
            let error = storage
                .export_recap_image(destination.to_str().unwrap(), &input)
                .unwrap_err();
            assert!(matches!(error, StorageError::Validation(message) if message == expected));
            assert_eq!(fs::read(&destination).unwrap(), b"keep this file");
        }

        assert!(matches!(
            storage.export_recap_image(destination.to_str().unwrap(), "not-base64!"),
            Err(StorageError::Validation(_))
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"keep this file");
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_overwrites_the_chosen_png_after_validation() {
        let root = temp_root("overwrite");
        fs::create_dir_all(&root).unwrap();
        let storage = Storage::open(&root).unwrap();
        let destination = root.join("recap.png");
        fs::write(&destination, b"old export").unwrap();
        let png = png_base64(2, 3, [120, 60, 180, 255]);
        let expected = BASE64.decode(&png).unwrap();

        storage
            .export_recap_image(destination.to_str().unwrap(), &png)
            .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), expected);

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_failure_removes_its_temporary_file() {
        let root = temp_root("failure");
        fs::create_dir_all(&root).unwrap();
        let storage = Storage::open(&root).unwrap();
        let destination = root.join("existing-directory.png");
        fs::create_dir(&destination).unwrap();

        assert!(storage
            .export_recap_image(
                destination.to_str().unwrap(),
                &png_base64(2, 2, [10, 20, 30, 255]),
            )
            .is_err());
        let leftovers = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tastellar-recap-")
            })
            .count();
        assert_eq!(leftovers, 0);
        assert!(destination.is_dir());

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
