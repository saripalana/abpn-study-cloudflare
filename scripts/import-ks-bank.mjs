import { createHash } from "node:crypto";
import { parseLegacyQuestionsArray } from "../public/client/legacy-spiegel-import.js";

const source = Object.freeze({
  repository: "saripalana/ks-study-guide",
  commit: "4d03f158c6fbfacd698796d94c213a49ac8a377d",
  path: "data.js",
  expectedGitBlobSha: "f4180d69a4a6bbd8a7f764bb88e7f2f404f7431f",
  expectedQuestionCount: 602,
});

const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
const response = await fetch(url, { headers: { "user-agent": "abpn-study-cloudflare-deck-verification" } });
if (!response.ok) throw new Error(`Unable to retrieve pinned K&S source: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const gitBlobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
if (gitBlobSha !== source.expectedGitBlobSha) {
  throw new Error(`K&S source hash mismatch: expected ${source.expectedGitBlobSha}, received ${gitBlobSha}`);
}

const questions = parseLegacyQuestionsArray(bytes.toString("utf8"), "K&S data.js");
if (questions.length !== source.expectedQuestionCount) {
  throw new Error(`K&S count mismatch: expected ${source.expectedQuestionCount}, received ${questions.length}`);
}

const ids = new Set();
for (const [index, question] of questions.entries()) {
  const id = String(question?.id || "");
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  const letters = Array.isArray(question?.choiceLetters) ? question.choiceLetters : [];
  if (!id || ids.has(id)) throw new Error(`Missing or duplicate K&S question id at index ${index}: ${id}`);
  if (!String(question?.question || "").trim()) throw new Error(`K&S question ${id} has no prompt`);
  if (choices.length < 2 || choices.length !== letters.length) throw new Error(`K&S question ${id} has invalid choices`);
  if (!letters.includes(String(question?.correctLetter || ""))) throw new Error(`K&S question ${id} has an invalid correct answer`);
  ids.add(id);
}

console.log(`Verified ${questions.length} K&S questions from the external pinned deck source; no K&S content was generated into this repository.`);
