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
  owner: string;
  ownerName: string;
  scope: string;
  paths: string[];
  note?: string;
  /** true when this head came from a conflict.resolved event assigning the owner */
  viaResolution: boolean;
}

export interface ProgressView extends SourceRef {
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
  /** Live claim heads (not superseded / released). >1 owner ⇒ conflict. */
  claims: ClaimView[];
  owners: string[];
  /** Latest progress per author (deterministic order), newest last. */
  latestProgress: ProgressView[];
  /** Status from the latest progress overall in deterministic order, or "unclaimed"/"claimed". */
  status: string;
  openBlockers: string[];
  claimConflict: boolean;
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
  goal: { current: GoalVersion | null; heads: GoalVersion[]; conflict: boolean };
  tasks: TaskView[];
  decisions: TopicView[];
  conflicts: ConflictView[];
  questions: QuestionView[];
  notifications: MessageView[];
  issues: IssueView[];
  /** Most recent activity first, max 50. */
  activity: ActivityView[];
  /** eventId → participant ids that acknowledged it. */
  acknowledgements: Record<string, string[]>;
  forks: ForkAlarm[];
  /** Latest MATERIAL event in deterministic order (used for "last update" in IMPORTANT.md). */
  lastMaterial: SourceRef | null;
  eventCount: number;
  /** Events of unknown type/version that were stored but not projected. */
  opaqueCount: number;
}
