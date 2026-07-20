import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const rootUrl = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, rootUrl), "utf8"));
}

test("production deployment verifies, applies pending remote D1 migrations, then deploys", async () => {
  const packageJson = await readJson("package.json");
  const scripts = packageJson.scripts || {};

  assert.equal(
    scripts["db:migrate:remote"],
    "wrangler d1 migrations apply abpn-study-db --remote"
  );
  assert.equal(
    scripts.deploy,
    "npm run verify && npm run db:migrate:remote && wrangler deploy"
  );
  assert.match(scripts.verify, /wrangler deploy --dry-run/);
  assert.doesNotMatch(scripts.verify, /db:migrate:remote|migrations apply .*--remote/);
});

test("tracked D1 migration contains the required empty study schema", async () => {
  const migrationsUrl = new URL("migrations/", rootUrl);
  const migrationFiles = (await readdir(migrationsUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  assert.ok(migrationFiles.length > 0, "At least one tracked SQL migration is required");
  const sql = (await Promise.all(
    migrationFiles.map((name) => readFile(new URL(name, migrationsUrl), "utf8"))
  )).join("\n");

  for (const table of [
    "users",
    "devices",
    "question_banks",
    "question_progress",
    "practice_sets",
    "practice_set_answers",
    "sync_changes",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }

  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|DATABASE)\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
});
