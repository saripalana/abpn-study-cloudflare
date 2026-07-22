import {
  installQuestionBankPackage,
  prepareQuestionBankPackage,
} from "./question-bank-import.js";
import { STORES, deleteRecord, getAllRecords, getRecord, putRecord } from "./storage.js";

const JSON_HEADERS = { "content-type": "application/json" };
const PENDING_PREFIX = "pendingDeckUpload:";

async function responseDetails(response, fallback) {
  const text = await response.text();
  if (!text) return { message: fallback, body: null };
  try {
    const parsed = JSON.parse(text);
    return { message: parsed.error || fallback, body: parsed };
  } catch {
    return { message: text, body: null };
  }
}

const pendingKey = (deckId) => `${PENDING_PREFIX}${deckId}`;

async function queuePendingPackage(prepared, reason) {
  await putRecord(STORES.META, {
    key: pendingKey(prepared.bank.id),
    deckId: prepared.bank.id,
    package: prepared,
    reason: String(reason || "cloud-unavailable"),
    queuedAt: new Date().toISOString(),
  });
}

export async function listCloudDecks(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl("/api/decks", { method: "GET", cache: "no-store" });
  if (!response.ok) {
    const details = await responseDetails(response, "Cloud deck library could not be loaded.");
    const error = new Error(details.message);
    error.responseBody = details.body;
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  return Array.isArray(body.decks) ? body.decks : [];
}

export async function fetchCloudDeckPackage(deckId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(deckId)}`, { method: "GET", cache: "no-store" });
  if (!response.ok) {
    const details = await responseDetails(response, `Deck ${deckId} could not be downloaded.`);
    throw new Error(details.message);
  }
  return response.json();
}

export async function publishCloudDeckPackage(
  prepared,
  fetchImpl = globalThis.fetch.bind(globalThis),
  { queueOnTemporaryFailure = true } = {},
) {
  if (!prepared?.bank?.id) throw new Error("Prepared deck package is required.");
  try {
    const response = await fetchImpl(`/api/decks/${encodeURIComponent(prepared.bank.id)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(prepared),
    });
    if (!response.ok) {
      const details = await responseDetails(response, "Deck could not be saved to the cloud library.");
      const temporary = response.status === 429 || response.status >= 500 || Boolean(details.body?.localOnly);
      if (queueOnTemporaryFailure && temporary) {
        await queuePendingPackage(prepared, details.message);
        return { ok: false, queued: true, localOnly: true, reason: details.message };
      }
      throw new Error(details.message);
    }
    await deleteRecord(STORES.META, pendingKey(prepared.bank.id));
    return response.json();
  } catch (error) {
    const permanent = /format|invalid|protected|limit|too many|must contain|required/i.test(String(error?.message || ""));
    if (queueOnTemporaryFailure && !permanent) {
      await queuePendingPackage(prepared, error.message);
      return { ok: false, queued: true, localOnly: true, reason: error.message };
    }
    throw error;
  }
}

export async function flushPendingCloudDeckUploads(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const pending = (await getAllRecords(STORES.META)).filter((record) => String(record.key).startsWith(PENDING_PREFIX));
  const results = [];
  for (const record of pending) {
    try {
      const result = await publishCloudDeckPackage(record.package, fetchImpl, { queueOnTemporaryFailure: false });
      results.push({ deckId: record.deckId, status: "uploaded", result });
    } catch (error) {
      results.push({ deckId: record.deckId, status: "pending", error });
    }
  }
  return results;
}

export async function removeCloudDeck(deckId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(deckId)}`, { method: "DELETE" });
  if (!response.ok) {
    const details = await responseDetails(response, "Deck could not be removed from the cloud library.");
    throw new Error(details.message);
  }
  await deleteRecord(STORES.META, pendingKey(deckId));
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
