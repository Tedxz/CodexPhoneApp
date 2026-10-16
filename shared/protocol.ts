export type ThreadStatus = 'notLoaded' | 'idle' | 'active' | 'systemError';
export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  status: ThreadStatus;
  activeTurnId?: string;
  updatedAt: number;
  model?: string;
  source?: string;
  canAcceptDirectInput?: boolean;
}
export interface WorkspaceSummary {
  cwd: string;
  threadCount: number;
  activeCount: number;
  updatedAt: number;
}
export interface SessionSettings {
  model?: string;
  effort?: string;
  mode?: 'default' | 'plan';
}
export interface ConversationItem {
  id: string;
  turnId: string;
  type: string;
  role?: 'user' | 'assistant';
  text: string;
  status?: string;
  images?: string[];
}
export interface InputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
  isSecret?: boolean;
}
export interface PendingRequest {
  id: string;
  threadId: string;
  kind: 'command' | 'fileChange' | 'permissions' | 'userInput' | 'unsupported';
  title: string;
  detail: string;
  questions?: InputQuestion[];
  decisions?: string[];
}
export interface RequestAnswer {
  decision?: 'accept' | 'decline' | 'cancel';
  answers?: Record<string, string[]>;
}
export interface ThreadSnapshot {
  thread: ThreadSummary;
  readOnly?: boolean;
  items: ConversationItem[];
  nextCursor: string | null;
  pendingRequests: PendingRequest[];
  settings?: SessionSettings;
  warning?: string;
  eventCursor?: { epoch: string; seq: number };
}
export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}
export interface Project {
  id: string;
  name: string;
  path: string;
}
export type ClientType = 'harmony' | 'browser';
export interface Device {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  current?: boolean;
  clientType?: ClientType;
  lastSeenAt?: number;
  authorizationCount?: number;
}
export interface ConnectionState {
  connected: boolean;
  message: string;
  serverVersion?: string;
  sharedBackend: true;
  stage?: string;
  errorCode?: string;
}
export interface Capabilities {
  images: boolean;
  planMode: boolean;
  liveControl: boolean;
}
export interface TargetSummary {
  id: string;
  name: string;
  kind: 'local' | 'ssh';
  connection: ConnectionState;
  capabilities: Capabilities;
}
export interface Bootstrap {
  device: Device;
  projects: Project[];
  connection: ConnectionState;
  capabilities: Capabilities;
  target?: TargetSummary;
}
export type GatewayEvent =
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'thread.changed'; thread: ThreadSummary }
  | { type: 'item.updated'; threadId: string; item: ConversationItem }
  | { type: 'item.delta'; threadId: string; itemId: string; turnId: string; delta: string }
  | { type: 'request.pending'; request: PendingRequest }
  | { type: 'request.resolved'; requestId: string; threadId: string }
  | { type: 'resync'; threadId?: string };
export interface EventEnvelope {
  type: 'event';
  epoch: string;
  seq: number;
  event: GatewayEvent;
}
export interface RpcCommand {
  id: string;
  method: 'thread.subscribe' | 'thread.create' | 'turn.send' | 'turn.interrupt' | 'request.respond';
  params: Record<string, unknown>;
}
export interface RpcReply {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface CreateThreadInput extends SessionSettings {
  cwd: string;
}
export interface SendInput extends SessionSettings {
  threadId: string;
  text: string;
  imagePaths?: string[];
  expectedTurnId?: string;
}
