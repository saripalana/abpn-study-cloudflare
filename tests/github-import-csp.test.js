import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const accessWorkerPath = new URL("../src/access-worker.js", import.meta.url);
const applicationWorkerPath = new URL("../src/worker.js", import.meta.url);

test("GitHub question-bank imports allow only raw.githubusercontent.com through CSP", async () => {
  const [accessSource, applicationSource] = await Promise.all([
    readFile(accessWorkerPath, "utf8"),
    readFile(applicationWorkerPath, "utf8"),
  ]);

  assert.match(applicationSource, /connect-src 'self'/);
  assert.match(accessSource, /connect-src 'self' https:\/\/raw\.githubusercontent\.com/);
  assert.doesNotMatch(accessSource, /connect-src[^\n]*https:\/\/github\.com/);
  assert.doesNotMatch(accessSource, /connect-src[^\n]*\*/);
});
