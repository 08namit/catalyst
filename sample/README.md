# Pocket Tasks: Catalyst demo app

A deliberately tiny app with two halves, so two developers (and their Claude Code sessions) can split the
work and coordinate through Catalyst. It has its own `package.json` and no dependencies, and it is separate
from Catalyst itself.

```
sample/
  server/index.js   HTTP API (node:http, in-memory tasks)   owned by Agent A
  client/index.js   CLI client                              owned by Agent B
  test/*.test.js    node:test tests
```

## Run

Requires Node.js 22.13 or later.

```sh
cd sample
npm start                      # API on http://127.0.0.1:4317 (override with PORT=...)
node client/index.js list      # in another terminal; uses POCKET_TASKS_URL or PORT
npm test                       # node --test
```

Baseline features: `GET /health`, `GET /tasks`, and `client list`. Unknown routes return 404 JSON.

## The demo work (deliberately not implemented)

| Catalyst task id     | Owner   | What                                                         |
|----------------------|---------|--------------------------------------------------------------|
| `api-create-task`    | Agent A | `POST /tasks` in `server/index.js` (currently returns 501)   |
| `client-add-command` | Agent B | `node client/index.js add "<title>"` in `client/index.js`    |

The request format is decided through Catalyst, not in this README:

1. **Agent A** claims `api-create-task` and publishes a decision on the topic **`api/create-task`**. The
   decision specifies the exact JSON body shape of `POST /tasks`, the auth header, and the response.
   Agent A then implements it.
2. **Agent B** claims `client-add-command`, retrieves the `api/create-task` decision (briefing or updates),
   and implements `add` to match it exactly. If the decision isn't there yet, Agent B asks a question
   through Catalyst instead of guessing.
3. If both publish different versions on the topic, Catalyst flags a conflict until someone resolves it.

The `TODO(api-create-task)` and `TODO(client-add-command)` markers show where the code goes. Each
`test.todo` in `test/` describes the expected behaviour; replace it with real assertions as part of the task.
