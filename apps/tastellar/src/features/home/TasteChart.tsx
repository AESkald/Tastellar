import type { TasteAxis } from "./domain/taste";
import { t } from "../../shared/ui/i18n";
export function TasteChart({ axes }: { axes: TasteAxis[] }) {
  const showSampleCounts = axes.some((axis) => axis.sampleCount > 0);
  if (axes.length < 3)
    return (
      <div className="taste-bars">
        {axes.map((axis) => (
          <div className="taste-bar" key={axis.criterionId}>
            <div>
              <span>
                {axis.label}
                {showSampleCounts && (
                  <small className="taste-sample-count">
                    {t("home.favoriteSampleCount", { count: axis.sampleCount })}
                  </small>
                )}
              </span>
              <strong>
                {axis.value} <small>/ 10</small>
              </strong>
            </div>
            <div className="bar-track">
              <span style={{ width: `${(axis.value ?? 0) * 10}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  const n = axes.length,
    cx = 210,
    cy = 160,
    r = 104;
  const point = (i: number, radius: number) => ({
    x: cx + Math.sin((i * Math.PI * 2) / n) * radius,
    y: cy - Math.cos((i * Math.PI * 2) / n) * radius,
  });
  const polygon = (scale: number) =>
    axes
      .map((_, i) => {
        const p = point(i, r * scale);
        return `${p.x},${p.y}`;
      })
      .join(" ");
  const shape = axes
    .map((axis, i) => {
      const p = point(i, (r * (axis.value ?? 0)) / 10);
      return `${p.x},${p.y}`;
    })
    .join(" ");
  return (
    <div className="taste-radar-wrap">
      <svg
        className="radar"
        viewBox="0 0 420 330"
        role="img"
        aria-label={t("home.radarChartLabel")}
      >
        {[0.2, 0.4, 0.6, 0.8, 1].map((scale) => (
          <polygon key={scale} points={polygon(scale)} className="radar-grid" />
        ))}
        {axes.map((axis, i) => {
          const p = point(i, r);
          return (
            <line
              key={axis.criterionId}
              x1={cx}
              y1={cy}
              x2={p.x}
              y2={p.y}
              className="radar-grid"
            />
          );
        })}
        <polygon points={shape} className="radar-shape" />
        {axes.map((axis, i) => {
          const p = point(i, (r * (axis.value ?? 0)) / 10),
            label = point(i, r + 27);
          const labelText =
            axis.criterionId === "audiovisual"
              ? t("home.criterion.audiovisualShort")
              : axis.label;
          return (
            <g key={axis.criterionId}>
              <circle cx={p.x} cy={p.y} r="4" className="radar-dot" />
              <text
                x={label.x}
                y={label.y}
                dy=".35em"
                textAnchor={
                  Math.abs(label.x - cx) < 10
                    ? "middle"
                    : label.x > cx
                      ? "start"
                      : "end"
                }
              >
                {labelText}
              </text>
            </g>
          );
        })}
      </svg>
      {showSampleCounts && (
        <div
          className="taste-sample-counts"
          role="group"
          aria-label={t("home.favoriteSampleCounts")}
        >
          {axes.map((axis) => (
            <span key={axis.criterionId}>
              <strong>{axis.label}</strong>: {t("home.favoriteSampleCount", { count: axis.sampleCount })}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
export function EmptyConstellation() {
  return (
    <svg
      className="empty-constellation"
      viewBox="0 0 320 180"
      aria-hidden="true"
    >
      <g fill="none" stroke="currentColor">
        <ellipse
          cx="160"
          cy="90"
          rx="105"
          ry="46"
          transform="rotate(-25 160 90)"
        />
        <ellipse
          cx="160"
          cy="90"
          rx="105"
          ry="46"
          transform="rotate(35 160 90)"
        />
        <circle cx="160" cy="90" r="61" strokeDasharray="2 6" />
      </g>
      <g fill="currentColor">
        <circle cx="66" cy="114" r="3" />
        <circle cx="219" cy="45" r="4" />
        <circle cx="224" cy="146" r="2.5" />
      </g>
      <path
        d="M160 73 164 86 177 90 164 94 160 107 156 94 143 90 156 86Z"
        fill="currentColor"
      />
    </svg>
  );
}
