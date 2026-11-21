// Public-domain Natural Earth 1:110m v5.1.2 country geometry, projected onto a 720 × 300 grid.
// https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_110m_admin_0_countries.geojson
import paths from "@/lib/world-paths.json";
import { number } from "@/lib/api";
export function WorldMap({
  rows,
  label,
}: {
  rows: { label: string; count: number }[];
  label: string;
}) {
  const values = new Map(rows.map((r) => [r.label, r.count])),
    max = Math.max(1, ...rows.map((r) => Math.abs(r.count)));
  return (
    <figure>
      <svg className="w-full" viewBox="0 0 720 296" role="img" aria-label={label}>
        {paths.map(([code, name, d]) => {
          const value = values.get(code);
          return (
            <path
              key={name}
              d={d}
              stroke="var(--background)"
              strokeWidth=".6"
              fill={
                value == null
                  ? "var(--muted)"
                  : `color-mix(in oklab,var(--data${value < 0 ? "-secondary" : ""}) ${30 + Math.round(70 * Math.sqrt(Math.abs(value) / max))}%,var(--muted))`
              }
            >
              <title>
                {name}: {value == null ? "No measured value" : number(value, 2)}
              </title>
            </path>
          );
        })}
      </svg>
      <figcaption className="text-xs text-muted-foreground">
        {rows.length
          ? "Darker countries have less activity. Unmeasured countries are gray."
          : "No country measurements in this period."}
      </figcaption>
    </figure>
  );
}
