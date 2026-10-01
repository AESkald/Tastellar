import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Plus, Search, X } from "lucide-react";
import { t } from "../../shared/ui/i18n";

export interface LibrarySidebarItem {
  id: string;
  label: ReactNode;
  count?: ReactNode;
  selected?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    [key: `data-${string}`]: string | number | boolean | undefined;
  };
}

export interface LibrarySidebarProps {
  ariaLabel: string;
  searchId: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAddWork: () => void;
  items: readonly LibrarySidebarItem[];
  heading?: ReactNode;
  count?: ReactNode;
  listAriaLabel?: string;
  showSearchContent?: boolean;
  searchContent?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Shared Library-style add/search/navigation controls used by Library and Ranking. */
export function LibrarySidebar({
  ariaLabel,
  searchId,
  searchValue,
  onSearchChange,
  onAddWork,
  items,
  heading = t("library.ui.groups"),
  count,
  listAriaLabel = t("library.ui.workGroups"),
  showSearchContent = false,
  searchContent,
  footer,
  className = "",
}: LibrarySidebarProps) {
  return (
    <div
      className={`library-side-actions ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="button primary library-add"
        onClick={onAddWork}
      >
        <Plus size={15} /> {t("library.ui.addWork")}
      </button>
      <label className="library-search-field" htmlFor={searchId}>
        <Search size={15} />
        <input
          id={searchId}
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("library.ui.searchPlaceholder")}
          aria-label={t("library.ui.searchAria")}
        />
        {searchValue && (
          <button
            type="button"
            aria-label={t("library.ui.clearSearch")}
            onClick={() => onSearchChange("")}
          >
            <X size={14} />
          </button>
        )}
      </label>
      <div className="library-sidebar-content">
        {showSearchContent ? (
          searchContent
        ) : (
          <>
            <div className="library-pane-caption groups-caption">
              <strong>{heading}</strong>
              {count !== undefined && <span>{count}</span>}
            </div>
            <nav className="library-group-list" aria-label={listAriaLabel}>
              {items.map((item) => {
                const {
                  className: itemClassName,
                  onClick,
                  ...buttonProps
                } = item.buttonProps ?? {};
                return (
                  <button
                    key={item.id}
                    type="button"
                    {...buttonProps}
                    className={`${item.selected ? "active" : ""}${item.separatorBefore ? " separated" : ""}${itemClassName ? ` ${itemClassName}` : ""}`.trim()}
                    aria-current={item.selected ? "page" : undefined}
                    onClick={(event) => {
                      onClick?.(event);
                      item.onSelect();
                    }}
                  >
                    <span className="group-label">{item.label}</span>
                    {item.count !== undefined && (
                      <span className="group-count">{item.count}</span>
                    )}
                  </button>
                );
              })}
            </nav>
          </>
        )}
        {footer && <div className="library-sidebar-footer">{footer}</div>}
      </div>
    </div>
  );
}
