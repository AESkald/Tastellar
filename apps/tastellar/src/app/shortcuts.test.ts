import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAB_SHORTCUTS,
  shortcutAllowed,
  shortcutFromEvent,
  shortcutLabel,
} from "./shortcuts";

function keyEvent(
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">
  > = {},
): Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> {
  return {
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  };
}

describe("keyboard shortcuts", () => {
  it("normalizes modifier order, lowercase letters, and named navigation keys", () => {
    expect(
      shortcutFromEvent(
        keyEvent("R", {
          ctrlKey: true,
          altKey: true,
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe("Control+Alt+Meta+Shift+r");
    expect(shortcutFromEvent(keyEvent("ArrowRight", { altKey: true }))).toBe(
      "Alt+ArrowRight",
    );
  });

  it("uses Option plus the arrow keys as the default tab shortcuts", () => {
    expect(DEFAULT_TAB_SHORTCUTS).toEqual({
      previousTabShortcut: "Alt+ArrowLeft",
      nextTabShortcut: "Alt+ArrowRight",
    });
  });

  it("does not treat a modifier key by itself as a shortcut", () => {
    for (const key of ["Control", "Alt", "Meta", "Shift"]) {
      expect(
        shortcutFromEvent(
          keyEvent(key, { ctrlKey: key !== "Control", altKey: key !== "Alt" }),
        ),
      ).toBe("");
    }
  });

  it("requires a supported modifier and rejects conflicts and reserved browser shortcuts", () => {
    expect(shortcutAllowed("ArrowRight", "Alt+ArrowLeft")).toBe(false);
    expect(shortcutAllowed("Alt+ArrowLeft", "Alt+ArrowLeft")).toBe(
      false,
    );
    expect(shortcutAllowed("Meta+w", "Alt+ArrowLeft")).toBe(false);
    expect(shortcutAllowed("Control+c", "Alt+ArrowLeft")).toBe(false);
    expect(shortcutAllowed("Alt+ArrowLeft", "Alt+ArrowRight")).toBe(true);
    expect(shortcutAllowed("Alt+g", "Alt+ArrowLeft")).toBe(true);
  });

  it("renders readable labels for platform modifiers and arrows", () => {
    expect(shortcutLabel("Alt+ArrowLeft")).toBe("⌥ ←");
    expect(shortcutLabel("Meta+Shift+ArrowRight")).toBe("⌘ ⇧ →");
  });
});
