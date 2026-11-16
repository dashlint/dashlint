// A source with no SDK dependency and no SDK call: nothing is withheld, as before ADR-069.
export function restock(isbn: string, copies: number): string {
  return `${isbn}:${copies}`;
}
