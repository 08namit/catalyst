/**
 * Projection output types: a pure function of the event set (see src/store/projections.ts).
 * Shared by briefing, dashboard (/api/state), handover (IMPORTANT.md) and snapshot.
 */
import type { EventRefs, Origin } from './protocol.js';

/** Compact reference to a source event, included in every view so agents can cite source IDs. */
export interface SourceRef {
  id: string;
  author: string;
  authorName: string;
  seq: number;
  /** Display timestamp from the author's clock. */
  ts: string;
  origin: Origin;
  /** Agent key inside `author` (LEAD_AGENT when the event has none). */
  agent: string;
  /** Display name: "<authorName>" for the lead, "<authorName> / <agent name>" for subagents. */
  agentName: string;
}

/** One agent of one participant (from agent.registered + any event it authored). */
export interface AgentView {
  participant: string;
  participantName: string;
  /** Agent key (ID_PATTERNS.agent). */
  agent: string;
  /** "participant/agent" (ownerKey). */
  address: string;
  /** Short name, e.g. "api" or "general-purpose-2"; "lead" for the main session. */
  name: string;
  /** "<participantName> / <name>" (just participantName for the lead). */
  displayName: string;
  agentType?: string;
  /** false once an agent.registered with active:false is the latest for this agent. */
  active: boolean;
  isMe: boolean;
  /** Task ids this agent currently holds a live claim on. */
  claims: string[];
}

export interface ParticipantView {
  id: string;
  name: string;
  publicKey: string;
  role?: string;
  joinedAt: string;
  isMe: boolean;
}

export interface GoalVersion extends SourceRef {
  title: string;
  description?: string;
  successCriteria: string[];
}

export interface ClaimView extends SourceRef {
  taskId: string;
  /** Owning participant. */
  owner: string;
  /** Owning participant's display name plus agent, e.g. "Tiam / api". */
  ownerName: string;
  /** Owning agent key inside `owner` (for resolutions: payload.ownerAgent). */
  ownerAgent: string;
  /** ownerKey(owner, ownerAgent). */
  ownerKey: string;
  scope: string;
  paths: string[];
  note?: string;
  /** true when this head came from a conflict.resolved event assigning the owner */
  viaResolution: boolean;
}

export interface ProgressView extends SourceRef {
  /** Recovery checkpoint: share through Catalyst runtime, never export its content to project handover files. */
  runtimeOnly?: boolean;
  taskId?: string;
  status: string;
  summary: string;
  blockers: string[];
  evidence: string[];
  nextSteps: string[];
  branch?: string;
  commit?: string;
}

export interface TaskView {
  taskId: string;
  title: string;
  description?: string;
  paths: string[];
  createdBy?: SourceRef;
  /** Live claim heads (not superseded / released). >1 distinct ownerKey ⇒ conflict. */
  claims: ClaimView[];
  /** Distinct owning participants. */
  owners: string[];
  /** Distinct owning agents (ownerKey "participant/agent"). */
  ownerKeys: string[];
  /** Latest progress per (author, agent) (deterministic order), newest last. */
  latestProgress: ProgressView[];
  /** Status from the latest progress overall in deterministic order, or "unclaimed"/"claimed". */
  status: string;
  openBlockers: string[];
  claimConflict: boolean;
  // ---- queue (from the latest task.created) ----
  dependsOn: string[];
  /** Participant id or "any". */
  assignee: string;
  /** Queue position: payload.order, else the deterministic index of the first task.created. */
  order: number;
  /** true when the task has been posted to the queue (has a task.created) and every dependency is "done". */
  ready: boolean;
}

export interface DecisionView extends SourceRef {
  topic: string;
  title: string;
  decision: string;
  rationale: string;
  status: 'proposed' | 'accepted' | 'resolved';
  codeRefs: string[];
  alternatives: string[];
  supersedes: string[];
  refs: EventRefs;
}

export interface TopicView {
  topic: string;
  /** Current versions (not superseded). Exactly one unless in conflict. */
  heads: DecisionView[];
  /** Every version, deterministic order. */
  history: DecisionView[];
  conflict: boolean;
}

export interface ConflictView {
  scope: 'decision' | 'claim' | 'goal';
  key: string;
  /** Human summary of each competing head. */
  heads: Array<SourceRef & { summary: string }>;
  hint: string;
}

export interface MessageView extends SourceRef {
  kind: 'question' | 'reply' | 'notification';
  body: string;
  /** Participant id, agent address "p_…/agent", or "all". */
  to?: string;
  replyTo?: string;
  refs: EventRefs;
}

export interface QuestionView extends MessageView {
  replies: MessageView[];
  answered: boolean;
}

export interface IssueView extends SourceRef {
  kind: 'bug' | 'blocker' | 'risk';
  title: string;
  detail?: string;
  taskId?: string;
  status: 'open' | 'resolved';
  resolution?: SourceRef & { note?: string };
}

export interface ActivityView extends SourceRef {
  kind: string;
  summary: string;
  commits: Array<{ hash: string; message: string }>;
  paths: string[];
}

export interface ForkAlarm {
  author: string;
  seq: number;
  eventIds: string[];
  detectedAt: string;
}

export interface ProjectState {
  project: { id: string; name: string; description?: string } | null;
  me: string;
  participants: ParticipantView[];
  /** Every known agent (lead of each participant always included), deterministic order. */
  agents: AgentView[];
  goal: { current: GoalVersion | null; heads: GoalVersion[]; conflict: boolean };
  tasks: TaskView[];
  decisions: TopicView[];
  conflicts: ConflictView[];
  questions: QuestionView[];
  notifications: MessageView[];
  issues: IssueView[];
  /** Latest task-less progress report per author (deterministic order). Task progress lives in tasks[].latestProgress. */
  generalProgress: ProgressView[];
  /** Most recent activity first, max 50. */
  activity: ActivityView[];
  /** eventId → participant ids that acknowledged it (any of their agents). */
  acknowledgements: Record<string, string[]>;
  /** eventId → agent addresses ("participant/agent") that acknowledged it. */
  agentAcknowledgements: Record<string, string[]>;
  forks: ForkAlarm[];
  /** Latest MATERIAL event in deterministic order (used for "last update" in IMPORTANT.md). */
  lastMaterial: SourceRef | null;
  eventCount: number;
  /** Events of unknown type/version that were stored but not projected. */
  opaqueCount: number;
}
