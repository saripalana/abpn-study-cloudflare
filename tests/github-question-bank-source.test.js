import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchGithubQuestionBankFile,
  githubQuestionBankCandidates,
} from "../public/client/github-question-bank-source.js";

test("converts a GitHub blob JSON link to a raw package link", () => {
  assert.deepEqual(
    githubQuestionBankCandidates("https://github.com/example/repo/blob/main/packages/bank.json"),
    ["https://raw.githubusercontent.com/example/repo/main/packages/bank.json"],
  );
});

test("repository links search standard package names on main and master", () => {
  const candidates = githubQuestionBankCandidates("https://github.com/example/repo");
  assert.equal(candidates.length, 6);
  assert.equal(candidates[0], "https://raw.githubusercontent.com/example/repo/main/abpn-question-bank.json");
  assert.ok(candidates.includes("https://raw.githubusercontent.com/example/repo/master/bank.json"));
});

test("rejects non-GitHub and non-JSON direct file links", () => {
  assert.throws(
    () => githubQuestionBankCandidates("https://example.com/question-bank.json"),
    /github\.com/i,
  );
  assert.throws(
    () => githubQuestionBankCandidates("https://github.com/example/repo/blob/main/README.md"),
    /JSON/i,
  );
});

test("fetches the first compatible repository package as a file-like object", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!url.endsWith("/question-bank.json")) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ format: "abpn-question-bank" }),
    };
  };

  const result = await fetchGithubQuestionBankFile("https://github.com/example/repo", fetchImpl);
  assert.equal(result.sourceUrl, "https://raw.githubusercontent.com/example/repo/main/question-bank.json");
  assert.match(await result.file.text(), /abpn-question-bank/);
  assert.equal(calls.length, 2);
});

test("returns a manual-integration message when a repository has no package", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => "",
  });

  await assert.rejects(
    fetchGithubQuestionBankFile("https://github.com/example/unpackaged", fetchImpl),
    /bring the GitHub address back to ChatGPT/i,
  );
});
