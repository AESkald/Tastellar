import { useEffect, useState } from "react";
import { ArrowUpRight, Heart, X } from "lucide-react";
import { t } from "../../shared/ui/i18n";
import { ExternalLink } from "../../shared/ui/ExternalLink";
import "./support.css";

const storageKey = "tastellar.supportReminder.lastShown.v1";
const reminderIntervalMs = 30 * 24 * 60 * 60 * 1000;

export function SupportReminder() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const now = Date.now();
    let lastShown = 0;
    try {
      lastShown = Number(window.localStorage.getItem(storageKey) ?? 0);
    } catch {
      // Keep this reminder available in restricted storage contexts.
    }
    if (
      Number.isFinite(lastShown) &&
      lastShown > 0 &&
      now - lastShown < reminderIntervalMs
    )
      return;
    try {
      window.localStorage.setItem(storageKey, String(now));
    } catch {
      // The in-memory state still prevents repeated prompts in this session.
    }
    setVisible(true);
  }, []);

  if (!visible) return null;
  return (
    <aside className="support-reminder" aria-label={t("settings.supportTitle")}>
      <button
        type="button"
        className="support-reminder-close"
        aria-label={t("common.close")}
        onClick={() => setVisible(false)}
      >
        <X size={16} />
      </button>
      <div className="support-reminder-copy">
        <span className="support-reminder-mark">
          <Heart size={17} />
        </span>
        <div>
          <strong>{t("settings.supportTitle")}</strong>
          <p>{t("settings.supportReminderBody")}</p>
        </div>
      </div>
      <ExternalLink
        className="button primary support-reminder-action"
        href="https://boosty.to/tastellar"
        onClick={() => setVisible(false)}
      >
        {t("settings.supportReminderAction")} <ArrowUpRight size={14} />
      </ExternalLink>
    </aside>
  );
}
