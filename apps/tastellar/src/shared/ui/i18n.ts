import { IntlMessageFormat } from "intl-messageformat";
import common from "../messages/en.json";
import home from "../../features/home/messages/en.json";
import library from "../../features/library/messages/en.json";
import settings from "../../features/settings/messages/en.json";
import ranking from "../../features/ranking/messages/en.json";
const messages: Record<string, string> = {
  ...common,
  ...home,
  ...library,
  ...settings,
  ...ranking,
};
const compiled = new Map<string, IntlMessageFormat>();
export function t(
  key: string,
  values?: Record<string, string | number>,
): string {
  if (!messages[key]) return key;
  let message = compiled.get(key);
  if (!message) {
    message = new IntlMessageFormat(messages[key], "en");
    compiled.set(key, message);
  }
  return String(message.format(values));
}
