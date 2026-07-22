import test from "node:test";
import assert from "node:assert/strict";
import { convertLegacySpiegelScript } from "../public/client/legacy-spiegel-import.js";
import { prepareQuestionBankPackage } from "../public/client/question-bank-import.js";

const sourceUrl = "https://raw.githubusercontent.com/dancingremote/spiegel-test-prep/main/data.js";

test("the current public Spiegel source converts all 1,060 questions without storing the source", async () => {
  const response = await fetch(sourceUrl, { headers: { Accept: "text/javascript,text/plain" } });
  assert.equal(response.ok, true, `Could not retrieve the public Spiegel source: ${response.status}`);
  const converted = await convertLegacySpiegelScript(await response.text(), sourceUrl);
  const prepared = await prepareQuestionBankPackage(converted, {
    reservedIds: ["ks-psychiatry-core", "validation-bank"],
  });
  assert.equal(prepared.bank.id, "spiegel-test-prep");
  assert.equal(prepared.bank.questions.length, 1060);
  assert.equal(new Set(prepared.bank.questions.map((question) => question.id)).size, 1060);
  assert.ok(prepared.bank.questions.some((question) => question.vignetteStem));
  assert.ok(prepared.bank.questions.some((question) => question.isMultiSelect));
});
