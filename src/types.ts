export type JsonRecord = Record<string, unknown>;

export interface ThreadInfo {
  id: string;
  title: string;
  projectId: string | null;
  lineage: { parentThreadId: string | null; relationshipToParent: string | null; rootThreadId?: string };
  latestRunCompletedAt?: string | null;
  activeRunId?: string | null;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: unknown;
  pendingBackgroundTasks?: Array<{ kind?: string; [key: string]: unknown }>;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface ProjectInfo {
  id: string;
  title: string;
  workspaceRoot: string;
  [key: string]: unknown;
}

export interface RunInfo {
  id: string;
  ordinal: number;
  status: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  rootNodeId: string | null;
  userMessageId?: string | null;
  [key: string]: unknown;
}

export interface MessageInfo {
  id: string;
  runId: string | null;
  nodeId: string | null;
  role: string;
  text: string;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ProviderThreadInfo {
  id?: unknown;
  providerInstanceId?: unknown;
  providerSessionId?: unknown;
  appThreadId?: unknown;
  [key: string]: unknown;
}

export interface Projection {
  thread: ThreadInfo;
  runs: RunInfo[];
  messages: MessageInfo[];
  providerThreads?: ProviderThreadInfo[];
  subagents?: JsonRecord[];
  turnItems?: JsonRecord[];
  [key: string]: unknown;
}

export interface SourceItem {
  stream: "active" | "archive";
  item: JsonRecord;
}

// the parsed process configuration, the value of the SupervisorConfig service
export interface SupervisorSettings {
  dataDirectory: string;
  t3Url: string;
  t3TokenFile: string;
  excludedThreadIds: string[];
  healthPort: number;
  helperProviderInstanceId?: string;
  uiPort?: number;
  uiHost?: string;
  workflowMcpHosts?: ReadonlyArray<string>;
  workflowMcpBindHost?: string;
  workflowMcpPort?: number;
  uiAssetsDirectory?: string;
  guidanceTokenFile?: string;
  projectWriteTokenFile?: string;
  projectCommitTokenFile?: string;
  gitProbeTokenFile?: string;
  managedScratchRoot?: string;
}

// the configuration a supervision run reads: the parsed settings themselves (the thread policy and the ownership set are services)
export type SupervisorConfig = SupervisorSettings;
