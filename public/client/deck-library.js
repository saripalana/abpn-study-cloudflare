import {
  installQuestionBankPackage,
  prepareQuestionBankPackage,
} from "./question-bank-import.js";
import { STORES, getRecord } from "./storage.js";

const JSON_HEADERS = { "content-type": "application/json" };

async function responseError(response, fallback) {
  const text = await response.text();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed.error || fallback;
  } catch {
    return text;
  }
}

export async function listCloudDecks(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl("/api/decks", { method: "GET", cache: "no-store" });
  if (!response.ok) throw new Error(await responseError(response, "Cloud deck library could not be loaded."));
  const body = await response.json();
  return Array.isArray(body.decks) ? body.decks : [];
}

export async function fetchCloudDeckPackage(deckId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(deckId)}`, { method: "GET", cache: "no-store" });
  if (!response.ok) throw new Error(await responseError(response, `Deck ${deckId} could not be downloaded.`));
  return response.json();
}

export async function publishCloudDeckPackage(prepared, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (!prepared?.bank?.id) throw new Error("Prepared deck package is required.");
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(prepared.bank.id)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(prepared),
  });
  if (!response.ok) throw new Error(await responseError(response, "Deck could not be saved to the cloud library."));
  return response.json();
}

export async function removeCloudDeck(deckId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(deckId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "Deck could not be removed from the cloud library."));
  return response.json();
}

export async function refreshCloudDeckLibrary({ reservedIds = [], fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  const metadata = await listCloudDecks(fetchImpl);
  const results = [];

  for (const deck of metadata) {
    if (reservedIds.includes(deck.id)) {
      results.push({ id: deck.id, status: "reserved-skipped" });
      continue;
    }
    try {
      const local = await getRecord(STORES.BANK_CONTENT, deck.id);
      if (local?.checksum === deck.checksum) {
        results.push({ id: deck.id, status: "current" });
        continue;
      }
      const rawPackage = await fetchCloudDeckPackage(deck.id, fetchImpl);
      const prepared = await prepareQuestionBankPackage(rawPackage, { reservedIds });
      const installed = await installQuestionBankPackage(prepared, { reservedIds });
      results.push({ id: deck.id, status: installed.status, bank: installed.bank });
    } catch (error) {
      console.error(`Cloud deck ${deck.id} could not be refreshed`, error);
      results.push({ id: deck.id, status: "error", error });
    }
  }

  return results;
}
