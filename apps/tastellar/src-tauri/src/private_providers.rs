use tastellar_storage::{ProviderSession, StorageError};
use zeroize::Zeroizing;

pub fn session() -> Result<ProviderSession, StorageError> {
    let cleartext = decode(
        include_bytes!(concat!(env!("OUT_DIR"), "/provider-data.bin")),
        include_bytes!(concat!(env!("OUT_DIR"), "/provider-mask.bin")),
    )?;
    let json = std::str::from_utf8(&cleartext).map_err(|_| {
        StorageError::Validation("Bundled provider configuration is invalid.".into())
    })?;
    ProviderSession::from_private_config_json(json)
}

// Keep reconstruction at runtime, rather than allowing constant folding into a
// plaintext literal. The temporary JSON buffer is wiped when parsing finishes.
#[inline(never)]
fn decode(payload: &[u8], mask: &[u8]) -> Result<Zeroizing<Vec<u8>>, StorageError> {
    let payload = std::hint::black_box(payload);
    let mask = std::hint::black_box(mask);
    if payload.len() != mask.len() || payload.len() > 64 * 1024 {
        return Err(StorageError::Validation(
            "Bundled provider configuration is invalid.".into(),
        ));
    }
    Ok(Zeroizing::new(
        payload.iter().zip(mask).map(|(a, b)| a ^ b).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tastellar_storage::catalog_capabilities;

    #[test]
    fn decode_reconstructs_synthetic_json_without_plaintext_constants() {
        let cleartext = b"[]";
        let mask = [0x31, 0x72];
        let payload = cleartext
            .iter()
            .zip(mask)
            .map(|(byte, mask)| *byte ^ mask)
            .collect::<Vec<_>>();

        let decoded = decode(&payload, &mask).unwrap();
        assert_eq!(decoded.as_slice(), cleartext);
    }

    #[test]
    fn decode_rejects_mismatched_and_oversized_shares() {
        assert!(decode(&[0], &[]).is_err());
        let oversized = vec![0; 64 * 1024 + 1];
        assert!(decode(&oversized, &oversized).is_err());
    }

    #[test]
    fn bundled_provider_session_loads_without_disclosing_configured_values() {
        let session = session().expect("bundled provider configuration should load");
        let capabilities = catalog_capabilities(&session);
        for provider in ["tmdb", "googleBooks", "igdb", "steam"] {
            let capability = capabilities
                .iter()
                .find(|capability| capability.provider == provider)
                .expect("expected catalog provider capability");
            assert!(capability.configured, "{provider} should be configured");
        }
        for provider in ["tmdb", "googleBooks", "igdb"] {
            let capability = capabilities
                .iter()
                .find(|capability| capability.provider == provider)
                .expect("expected catalog provider capability");
            assert!(capability.enabled, "{provider} should be available");
        }
    }
}
