// Verify additive schema upgrade and the actual Worker push/pull SQL in SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';

test('tutor state survives Worker sync; additive migration preserves existing answers', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql') && !f.startsWith('0013')).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
    const DB = { async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }, prepare(sql) {
      const statement = db.prepare(sql);
      let values = [];
      return { bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { statement.run(...values); return { success: true }; } };
    }};
    const env = { DB, APP_RELEASE_MODE: 'full', CLOUD_SYNC_ENABLED: 'true', STUDY_USER_ID: 'tutor-test-user' };
    const headers = { 'x-abpn-device-id': 'tutor-test-device', 'content-type': 'application/json' };
    const request = async (path, body) => {
      const response = await worker.fetch(new Request(`https://study.example/api/sync/${path}`, { headers: { ...headers, 'x-abpn-device-id': body ? 'tutor-test-device' : 'tutor-other-device' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }), env);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    // Seed an existing completed record before applying the additive change.
    const now = new Date().toISOString();
    const name = 'Test · Flagged AND Wrong · Subjects: ' + Array(20).fill('Synthetic source section').join(', ');
    await request('push', { changes: [{ id: 'set', entityType: 'practiceSet', operation: 'upsert', payload: {
      id: 'test-set', bankId: 'test-bank', mode: 'tutor', status: 'completed', submitted: true,
      questionIds: ['q1'], name, revision: 1, updatedAt: now,
    } }] });
    db.exec("INSERT INTO practice_set_answers (set_id, question_id, selected_answer, is_correct, time_ms, revision, updated_at) VALUES ('test-set', 'q1', 'B', 1, 1200, 1, '2026-09-06T00:00:00Z')");
    const before = db.prepare('SELECT * FROM practice_set_answers').get();
    db.exec(readFileSync(new URL('0013_tutor_answer_state.sql', directory), 'utf8'));
    const { tutor_state_json, ...after } = db.prepare('SELECT * FROM practice_set_answers').get();
    assert.deepEqual(after, { ...before });
    assert.equal(tutor_state_json, null);
    for (const [index, state] of [
      { finalized: false, progressRecorded: false, progressTimeMs: 0 },
      { finalized: true, progressRecorded: true, progressTimeMs: 1500 },
      { finalized: false, progressRecorded: true, progressTimeMs: 1500 },
    ].entries()) {
      const result = await request('push', { changes: [{ id: `answer-${index}`, entityType: 'practiceSetAnswer', operation: 'upsert', payload: {
        setId: 'test-set', questionId: 'q1', selectedAnswer: index === 2 ? null : 'B', isCorrect: index === 2 ? null : true,
        timeMs: 1500, revision: index + 2, updatedAt: now, ...state,
      } }] });
      assert.deepEqual(result.conflicts, []);
      const pull = await request('pull');
      assert.equal(pull.changes.find(change => change.entityType === 'practiceSet').payload.name, name);
      const answer = pull.changes.find(change => change.entityType === 'practiceSetAnswer').payload;
      for (const key of Object.keys(state)) assert.equal(answer[key], state[key]);
    }
  } finally { db.close(); }
});
