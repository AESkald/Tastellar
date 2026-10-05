export function importFailureMessage(error: unknown, fallback: string): string {
  let value: unknown = error instanceof Error ? error.message : error;
  if (typeof value === "string") {
    const text = value;
    if (!text.trim()) return fallback;
    try { value = JSON.parse(text); } catch { return text; }
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = value.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
