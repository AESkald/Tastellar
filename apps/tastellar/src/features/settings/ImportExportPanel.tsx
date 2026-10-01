import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { open, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Modal } from "../../shared/ui/Modal";
import { t } from "../../shared/ui/i18n";
import { localizedErrorMessage } from "../../shared/ui/errorMessage";
import "./transfer.css";

export function ImportExportPanel({
  onExport,
  onImport,
  isNative,
}: {
  onExport: (path: string) => Promise<void>;
  onImport: (path: string) => Promise<void>;
  isNative: boolean;
}) {
  const [importPath, setImportPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function exportArchive() {
    setError("");
    setNotice("");
    try {
      const path = await saveFile({
        defaultPath: t("settings.defaultArchiveName"),
        filters: [{ name: t("settings.archiveFilter"), extensions: ["json"] }],
      });
      if (!path) return;
      setBusy(true);
      await onExport(path);
      setNotice(t("settings.archiveSaved"));
    } catch (cause) {
      setError(localizedErrorMessage(cause, "error.archiveFallback"));
    } finally {
      setBusy(false);
    }
  }

  async function chooseArchive() {
    setError("");
    setNotice("");
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: t("settings.archiveFilter"), extensions: ["json"] }],
      });
      if (typeof path === "string") setImportPath(path);
    } catch (cause) {
      setError(localizedErrorMessage(cause, "error.archiveFallback"));
    }
  }

  async function restoreArchive() {
    if (!importPath) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await onImport(importPath);
      setNotice(t("settings.archiveRestored"));
      setImportPath(null);
    } catch (cause) {
      setError(localizedErrorMessage(cause, "error.archiveFallback"));
      setImportPath(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="transfer-panel">
      <p className="transfer-panel-copy">{t("settings.archiveBody")}</p>
      <div className="transfer-actions">
        <button
          className="button primary"
          disabled={!isNative || busy}
          onClick={() => void chooseArchive()}
        >
          <Download size={15} />
          {t("settings.import")}
        </button>
        <button
          className="button secondary"
          disabled={!isNative || busy}
          onClick={() => void exportArchive()}
        >
          <Upload size={15} />
          {t("settings.export")}
        </button>
      </div>
      {!isNative && <p className="field-hint">{t("settings.previewData")}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-message" role="status">
          {notice}
        </p>
      )}
      {importPath && (
        <Modal
          title={t("settings.restoreTitle")}
          description={t("settings.restoreWarning")}
          onClose={() => setImportPath(null)}
          busy={busy}
        >
          <div className="modal-body transfer-confirmation-body">
            <p className="transfer-selected-file">
              {importPath.split(/[\\/]/).at(-1)}
            </p>
          </div>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setImportPath(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void restoreArchive()}
            >
              {busy ? t("app.saving") : t("settings.restoreConfirm")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
