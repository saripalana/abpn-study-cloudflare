import {
  installQuestionBankPackage,
  prepareQuestionBankPackage,
  QUESTION_BANK_PACKAGE_FORMAT,
  QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
} from "./question-bank-import.js";
import { STORES, deleteRecord, getAllRecords, getRecord, putRecord } from "./storage.js";

const PENDING_PREFIX = "pendingDeckUpload:";
const DEVICE_KEY = "abpn-study:device-id";

function deviceId() {
  const existing = globalThis.localStorage?.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  globalThis.localStorage?.setItem(DEVICE_KEY, created);
  return created;
}

function requestHeaders(extra = {}) {
  return {
    "x-abpn-device-id": deviceId(),
    ...extra,
  };
}

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

function responseFailure(response, details) {
  const error = new Error(details.message);
  error.status = response.status;
  error.responseBody = details.body;
  return error;
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

export async function getCloudDeckBootstrapState(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl("/api/decks/bootstrap", {
    method: "GET",
    cache: "no-store",
    headers: requestHeaders(),
  });
  if (!response.ok) {
    const details = await responseDetails(response, "Deck bootstrap state could not be loaded.");
    throw responseFailure(response, details);
  }
  return response.json();
}

export async function setCloudDeckBootstrapState(version, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl("/api/decks/bootstrap", {
    method: "PUT",
    headers: requestHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ version }),
  });
  if (!response.ok) {
    const details = await responseDetails(response, "Deck bootstrap state could not be saved.");
    throw responseFailure(response, details);
  }
  return response.json();
}

export async function listCloudDecks(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl("/api/decks", {
    method: "GET",
    cache: "no-store",
    headers: requestHeaders(),
  });
  if (!response.ok) {
    const details = await responseDetails(response, "Cloud deck library could not be loaded.");
    throw responseFailure(response, details);
  }
  const body = await response.json();
  return Array.isArray(body.decks) ? body.decks : [];
}

export async function fetchCloudDeckPackage(deckId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(deckId)}`, {
    method: "GET",
    cache: "no-store",
    headers: requestHeaders(),
  });
  if (!response.ok) {
    const details = await responseDetails(response, `Deck ${deckId} could not be downloaded.`);
    throw responseFailure(response, details);
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
      headers: requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(prepared),
    });
    if (!response.ok) {
      const details = await responseDetails(response, "Deck could not be saved to the cloud library.");
      const temporary = response.status === 429 || response.status >= 500 || Boolean(details.body?.localOnly);
      if (queueOnTemporaryFailure && temporary) {
        await queuePendingPackage(prepared, details.message);
        return { ok: false, queued: true, localOnly: true, reason: details.message };
      }
      throw responseFailure(response, details);
    }
    await deleteRecord(STORES.META, pendingKey(prepared.bank.id));
    return response.json();
  } catch (error) {
    const permanent = Number(error?.status || 0) > 0 && Number(error.status) < 500 && Number(error.status) !== 429;
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
      if (Number(error?.status || 0) >= 400 && Number(error.status) < 500 && Number(error.status) !== 429) {
        await deleteRecord(STORES.META, record.key);
        results.push({ deckId: record.deckId, status: "discarded-stale", error });
      } else {
        results.push({ deckId: record.deckId, status: "pending", error });
      }
    }
  }
  return results;
}

export async function promoteLocallyInstalledDecks({ fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  const [localDecks, remoteDecks] = await Promise.all([
    getAllRecords(STORES.BANK_CONTENT),
    listCloudDecks(fetchImpl),
  ]);
  const remoteById = new Map(remoteDecks.map((deck) => [deck.id, deck]));
  const results = [];

  for (const bank of localDecks) {
    const remote = remoteById.get(bank.id);
    if (remote) {
      results.push({
        deckId: bank.id,
        status: remote.checksum === bank.checksum ? "current" : "remote-authoritative",
      });
      continue;
    }
    const prepared = {
      format: QUESTION_BANK_PACKAGE_FORMAT,
      schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
      checksum: bank.checksum,
      bank,
    };
    const publication = await publishCloudDeckPackage(prepared, fetchImpl);
    results.push({ deckId: bank.id, status: publication.queued ? "queued" : "uploaded", publication });
  }
  return results;
}

export async function removeCloudDeck(deckId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`/api/decks/${encodeURIComponent(deckId)}`, {
    method: "DELETE",
    headers: requestHeaders(),
  });
  if (!response.ok) {
    const details = await responseDetails(response, "Deck could not be removed from the cloud library.");
    throw responseFailure(response, details);
  }
  await deleteRecord(STORES.META, pendingKey(deckId));
  return response.json();
}

export async function refreshCloudDeckLibrary({ fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  const metadata = await listCloudDecks(fetchImpl);
  const results = [];

  for (const deck of metadata) {
    try {
      const local = await getRecord(STORES.BANK_CONTENT, deck.id);
      if (local?.checksum === deck.checksum) {
        results.push({ id: deck.id, status: "current" });
        continue;
      }
      const rawPackage = await fetchCloudDeckPackage(deck.id, fetchImpl);
      const prepared = await prepareQuestionBankPackage(rawPackage);
      const installed = await installQuestionBankPackage(prepared);
      results.push({ id: deck.id, status: installed.status, bank: installed.bank });
    } catch (error) {
      console.error(`Cloud deck ${deck.id} could not be refreshed`, error);
      results.push({ id: deck.id, status: "error", error });
    }
  }

  return results;
}
