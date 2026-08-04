import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ToolLoopAgent, isLoopFinished, type ModelMessage } from "ai";
import { DurableObject } from "cloudflare:workers";

type LelemStatus = "awaiting_budget" | "running" | "thinking" | "paused" | "error";

type RuntimeEnv = Env & { KEY_ENCRYPTION_SECRET: string };

type DirectoryRow = {
  id: string;
  slug: string;
  name: string;
  system_prompt: string;
  model: string;
  status: LelemStatus;
  budget_remaining: number;
  total_spent: number;
  total_tokens: number;
  turn_count: number;
  last_message: string | null;
  owner_token_hash: string | null;
  created_at: string;
  updated_at: string;
};

type MetaRow = {
  id: string;
  slug: string;
  name: string;
  system_prompt: string;
  model: string;
  status: LelemStatus;
  total_spent: number;
  total_tokens: number;
  turn_count: number;
  created_at: string;
  updated_at: string;
};

type KeyRow = {
  id: string;
  encrypted_key: string;
  iv: string;
  label: string;
  initial_budget: number;
  remaining: number;
  spent: number;
  status: "active" | "depleted" | "expired" | "invalid";
  expires_at: string | null;
  created_at: string;
};

type TranscriptRole = "user" | "assistant" | "tool";
type TranscriptKind =
  | "message"
  | "loop-prompt"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "tool-error"
  | "step"
  | "source"
  | "file"
  | "custom"
  | "error";

type TranscriptRow = {
  id: number;
  content: string;
  model: string;
  created_at: string;
  turn_id: string | null;
  sequence: number;
  step_number: number | null;
  role: TranscriptRole;
  kind: TranscriptKind;
  tool_name: string | null;
  tool_call_id: string | null;
  input_json: string | null;
  output_json: string | null;
};

type TurnRow = {
  id: string;
  model: string;
  status: "running" | "complete" | "error";
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost: number;
  finish_reason: string | null;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
};

type OpenRouterKeyData = {
  label?: string;
  limit: number | null;
  limit_remaining: number | null;
  usage: number;
  expires_at: string | null;
};

type PublicSnapshot = {
  lelem: {
    id: string;
    slug: string;
    name: string;
    systemPrompt: string;
    model: string;
    status: LelemStatus;
    createdAt: string;
    updatedAt: string;
  };
  budget: {
    remaining: number;
    initial: number;
    spent: number;
    contributors: number;
    activeKeys: number;
    expiredKeys: number;
    nextExpiration: string | null;
  };
  totals: { tokens: number; turns: number };
  turns: Array<{
    id: string;
    model: string;
    status: "running" | "complete" | "error";
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cost: number;
    finishReason: string | null;
    durationMs: number;
    startedAt: string;
    finishedAt: string | null;
  }>;
  transcript: Array<{
    id: number;
    turnId: string | null;
    sequence: number;
    stepNumber: number | null;
    role: TranscriptRole;
    kind: TranscriptKind;
    content: string;
    model: string;
    toolName: string | null;
    toolCallId: string | null;
    input: unknown;
    output: unknown;
    createdAt: string;
  }>;
  hasMoreTranscript: boolean;
};

type PublicTranscriptPage = Pick<PublicSnapshot, "turns" | "transcript" | "hasMoreTranscript">;

type ConversationTurnRow = {
  user_message_json: string;
  response_messages_json: string;
};

const LOOP_DELAY_MS = 3_000;
const ERROR_RETRY_MS = 20_000;
const LOOP_PROMPT = "Continue.";
const MAX_MODEL_CONTEXT_TURNS = 24;
const TRANSCRIPT_PAGE_SIZE = 200;
const KEY_EXPIRY_SAFETY_MS = 120_000;

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function apiError(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 32_000) throw new Error("Request body is too large.");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return result;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "lelem";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

function roundMoney(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000) / 1_000_000);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    });
  } catch {
    return JSON.stringify({ unavailable: "Value could not be serialized." });
  }
}

function parseStoredJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function redactSensitiveText(value: string): string {
  return value.replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted OpenRouter key]");
}

function normalizeExpiration(value: string | null | undefined): string | null {
  if (value === undefined) throw new Error("OpenRouter did not return API key expiration metadata.");
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("OpenRouter returned an invalid API key expiration.");
  return new Date(timestamp).toISOString();
}

function isExpirationUsable(expiresAt: string | null, now = Date.now()): boolean {
  return expiresAt === null || Date.parse(expiresAt) > now + KEY_EXPIRY_SAFETY_MS;
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function keyFingerprint(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return bytesToBase64(new Uint8Array(digest));
}

function createControlToken(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function controlTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToBase64(new Uint8Array(digest));
}

async function isValidControlToken(token: string, expectedHash: string | null): Promise<boolean> {
  if (!token || !expectedHash) return false;
  const supplied = base64ToBytes(await controlTokenHash(token));
  const expected = base64ToBytes(expectedHash);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
  };
  return supplied.byteLength === expected.byteLength && subtle.timingSafeEqual(supplied, expected);
}

async function encryptApiKey(apiKey: string, secret: string): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(apiKey),
  );
  return { encrypted: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptApiKey(encrypted: string, iv: string, secret: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    await encryptionKey(secret),
    base64ToBytes(encrypted),
  );
  return new TextDecoder().decode(decrypted);
}

async function getOpenRouterKeyData(apiKey: string): Promise<OpenRouterKeyData> {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("OpenRouter rejected this API key.");
    throw new Error(`OpenRouter key check failed (${response.status}).`);
  }
  const payload = await response.json<{ data?: OpenRouterKeyData }>();
  if (!payload.data) throw new Error("OpenRouter returned an invalid key response.");
  return payload.data;
}

function publicDirectoryRow(row: DirectoryRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: row.model,
    status: row.status,
    budgetRemaining: row.budget_remaining,
    totalSpent: row.total_spent,
    totalTokens: row.total_tokens,
    turnCount: row.turn_count,
    lastMessage: row.last_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Lelem extends DurableObject<RuntimeEnv> {
  private currentGeneration: AbortController | null = null;

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        total_spent REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS donated_keys (
        id TEXT PRIMARY KEY,
        encrypted_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        initial_budget REAL NOT NULL,
        remaining REAL NOT NULL,
        spent REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS donated_keys_active_idx ON donated_keys(status, remaining DESC);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        finish_reason TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS turns_started_idx ON turns(started_at DESC);
      CREATE TABLE IF NOT EXISTS transcript (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        step_number INTEGER,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        tool_name TEXT,
        tool_call_id TEXT,
        input_json TEXT,
        output_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_created_idx ON transcript(id DESC);
      CREATE INDEX IF NOT EXISTS transcript_turn_idx ON transcript(turn_id, sequence);
      CREATE TABLE IF NOT EXISTS conversation_turns (
        turn_id TEXT PRIMARY KEY,
        user_message_json TEXT NOT NULL,
        response_messages_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_turns_created_idx ON conversation_turns(created_at DESC);
    `);
  }

  async init(input: {
    id: string;
    slug: string;
    name: string;
    systemPrompt: string;
    model: string;
    createdAt: string;
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO meta
       (id, slug, name, system_prompt, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'awaiting_budget', ?, ?)`,
      input.id,
      input.slug,
      input.name,
      input.systemPrompt,
      input.model,
      input.createdAt,
      input.createdAt,
    );
  }

  async donate(apiKey: string, donorLabel: string): Promise<PublicSnapshot> {
    if (!this.env.KEY_ENCRYPTION_SECRET || this.env.KEY_ENCRYPTION_SECRET.length < 32) {
      throw new Error("The server's key-encryption secret is not configured.");
    }
    if (!apiKey.startsWith("sk-or-")) throw new Error("That does not look like an OpenRouter API key.");

    const keyData = await getOpenRouterKeyData(apiKey);
    if (typeof keyData.limit_remaining !== "number" || typeof keyData.limit !== "number") {
      throw new Error("Please donate a capped OpenRouter key so its remaining budget can be measured safely.");
    }
    if (keyData.limit_remaining <= 0) throw new Error("This OpenRouter key has no remaining budget.");
    const expiresAt = normalizeExpiration(keyData.expires_at);
    if (!isExpirationUsable(expiresAt)) {
      throw new Error("This OpenRouter key is expired or expires too soon to safely complete a generation.");
    }

    const { encrypted, iv } = await encryptApiKey(apiKey, this.env.KEY_ENCRYPTION_SECRET);
    const fingerprint = await keyFingerprint(apiKey);
    const duplicate = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM donated_keys WHERE fingerprint = ? LIMIT 1", fingerprint)
      .toArray()[0];
    if (duplicate) throw new Error("This key has already been donated to this Lelem.");
    const now = new Date().toISOString();
    const label = donorLabel.trim().slice(0, 40) || keyData.label?.slice(0, 40) || "Anonymous";
    this.ctx.storage.sql.exec(
      `INSERT INTO donated_keys
      (id, encrypted_key, iv, fingerprint, label, initial_budget, remaining, spent, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
      crypto.randomUUID(),
      encrypted,
      iv,
      fingerprint,
      label,
      keyData.limit_remaining,
      keyData.limit_remaining,
      expiresAt,
      now,
    );
    const currentStatus = this.ctx.storage.sql.exec<{ status: LelemStatus }>("SELECT status FROM meta LIMIT 1").one().status;
    if (currentStatus !== "paused") {
      this.ctx.storage.sql.exec("UPDATE meta SET status = 'running', updated_at = ?", now);
      await this.ctx.storage.setAlarm(Date.now() + 250);
    }
    const snapshot = this.getSnapshot();
    this.broadcast(snapshot);
    await this.syncDirectory(snapshot);
    return snapshot;
  }

  async pause(): Promise<PublicSnapshot> {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("UPDATE meta SET status = 'paused', updated_at = ?", now);
    await this.ctx.storage.deleteAlarm();
    this.currentGeneration?.abort(new DOMException("Paused by owner.", "AbortError"));
    const snapshot = this.getSnapshot();
    this.broadcast(snapshot);
    await this.syncDirectory(snapshot);
    return snapshot;
  }

  async resume(): Promise<PublicSnapshot> {
    this.expireUnusableKeys();
    const activeKeys = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM donated_keys WHERE status = 'active' AND remaining > 0")
      .one().count;
    const now = new Date().toISOString();
    const status: LelemStatus = activeKeys > 0 ? "running" : "awaiting_budget";
    this.ctx.storage.sql.exec("UPDATE meta SET status = ?, updated_at = ?", status, now);
    if (activeKeys > 0) await this.ctx.storage.setAlarm(Date.now() + 250);
    else await this.ctx.storage.deleteAlarm();
    const snapshot = this.getSnapshot();
    this.broadcast(snapshot);
    await this.syncDirectory(snapshot);
    return snapshot;
  }

  private publicTranscriptPage(beforeId?: number): PublicTranscriptPage {
    const rows = beforeId
      ? this.ctx.storage.sql
          .exec<TranscriptRow>(
            "SELECT * FROM transcript WHERE id < ? ORDER BY id DESC LIMIT ?",
            beforeId,
            TRANSCRIPT_PAGE_SIZE + 1,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<TranscriptRow>("SELECT * FROM transcript ORDER BY id DESC LIMIT ?", TRANSCRIPT_PAGE_SIZE + 1)
          .toArray();
    const hasMoreTranscript = rows.length > TRANSCRIPT_PAGE_SIZE;
    const transcriptRows = rows.slice(0, TRANSCRIPT_PAGE_SIZE).reverse();
    const turnIds = [...new Set(transcriptRows.flatMap((row) => (row.turn_id ? [row.turn_id] : [])))];
    const turns = turnIds.length
      ? this.ctx.storage.sql
          .exec<TurnRow>(`SELECT * FROM turns WHERE id IN (${turnIds.map(() => "?").join(",")})`, ...turnIds)
          .toArray()
      : [];

    return {
      turns: turns.map((turn) => ({
        id: turn.id,
        model: turn.model,
        status: turn.status,
        inputTokens: turn.input_tokens,
        outputTokens: turn.output_tokens,
        reasoningTokens: turn.reasoning_tokens,
        cost: turn.cost,
        finishReason: turn.finish_reason,
        durationMs: turn.duration_ms,
        startedAt: turn.started_at,
        finishedAt: turn.finished_at,
      })),
      transcript: transcriptRows.map((item) => ({
        id: item.id,
        turnId: item.turn_id,
        sequence: item.sequence,
        stepNumber: item.step_number,
        role: item.role,
        kind: item.kind,
        content: item.content,
        model: item.model,
        toolName: item.tool_name,
        toolCallId: item.tool_call_id,
        input: parseStoredJson(item.input_json),
        output: parseStoredJson(item.output_json),
        createdAt: item.created_at,
      })),
      hasMoreTranscript,
    };
  }

  getTranscriptPage(beforeId: number): PublicTranscriptPage {
    if (!Number.isInteger(beforeId) || beforeId < 1) throw new Error("Invalid transcript cursor.");
    return this.publicTranscriptPage(beforeId);
  }

  getSnapshot(): PublicSnapshot {
    this.expireUnusableKeys();
    const meta = this.ctx.storage.sql.exec<MetaRow>("SELECT * FROM meta LIMIT 1").one();
    const budget = this.ctx.storage.sql
      .exec<{
        initial: number;
        remaining: number;
        spent: number;
        contributors: number;
        active_keys: number;
        expired_keys: number;
        next_expiration: string | null;
      }>(
        `SELECT
          COALESCE(SUM(initial_budget), 0) AS initial,
          COALESCE(SUM(CASE WHEN status = 'active' THEN remaining ELSE 0 END), 0) AS remaining,
          COALESCE(SUM(spent), 0) AS spent,
          COUNT(*) AS contributors,
          COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_keys,
          COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired_keys,
          MIN(CASE WHEN status = 'active' THEN expires_at END) AS next_expiration
         FROM donated_keys`,
      )
      .one();
    const transcriptPage = this.publicTranscriptPage();

    return {
      lelem: {
        id: meta.id,
        slug: meta.slug,
        name: meta.name,
        systemPrompt: meta.system_prompt,
        model: meta.model,
        status: meta.status,
        createdAt: meta.created_at,
        updatedAt: meta.updated_at,
      },
      budget: {
        remaining: roundMoney(budget.remaining),
        initial: roundMoney(budget.initial),
        spent: roundMoney(budget.spent),
        contributors: budget.contributors,
        activeKeys: budget.active_keys,
        expiredKeys: budget.expired_keys,
        nextExpiration: budget.next_expiration,
      },
      totals: { tokens: meta.total_tokens, turns: meta.turn_count },
      ...transcriptPage,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", data: this.getSnapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private getModelHistory(): ModelMessage[] {
    const turns = this.ctx.storage.sql
      .exec<ConversationTurnRow>(
        `SELECT user_message_json, response_messages_json
         FROM conversation_turns ORDER BY rowid DESC LIMIT ?`,
        MAX_MODEL_CONTEXT_TURNS,
      )
      .toArray()
      .reverse();

    return turns.flatMap((turn) => {
      try {
        const userMessage = JSON.parse(turn.user_message_json) as ModelMessage;
        const responseMessages = JSON.parse(turn.response_messages_json) as ModelMessage[];
        return Array.isArray(responseMessages) ? [userMessage, ...responseMessages] : [];
      } catch {
        return [];
      }
    });
  }

  private storeConversationTurn(
    turnId: string,
    userMessage: ModelMessage,
    responseMessages: ModelMessage[],
    createdAt: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO conversation_turns
       (turn_id, user_message_json, response_messages_json, created_at)
       VALUES (?, ?, ?, ?)`,
      turnId,
      safeJson(userMessage),
      safeJson(responseMessages),
      createdAt,
    );
  }

  async alarm(): Promise<void> {
    this.expireUnusableKeys();
    const meta = this.ctx.storage.sql.exec<MetaRow>("SELECT * FROM meta LIMIT 1").one();
    if (meta.status === "paused") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (meta.status === "thinking") {
      const startedAt = new Date(meta.updated_at).getTime();
      const guardUntil = startedAt + 95_000;
      if (guardUntil > Date.now()) {
        await this.ctx.storage.setAlarm(guardUntil);
        return;
      }
    }
    const key = this.ctx.storage.sql
      .exec<KeyRow>(
        "SELECT * FROM donated_keys WHERE status = 'active' AND remaining > 0 ORDER BY created_at ASC LIMIT 1",
      )
      .toArray()[0];

    if (!key) {
      this.ctx.storage.sql.exec("UPDATE meta SET status = 'awaiting_budget', updated_at = ?", new Date().toISOString());
      const snapshot = this.getSnapshot();
      this.broadcast(snapshot);
      await this.syncDirectory(snapshot);
      return;
    }

    let apiKey: string | undefined;
    let turnId: string | undefined;
    let turnStartedMs = 0;
    try {
      apiKey = await decryptApiKey(key.encrypted_key, key.iv, this.env.KEY_ENCRYPTION_SECRET);
      const before = await getOpenRouterKeyData(apiKey);
      if (this.ctx.storage.sql.exec<{ status: LelemStatus }>("SELECT status FROM meta LIMIT 1").one().status === "paused") {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const refreshedExpiration = normalizeExpiration(before.expires_at);
      if (!isExpirationUsable(refreshedExpiration)) {
        this.ctx.storage.sql.exec(
          "UPDATE donated_keys SET status = 'expired', expires_at = ? WHERE id = ?",
          refreshedExpiration,
          key.id,
        );
        this.ctx.storage.sql.exec("UPDATE meta SET status = 'running', updated_at = ?", new Date().toISOString());
        await this.ctx.storage.setAlarm(Date.now() + 250);
        return;
      }
      this.ctx.storage.sql.exec("UPDATE donated_keys SET expires_at = ? WHERE id = ?", refreshedExpiration, key.id);
      if (typeof before.limit_remaining !== "number" || before.limit_remaining <= 0) {
        this.ctx.storage.sql.exec("UPDATE donated_keys SET status = 'depleted', remaining = 0 WHERE id = ?", key.id);
        this.ctx.storage.sql.exec("UPDATE meta SET status = 'running', updated_at = ?", new Date().toISOString());
        await this.ctx.storage.setAlarm(Date.now() + 250);
        return;
      }

      const userMessage: ModelMessage = { role: "user", content: LOOP_PROMPT };
      const messages = [...this.getModelHistory(), userMessage];

      turnId = crypto.randomUUID();
      turnStartedMs = Date.now();
      const startedAt = new Date(turnStartedMs).toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO turns (id, model, status, started_at) VALUES (?, ?, 'running', ?)`,
        turnId,
        meta.model,
        startedAt,
      );
      this.insertTranscriptEvent({
        turnId,
        sequence: 0,
        role: "user",
        kind: "loop-prompt",
        content: LOOP_PROMPT,
        model: meta.model,
        createdAt: startedAt,
      });
      this.ctx.storage.sql.exec("UPDATE meta SET status = 'thinking', updated_at = ?", startedAt);
      this.broadcast(this.getSnapshot());

      const openrouter = createOpenRouter({ apiKey });
      const abortController = new AbortController();
      this.currentGeneration = abortController;
      const agent = new ToolLoopAgent({
        model: openrouter(meta.model, {
          usage: { include: true },
          reasoning: { enabled: true, effort: "medium", exclude: false },
        }),
        instructions: meta.system_prompt,
        stopWhen: isLoopFinished(),
      });
      const result = await agent.stream({
        messages,
        abortSignal: abortController.signal,
        timeout: { totalMs: 90_000 },
      });

      let sequence = 1;
      let currentStep = -1;
      const openTextEvents = new Map<string, number>();
      const openReasoningEvents = new Map<string, number>();
      const toolInputEvents = new Map<string, { eventId: number; value: string }>();

      for await (const part of result.stream) {
        const streamedAt = new Date().toISOString();
        const common = {
          turnId,
          stepNumber: Math.max(0, currentStep),
          model: meta.model,
          createdAt: streamedAt,
        };
        switch (part.type) {
          case "start-step":
            currentStep += 1;
            break;
          case "text-start": {
            const eventId = this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "message",
              content: "",
            });
            openTextEvents.set(part.id, eventId);
            this.broadcast(this.getSnapshot());
            break;
          }
          case "text-delta": {
            let eventId = openTextEvents.get(part.id);
            if (!eventId) {
              eventId = this.insertTranscriptEvent({
                ...common,
                sequence: sequence++,
                role: "assistant",
                kind: "message",
                content: "",
              });
              openTextEvents.set(part.id, eventId);
              this.broadcast(this.getSnapshot());
            }
            this.appendTranscriptContent(eventId, part.text);
            this.broadcastTranscriptDelta(eventId, part.text);
            break;
          }
          case "reasoning-start": {
            const eventId = this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "reasoning",
              content: "",
            });
            openReasoningEvents.set(part.id, eventId);
            this.broadcast(this.getSnapshot());
            break;
          }
          case "reasoning-delta": {
            let eventId = openReasoningEvents.get(part.id);
            if (!eventId) {
              eventId = this.insertTranscriptEvent({
                ...common,
                sequence: sequence++,
                role: "assistant",
                kind: "reasoning",
                content: "",
              });
              openReasoningEvents.set(part.id, eventId);
              this.broadcast(this.getSnapshot());
            }
            this.appendTranscriptContent(eventId, part.text);
            this.broadcastTranscriptDelta(eventId, part.text);
            break;
          }
          case "tool-input-start": {
            const eventId = this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "tool-call",
              content: `Preparing ${part.toolName}`,
              toolName: part.toolName,
              toolCallId: part.id,
              input: "",
            });
            toolInputEvents.set(part.id, { eventId, value: "" });
            this.broadcast(this.getSnapshot());
            break;
          }
          case "tool-input-delta": {
            const pending = toolInputEvents.get(part.id);
            if (pending) {
              pending.value += part.delta;
              this.updateTranscriptInput(pending.eventId, pending.value);
              this.broadcastTranscriptInput(pending.eventId, pending.value);
            }
            break;
          }
          case "tool-call": {
            const pending = toolInputEvents.get(part.toolCallId);
            if (pending) {
              this.updateToolCallEvent(pending.eventId, part.toolName, part.input);
              toolInputEvents.delete(part.toolCallId);
            } else {
              this.insertTranscriptEvent({
                ...common,
                sequence: sequence++,
                role: "assistant",
                kind: "tool-call",
                content: `Called ${part.toolName}`,
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                input: part.input,
              });
            }
            this.broadcast(this.getSnapshot());
            break;
          }
          case "tool-result":
            this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "tool",
              kind: "tool-result",
              content: `${part.toolName} returned a result`,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.input,
              output: part.output,
            });
            this.broadcast(this.getSnapshot());
            break;
          case "tool-error":
            this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "tool",
              kind: "tool-error",
              content: `${part.toolName} failed`,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.input,
              output: part.error,
            });
            this.broadcast(this.getSnapshot());
            break;
          case "source":
            this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "source",
              content: "Model-provided source",
              output: part,
            });
            this.broadcast(this.getSnapshot());
            break;
          case "file":
          case "reasoning-file":
            this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "file",
              content: part.type === "reasoning-file" ? "Reasoning file" : "Generated file",
              output: { mediaType: part.file.mediaType },
            });
            this.broadcast(this.getSnapshot());
            break;
          case "custom":
            this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "custom",
              content: `Agent event: ${part.kind}`,
              output: part,
            });
            this.broadcast(this.getSnapshot());
            break;
          case "finish-step":
            this.insertTranscriptEvent({
              ...common,
              sequence: sequence++,
              role: "assistant",
              kind: "step",
              content: `Step ${currentStep + 1} complete`,
              model: part.response.modelId,
              output: {
                inputTokens: part.usage.inputTokens ?? 0,
                outputTokens: part.usage.outputTokens ?? 0,
                reasoningTokens: part.usage.outputTokenDetails.reasoningTokens ?? 0,
                finishReason: part.finishReason,
                durationMs: part.performance.stepTimeMs,
              },
            });
            this.broadcast(this.getSnapshot());
            break;
          case "error":
            throw part.error;
          case "abort":
            throw new Error(part.reason || "Generation was aborted.");
          case "start":
          case "finish":
          case "text-end":
          case "reasoning-end":
          case "tool-input-end":
          case "raw":
            break;
        }
      }
      this.currentGeneration = null;

      const responseMessages = await result.responseMessages;
      this.storeConversationTurn(turnId, userMessage, responseMessages, startedAt);

      const after = await getOpenRouterKeyData(apiKey);
      const usage = await result.usage;
      const steps = await result.steps;
      const finalStep = await result.finalStep;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const reasoningTokens = usage.outputTokenDetails.reasoningTokens ?? 0;
      const totalTokens = inputTokens + outputTokens;
      const measuredCost = Math.max(0, before.limit_remaining - (after.limit_remaining ?? before.limit_remaining));
      const providerCost = steps.reduce((sum, step) => {
        const usage = step.providerMetadata?.openrouter?.usage as { cost?: number } | undefined;
        return sum + (usage?.cost ?? 0);
      }, 0);
      const cost = roundMoney(measuredCost > 0 ? measuredCost : providerCost);
      const now = new Date().toISOString();
      const remaining = roundMoney(after.limit_remaining ?? Math.max(0, key.remaining - cost));
      const keyStatus = remaining > 0 ? "active" : "depleted";

      const actualModel = finalStep.model.modelId;
      this.ctx.storage.sql.exec(
        `UPDATE turns SET model = ?, status = 'complete', input_tokens = ?, output_tokens = ?,
         reasoning_tokens = ?, cost = ?, finish_reason = ?, duration_ms = ?, finished_at = ? WHERE id = ?`,
        actualModel,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cost,
        finalStep.finishReason,
        Date.now() - turnStartedMs,
        now,
        turnId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE donated_keys SET remaining = ?, spent = spent + ?, status = ? WHERE id = ?",
        remaining,
        cost,
        keyStatus,
        key.id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE meta SET status = ?, total_spent = total_spent + ?,
         total_tokens = total_tokens + ?, turn_count = turn_count + 1, updated_at = ?`,
        this.ctx.storage.sql.exec<{ status: LelemStatus }>("SELECT status FROM meta LIMIT 1").one().status === "paused"
          ? "paused"
          : "running",
        cost,
        totalTokens,
        now,
      );

      const snapshot = this.getSnapshot();
      this.broadcast(snapshot);
      await this.syncDirectory(snapshot);
      if (snapshot.lelem.status === "paused") await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + LOOP_DELAY_MS);
    } catch (error) {
      this.currentGeneration = null;
      const message = redactSensitiveText(error instanceof Error ? error.message : "Unknown generation error");
      console.error(JSON.stringify({ event: "lelem_generation_failed", lelemId: meta.id, message }));
      const failedAt = new Date().toISOString();
      if (turnId) {
        this.ctx.storage.sql.exec(
          "UPDATE turns SET status = 'error', duration_ms = ?, finished_at = ? WHERE id = ?",
          Date.now() - turnStartedMs,
          failedAt,
          turnId,
        );
        this.insertTranscriptEvent({
          turnId,
          sequence: 999_999,
          role: "assistant",
          kind: "error",
          content: message,
          model: meta.model,
          createdAt: failedAt,
        });
      }
      if (apiKey) {
        try {
          const latest = await getOpenRouterKeyData(apiKey);
          const remaining = roundMoney(latest.limit_remaining ?? key.remaining);
          this.ctx.storage.sql.exec(
            "UPDATE donated_keys SET remaining = ?, status = ? WHERE id = ?",
            remaining,
            remaining > 0 ? "active" : "depleted",
            key.id,
          );
        } catch (keyError) {
          if (keyError instanceof Error && keyError.message.includes("rejected")) {
            this.ctx.storage.sql.exec("UPDATE donated_keys SET status = 'invalid' WHERE id = ?", key.id);
          }
        }
      }
      const wasPaused = this.ctx.storage.sql.exec<{ status: LelemStatus }>("SELECT status FROM meta LIMIT 1").one().status === "paused";
      if (!wasPaused) {
        this.ctx.storage.sql.exec("UPDATE meta SET status = 'error', updated_at = ?", new Date().toISOString());
      }
      const snapshot = this.getSnapshot();
      this.broadcast(snapshot);
      await this.syncDirectory(snapshot);
      if (wasPaused) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + ERROR_RETRY_MS);
    }
  }

  private insertTranscriptEvent(input: {
    turnId?: string;
    sequence?: number;
    stepNumber?: number;
    role: TranscriptRole;
    kind: TranscriptKind;
    content: string;
    model?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    createdAt: string;
  }): number {
    return this.ctx.storage.sql.exec<{ id: number }>(
      `INSERT INTO transcript
       (turn_id, sequence, step_number, role, kind, content, model, tool_name, tool_call_id,
        input_json, output_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      input.turnId ?? null,
      input.sequence ?? 0,
      input.stepNumber ?? null,
      input.role,
      input.kind,
      input.content,
      input.model ?? "",
      input.toolName ?? null,
      input.toolCallId ?? null,
      input.input === undefined ? null : safeJson(input.input),
      input.output === undefined ? null : safeJson(input.output),
      input.createdAt,
    ).one().id;
  }

  private appendTranscriptContent(eventId: number, delta: string): void {
    this.ctx.storage.sql.exec("UPDATE transcript SET content = content || ? WHERE id = ?", delta, eventId);
  }

  private expireUnusableKeys(now = Date.now()): void {
    const cutoff = new Date(now + KEY_EXPIRY_SAFETY_MS).toISOString();
    this.ctx.storage.sql.exec(
      "UPDATE donated_keys SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
      cutoff,
    );
  }

  private updateTranscriptInput(eventId: number, input: unknown): void {
    this.ctx.storage.sql.exec("UPDATE transcript SET input_json = ? WHERE id = ?", safeJson(input), eventId);
  }

  private updateToolCallEvent(eventId: number, toolName: string, input: unknown): void {
    this.ctx.storage.sql.exec(
      "UPDATE transcript SET content = ?, tool_name = ?, input_json = ? WHERE id = ?",
      `Called ${toolName}`,
      toolName,
      safeJson(input),
      eventId,
    );
  }

  private broadcast(snapshot: PublicSnapshot): void {
    const message = JSON.stringify({ type: "snapshot", data: snapshot });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Unable to send update");
      }
    }
  }

  private broadcastTranscriptDelta(eventId: number, append: string): void {
    this.broadcastMessage({ type: "transcript-delta", data: { id: eventId, append } });
  }

  private broadcastTranscriptInput(eventId: number, input: unknown): void {
    this.broadcastMessage({ type: "transcript-input", data: { id: eventId, input } });
  }

  private broadcastMessage(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Unable to send update");
      }
    }
  }

  private async syncDirectory(snapshot: PublicSnapshot): Promise<void> {
    const lastMessage = [...snapshot.transcript]
      .reverse()
      .find((event) => event.role === "assistant" && event.kind === "message")?.content ?? null;
    try {
      await this.env.DB.prepare(
        `UPDATE lelems SET status = ?, budget_remaining = ?, total_spent = ?, total_tokens = ?,
         turn_count = ?, last_message = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(
          snapshot.lelem.status,
          snapshot.budget.remaining,
          snapshot.budget.spent,
          snapshot.totals.tokens,
          snapshot.totals.turns,
          lastMessage,
          snapshot.lelem.updatedAt,
          snapshot.lelem.id,
        )
        .run();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "directory_sync_failed",
          lelemId: snapshot.lelem.id,
          message: error instanceof Error ? error.message : "Unknown D1 error",
        }),
      );
    }
  }
}

function lelemStub(env: Env, id: string): DurableObjectStub<Lelem> {
  return env.LELEM.getByName(id) as DurableObjectStub<Lelem>;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/lelems") {
    const result = await env.DB.prepare("SELECT * FROM lelems ORDER BY updated_at DESC LIMIT 100").run<DirectoryRow>();
    return json({ lelems: result.results.map(publicDirectoryRow) });
  }

  if (request.method === "POST" && url.pathname === "/api/lelems") {
    const body = await readJson(request);
    const name = cleanString(body.name, "Name", 60);
    const systemPrompt = cleanString(body.systemPrompt, "System prompt", 8_000);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 120) : "openrouter/auto";
    const id = crypto.randomUUID();
    const slug = slugify(name);
    const createdAt = new Date().toISOString();
    const ownerToken = createControlToken();
    const ownerTokenHash = await controlTokenHash(ownerToken);

    await env.DB.prepare(
      `INSERT INTO lelems
       (id, slug, name, system_prompt, model, status, owner_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'awaiting_budget', ?, ?, ?)`,
    )
      .bind(id, slug, name, systemPrompt, model, ownerTokenHash, createdAt, createdAt)
      .run();
    await lelemStub(env, id).init({ id, slug, name, systemPrompt, model, createdAt });
    const row = await env.DB.prepare("SELECT * FROM lelems WHERE id = ?").bind(id).first<DirectoryRow>();
    return json({ lelem: row ? publicDirectoryRow(row) : null, ownerToken }, { status: 201 });
  }

  if (parts[0] === "api" && parts[1] === "lelems" && parts[2]) {
    const idOrSlug = decodeURIComponent(parts[2]);
    const row = await env.DB.prepare("SELECT * FROM lelems WHERE id = ? OR slug = ? LIMIT 1")
      .bind(idOrSlug, idOrSlug)
      .first<DirectoryRow>();
    if (!row) return apiError("Lelem not found.", 404);
    const stub = lelemStub(env, row.id);
    await stub.init({
      id: row.id,
      slug: row.slug,
      name: row.name,
      systemPrompt: row.system_prompt,
      model: row.model,
      createdAt: row.created_at,
    });

    if (request.method === "GET" && parts.length === 3) {
      return json({ snapshot: await stub.getSnapshot() });
    }

    if (request.method === "GET" && parts[3] === "live") {
      return stub.fetch(request);
    }

    if (request.method === "GET" && parts[3] === "transcript") {
      const before = Number(url.searchParams.get("before"));
      return json(await stub.getTranscriptPage(before));
    }

    if (request.method === "POST" && parts[3] === "donations") {
      const body = await readJson(request);
      const apiKey = cleanString(body.apiKey, "OpenRouter API key", 512);
      const donorLabel = typeof body.donorLabel === "string" ? body.donorLabel : "";
      return json({ snapshot: await stub.donate(apiKey, donorLabel) }, { status: 201 });
    }

    if (request.method === "POST" && parts[3] === "claim-local-owner") {
      if (!isLocalHostname(url.hostname) || row.id !== "00000000-0000-4000-8000-000000000001") {
        return apiError("Local ownership claim is unavailable.", 403);
      }
      const suppliedToken = bearerToken(request);
      if (await isValidControlToken(suppliedToken, row.owner_token_hash)) {
        return json({ ownerToken: suppliedToken });
      }
      const ownerToken = createControlToken();
      const ownerTokenHash = await controlTokenHash(ownerToken);
      await env.DB.prepare("UPDATE lelems SET owner_token_hash = ? WHERE id = ?").bind(ownerTokenHash, row.id).run();
      return json({ ownerToken }, { status: 201 });
    }

    if (request.method === "POST" && (parts[3] === "pause" || parts[3] === "resume")) {
      if (!(await isValidControlToken(bearerToken(request), row.owner_token_hash))) {
        return apiError("Owner control token is missing or invalid.", 403);
      }
      const snapshot = parts[3] === "pause" ? await stub.pause() : await stub.resume();
      return json({ snapshot });
    }

  }

  return apiError("API route not found.", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    try {
      return await handleApi(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      const status = message.includes("not configured") ? 503 : 400;
      return apiError(message, status);
    }
  },
} satisfies ExportedHandler<Env>;
