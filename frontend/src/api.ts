export type SessionSummary = {
  id: string;
  title: string;
  model_provider: string;
  model: string | null;
  cwd: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
};

export type ProviderStat = {
  model_provider: string;
  count: number;
};

export type CodexConfig = {
  codexHome: string;
  dbPath: string;
  detected: boolean;
  usable: boolean;
  usableReadMode: "database" | "rollout_fallback" | "unavailable";
  reason: string;
  paths: {
    sessionsDir: string;
    sessionIndexPath: string;
  };
  files: {
    database: {
      path: string;
      exists: boolean;
      size: number;
    };
    wal: {
      path: string;
      exists: boolean;
      size: number;
    };
    sessionIndexExists: boolean;
    sessionsDirExists: boolean;
    hasRolloutFiles: boolean;
  };
  databaseMode: string;
  databaseReadable: boolean;
  databaseError: string;
};

export type DynamicTool = {
  position: number;
  name: string;
  description: string;
  input_schema: string;
  defer_loading: boolean;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  source: string;
};

export type SessionDetail = SessionSummary & {
  source?: string | null;
  sandbox_policy?: string | null;
  approval_mode?: string | null;
  tokens_used?: number | null;
  has_user_event?: boolean;
  archived_at?: number | null;
  git_sha?: string | null;
  git_branch?: string | null;
  git_origin_url?: string | null;
  cli_version?: string | null;
  first_user_message?: string | null;
  agent_nickname?: string | null;
  agent_role?: string | null;
  memory_mode?: string | null;
  reasoning_effort?: string | null;
  agent_path?: string | null;
  rollout_exists?: boolean;
  dynamic_tools?: DynamicTool[];
  conversation_messages?: ConversationMessage[];
};

export type ImportFailure = {
  threadId: string;
  error: string;
};

export type BatchImportResult = {
  total: number;
  importedIds: string[];
  skippedIds: string[];
  failed: ImportFailure[];
  backupPath: string;
};

type ApiErrorPayload = {
  error?: string;
};

async function parseApiError(response: Response) {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    return payload.error ?? "Request failed.";
  } catch {
    return "Request failed.";
  }
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "content-type": "application/json"
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return (await response.json()) as T;
}

export async function fetchBinary(
  input: string,
  init?: RequestInit
): Promise<{ blob: Blob; filename: string | null }> {
  const response = await fetch(input, init);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return {
    blob: await response.blob(),
    filename: response.headers.get("x-codex-download-name")
  };
}

export async function getProviders() {
  return fetchJson<{ providers: ProviderStat[] }>("/api/providers");
}

export async function getConfig() {
  return fetchJson<{ config: CodexConfig }>("/api/config");
}

export async function updateConfig(params: { codexHome?: string; dbPath?: string }) {
  return fetchJson<{ config: CodexConfig }>("/api/config", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function getSessions(params: {
  provider?: string;
  search?: string;
  limit?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params.provider) {
    searchParams.set("provider", params.provider);
  }
  if (params.search) {
    searchParams.set("search", params.search);
  }
  searchParams.set("limit", String(params.limit ?? 100));

  return fetchJson<{ sessions: SessionSummary[] }>(`/api/sessions?${searchParams.toString()}`);
}

export async function getSession(threadId: string) {
  return fetchJson<{ session: SessionDetail }>(`/api/sessions/${encodeURIComponent(threadId)}`);
}

export async function cloneSession(threadId: string, modelProvider: string) {
  return fetchJson<{
    result: {
      sourceId: string;
      clonedId: string;
      modelProvider: string;
      rolloutPath: string;
    };
  }>(`/api/sessions/${encodeURIComponent(threadId)}/clone`, {
    method: "POST",
    body: JSON.stringify({ modelProvider })
  });
}

export async function retargetSession(threadId: string, modelProvider: string) {
  return fetchJson<{
    result: {
      threadId: string;
      modelProvider: string;
    };
  }>(`/api/sessions/${encodeURIComponent(threadId)}/retarget`, {
    method: "POST",
    body: JSON.stringify({ modelProvider })
  });
}

export async function batchRetargetSessions(threadIds: string[], modelProvider: string) {
  return fetchJson<{
    result: {
      modelProvider: string;
      threadIds: string[];
      skippedIds: string[];
    };
  }>("/api/sessions/batch/retarget", {
    method: "POST",
    body: JSON.stringify({ threadIds, modelProvider })
  });
}

export async function exportSelectedSessions(threadIds: string[]) {
  return fetchBinary("/api/sessions/export/archive", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ threadIds })
  });
}

export async function importSessionArchive(file: File, options?: { force?: boolean }) {
  return fetchJson<{
    result: BatchImportResult;
  }>("/api/import/archive/batch", {
    method: "POST",
    headers: {
      "content-type": "application/gzip",
      "x-codex-upload-name": encodeURIComponent(file.name),
      "x-codex-import-force": options?.force ? "true" : "false"
    },
    body: file
  });
}
