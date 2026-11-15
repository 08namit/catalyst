/**
 * Pure, deterministic projection of the event set into ProjectState.
 * Order is (lc, author, seq) — never ts — so every replica holding the same events computes the same state.
 * Heads model: an event is a head of its family if no other event of that family lists it in `supersedes`.
 */
import {
  LEAD_AGENT,
  MATERIAL_TYPES,
  PROTOCOL_VERSION,
  agentOf,
  compareEvents,
  isKnownType,
  ownerKey,
  type CatalystEvent,
  type PayloadOf,
} from '../core/protocol.js';
import type {
  ActivityView,
  AgentView,
  ClaimView,
  ConflictView,
  DecisionView,
  ForkAlarm,
  GoalVersion,
  IssueView,
  MessageView,
  ParticipantView,
  ProgressView,
  ProjectState,
  QuestionView,
  SourceRef,
  TaskView,
  TopicView,
} from '../core/state.js';

export function sortEvents(events: CatalystEvent[]): CatalystEvent[] {
  return [...events].sort((a, b) => compareEvents(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function headsOf<T extends CatalystEvent>(family: T[]): T[] {
  const superseded = new Set(family.flatMap((e) => e.supersedes));
  return family.filter((e) => !superseded.has(e.id));
}

function short(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function project(events: CatalystEvent[], me: string, forks: ForkAlarm[] = []): ProjectState {
  const sorted = sortEvents(events);
  const known = sorted.filter((e) => e.v <= PROTOCOL_VERSION && isKnownType(e.type));

  // Participants first, so every SourceRef can carry a display name.
  const participants: ParticipantView[] = [];
  const names = new Map<string, string>();
  for (const e of known) {
    if (e.type !== 'participant.joined' || names.has(e.author)) continue;
    const p = e.payload as PayloadOf<'participant.joined'>;
    names.set(e.author, p.name);
    participants.push({ id: e.author, name: p.name, publicKey: p.publicKey, role: p.role, joinedAt: e.ts, isMe: e.author === me });
  }
  const nameOf = (id: string) => names.get(id) ?? id;

  // Agents: latest agent.registered per (author, agent) wins; any agent that authored an event is known too.
  // The lead is always named "lead" and displayed as the participant itself.
  const registrations = new Map<string, { participant: string; agent: string; p?: PayloadOf<'agent.registered'> }>();
  for (const id of names.keys()) registrations.set(ownerKey(id, LEAD_AGENT), { participant: id, agent: LEAD_AGENT });
  for (const e of known) {
    const agent = agentOf(e);
    const key = ownerKey(e.author, agent);
    const entry = registrations.get(key) ?? { participant: e.author, agent };
    if (e.type === 'agent.registered' && agent !== LEAD_AGENT) entry.p = e.payload as PayloadOf<'agent.registered'>;
    registrations.set(key, entry);
  }
  const agentShortName = (participant: string, agent: string) =>
    agent === LEAD_AGENT ? LEAD_AGENT : (registrations.get(ownerKey(participant, agent))?.p?.name ?? agent.slice(0, 8));
  const agentName = (participant: string, agent: string) =>
    agent === LEAD_AGENT ? nameOf(participant) : `${nameOf(participant)} / ${agentShortName(participant, agent)}`;
  const ref = (e: CatalystEvent): SourceRef => ({
    id: e.id,
    author: e.author,
    authorName: nameOf(e.author),
    seq: e.seq,
    ts: e.ts,
    origin: e.origin,
    agent: agentOf(e),
    agentName: agentName(e.author, agentOf(e)),
  });
  const position = new Map(known.map((e, i) => [e.id, i]));

  let projectInfo: ProjectState['project'] = null;

  // Families
  const goalFamily: CatalystEvent[] = [];
  const goalVersions = new Map<string, GoalVersion>();
  interface TaskBuilder {
    taskId: string;
    title?: string;
    description?: string;
    paths: string[];
    createdBy?: SourceRef;
    claimFamily: CatalystEvent[];
    /** Latest progress per ownerKey (author/agent). */
    progressByAgent: Map<string, ProgressView>;
    /** Runtime-only task recovery checkpoints, kept separate so they cannot reopen completed work. */
    checkpointsByAgent: Map<string, ProgressView>;
    dependsOn: string[];
    assignee: string;
    explicitOrder?: number;
    /** Index of the first task.created among tasks (deterministic order). */
    createdIndex?: number;
  }
  const tasks = new Map<string, TaskBuilder>();
  const task = (taskId: string): TaskBuilder => {
    let t = tasks.get(taskId);
    if (!t) {
      t = { taskId, paths: [], claimFamily: [], progressByAgent: new Map(), checkpointsByAgent: new Map(), dependsOn: [], assignee: 'any' };
      tasks.set(taskId, t);
    }
    return t;
  };
  const claimViews = new Map<string, ClaimView>();
  const topics = new Map<string, { family: CatalystEvent[]; views: Map<string, DecisionView> }>();
  const topic = (key: string) => {
    let t = topics.get(key);
    if (!t) {
      t = { family: [], views: new Map() };
      topics.set(key, t);
    }
    return t;
  };
  const questions = new Map<string, QuestionView>();
  const notifications: MessageView[] = [];
  const issues = new Map<string, IssueView>();
  const activity: ActivityView[] = [];
  const generalProgress = new Map<string, ProgressView>();
  const acknowledgements: Record<string, string[]> = {};
  const agentAcknowledgements: Record<string, string[]> = {};
  let createdCount = 0;
  let lastMaterial: SourceRef | null = null;

  for (const e of known) {
    if (MATERIAL_TYPES.has(e.type)) lastMaterial = ref(e);
    switch (e.type) {
      case 'project.created': {
        const p = e.payload as PayloadOf<'project.created'>;
        if (!projectInfo) projectInfo = { id: e.project, name: p.name, description: p.description };
        break;
      }
      case 'goal.set': {
        const p = e.payload as PayloadOf<'goal.set'>;
        goalFamily.push(e);
        goalVersions.set(e.id, { ...ref(e), title: p.title, description: p.description, successCriteria: p.successCriteria ?? [] });
        break;
      }
      case 'task.created': {
        const p = e.payload as PayloadOf<'task.created'>;
        const t = task(p.taskId);
        t.title = p.title;
        t.description = p.description;
        t.paths = p.paths ?? [];
        t.dependsOn = p.dependsOn ?? [];
        t.assignee = p.assignee ?? 'any';
        t.explicitOrder = p.order;
        t.createdBy ??= ref(e);
        t.createdIndex ??= createdCount++;
        break;
      }
      case 'task.claimed': {
        const p = e.payload as PayloadOf<'task.claimed'>;
        task(p.taskId).claimFamily.push(e);
        claimViews.set(e.id, {
          ...ref(e),
          taskId: p.taskId,
          owner: e.author,
          ownerName: agentName(e.author, agentOf(e)),
          ownerAgent: agentOf(e),
          ownerKey: ownerKey(e.author, agentOf(e)),
          scope: p.scope,
          paths: p.paths ?? [],
          note: p.note,
          viaResolution: false,
        });
        break;
      }
      case 'task.released': {
        const p = e.payload as PayloadOf<'task.released'>;
        task(p.taskId).claimFamily.push(e);
        break;
      }
      case 'decision.recorded': {
        const p = e.payload as PayloadOf<'decision.recorded'>;
        const t = topic(p.topic);
        t.family.push(e);
        t.views.set(e.id, {
          ...ref(e),
          topic: p.topic,
          title: p.title,
          decision: p.decision,
          rationale: p.rationale,
          status: p.status,
          codeRefs: p.codeRefs ?? [],
          alternatives: p.alternatives ?? [],
          supersedes: e.supersedes,
          refs: e.refs,
        });
        break;
      }
      case 'progress.reported': {
        const p = e.payload as PayloadOf<'progress.reported'>;
        const view: ProgressView = {
          ...ref(e),
          taskId: p.taskId,
          status: p.status,
          summary: p.summary,
          blockers: p.blockers ?? [],
          evidence: p.evidence ?? [],
          nextSteps: p.nextSteps ?? [],
          branch: p.branch,
          commit: p.commit,
        };
        const key = ownerKey(e.author, agentOf(e));
        if (p.taskId) task(p.taskId).progressByAgent.set(key, view);
        else generalProgress.set(key, view);
        break;
      }
      case 'task.checkpoint': {
        const p = e.payload as PayloadOf<'task.checkpoint'>;
        const key = ownerKey(e.author, agentOf(e));
        const view: ProgressView = {
          ...ref(e),
          taskId: p.taskId,
          status: p.status,
          summary: p.summary,
          blockers: p.blockers ?? [],
          evidence: p.evidence ?? [],
          nextSteps: p.nextSteps ?? [],
          branch: p.branch,
          commit: p.commit,
          runtimeOnly: true,
        };
        task(p.taskId).checkpointsByAgent.set(key, view);
        break;
      }
      case 'issue.reported': {
        const p = e.payload as PayloadOf<'issue.reported'>;
        if (p.taskId) task(p.taskId);
        issues.set(e.id, { ...ref(e), kind: p.kind, title: p.title, detail: p.detail, taskId: p.taskId, status: 'open' });
        break;
      }
      case 'issue.resolved': {
        const p = e.payload as PayloadOf<'issue.resolved'>;
        const issue = issues.get(p.issueId);
        if (issue) {
          issue.status = 'resolved';
          issue.resolution = { ...ref(e), note: p.note };
        }
        break;
      }
      case 'message.posted': {
        const p = e.payload as PayloadOf<'message.posted'>;
        const m: MessageView = { ...ref(e), kind: p.kind, body: p.body, to: p.to, replyTo: p.replyTo, refs: e.refs };
        if (p.kind === 'question') questions.set(e.id, { ...m, replies: [], answered: false });
        else if (p.kind === 'notification') notifications.push(m);
        else if (p.replyTo) {
          const q = questions.get(p.replyTo);
          if (q) {
            q.replies.push(m);
            q.answered = true;
          }
        }
        break;
      }
      case 'conflict.resolved': {
        const p = e.payload as PayloadOf<'conflict.resolved'>;
        if (p.scope === 'goal') {
          const chosen = p.chosen ? goalVersions.get(p.chosen) : undefined;
          goalFamily.push(e);
          goalVersions.set(e.id, {
            ...ref(e),
            title: chosen?.title ?? short(p.resolution, 200),
            description: p.resolution,
            successCriteria: chosen?.successCriteria ?? [],
          });
        } else if (p.scope === 'decision') {
          const t = topic(p.key);
          const chosen = p.chosen ? t.views.get(p.chosen) : undefined;
          t.family.push(e);
          t.views.set(e.id, {
            ...ref(e),
            topic: p.key,
            title: chosen?.title ?? `Resolved: ${p.key}`,
            decision: p.resolution,
            rationale: chosen?.rationale ?? 'Resolved by agreement (conflict.resolved).',
            status: 'resolved',
            codeRefs: chosen?.codeRefs ?? [],
            alternatives: [],
            supersedes: e.supersedes,
            refs: e.refs,
          });
        } else {
          const t = task(p.key);
          t.claimFamily.push(e);
          if (p.owner) {
            const chosen = p.chosen ? claimViews.get(p.chosen) : undefined;
            const ownerAgent = p.ownerAgent ?? LEAD_AGENT;
            claimViews.set(e.id, {
              ...ref(e),
              taskId: p.key,
              owner: p.owner,
              ownerName: agentName(p.owner, ownerAgent),
              ownerAgent,
              ownerKey: ownerKey(p.owner, ownerAgent),
              scope: p.resolution,
              paths: chosen?.paths ?? [],
              viaResolution: true,
            });
          }
        }
        break;
      }
      case 'ack.recorded': {
        const p = e.payload as PayloadOf<'ack.recorded'>;
        for (const id of p.eventIds) {
          const list = (acknowledgements[id] ??= []);
          if (!list.includes(e.author)) list.push(e.author);
          const byAgent = (agentAcknowledgements[id] ??= []);
          const key = ownerKey(e.author, agentOf(e));
          if (!byAgent.includes(key)) byAgent.push(key);
        }
        break;
      }
      case 'activity.captured': {
        const p = e.payload as PayloadOf<'activity.captured'>;
        activity.push({ ...ref(e), kind: p.kind, summary: p.summary, commits: p.commits ?? [], paths: p.paths ?? [] });
        break;
      }
    }
  }

  // Goal
  const goalHeads = headsOf(goalFamily).map((e) => goalVersions.get(e.id)!);
  const goal = { current: goalHeads.at(-1) ?? null, heads: goalHeads, conflict: goalHeads.length > 1 };

  // Issues
  const issueList = [...issues.values()];

  // Tasks
  const taskViews: TaskView[] = [...tasks.values()].map((t) => {
    const claims = headsOf(t.claimFamily)
      .map((e) => claimViews.get(e.id))
      .filter((c): c is ClaimView => c !== undefined);
    const owners = [...new Set(claims.map((c) => c.owner))];
    const ownerKeys = [...new Set(claims.map((c) => c.ownerKey))];
    const progress = [...t.progressByAgent.values()];
    const latestProgress = [...progress, ...t.checkpointsByAgent.values()].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    const blockers = [
      ...latestProgress.flatMap((p) => p.blockers),
      ...issueList.filter((i) => i.taskId === t.taskId && i.kind === 'blocker' && i.status === 'open').map((i) => i.title),
    ];
    return {
      taskId: t.taskId,
      title: t.title ?? t.taskId,
      description: t.description,
      paths: t.paths,
      createdBy: t.createdBy,
      claims,
      owners,
      ownerKeys,
      latestProgress,
      status: progress.sort((a, b) => position.get(a.id)! - position.get(b.id)!).at(-1)?.status ?? (claims.length > 0 ? 'claimed' : 'unclaimed'),
      openBlockers: [...new Set(blockers)],
      claimConflict: ownerKeys.length > 1,
      dependsOn: t.dependsOn,
      assignee: t.assignee,
      // Tasks never posted with task.created sort after every posted one.
      order: t.explicitOrder ?? t.createdIndex ?? createdCount++,
      ready: false,
    };
  });
  const statusById = new Map(taskViews.map((t) => [t.taskId, t.status]));
  for (const t of taskViews) {
    t.ready = t.createdBy !== undefined && t.dependsOn.every((d) => statusById.get(d) === 'done');
  }

  // Agents (deterministic: participant in join order, lead first, then name, then key)
  const joinRank = (id: string) => {
    const i = participants.findIndex((p) => p.id === id);
    return i === -1 ? participants.length : i;
  };
  const agents: AgentView[] = [...registrations.values()]
    .map(({ participant, agent, p }) => {
      const address = ownerKey(participant, agent);
      const view: AgentView = {
        participant,
        participantName: nameOf(participant),
        agent,
        address,
        name: agentShortName(participant, agent),
        displayName: agentName(participant, agent),
        active: p?.active !== false,
        isMe: participant === me,
        claims: taskViews.filter((t) => t.ownerKeys.includes(address)).map((t) => t.taskId),
      };
      if (p?.agentType !== undefined) view.agentType = p.agentType;
      return view;
    })
    .sort(
      (x, y) =>
        joinRank(x.participant) - joinRank(y.participant) ||
        cmp(x.participant, y.participant) ||
        Number(y.agent === LEAD_AGENT) - Number(x.agent === LEAD_AGENT) ||
        cmp(x.name, y.name) ||
        cmp(x.agent, y.agent),
    );

  // Decisions
  const decisions: TopicView[] = [...topics.entries()].map(([key, t]) => {
    const history = t.family.map((e) => t.views.get(e.id)!);
    const heads = headsOf(t.family).map((e) => t.views.get(e.id)!);
    return { topic: key, heads, history, conflict: heads.length > 1 };
  });

  // Conflicts
  const conflicts: ConflictView[] = [];
  if (goal.conflict) {
    conflicts.push({
      scope: 'goal',
      key: 'goal',
      heads: goal.heads.map((g) => ({ ...pickRef(g), summary: short(g.title) })),
      hint: "Agree on one goal with your peer, then call resolve_conflict {scope:'goal', key:'goal', resolution:'…', chosen:'<event id>'}.",
    });
  }
  for (const d of decisions) {
    if (!d.conflict) continue;
    conflicts.push({
      scope: 'decision',
      key: d.topic,
      heads: d.heads.map((h) => ({ ...pickRef(h), summary: short(`[${h.status}] ${h.title}: ${h.decision}`, 300) })),
      hint: `Agree with your peer, then call resolve_conflict {scope:'decision', key:'${d.topic}', resolution:'…'}.`,
    });
  }
  for (const t of taskViews) {
    if (!t.claimConflict) continue;
    conflicts.push({
      scope: 'claim',
      key: t.taskId,
      heads: t.claims.map((c) => ({ ...pickRef(c), summary: short(`${c.ownerName} claims ${t.taskId}: ${c.scope}`, 300) })),
      hint: `Agree who owns the task, then call resolve_conflict {scope:'claim', key:'${t.taskId}', owner:'<name or name/agent>', resolution:'…'} (or one side calls release_task).`,
    });
  }

  return {
    project: projectInfo,
    me,
    participants,
    agents,
    goal,
    tasks: taskViews,
    decisions,
    conflicts,
    questions: [...questions.values()],
    notifications,
    issues: issueList,
    generalProgress: [...generalProgress.values()].sort((a, b) => position.get(a.id)! - position.get(b.id)!),
    activity: activity.reverse().slice(0, 50),
    acknowledgements,
    agentAcknowledgements,
    forks,
    lastMaterial,
    eventCount: sorted.length,
    opaqueCount: sorted.length - known.length,
  };
}

function pickRef(r: SourceRef): SourceRef {
  return { id: r.id, author: r.author, authorName: r.authorName, seq: r.seq, ts: r.ts, origin: r.origin, agent: r.agent, agentName: r.agentName };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
