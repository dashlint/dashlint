// Two dynamic imports loaded together; the client comes out of an array parameter typed `any[]`
// through a fallback (`m?.default ?? m`).
let catalogue: any = null;
let ready: Promise<void> | null = null;

export function loadCatalogue(): void {
  ready = Promise.all([import('posthog-js'), import('posthog-js/dist/module.no-external')]).then(
    ([m]: any[]) => {
      catalogue = m?.default ?? m;
    },
  );
}

export function searchCatalogue(query: string): void {
  if (catalogue?.capture) catalogue.capture('catalogue_searched', { query });
  void ready;
}
