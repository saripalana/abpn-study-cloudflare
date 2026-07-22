import { MAX_QUESTION_BANK_FILE_BYTES } from "./question-bank-import.js";
import { convertLegacySpiegelScript } from "./legacy-spiegel-import.js";

const STANDARD_PACKAGE_NAMES = [
  "abpn-question-bank.json",
  "question-bank.json",
  "bank.json",
];
const LEGACY_SPIEGEL_FILENAME = "data.js";

function unique(values) {
  return [...new Set(values)];
}

function rawUrl(owner, repository, ref, path) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${ref}/${path}`;
}

function acceptedFilePath(path) {
  const normalized = String(path || "").toLowerCase();
  return normalized.endsWith(".json") || normalized.endsWith(`/${LEGACY_SPIEGEL_FILENAME}`) || normalized === LEGACY_SPIEGEL_FILENAME;
}

function repositoryCandidates(owner, repository, refs = ["main", "master"], directory = "") {
  const prefix = directory ? `${directory.replace(/\/$/, "")}/` : "";
  return unique(refs.flatMap((ref) => [
    ...STANDARD_PACKAGE_NAMES.map((name) => rawUrl(owner, repository, ref, `${prefix}${name}`)),
    rawUrl(owner, repository, ref, `${prefix}${LEGACY_SPIEGEL_FILENAME}`),
  ]));
}

function githubPagesCandidates(url) {
  const match = /^([a-z0-9-]+)\.github\.io$/i.exec(url.hostname);
  if (!match) return null;
  const owner = match[1];
  const parts = url.pathname.split("/").filter(Boolean);
  const repository = parts[0] || `${owner}.github.io`;
  const directory = parts.slice(1).join("/");
  return unique(["main", "master"].flatMap((ref) => [
    rawUrl(owner, repository, ref, directory ? `${directory}/${LEGACY_SPIEGEL_FILENAME}` : LEGACY_SPIEGEL_FILENAME),
    ...STANDARD_PACKAGE_NAMES.map((name) => rawUrl(owner, repository, ref, directory ? `${directory}/${name}` : name)),
  ]));
}

export function githubQuestionBankCandidates(address) {
  const value = String(address || "").trim();
  if (!value) throw new Error("Paste a GitHub address first.");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a complete GitHub address beginning with https://.");
  }

  if (url.protocol !== "https:") throw new Error("Only secure https:// GitHub addresses are accepted.");

  const pagesCandidates = githubPagesCandidates(url);
  if (pagesCandidates) return pagesCandidates;

  const host = url.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com") {
    if (!acceptedFilePath(url.pathname)) {
      throw new Error("The raw GitHub address must point to a JSON question-bank package or a legacy data.js file.");
    }
    return [url.toString()];
  }

  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error("Use a github.com, github.io, or raw.githubusercontent.com address.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("The GitHub address must identify a repository or supported question-bank file.");

  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!owner || !repository) throw new Error("The GitHub repository address is incomplete.");

  if (["blob", "raw"].includes(parts[2]) && parts.length >= 5) {
    const ref = parts[3];
    const path = parts.slice(4).join("/");
    if (!acceptedFilePath(path)) {
      throw new Error("The GitHub file address must point to a JSON question-bank package or a legacy data.js file.");
    }
    return [rawUrl(owner, repository, ref, path)];
  }

  if (parts[2] === "tree" && parts.length >= 4) {
    const ref = parts[3];
    const directory = parts.slice(4).join("/");
    return repositoryCandidates(owner, repository, [ref], directory);
  }

  if (parts.length === 2) return repositoryCandidates(owner, repository);

  throw new Error([
    "Use a direct GitHub JSON/data.js file link, a repository address, or its github.io study-site address.",
    "Repository imports look for standard JSON packages and the legacy Spiegel data.js format.",
  ].join(" "));
}

function packageFile(text, sourceUrl, filename = null) {
  const name = filename || new URL(sourceUrl).pathname.split("/").pop() || "github-question-bank.json";
  if (typeof File === "function") {
    return new File([text], name, { type: "application/json" });
  }
  return {
    name,
    size: new TextEncoder().encode(text).byteLength,
    type: "application/json",
    text: async () => text,
  };
}

function isLegacySpiegelCandidate(candidate) {
  return new URL(candidate).pathname.toLowerCase().endsWith(`/${LEGACY_SPIEGEL_FILENAME}`);
}

export async function fetchGithubQuestionBankFile(address, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This browser cannot retrieve GitHub packages.");
  const candidates = githubQuestionBankCandidates(address);
  const failures = [];

  for (const candidate of candidates) {
    try {
      const legacy = isLegacySpiegelCandidate(candidate);
      const response = await fetchImpl(candidate, {
        method: "GET",
        cache: "no-store",
        redirect: "follow",
        headers: { Accept: legacy ? "text/javascript,text/plain;q=0.9,*/*;q=0.1" : "application/json,text/plain;q=0.9,*/*;q=0.1" },
      });
      if (!response.ok) {
        failures.push(`${response.status} ${candidate}`);
        continue;
      }

      const declaredLength = Number(response.headers?.get?.("content-length") || 0);
      if (declaredLength > MAX_QUESTION_BANK_FILE_BYTES) {
        throw new Error("The GitHub question-bank source exceeds the 25 MiB safety limit.");
      }

      const text = await response.text();
      const size = new TextEncoder().encode(text).byteLength;
      if (size > MAX_QUESTION_BANK_FILE_BYTES) {
        throw new Error("The GitHub question-bank source exceeds the 25 MiB safety limit.");
      }
      if (!text.trim() || /^\s*</.test(text)) {
        failures.push(`Not a supported data file ${candidate}`);
        continue;
      }

      if (legacy) {
        const converted = await convertLegacySpiegelScript(text, candidate);
        return {
          file: packageFile(JSON.stringify(converted), candidate, "spiegel-test-prep.abpn-question-bank.json"),
          sourceUrl: candidate,
          convertedFromLegacy: true,
        };
      }

      return { file: packageFile(text, candidate), sourceUrl: candidate, convertedFromLegacy: false };
    } catch (error) {
      if (/25 MiB/.test(String(error?.message))) throw error;
      failures.push(`${error?.message || "Fetch failed"} ${candidate}`);
    }
  }

  throw new Error([
    "No compatible question-bank data was found at that GitHub address.",
    "The importer supports an ABPN JSON package or the legacy Spiegel data.js format used by dancingremote/spiegel-test-prep.",
    "You can bring another GitHub address back to ChatGPT when its data uses a different structure.",
  ].join(" "));
}
