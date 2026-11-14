import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('GET /health reports ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /tasks returns the in-memory task list', async () => {
  const res = await fetch(`${base}/tasks`);
  assert.equal(res.status, 200);
  const { tasks } = await res.json();
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length >= 1);
  for (const t of tasks) {
    assert.equal(typeof t.id, 'number');
    assert.equal(typeof t.title, 'string');
    assert.equal(typeof t.done, 'boolean');
  }
});

test('unknown routes return 404 JSON', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

// Expected behaviour, to be implemented by Agent A (task "api-create-task"):
//   POST /tasks with the body shape and auth header published on Catalyst topic "api/create-task"
//   creates a task, responds with a 2xx status, and the new task then appears in GET /tasks.
//   Requests without valid auth, or with an invalid body, are rejected with 4xx.
// Replace this todo with real assertions once the decision is published.
test.todo('POST /tasks creates a task as specified by the Catalyst decision api/create-task');
