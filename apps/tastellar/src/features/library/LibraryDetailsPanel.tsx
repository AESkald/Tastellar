import type { ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "../../shared/ui/i18n";
import "./library.css";

export interface LibraryDetailsPanelProps {
  title: ReactNode;
  ariaLabel: string;
  onClose: () => void;
  children?: ReactNode;
  width?: number;
  className?: string;
  resizer?: ReactNode;
}

/** Shared right-side panel frame used for Library and Ranking work details. */
export function LibraryDetailsPanel({
  title,
  ariaLabel,
  onClose,
  children,
  width,
  className = "",
  resizer,
}: LibraryDetailsPanelProps) {
  return (
    <aside
      className={`library-context-panel ${className}`.trim()}
      style={width === undefined ? undefined : { width }}
      aria-label={ariaLabel}
    >
      {resizer}
      <header className="library-context-header">
        <span>{title}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t("library.ui.closeRightPanel")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {children}
    </aside>
  );
}
