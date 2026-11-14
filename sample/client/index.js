// Pocket Tasks CLI client. Owned by Agent B in the Catalyst demo (task "client-add-command").
// Usage: node client/index.js list
// Server URL: POCKET_TASKS_URL, else http://127.0.0.1:$PORT (default 4317).
import { pathToFileURL } from 'node:url';

export function serverUrl(env = process.env) {
  return env.POCKET_TASKS_URL ?? `http://127.0.0.1:${env.PORT ?? 4317}`;
}

export function formatTask(task) {
  return `#${task.id} [${task.done ? 'x' : ' '}] ${task.title}`;
}

export async function listTasks(baseUrl) {
  const res = await fetch(`${baseUrl}/tasks`);
  if (!res.ok) throw new Error(`GET /tasks failed: HTTP ${res.status}`);
  const { tasks } = await res.json();
  return tasks;
}

const USAGE = 'Usage:\n  node client/index.js list\n  node client/index.js add "<title>"   (not implemented yet)';

export async function main(argv, env = process.env) {
  const [command] = argv;
  const baseUrl = serverUrl(env);

  if (command === 'list') {
    const tasks = await listTasks(baseUrl);
    console.log(tasks.length ? tasks.map(formatTask).join('\n') : 'No tasks yet.');
    return 0;
  }
  if (command === 'add') {
    // TODO(client-add-command, Agent B): implement `add "<title>"`.
    // It must send POST /tasks exactly as decided on Catalyst topic "api/create-task" (body shape + auth
    // header). Retrieve that decision first (get_briefing / get_updates); do not guess the format.
    console.error('`add` is not implemented yet: follow the Catalyst decision on topic api/create-task.');
    return 2;
  }
  console.error(USAGE);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`Error: ${err.message}. Is the server running? (npm start)`);
      process.exitCode = 1;
    },
  );
}
