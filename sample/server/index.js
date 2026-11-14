// Pocket Tasks HTTP API. Owned by Agent A in the Catalyst demo (task "api-create-task").
// In-memory only: tasks reset when the server restarts.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 4317;

function seedTasks() {
  return [
    { id: 1, title: 'Try Pocket Tasks', done: false },
    { id: 2, title: 'Pair two Claude Code sessions with Catalyst', done: true },
  ];
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Build the HTTP server (not listening yet). Each server has its own in-memory task list. */
export function createApp() {
  const tasks = seedTasks();

  return createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, tasks: tasks.length });
    }
    if (req.method === 'GET' && pathname === '/tasks') {
      return sendJson(res, 200, { tasks });
    }
    if (req.method === 'POST' && pathname === '/tasks') {
      // TODO(api-create-task, Agent A): implement task creation.
      // The exact JSON body shape and the auth header are NOT decided yet. Agree them through Catalyst:
      // publish the decision on topic "api/create-task" (publish_decision) BEFORE implementing, so that
      // Agent B's CLI `add` command can follow it. Then replace this 501 and the todo test in test/server.test.js.
      return sendJson(res, 501, { error: 'POST /tasks is not implemented yet (see Catalyst decision topic api/create-task)' });
    }
    return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  });
}

// Run directly: `npm start` or `node server/index.js` (PORT env var, default 4317).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`Pocket Tasks API listening on http://127.0.0.1:${port}`);
  });
}
