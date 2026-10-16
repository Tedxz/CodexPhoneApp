// Native representation of shared/protocol.ts. Keep the wire field names stable.
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

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface InputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: QuestionOption[];
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

export interface QuestionAnswer {
  id: string;
  answers: string[];
}

export interface Attachment {
  id: string;
  url: string;
  name: string;
  localUri: string;
}

export interface SnapshotCursor {
  epoch: string;
  seq: number;
}

export interface ThreadSnapshot {
  thread: ThreadSummary;
  items: ConversationItem[];
  nextCursor: string | null;
  pendingRequests: PendingRequest[];
  settings?: SessionSettings;
  warning?: string;
  readOnly?: boolean;
  eventCursor?: SnapshotCursor;
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
  clientType?: ClientType;
  lastSeenAt?: number;
  authorizationCount?: number;
  current?: boolean;
}

export interface ConnectionState {
  connected: boolean;
  message: string;
  serverVersion?: string;
  sharedBackend: boolean;
  stage?: string;
  errorCode?: string;
}

export interface Capabilities {
  images: boolean;
  planMode: boolean;
  liveControl: boolean;
}

export interface Bootstrap {
  device: Device;
  projects: Project[];
  connection: ConnectionState;
  capabilities: Capabilities;
}

// ArkTS uses an explicit event shape instead of structural discriminated unions.
// The receiver checks each variant's required fields before applying it.
export interface GatewayEvent {
  type: string;
  connection?: ConnectionState;
  thread?: ThreadSummary;
  threadId?: string;
  item?: ConversationItem;
  itemId?: string;
  turnId?: string;
  delta?: string;
  request?: PendingRequest;
  requestId?: string;
}

export interface EventEnvelope {
  type: 'event';
  epoch: string;
  seq: number;
  event: GatewayEvent;
}

export interface ThreadPage {
  data: ThreadSummary[];
  nextCursor: string | null;
}

export interface WorkspacePage {
  data: WorkspaceSummary[];
}

export interface ModelPage {
  data: ModelOption[];
}

export interface DevicePage {
  data: Device[];
}

export interface PairReply {
  device: Device;
}

export interface UploadResult {
  id: string;
  url: string;
}

export interface ErrorDetail {
  code: string;
  message: string;
}

export interface ErrorReply {
  error?: ErrorDetail;
  message?: string;
}

export interface TargetSummary {
  id: string;
  name: string;
  kind: 'local' | 'ssh';
  connection: ConnectionState;
  capabilities: Capabilities;
}

export interface TargetPage { data: TargetSummary[] }
