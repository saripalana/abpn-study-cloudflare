import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchGithubQuestionBankFile,
  githubQuestionBankCandidates,
} from "../public/client/github-question-bank-source.js";

const legacySource = `const QUESTIONS = \uFEFF${JSON.stringify([{
  id: "legacy-q1",
  section: "Vignette 1",
  sectionType: "vignette",
  vignetteStem: "A patient presents for evaluation.",
  question: "Select the two correct findings.",
  choices: ["Finding one", "Distractor", "Finding two"],
  choiceLetters: ["A", "B", "C"],
  correctLetters: ["A", "C"],
  isMultiSelect: true,
  explanation: "A and C are correct.",
}])};`;

test("converts a GitHub blob JSON link to a raw package link", () => {
  assert.deepEqual(
    githubQuestionBankCandidates("https://github.com/example/repo/blob/main/packages/bank.json"),
    ["https://raw.githubusercontent.com/example/repo/main/packages/bank.json"],
  );
});

test("repository links search standard packages and legacy data.js on main and master", () => {
  const candidates = githubQuestionBankCandidates("https://github.com/example/repo");
  assert.equal(candidates.length, 8);
  assert.equal(candidates[0], "https://raw.githubusercontent.com/example/repo/main/abpn-question-bank.json");
  assert.ok(candidates.includes("https://raw.githubusercontent.com/example/repo/main/data.js"));
  assert.ok(candidates.includes("https://raw.githubusercontent.com/example/repo/master/bank.json"));
});

test("maps the Spiegel GitHub Pages address directly to its legacy repository data", () => {
  const candidates = githubQuestionBankCandidates("https://dancingremote.github.io/spiegel-test-prep/");
  assert.equal(candidates[0], "https://raw.githubusercontent.com/dancingremote/spiegel-test-prep/main/data.js");
  assert.ok(candidates.includes("https://raw.githubusercontent.com/dancingremote/spiegel-test-prep/master/data.js"));
});

test("rejects non-GitHub and unsupported direct file links", () => {
  assert.throws(
    () => githubQuestionBankCandidates("https://example.com/question-bank.json"),
    /github\.com/i,
  );
  assert.throws(
    () => githubQuestionBankCandidates("https://github.com/example/repo/blob/main/README.md"),
    /JSON.*data\.js/i,
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
  assert.equal(result.convertedFromLegacy, false);
  assert.equal(calls.length, 2);
});

test("converts the legacy Spiegel GitHub Pages data.js source into a package", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: url.endsWith("/main/data.js"),
      status: url.endsWith("/main/data.js") ? 200 : 404,
      headers: { get: () => null },
      text: async () => url.endsWith("/main/data.js") ? legacySource : "",
    };
  };

  const result = await fetchGithubQuestionBankFile("https://dancingremote.github.io/spiegel-test-prep/", fetchImpl);
  const converted = JSON.parse(await result.file.text());
  assert.equal(result.convertedFromLegacy, true);
  assert.equal(result.sourceUrl, "https://raw.githubusercontent.com/dancingremote/spiegel-test-prep/main/data.js");
  assert.equal(converted.bank.id, "spiegel-test-prep");
  assert.equal(converted.bank.questions[0].isMultiSelect, true);
  assert.deepEqual(converted.bank.questions[0].correctLetters, ["A", "C"]);
  assert.equal(calls.length, 1);
});

test("returns manual-integration guidance when a repository has no supported data", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => "",
  });

  await assert.rejects(
    fetchGithubQuestionBankFile("https://github.com/example/unpackaged", fetchImpl),
    /different structure/i,
  );
});
