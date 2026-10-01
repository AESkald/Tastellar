export const DEFAULT_TAB_SHORTCUTS = {
  previousTabShortcut: "Alt+ArrowLeft",
  nextTabShortcut: "Alt+ArrowRight",
} as const;

export function shortcutFromEvent(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">,
): string {
  if (["Control", "Alt", "Meta", "Shift"].includes(e.key)) return "";
  const modifiers = [
    e.ctrlKey ? "Control" : "",
    e.altKey ? "Alt" : "",
    e.metaKey ? "Meta" : "",
    e.shiftKey ? "Shift" : "",
  ].filter(Boolean);
  return [...modifiers, e.key.length === 1 ? e.key.toLowerCase() : e.key].join(
    "+",
  );
}
export function shortcutAllowed(shortcut: string, other: string): boolean {
  if (
    !shortcut ||
    shortcut === other ||
    !/^(Control|Alt|Meta)\+/.test(shortcut)
  )
    return false;
  return !new Set([
    "Meta+q",
    "Meta+w",
    "Meta+h",
    "Meta+m",
    "Meta+c",
    "Meta+v",
    "Meta+x",
    "Meta+a",
    "Meta+z",
    "Meta+t",
    "Meta+,",
    "Control+c",
    "Control+v",
    "Control+x",
    "Control+a",
    "Alt+Tab",
    "Meta+Tab",
    "Control+Tab",
  ]).has(shortcut);
}
export function shortcutLabel(shortcut: string) {
  return shortcut
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Meta", "⌘")
    .replace("Shift", "⇧")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replaceAll("+", " ");
}
export function isEditing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      'input,textarea,select,[contenteditable="true"],[role="textbox"]',
    )
  );
}
