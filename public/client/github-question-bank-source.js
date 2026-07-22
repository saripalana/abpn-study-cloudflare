import { MAX_QUESTION_BANK_FILE_BYTES } from "./question-bank-import.js";

const STANDARD_PACKAGE_NAMES = [
  "abpn-question-bank.json",
  "question-bank.json",
  "bank.json",
];

function unique(values) {
  return [...new Set(values)];
}

function rawUrl(owner, repository, ref, path) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${ref}/${path}`;
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

  const host = url.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com") {
    if (!url.pathname.toLowerCase().endsWith(".json")) {
      throw new Error("The raw GitHub address must point to a JSON question-bank package.");
    }
    return [url.toString()];
  }

  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error("Use a github.com or raw.githubusercontent.com address.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("The GitHub address must identify a repository or JSON file.");

  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!owner || !repository) throw new Error("The GitHub repository address is incomplete.");

  if (["blob", "raw"].includes(parts[2]) && parts.length >= 5) {
    const ref = parts[3];
    const path = parts.slice(4).join("/");
    if (!path.toLowerCase().endsWith(".json")) {
      throw new Error("The GitHub file address must point to a JSON question-bank package.");
    }
    return [rawUrl(owner, repository, ref, path)];
  }

  if (parts[2] === "tree" && parts.length >= 4) {
    const ref = parts[3];
    const directory = parts.slice(4).join("/");
    return STANDARD_PACKAGE_NAMES.map((name) => rawUrl(
      owner,
      repository,
      ref,
      directory ? `${directory}/${name}` : name,
    ));
  }

  if (parts.length === 2) {
    return unique(["main", "master"].flatMap((ref) =>
      STANDARD_PACKAGE_NAMES.map((name) => rawUrl(owner, repository, ref, name))
    ));
  }

  throw new Error([
    "Use either a direct GitHub JSON-file link or the repository's main address.",
    "A repository import looks for abpn-question-bank.json, question-bank.json, or bank.json at the repository root.",
  ].join(" "));
}

function packageFile(text, sourceUrl) {
  const name = new URL(sourceUrl).pathname.split("/").pop() || "github-question-bank.json";
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

export async function fetchGithubQuestionBankFile(address, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This browser cannot retrieve GitHub packages.");
  const candidates = githubQuestionBankCandidates(address);
  const failures = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, {
        method: "GET",
        cache: "no-store",
        redirect: "follow",
        headers: { Accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
      });
      if (!response.ok) {
        failures.push(`${response.status} ${candidate}`);
        continue;
      }

      const declaredLength = Number(response.headers?.get?.("content-length") || 0);
      if (declaredLength > MAX_QUESTION_BANK_FILE_BYTES) {
        throw new Error("The GitHub question-bank package exceeds the 25 MiB safety limit.");
      }

      const text = await response.text();
      const size = new TextEncoder().encode(text).byteLength;
      if (size > MAX_QUESTION_BANK_FILE_BYTES) {
        throw new Error("The GitHub question-bank package exceeds the 25 MiB safety limit.");
      }
      if (!text.trim() || /^\s*</.test(text)) {
        failures.push(`Not JSON ${candidate}`);
        continue;
      }

      return { file: packageFile(text, candidate), sourceUrl: candidate };
    } catch (error) {
      if (/25 MiB/.test(String(error?.message))) throw error;
      failures.push(`${error?.message || "Fetch failed"} ${candidate}`);
    }
  }

  throw new Error([
    "No compatible ABPN question-bank package was found at that GitHub address.",
    "Paste a direct JSON-file link, or place abpn-question-bank.json, question-bank.json, or bank.json at the repository root.",
    "You can also bring the GitHub address back to ChatGPT so the repository can be reviewed and packaged safely.",
  ].join(" "));
}
