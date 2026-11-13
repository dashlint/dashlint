// The "closest" hint of spec 6.9.7: what the code sends instead of a name it does not send. A
// candidate is close at an edit distance of at most 3 or with a shared prefix (ADR-038).

/** The largest edit distance that still gives a hint. */
export const MAX_HINT_DISTANCE = 3;

/** The shortest shared prefix that gives a hint when the edit distance is larger. */
export const MIN_SHARED_PREFIX = 4;

/** Levenshtein distance by UTF-16 code unit, case-sensitive. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The candidate closest to `name`, or undefined. First the smallest edit distance up to 3 that is
 * less than the longer name's length (so no two short names are "close" by replacing every
 * character); then the longest shared prefix of at least 4 characters, or the whole of the shorter
 * name; ties go to the smaller distance, then code point order. `name` itself is never a hint.
 */
export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  let bestPrefix: { name: string; prefix: number; distance: number } | undefined;
  for (const candidate of new Set(candidates)) {
    if (candidate === name || candidate.length === 0) continue;
    const distance = editDistance(name, candidate);
    if (distance <= MAX_HINT_DISTANCE && distance < Math.max(name.length, candidate.length)) {
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && byCodePoint(candidate, best.name) < 0)
      )
        best = { name: candidate, distance };
      continue;
    }
    const prefix = sharedPrefix(name, candidate);
    if (prefix < MIN_SHARED_PREFIX && prefix < Math.min(name.length, candidate.length)) continue;
    if (prefix === 0) continue;
    if (
      bestPrefix === undefined ||
      prefix > bestPrefix.prefix ||
      (prefix === bestPrefix.prefix &&
        (distance < bestPrefix.distance ||
          (distance === bestPrefix.distance && byCodePoint(candidate, bestPrefix.name) < 0)))
    )
      bestPrefix = { name: candidate, prefix, distance };
  }
  return best?.name ?? bestPrefix?.name;
}
