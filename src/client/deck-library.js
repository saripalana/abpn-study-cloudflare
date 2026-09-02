import {
  installQuestionBankPackage,
  prepareQuestionBankPackage,
  QUESTION_BANK_PACKAGE_FORMAT,
  QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
} from "./question-bank-import.js";
import { STORES, deleteRecord, getAllRecords, getRecord, putRecord } from "./storage.js";
import {
  reconcileStudyCoachBanks,
  STUDY_COACH_BANK_ID,
} from "./study-coach-deck-library.js";

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

async function queuePendingPackage(prepared, reason, expectedHeadChecksum = "") {
  await putRecord(STORES.META, {
    key: pendingKey(prepared.bank.id),
    deckId: prepared.bank.id,
    package: prepared,
    expectedHeadChecksum,
    reason: String(reason || "cloud-unavailable"),
    queuedAt: new Date().toISOString(),
  });
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
  { queueOnTemporaryFailure = true, expectedHeadChecksum = "", expectNoHead = false } = {},
) {
  if (!prepared?.bank?.id) throw new Error("Prepared deck package is required.");
  try {
    const response = await fetchImpl(`/api/decks/${encodeURIComponent(prepared.bank.id)}`, {
      method: "PUT",
      headers: requestHeaders({
        "content-type": "application/json",
        ...(expectedHeadChecksum ? { "x-abpn-expected-head-checksum": expectedHeadChecksum } : {}),
        ...(expectNoHead ? { "x-abpn-expect-no-head": "true" } : {}),
      }),
      body: JSON.stringify(prepared),
    });
    if (!response.ok) {
      const details = await responseDetails(response, "Deck could not be saved to the cloud library.");
      const temporary = response.status === 429 || response.status >= 500 || Boolean(details.body?.localOnly);
      if (queueOnTemporaryFailure && temporary) {
        await queuePendingPackage(prepared, details.message, expectedHeadChecksum);
        return { ok: false, queued: true, localOnly: true, reason: details.message };
      }
      throw responseFailure(response, details);
    }
    await deleteRecord(STORES.META, pendingKey(prepared.bank.id));
    return response.json();
  } catch (error) {
    const permanent = Number(error?.status || 0) > 0 && Number(error.status) < 500 && Number(error.status) !== 429;
    if (queueOnTemporaryFailure && !permanent) {
      await queuePendingPackage(prepared, error.message, expectedHeadChecksum);
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
      if (record.deckId === STUDY_COACH_BANK_ID) {
        const result = await reconcileStudyCoachCloudDeck({
          fetchImpl,
          queueOnTemporaryFailure: false,
        });
        await deleteRecord(STORES.META, record.key);
        results.push({ deckId: record.deckId, status: "reconciled", result });
        continue;
      }
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

function installedBankPackage(bank) {
  return {
    format: QUESTION_BANK_PACKAGE_FORMAT,
    schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
    checksum: bank.checksum,
    bank,
  };
}

export async function reconcileStudyCoachCloudDeck({
  localBank = null,
  reservedIds = [],
  fetchImpl = globalThis.fetch.bind(globalThis),
  queueOnTemporaryFailure = true,
  retryOnConflict = true,
} = {}) {
  const local = localBank || await getRecord(STORES.BANK_CONTENT, STUDY_COACH_BANK_ID);
  const metadata = await listCloudDecks(fetchImpl);
  const remoteMetadata = metadata.find((deck) => deck.id === STUDY_COACH_BANK_ID) || null;
  if (!local && !remoteMetadata) return { status: "absent", bank: null };
  if (local?.checksum && local.checksum === remoteMetadata?.checksum) {
    return { status: "current", bank: local };
  }

  const remotePackage = remoteMetadata
    ? await prepareQuestionBankPackage(await fetchCloudDeckPackage(STUDY_COACH_BANK_ID, fetchImpl), { reservedIds })
    : null;
  const reconciliation = reconcileStudyCoachBanks({
    localBank: local,
    remoteBank: remotePackage?.bank || null,
  });

  if (reconciliation.status === "remote-ahead") {
    const installed = await installQuestionBankPackage(remotePackage, { reservedIds });
    return { ...reconciliation, status: "installed-cloud-superset", bank: installed.bank };
  }
  if (reconciliation.status === "current" || reconciliation.status === "absent") return reconciliation;

  const prepared = reconciliation.status === "merged"
    ? await prepareQuestionBankPackage({
      format: QUESTION_BANK_PACKAGE_FORMAT,
      schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
      bank: reconciliation.bank,
    }, { reservedIds })
    : installedBankPackage(reconciliation.bank);
  if (reconciliation.status === "merged") {
    await installQuestionBankPackage(prepared, { reservedIds });
  }

  try {
    const publication = await publishCloudDeckPackage(prepared, fetchImpl, {
      queueOnTemporaryFailure,
      expectedHeadChecksum: remoteMetadata?.checksum || "",
      expectNoHead: !remoteMetadata,
    });
    return {
      ...reconciliation,
      status: publication.queued ? "queued" : reconciliation.status === "merged" ? "merged-and-published" : "published-local-superset",
      bank: prepared.bank,
      publication,
    };
  } catch (error) {
    if (retryOnConflict && error?.status === 409) {
      return reconcileStudyCoachCloudDeck({
        localBank: await getRecord(STORES.BANK_CONTENT, STUDY_COACH_BANK_ID),
        reservedIds,
        fetchImpl,
        queueOnTemporaryFailure,
        retryOnConflict: false,
      });
    }
    throw error;
  }
}

export async function promoteLocallyInstalledDecks({
  reservedIds = [],
  authoritativeIds = [],
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  const [localDecks, remoteDecks] = await Promise.all([
    getAllRecords(STORES.BANK_CONTENT),
    listCloudDecks(fetchImpl),
  ]);
  const remoteById = new Map(remoteDecks.map((deck) => [deck.id, deck]));
  const authoritative = new Set(authoritativeIds);
  const results = [];

  for (const bank of localDecks) {
    if (reservedIds.includes(bank.id)) continue;
    if (bank.id === STUDY_COACH_BANK_ID) {
      results.push({ deckId: bank.id, status: "study-coach-reconciled-separately" });
      continue;
    }
    const remote = remoteById.get(bank.id);
    if (remote) {
      if (remote.checksum !== bank.checksum && authoritative.has(bank.id)) {
        const prepared = {
          format: QUESTION_BANK_PACKAGE_FORMAT,
          schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
          checksum: bank.checksum,
          bank,
        };
        const publication = await publishCloudDeckPackage(prepared, fetchImpl);
        results.push({
          deckId: bank.id,
          status: publication.queued ? "queued-authoritative-update" : "updated-authoritative",
          publication,
        });
        continue;
      }
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

export async function refreshCloudDeckLibrary({
  reservedIds = [],
  authoritativeIds = [],
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  const metadata = await listCloudDecks(fetchImpl);
  const authoritative = new Set(authoritativeIds);
  const results = [];

  for (const deck of metadata) {
    if (reservedIds.includes(deck.id)) {
      results.push({ id: deck.id, status: "reserved-skipped" });
      continue;
    }
    if (deck.id === STUDY_COACH_BANK_ID) {
      results.push({ id: deck.id, status: "study-coach-reconciled-separately" });
      continue;
    }
    try {
      const local = await getRecord(STORES.BANK_CONTENT, deck.id);
      if (local?.checksum === deck.checksum) {
        results.push({ id: deck.id, status: "current" });
        continue;
      }
      if (local && authoritative.has(deck.id)) {
        results.push({ id: deck.id, status: "local-authoritative" });
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
