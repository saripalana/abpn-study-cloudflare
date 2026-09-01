let deckCatalogResolved = false;
let resolveDeckCatalog;

export const deckCatalogReady = new Promise((resolve) => {
  resolveDeckCatalog = resolve;
});

export function markDeckCatalogReady() {
  if (deckCatalogResolved) return;
  deckCatalogResolved = true;
  resolveDeckCatalog();
}

export function isDeckCatalogReady() {
  return deckCatalogResolved;
}
