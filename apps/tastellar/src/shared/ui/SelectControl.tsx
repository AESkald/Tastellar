import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

type OptionProps = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};

type SelectOption = {
  value: string;
  label: ReactNode;
  disabled: boolean;
};

function plainText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(plainText).join("");
  if (isValidElement<{ children?: ReactNode }>(value))
    return plainText(value.props.children);
  return "";
}

function getOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child) || child.type !== "option")
      return [];
    const label = child.props.children;
    return [
      {
        value: String(child.props.value ?? plainText(label)),
        label,
        disabled: Boolean(child.props.disabled),
      },
    ];
  });
}

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
};

function enabledIndex(
  options: SelectOption[],
  from: number,
  direction: -1 | 1,
): number {
  for (let step = 0; step < options.length; step += 1) {
    const index = (from + direction * step + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function SelectControl({
  value,
  onValueChange,
  children,
  className = "",
  disabled = false,
  menuWidth = "content",
  "aria-label": ariaLabel,
}: {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  menuWidth?: "content" | "trigger";
  "aria-label"?: string;
}) {
  const options = getOptions(children);
  const selectedValue = String(value);
  const selectedIndex = options.findIndex(
    (option) => option.value === selectedValue,
  );
  const selectedOption = options[selectedIndex];
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  const openAt = (index: number) => {
    if (!options.length) return;
    const start = index < 0 ? 0 : index;
    setActiveIndex(enabledIndex(options, start, 1));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveActive = (direction: -1 | 1) => {
    const next = enabledIndex(
      options,
      activeIndex < 0
        ? direction === 1
          ? 0
          : options.length - 1
        : (activeIndex + direction + options.length) % options.length,
      direction,
    );
    if (next >= 0) setActiveIndex(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openAt(selectedIndex >= 0 ? selectedIndex : 0);
      else moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        const last =
          selectedIndex >= 0
            ? selectedIndex
            : enabledIndex(options, options.length - 1, -1);
        setActiveIndex(last);
        setOpen(true);
      } else moveActive(-1);
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(enabledIndex(options, 0, 1));
    } else if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(enabledIndex(options, options.length - 1, -1));
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab" && open) {
      setOpen(false);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openAt(selectedIndex >= 0 ? selectedIndex : 0);
    }
  };

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const viewportPadding = 10;
      const requestedHeight = Math.min(360, options.length * 38 + 12);
      const below = window.innerHeight - bounds.bottom - viewportPadding;
      const above = bounds.top - viewportPadding;
      const openAbove = below < requestedHeight && above > below;
      const maxHeight = Math.max(
        100,
        Math.min(requestedHeight, openAbove ? above : below),
      );
      const availableWidth = window.innerWidth - viewportPadding * 2;
      const maxWidth = Math.max(
        120,
        Math.min(
          menuWidth === "trigger" ? availableWidth : 420,
          availableWidth,
        ),
      );
      const minWidth = Math.min(bounds.width, maxWidth);
      const labelWidth = Math.max(
        140,
        ...options.map((option) => plainText(option.label).length * 7 + 48),
      );
      const width =
        menuWidth === "trigger"
          ? minWidth
          : Math.min(maxWidth, Math.max(minWidth, labelWidth));
      const left = Math.max(
        viewportPadding,
        Math.min(bounds.left, window.innerWidth - width - viewportPadding),
      );
      const top = openAbove
        ? Math.max(viewportPadding, bounds.top - maxHeight - 6)
        : Math.min(
            bounds.bottom + 6,
            window.innerHeight - maxHeight - viewportPadding,
          );
      setPosition({ top, left, width, minWidth, maxWidth, maxHeight });
    };

    const dialog = triggerRef.current?.closest<HTMLDialogElement>("dialog[open]");
    setPortalHost(dialog ?? document.body);
    updatePosition();
    document.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [menuWidth, open, options.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open, portalHost]);

  const listbox = open && position && portalHost ? (
    <div
      ref={menuRef}
      id={`${id}-listbox`}
      role="listbox"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : `${id}-trigger`}
      className="select-control-listbox"
      style={position}
    >
      {options.map((option, index) => (
        <button
          key={`${option.value}-${index}`}
          id={`${id}-option-${index}`}
          type="button"
          tabIndex={-1}
          role="option"
          aria-selected={index === selectedIndex}
          aria-disabled={option.disabled || undefined}
          className={`select-control-option ${index === activeIndex ? "active" : ""}`}
          disabled={option.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(index)}
        >
          {option.label}
          {index === selectedIndex && (
            <Check size={14} className="select-control-option-check" aria-hidden="true" />
          )}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`select-control ${className}`.trim()}>
      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        className="select-control-trigger"
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (open) setOpen(false);
          else openAt(selectedIndex >= 0 ? selectedIndex : 0);
        }}
      >
        <span className="select-control-value">
          {selectedOption?.label ?? options[0]?.label}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {listbox && createPortal(listbox, portalHost!)}
    </div>
  );
}
