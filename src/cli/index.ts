#!/usr/bin/env node
/**
 * `catalyst` CLI. Heavy modules (zod, MCP SDK, node:sqlite, sync) are loaded lazily inside each action so that
 * `catalyst hook <event>` starts fast. Errors: one actionable line on stderr, exit 1 (hooks always exit 0).
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { networkInterfaces, userInfo } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Briefing, DashboardState, InviteResponse, PublishResult, StatusResponse, SyncSummary, FileWriteResponse, UpdatesResult } from '../core/api.js';
import { ensureDir, loadConfig, loadIdentity, readDaemonInfo, readJson, saveConfig, saveIdentity, type Identity, type ProjectConfig } from '../core/config.js';
import { findProjectDir, projectPaths, type ProjectPaths } from '../core/paths.js';
import type { CatalystClient } from '../client/index.js';

class CliError extends Error {}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/** Exit 0 once stdout is flushed (pipes are asynchronous on macOS; hook context must not be truncated). */
function exitAfterFlush(): void {
  process.stdout.write('', () => process.exit(0));
}

function fail(err: unknown): never {
  const e = err as Error & { hint?: string };
  const msg = e?.message ?? String(err);
  process.stderr.write(`catalyst: ${msg}${e?.hint ? ` — ${e.hint}` : ''}\n`);
  if (process.env.CATALYST_DEBUG === '1' && e?.stack) process.stderr.write(`${e.stack}\n`);
  process.exit(1);
}

function act<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail(err);
    }
  };
}

const out = (s = '') => process.stdout.write(`${s}\n`);

interface GlobalOpts {
  dir?: string;
}
function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

/** Existing project dir (walks up from cwd unless --dir is given). */
function projectDir(cmd: Command): string {
  const { dir } = globals(cmd);
  const found = findProjectDir(dir);
  if (!found) throw new CliError(`No Catalyst project at ${dir ? resolve(dir) : process.cwd()} (or any parent). Run \`catalyst init\` or \`catalyst join <invite>\` first.`);
  return found;
}

async function daemonClient(cmd: Command): Promise<CatalystClient> {
  const { CatalystClient } = await import('../client/index.js');
  const c = CatalystClient.forProject(projectDir(cmd), { client: 'cli', session: 'cli:human', timeoutMs: 15_000 });
  await c.connect();
  return c;
}

function intOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliError(`--${name} must be an integer between 0 and 65535 (got "${v}").`);
  return n;
}

function defaultName(): string {
  try {
    const n = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    if (n) return n.slice(0, 80);
  } catch {
    /* no git or no user.name */
  }
  return userInfo().username;
}

/** Persisted advertiseHosts: a loopback-bound peer listener is only reachable on 127.0.0.1; otherwise [] = auto-detect. */
function loopbackHosts(bind: string): string[] {
  return bind === '127.0.0.1' || bind === 'localhost' ? ['127.0.0.1'] : [];
}

function detectHosts(bind: string): string[] {
  if (loopbackHosts(bind).length) return loopbackHosts(bind);
  const hosts: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) hosts.push(a.address);
  }
  return hosts.length ? hosts : ['127.0.0.1'];
}

function formatAddr(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function freePort(bind: string): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, bind, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

function ago(iso: string | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function newIdentity(name: string, keys: { publicKey: string; privateKey: string }, participantId: string): Identity {
  return { participantId, name, publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/** gitignore, Claude setup and daemon start shared by init and join. */
async function finishSetup(paths: ProjectPaths, opts: { setup?: boolean; start?: boolean }): Promise<void> {
  const { ensureGitignore, setupClaude } = await import('../setup/claude.js');
  if (ensureGitignore(paths.projectDir)) out('Added .catalyst/ to .gitignore.');
  if (opts.setup !== false) {
    const { changes } = setupClaude(paths.projectDir);
    for (const c of changes) out(`Claude setup: ${c}`);
    if (!changes.length) out('Claude setup: already up to date.');
  }
  if (opts.start !== false) {
    const { startDaemon } = await import('../client/index.js');
    const { info } = await startDaemon(paths);
    out(`Daemon running (pid ${info.pid}, peer port ${info.peerPort}).`);
  }
}

function printPublish(r: { text?: string }): void {
  out(r.text ?? JSON.stringify(r, null, 2));
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command('catalyst');
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    /* unknown */
  }
  program
    .description('Connect two developers\' Claude Code sessions: shared goals, tasks, decisions, progress and questions.')
    .version(version)
    .option('--dir <projectDir>', 'project directory (default: nearest parent with .catalyst/)')
    .showHelpAfterError();

  program
    .command('init')
    .description('initialise Catalyst in this project (first developer)')
    .option('--name <name>', 'your display name (default: git user.name)')
    .option('--project-name <name>', 'project name (default: directory name)')
    .option('--peer-port <n>', 'peer listener port (default: free port chosen on first start)')
    .option('--peer-bind <addr>', 'peer listener bind address', '0.0.0.0')
    .option('--api-port <n>', 'loopback API port (default: random)')
    .option('--host <host...>', 'host/IP to advertise in invitations (default: auto-detect)')
    .option('--no-setup', 'skip Claude Code setup (.mcp.json, hooks, CLAUDE.md)')
    .option('--no-start', 'do not start the daemon')
    .action(
      act(async (opts: { name?: string; projectName?: string; peerPort?: string; peerBind: string; apiPort?: string; host?: string[]; setup: boolean; start: boolean }, cmd: Command) => {
        const dir = resolve(globals(cmd).dir ?? process.cwd());
        const paths = projectPaths(dir);
        if (existsSync(paths.config)) throw new CliError(`Already initialised (${paths.config} exists). Use \`catalyst status\`.`);
        const { generateKeyPair, participantIdFromPublicKey, newProjectId } = await import('../core/protocol.js');
        const peerPort = intOpt(opts.peerPort, 'peer-port') ?? 0;
        const apiPort = intOpt(opts.apiPort, 'api-port') ?? 0;
        ensureDir(paths.dataDir, 0o700);
        chmodSync(paths.dataDir, 0o700);
        const name = opts.name ?? defaultName();
        const keys = generateKeyPair();
        const participantId = participantIdFromPublicKey(keys.publicKey);
        saveIdentity(paths, newIdentity(name, keys, participantId));
        const config: ProjectConfig = {
          projectId: newProjectId(),
          projectName: opts.projectName ?? basename(dir),
          participantId,
          name,
          peerPort,
          peerBind: opts.peerBind,
          apiPort,
          advertiseHosts: opts.host ?? loopbackHosts(opts.peerBind),
          createdByMe: true,
          autoHandover: true,
          createdAt: new Date().toISOString(),
        };
        saveConfig(paths, config);
        out(`Initialised Catalyst project "${config.projectName}" (${config.projectId}) as ${name} (${participantId}).`);
        await finishSetup(paths, opts);
        out('');
        out('Next steps:');
        if (opts.start === false) out('  catalyst start              # start the local daemon');
        out('  catalyst pair               # create a single-use invitation for your teammate');
        out('  catalyst status             # check peer connection and confirmation code');
        out('  (restart Claude Code in this project so it loads the Catalyst MCP server and hooks)');
      }),
    );

  program
    .command('join <invite>')
    .description('join a teammate\'s project with a `catalyst pair` invitation (run in your checkout)')
    .option('--name <name>', 'your display name (default: git user.name)')
    .option('--peer-port <n>', 'peer listener port (default: a free port)')
    .option('--peer-bind <addr>', 'peer listener bind address', '0.0.0.0')
    .option('--host <host...>', 'host/IP to advertise to your peer (default: auto-detect)')
    .option('--no-setup', 'skip Claude Code setup')
    .option('--no-start', 'do not start the daemon')
    .action(
      act(async (token: string, opts: { name?: string; peerPort?: string; peerBind: string; host?: string[]; setup: boolean; start: boolean }, cmd: Command) => {
        const dir = resolve(globals(cmd).dir ?? process.cwd());
        const paths = projectPaths(dir);
        const { parseInvite, joinWithInvite } = await import('../sync/pairing.js');
        const invite = parseInvite(token.trim());
        const existing = readJson<ProjectConfig>(paths.config);
        if (existing && existing.projectId !== invite.project) {
          throw new CliError(`${dir} is already Catalyst project "${existing.projectName}" (${existing.projectId}); this invitation is for "${invite.projectName}". Join from a separate checkout or use --dir.`);
        }
        const { generateKeyPair, participantIdFromPublicKey } = await import('../core/protocol.js');
        let identity: Identity;
        if (existing) {
          identity = loadIdentity(paths);
        } else {
          const keys = generateKeyPair();
          identity = newIdentity(opts.name ?? defaultName(), keys, participantIdFromPublicKey(keys.publicKey));
        }
        const peerPort = intOpt(opts.peerPort, 'peer-port') || existing?.peerPort || (await freePort(opts.peerBind));
        const hosts = opts.host ?? (existing?.advertiseHosts.length ? existing.advertiseHosts : detectHosts(opts.peerBind));
        const { createLogger } = await import('../core/log.js');
        const logger = createLogger(null, 'join', process.env.CATALYST_DEBUG === '1' ? 'debug' : 'error');
        out(`Joining "${invite.projectName}" — invited by ${invite.inviter.name}; dialing ${invite.addrs.join(', ')} …`);
        const joined = await joinWithInvite(token.trim(), {
          identity: { participantId: identity.participantId, name: identity.name, publicKey: identity.publicKey },
          addrs: hosts.map((h) => formatAddr(h, peerPort)),
          logger,
        });
        ensureDir(paths.dataDir, 0o700);
        chmodSync(paths.dataDir, 0o700);
        if (!existing) {
          saveIdentity(paths, identity);
          saveConfig(paths, {
            projectId: joined.projectId,
            projectName: joined.projectName,
            participantId: identity.participantId,
            name: identity.name,
            peerPort,
            peerBind: opts.peerBind,
            apiPort: 0,
            advertiseHosts: opts.host ?? loopbackHosts(opts.peerBind),
            createdByMe: false,
            autoHandover: true,
            createdAt: new Date().toISOString(),
          });
        }
        const { loadSecrets, saveSecrets } = await import('../core/config.js');
        const secrets = loadSecrets(paths, joined.projectId);
        secrets.peers[joined.inviter.participantId] = joined.inviter;
        saveSecrets(paths, secrets);
        out(`Joined "${joined.projectName}" (${joined.projectId}) as ${identity.name} (${identity.participantId}); peer: ${joined.inviter.name}.`);
        out(`Confirmation code: ${joined.confirmCode}`);
        out(`Ask ${joined.inviter.name} to compare it with the code shown by \`catalyst status\` on their machine — they must match.`);
        if (existing) out('This checkout was already part of the project: kept your identity. Restart the daemon (`catalyst stop && catalyst start`) to dial the new peer.');
        await finishSetup(paths, opts);
      }),
    );

  program
    .command('start')
    .description('start the daemon in the background')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const { startDaemon, probeDaemon } = await import('../client/index.js');
        const paths = projectPaths(projectDir(cmd));
        const already = await probeDaemon(paths);
        const { info } = already ?? (await startDaemon(paths));
        out(`Catalyst daemon ${already ? 'already running' : 'started'} (pid ${info.pid}, api 127.0.0.1:${info.apiPort}, peer port ${info.peerPort}).`);
      }),
    );

  program
    .command('stop')
    .description('stop the daemon')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const { probeDaemon, CatalystClient } = await import('../client/index.js');
        const { pidAlive } = await import('../daemon/lifecycle.js');
        const paths = projectPaths(projectDir(cmd));
        const live = await probeDaemon(paths);
        const pid = live?.info.pid ?? readDaemonInfo(paths)?.pid;
        if (!pid || !pidAlive(pid)) {
          out('Catalyst daemon is not running.');
          return;
        }
        if (live) await new CatalystClient(paths, { client: 'cli' }).post('/api/shutdown').catch(() => undefined);
        const waitExit = async (ms: number) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 100));
          return !pidAlive(pid);
        };
        if (!(await waitExit(5000))) {
          process.kill(pid, 'SIGTERM');
          if (!(await waitExit(3000))) throw new CliError(`Daemon (pid ${pid}) did not exit; kill it manually: kill -9 ${pid}`);
        }
        out(`Catalyst daemon stopped (pid ${pid}).`);
      }),
    );

  program
    .command('status')
    .description('show project, daemon, peers, sessions, conflicts and files')
    .option('--json', 'print raw JSON')
    .action(act(async (opts: { json?: boolean }, cmd: Command) => statusCommand(cmd, Boolean(opts.json))));

  program
    .command('doctor')
    .description('check installation, files, daemon and Claude setup')
    .action(act(async (_opts: unknown, cmd: Command) => doctorCommand(cmd)));

  program
    .command('pair')
    .description('create a single-use invitation for your teammate')
    .option('--ttl <minutes>', 'invitation lifetime in minutes', '15')
    .option('--host <host...>', 'host/IP to advertise (default: auto-detect)')
    .action(
      act(async (opts: { ttl: string; host?: string[] }, cmd: Command) => {
        const ttlMinutes = Number(opts.ttl);
        if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new CliError('--ttl must be 1-1440 minutes.');
        const c = await daemonClient(cmd);
        const inv = await c.post<InviteResponse>('/api/invites', { ttlMinutes, ...(opts.host ? { hosts: opts.host } : {}) });
        out(`Invitation (single use, expires ${new Date(inv.expiresAt).toLocaleString()}):`);
        out('');
        out(`  ${inv.token}`);
        out('');
        out('Share it privately — it is a secret that grants access to this project.');
        out('Your teammate runs, in their own checkout of the project:');
        out(`  catalyst join ${inv.token.slice(0, 12)}… --name <their name>`);
        out(`Advertised addresses: ${inv.addrs.join(', ')} (wrong network? re-run with --host <your LAN IP>; allow inbound TCP on the peer port).`);
        out('After they join, both sides show a confirmation code (`catalyst status`); check that they match.');
      }),
    );

  const peer = program.command('peer').description('peer sync controls');
  peer
    .command('list')
    .description('list paired peers and their connection state')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const s = await (await daemonClient(cmd)).get<StatusResponse>('/api/status');
        printPeers(s.sync);
      }),
    );
  peer
    .command('pause')
    .description('pause peer networking (local writes continue and queue)')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const s = await (await daemonClient(cmd)).post<SyncSummary>('/api/peer/pause');
        out(s.freshness);
      }),
    );
  peer
    .command('resume')
    .description('resume peer networking and replay queued updates')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const s = await (await daemonClient(cmd)).post<SyncSummary>('/api/peer/resume');
        out(s.freshness);
      }),
    );
  peer
    .command('set-addr <participant> <addr...>')
    .description('set the host:port addresses to dial for a peer (participant id or name)')
    .action(
      act(async (participant: string, addrs: string[], _opts: unknown, cmd: Command) => {
        const c = await daemonClient(cmd);
        const s = await c.get<StatusResponse>('/api/status');
        const match = s.sync.peers.find((p) => p.participant === participant || p.name.toLowerCase() === participant.toLowerCase());
        if (!match) throw new CliError(`Unknown peer "${participant}". Known: ${s.sync.peers.map((p) => `${p.name} (${p.participant})`).join(', ') || 'none'}.`);
        const r = await c.post<SyncSummary>('/api/peer/addr', { participant: match.participant, addrs });
        out(`Addresses for ${match.name} set to ${addrs.join(', ')}.`);
        out(r.freshness);
      }),
    );

  program
    .command('dashboard')
    .description('open the local dashboard')
    .option('--no-open', 'only print the URL')
    .action(
      act(async (opts: { open: boolean }, cmd: Command) => {
        const { probeDaemon } = await import('../client/index.js');
        const live = await probeDaemon(projectPaths(projectDir(cmd)));
        if (!live) throw new CliError('Catalyst daemon is not running. Start it with `catalyst start`.');
        const url = `http://127.0.0.1:${live.info.apiPort}/#token=${live.info.token}`;
        out(url);
        if (opts.open) {
          const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
          const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
          child.on('error', () => process.stderr.write(`catalyst: could not run ${opener}; open the URL above manually.\n`));
          child.unref();
        }
      }),
    );

  program
    .command('handover')
    .description('regenerate the generated block in IMPORTANT.md')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const r = await (await daemonClient(cmd)).post<FileWriteResponse>('/api/handover');
        out(`${r.path}: ${r.changed ? 'updated' : 'already up to date'}.`);
      }),
    );

  program
    .command('snapshot')
    .description('regenerate .catalyst/snapshot.md/json (fallback for agents)')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const r = await (await daemonClient(cmd)).post<FileWriteResponse>('/api/snapshot');
        out(`${r.path}: ${r.changed ? 'updated' : 'already up to date'} (${r.generatedAt}).`);
      }),
    );

  program
    .command('briefing')
    .description('print the briefing an agent would get')
    .option('--task <task>')
    .option('--topic <topic>')
    .option('--paths <p...>')
    .option('--query <text>')
    .action(
      act(async (opts: { task?: string; topic?: string; paths?: string[]; query?: string }, cmd: Command) => {
        const r = await (await daemonClient(cmd)).tool<Briefing>('get_briefing', opts);
        out(r.text);
      }),
    );

  program
    .command('updates')
    .description('list peer updates')
    .option('--since <n>', 'cursor')
    .option('--limit <n>', 'max items (1-50)')
    .action(
      act(async (opts: { since?: string; limit?: string }, cmd: Command) => {
        const input: Record<string, number> = {};
        if (opts.since !== undefined) input.since = Number(opts.since);
        if (opts.limit !== undefined) input.limit = Number(opts.limit);
        const r = await (await daemonClient(cmd)).tool<UpdatesResult>('get_updates', input);
        out(r.text);
      }),
    );

  program
    .command('goal <title>')
    .description('set the shared project goal')
    .option('--description <text>')
    .option('--criteria <c...>', 'success criteria')
    .action(
      act(async (title: string, opts: { description?: string; criteria?: string[] }, cmd: Command) => {
        const r = await (await daemonClient(cmd)).tool<PublishResult>('set_goal', {
          title,
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.criteria ? { successCriteria: opts.criteria } : {}),
        });
        printPublish(r);
      }),
    );

  program
    .command('tool <name> <json>')
    .description('call a Catalyst tool as a human, e.g. catalyst tool publish_progress \'{"status":"done","summary":"…"}\'')
    .action(
      act(async (name: string, json: string, _opts: unknown, cmd: Command) => {
        let input: unknown;
        try {
          input = JSON.parse(json);
        } catch (err) {
          throw new CliError(`<json> is not valid JSON: ${(err as Error).message}`);
        }
        printPublish(await (await daemonClient(cmd)).tool<{ text?: string }>(name, input));
      }),
    );

  program
    .command('setup <target>')
    .description('install the Claude Code integration (target: claude)')
    .action(
      act(async (target: string, _opts: unknown, cmd: Command) => {
        if (target !== 'claude') throw new CliError(`Unknown setup target "${target}"; use \`catalyst setup claude\`.`);
        const { setupClaude, ensureGitignore } = await import('../setup/claude.js');
        const dir = projectDir(cmd);
        ensureGitignore(dir);
        const { changes } = setupClaude(dir);
        for (const c of changes) out(c);
        if (!changes.length) out('Claude Code integration already up to date.');
      }),
    );

  program
    .command('uninstall <target>')
    .description('remove the Claude Code integration (target: claude); keeps .catalyst/ data')
    .action(
      act(async (target: string, _opts: unknown, cmd: Command) => {
        if (target !== 'claude') throw new CliError(`Unknown uninstall target "${target}"; use \`catalyst uninstall claude\`.`);
        const { uninstallClaude } = await import('../setup/claude.js');
        const { changes } = uninstallClaude(projectDir(cmd));
        for (const c of changes) out(c);
        out('To delete all Catalyst data for this project: catalyst stop && rm -rf .catalyst');
      }),
    );

  program
    .command('daemon')
    .description('run the daemon in the foreground (used by `catalyst start`)')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const { runDaemon, DaemonAlreadyRunningError } = await import('../daemon/main.js');
        try {
          const h = await runDaemon(projectDir(cmd), { signals: true });
          process.stderr.write(`catalyst daemon listening: api 127.0.0.1:${h.apiPort}, peer port ${h.peerPort}\n`);
        } catch (err) {
          if (err instanceof DaemonAlreadyRunningError) {
            process.stderr.write(`catalyst: ${err.message}\n`);
            process.exit(0);
          }
          throw err;
        }
      }),
    );

  program
    .command('mcp')
    .description('run the stdio MCP server (started by Claude Code via .mcp.json)')
    .action(
      act(async (_opts: unknown, cmd: Command) => {
        const { runMcpServer } = await import('../mcp/server.js');
        await runMcpServer(globals(cmd).dir);
      }),
    );

  program
    .command('hook <event>')
    .description('Claude Code hook entry (always exits 0)')
    .action(async (event: string, _opts: unknown, cmd: Command) => {
      try {
        const { runHook } = await import('../hooks/entry.js');
        const { dir } = globals(cmd);
        await runHook(event, dir ? { dir } : {});
      } catch {
        /* hooks never fail the session */
      }
      exitAfterFlush();
    });

  await program.parseAsync(process.argv);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
function printPeers(sync: SyncSummary): void {
  out(`Sync:    ${sync.freshness}`);
  if (!sync.peers.length) {
    out('Peers:   none paired (`catalyst pair`)');
    return;
  }
  out('Peers:');
  for (const p of sync.peers) {
    const since = p.since ? ` since ${new Date(p.since).toLocaleString()}` : '';
    out(`  - ${p.name} (${p.participant}): ${p.state}${since} · last sync ${ago(p.lastSyncAt)} · ${p.pendingOutbound} pending`);
    out(`    addrs: ${p.addrs.join(', ') || '(none)'}${p.confirmCode ? ` · confirmation code ${p.confirmCode}` : ''}`);
    if (p.lastError && p.state !== 'connected') out(`    last error: ${p.lastError}`);
  }
}

async function statusCommand(cmd: Command, json: boolean): Promise<void> {
  const dir = projectDir(cmd);
  const paths = projectPaths(dir);
  const config = loadConfig(paths);
  const { probeDaemon, CatalystClient } = await import('../client/index.js');
  const live = await probeDaemon(paths);
  if (!live) {
    if (json) {
      out(JSON.stringify({ running: false, config }, null, 2));
      return;
    }
    out(`Project: ${config.projectName} (${config.projectId})`);
    out(`Me:      ${config.name} (${config.participantId})`);
    out('Daemon:  not running — start it with `catalyst start`');
    return;
  }
  const c = new CatalystClient(paths, { client: 'cli', session: 'cli:human' });
  const s = await c.get<StatusResponse>('/api/status');
  const state = s.counts.conflicts > 0 ? await c.get<DashboardState>('/api/state') : null;
  if (json) {
    out(JSON.stringify({ running: true, ...s, conflicts: state?.state.conflicts ?? [] }, null, 2));
    return;
  }
  const h = s.health;
  out(`Project: ${config.projectName} (${h.projectId})`);
  out(`Me:      ${h.name} (${h.participantId})`);
  out(`Daemon:  running · pid ${h.pid} · api 127.0.0.1:${h.apiPort} · peer port ${h.peerPort} · up since ${new Date(h.startedAt).toLocaleString()}`);
  printPeers(s.sync);
  if (s.sync.parkedEvents) out(`         ${s.sync.parkedEvents} received event(s) parked waiting for missing earlier events`);
  out(`Events:  ${s.counts.events} (${s.counts.ownEvents} mine, ${s.counts.peerEvents} from peers) · ${s.counts.unacknowledged} unacknowledged`);
  if (s.sessions.length) {
    out('Sessions:');
    for (const x of s.sessions) {
      out(`  - ${x.id} (${x.kind}${x.linkedSession ? `, linked ${x.linkedSession}` : ''}) · last seen ${ago(x.lastSeenAt)} · last retrieval ${ago(x.lastRetrievalAt)}`);
    }
  } else out('Sessions: none yet');
  out(`Conflicts: ${s.counts.conflicts}`);
  for (const cf of state?.state.conflicts ?? []) out(`  - ${cf.scope} \`${cf.key}\`: ${cf.heads.map((hd) => `${hd.authorName}: ${hd.summary}`).join(' vs ')}`);
  if (s.counts.forks) out(`Forks:   ${s.counts.forks} — an identity was used from two checkouts; see \`catalyst doctor\``);
  out(`Inbox:   ${s.inbox.pending} pending · ${s.inbox.imported} imported · ${s.inbox.rejected} rejected${s.inbox.rejected ? ` (see ${paths.inboxRejected})` : ''}`);
  out(`Snapshot: ${s.snapshot.path} (${s.snapshot.generatedAt ? ago(s.snapshot.generatedAt) : 'not written yet'})`);
  out(`Handover: ${s.handover.path} (${s.handover.generatedAt ? ago(s.handover.generatedAt) : 'not written yet'})`);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function doctorCommand(cmd: Command): Promise<void> {
  let failed = 0;
  const check = (ok: boolean, label: string, fix?: string) => {
    out(`${ok ? '✓' : '✗'} ${label}${!ok && fix ? `\n    fix: ${fix}` : ''}`);
    if (!ok) failed++;
  };
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  check(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node} (need ≥ 22.13)`, 'install Node 22.13 or newer');

  const { dir } = globals(cmd);
  const found = findProjectDir(dir);
  check(Boolean(found), found ? `project config: ${join(found, '.catalyst', 'config.json')}` : 'project config found', 'run `catalyst init` or `catalyst join <invite>` in the project root');
  if (!found) {
    process.exit(1);
  }
  const paths = projectPaths(found);
  const config = loadConfig(paths);

  for (const [label, file] of [
    ['identity.json', paths.identity],
    ['secrets.json', paths.secrets],
    ['daemon.json', paths.daemonInfo],
  ] as const) {
    if (!existsSync(file)) {
      if (label === 'identity.json') check(false, `${label} exists`, 'identity is missing; re-run `catalyst init` in a fresh checkout');
      continue;
    }
    const mode = statSync(file).mode & 0o777;
    check(mode === 0o600, `${label} mode ${mode.toString(8)} (need 600)`, `chmod 600 ${file}`);
  }

  const gi = existsSync(join(found, '.gitignore')) ? readFileSync(join(found, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()) : [];
  check(['.catalyst/', '.catalyst', '/.catalyst/', '/.catalyst'].some((l) => gi.includes(l)), '.catalyst/ is in .gitignore', 'run `catalyst setup claude` (adds it) or add `.catalyst/` to .gitignore');

  const { probeDaemon, CatalystClient } = await import('../client/index.js');
  const live = await probeDaemon(paths);
  check(Boolean(live), live ? `daemon healthy (pid ${live.info.pid}, nonce verified)` : 'daemon running and healthy', 'run `catalyst start`; see .catalyst/logs/daemon.log');
  if (live) {
    const c = new CatalystClient(paths, { client: 'cli' });
    try {
      const v = await c.get<{ projection: { ok: boolean; detail?: string }; forks: unknown[] }>('/api/verify');
      check(v.projection.ok, `projection reproducible from the event log${v.projection.detail ? ` (${v.projection.detail})` : ''}`, 'report this bug; restart the daemon to rebuild the projection');
      check(v.forks.length === 0, `no fork alarms (${v.forks.length})`, 'the same identity was used in two checkouts; give each checkout its own `catalyst init`/`join`');
    } catch (err) {
      check(false, `projection check failed: ${(err as Error).message}`);
    }
    const host = config.peerBind === '0.0.0.0' || config.peerBind === '::' ? '127.0.0.1' : config.peerBind;
    const listening = await new Promise<boolean>((res) => {
      const sock = connect({ host, port: live.info.peerPort, timeout: 1000 }, () => {
        sock.destroy();
        res(true);
      });
      sock.on('error', () => res(false));
      sock.on('timeout', () => {
        sock.destroy();
        res(false);
      });
    });
    check(listening, `peer port ${live.info.peerPort} listening on ${config.peerBind}`, 'check .catalyst/logs/daemon.log; another process may hold the port (`catalyst init --peer-port`)');
  } else {
    out('  (skipped projection and peer-port checks: daemon not running)');
  }

  const mcp = readJsonSafe(join(found, '.mcp.json')) as { mcpServers?: Record<string, unknown> } | null;
  check(Boolean(mcp?.mcpServers?.catalyst), '.mcp.json has mcpServers.catalyst', 'run `catalyst setup claude`');
  const settings = readJsonSafe(join(found, '.claude', 'settings.json'));
  check(JSON.stringify(settings ?? {}).includes('catalyst hook'), '.claude/settings.json has Catalyst hooks', 'run `catalyst setup claude`');

  const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => {
    try {
      accessSync(join(d, 'catalyst'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  check(onPath, '`catalyst` is on PATH (needed by hooks and .mcp.json)', 'run `npm link` in the Catalyst checkout (or `npm i -g`), then restart your shell');

  const rejected = existsSync(paths.inboxRejected) ? readdirSync(paths.inboxRejected).filter((f) => f.endsWith('.json')).length : 0;
  check(rejected === 0, `no rejected inbox drafts (${rejected})`, `read the .error.txt files in ${paths.inboxRejected}, fix and move drafts back to ${paths.inbox}`);

  out(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  if (failed) process.exit(1);
}

function readJsonSafe(path: string): unknown {
  try {
    return readJson<unknown>(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch (last, so every module-level const above is initialised).
// Fast path for hooks: no commander parsing, always exit 0.
// ---------------------------------------------------------------------------
if (process.argv[2] === 'hook') {
  const args = process.argv.slice(3);
  const dirAt = args.indexOf('--dir');
  const dir = dirAt >= 0 ? args[dirAt + 1] : undefined;
  const event = args.find((a, i) => !a.startsWith('--') && (dirAt < 0 || (i !== dirAt + 1))) ?? '';
  import('../hooks/entry.js')
    .then((m) => m.runHook(event, dir ? { dir } : {}))
    .catch(() => undefined)
    .finally(exitAfterFlush);
} else {
  void main();
}
