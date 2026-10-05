import { describe, expect, it } from "vitest";
import { importFailureMessage } from "./importError";

describe("importFailureMessage", () => {
  const detail = "NOT NULL constraint failed: tag.normalized_name";
  const fallback = "The import did not finish.";

  it("shows the message from a structured Tauri rejection", () => {
    expect(importFailureMessage({ code: "Validation", message: detail }, fallback)).toBe(detail);
  });

  it("unwraps JSON-string and Error-wrapped command errors", () => {
    const commandError = JSON.stringify({ code: "Validation", message: detail });
    expect(importFailureMessage(commandError, fallback)).toBe(detail);
    expect(importFailureMessage(new Error(commandError), fallback)).toBe(detail);
  });

  it("keeps ordinary error text and falls back when no message exists", () => {
    expect(importFailureMessage(new Error(detail), fallback)).toBe(detail);
    expect(importFailureMessage({ code: "Validation" }, fallback)).toBe(fallback);
  });
});
