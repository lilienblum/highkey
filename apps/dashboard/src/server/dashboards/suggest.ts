// "Did you mean" suggestions, shared by formulas, catalog warnings and not-found hints.

function distance(a: string, b: string): number {
  const right = [...b];
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  [...a].forEach((ca, i) => {
    let diagonal = row[0] as number;
    row[0] = i + 1;
    right.forEach((cb, j) => {
      const above = row[j + 1] as number;
      row[j + 1] = Math.min(above + 1, (row[j] as number) + 1, diagonal + (ca === cb ? 0 : 1));
      diagonal = above;
    });
  });
  return row[right.length] as number;
}

/** The candidate closest to `name`, when it is at most two edits away. */
export function nearest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const d = distance(name, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

const LISTED = 20;

/** A hint for a name that matched nothing: the nearest candidate, else the candidates. */
export function missingHint(name: string, candidates: string[], plural: string): string {
  const close = nearest(name, candidates);
  if (close) return `did you mean \`${close}\`?`;
  if (candidates.length === 0)
    return plural === "projects"
      ? "There are no projects yet; create one in Piko's Settings or with create_project"
      : `This project has no ${plural} yet`;
  const more = candidates.length - LISTED;
  return `Existing ${plural}: ${candidates.slice(0, LISTED).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
