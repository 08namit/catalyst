import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { formatTask, listTasks, serverUrl } from '../client/index.js';

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('serverUrl prefers POCKET_TASKS_URL, then PORT', () => {
  assert.equal(serverUrl({ POCKET_TASKS_URL: 'http://x:1' }), 'http://x:1');
  assert.equal(serverUrl({ PORT: '5000' }), 'http://127.0.0.1:5000');
  assert.equal(serverUrl({}), 'http://127.0.0.1:4317');
});

test('list fetches tasks from the server', async () => {
  const tasks = await listTasks(base);
  assert.ok(tasks.length >= 1);
  assert.match(formatTask(tasks[0]), /^#\d+ \[( |x)\] .+/);
});

// Expected behaviour, to be implemented by Agent B (task "client-add-command"):
//   `node client/index.js add "<title>"` sends POST /tasks exactly as decided on Catalyst topic
//   "api/create-task" (body shape + auth header), then prints the created task.
test.todo('client add "<title>" follows the Catalyst decision api/create-task');
