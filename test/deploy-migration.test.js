import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const rootUrl = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, rootUrl), "utf8"));
}

const appliedMigrationSha256 = {
  "0001_initial.sql": "fd84dcb348c3f2941fccb09023425baa86a8fce2561c431ab72c1c57021f5e39",
  "0002_sync_usage_guardrails.sql": "39281243a8084ab45fdeed168a736b4df6ae7ec1ec6b4c56c0f7b1cced8b5502",
  "0003_complete_study_sync.sql": "edc5bb3d8092d8cb78b0d3ff0a7ee7793ce9d7ebb80c46816b01e4aed63a6b0a",
  "0004_cloud_deck_library.sql": "2dd140134cc71ff481532581b646532c49a2bbde9ecaf87513abbe73efddff8b",
  "0005_immutable_deck_revisions.sql": "3fd5a8afecd039bae164ac549cf3bbac8b92499e184c505848d774068a0c67ee",
  "0006_deck_library_bootstrap.sql": "391c19b5263f6f07f135913b571a8abde6ff091e1bf8249fe22a0d9e8fd19c0c",
  "0007_assistant_weakness_staging.sql": "939a1ec5d372a16ad1b65e4fac70915f5cf00120c2165a36b12a5fc3608ce24b",
  "0008_assistant_weakness_delete_count.sql": "81485a26747984a41c3c29244c2ede6ab32a984c99b5776c6dc2fb6e30cfe871",
  "0009_complete_recovery_bundles.sql": "cee792b2f4f3068cd7cc45f51d77018a504fc0897b9f77574fe3dcc765d87a05",
  "0010_study_coach_consent.sql": "7dc9e7f4fe2344d943a36aed76ae776e43d13eeae5feffe82c79e11e0c2645d7",
  "0011_study_coach_cloud_exchange.sql": "5c901d1fa7bd7a0249c4707e1155972946ea9fd8a36864411b68b17c6ceb87cc",
};

async function readMigrations() {
  const migrationsUrl = new URL("migrations/", rootUrl);
  const names = (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, migrationsUrl), "utf8"),
  })));
}

function applyMigrations(database, migrations) {
  for (const { sql } of migrations) database.exec(sql);
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

test("already-applied D1 migrations retain their verified byte identities", async () => {
  const migrations = await readMigrations();
  const byName = new Map(migrations.map(({ name, sql }) => [name, sql]));

  for (const [name, expected] of Object.entries(appliedMigrationSha256)) {
    const sql = byName.get(name);
    assert.ok(sql, `Applied migration ${name} must remain present`);
    const actual = createHash("sha256").update(sql).digest("hex");
    assert.equal(actual, expected, `${name} is immutable after application; add a new migration instead`);
  }
});

test("0012 upgrades the verified 0011 schema without losing existing rows", async () => {
  const migrations = await readMigrations();
  const through0011 = migrations.filter(({ name }) => name <= "0011_study_coach_cloud_exchange.sql");
  const migration0012 = migrations.find(({ name }) => name === "0012_study_coach_exchange_consent_and_audit.sql");
  assert.ok(migration0012, "The additive 0012 migration must be tracked");

  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database, through0011);
    database.exec(`
      INSERT INTO users (id, created_at, updated_at)
      VALUES ('upgrade-user', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z');
      INSERT INTO assistant_weakness_permissions (user_id, enabled, granted_at, consent_version)
      VALUES ('upgrade-user', 1, '2026-08-21T00:00:00Z', 2);
      INSERT INTO assistant_study_coach_artifacts
        (id, user_id, artifact_type, created_at, byte_count, chunk_count, primary_timestamp, metadata_json)
      VALUES
        ('upgrade-artifact', 'upgrade-user', 'package', '2026-08-21T00:00:00Z', 2, 1, '2026-08-21T00:00:00Z', '{}');
      INSERT INTO assistant_study_coach_artifact_chunks (artifact_id, chunk_index, chunk_text)
      VALUES ('upgrade-artifact', 0, '{}');
    `);

    database.exec(migration0012.sql);

    const permission = database.prepare(`
      SELECT enabled, consent_version, exchange_consent_version,
        exchange_publish_count, exchange_access_count
      FROM assistant_weakness_permissions
      WHERE user_id = 'upgrade-user'
    `).get();
    assert.deepEqual({ ...permission }, {
      enabled: 1,
      consent_version: 2,
      exchange_consent_version: 0,
      exchange_publish_count: 0,
      exchange_access_count: 0,
    });
    assert.equal(
      database.prepare("SELECT chunk_text FROM assistant_study_coach_artifact_chunks WHERE artifact_id = 'upgrade-artifact'").get().chunk_text,
      "{}"
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM assistant_study_coach_exchange_audit").get().count,
      0
    );
  } finally {
    database.close();
  }
});

test("a fresh database applies every tracked D1 migration in order", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database, await readMigrations());
    const permissionColumns = database
      .prepare("PRAGMA table_info(assistant_weakness_permissions)")
      .all()
      .map(({ name }) => name);
    for (const column of [
      "exchange_consent_version",
      "exchange_granted_at",
      "exchange_publish_count",
      "exchange_access_count",
      "last_exchange_accessed_at",
    ]) {
      assert.ok(permissionColumns.includes(column), `Fresh schema must include ${column}`);
    }
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_study_coach_exchange_audit'").get().count,
      1
    );
  } finally {
    database.close();
  }
});

test("tracked D1 migration contains the required empty study schema", async () => {
  const migrations = await readMigrations();
  assert.ok(migrations.length > 0, "At least one tracked SQL migration is required");
  const sql = migrations.map(({ sql }) => sql).join("\n");

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
