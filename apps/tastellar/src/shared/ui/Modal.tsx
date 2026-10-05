import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "./i18n";
export function Modal({
  title,
  description,
  children,
  onClose,
  dirty = false,
  busy = false,
  wide = false,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  dirty?: boolean;
  busy?: boolean;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const requestClose = () => {
    if (!busy) {
      if (dirty) setDiscard(true);
      else onClose();
    }
  };
  return (
    <dialog
      data-dirty={dirty}
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""} ${className}`.trim()}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          requestClose();
          return;
        }
        if (
          e.target instanceof Element &&
          e.target.closest("[data-modal-close-request]")
        ) {
          requestClose();
        }
      }}
      aria-labelledby={titleId}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <div>
            <h2 id={titleId}>
              {discard ? t("common.discardTitle") : title}
            </h2>
            <p>{discard ? t("common.discardBody") : description}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={requestClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <X size={19} />
          </button>
        </header>
        {discard ? (
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDiscard(false)}
            >
              {t("common.keepEditing")}
            </button>
            <button className="button danger" onClick={onClose}>
              {t("common.discard")}
            </button>
          </div>
        ) : (
          children
        )}
      </div>
    </dialog>
  );
}
