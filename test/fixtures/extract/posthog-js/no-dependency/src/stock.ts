// A source with no SDK dependency and no SDK call (a backend merged with a web source, ADR-025):
// nothing is withheld, as before ADR-069.
export function restock(isbn: string, copies: number): string {
  return `${isbn}:${copies}`;
}
