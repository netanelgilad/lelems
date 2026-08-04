export type LelemStatus = "awaiting_budget" | "running" | "thinking" | "paused" | "error";
export type TranscriptRole = "user" | "assistant" | "tool";
export type TranscriptKind =
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

export type LelemTurn = {
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
};

export type TranscriptEvent = {
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
};

export type TranscriptPage = {
  turns: LelemTurn[];
  transcript: TranscriptEvent[];
  hasMoreTranscript: boolean;
};

export type LelemSummary = {
  id: string;
  slug: string;
  name: string;
  systemPrompt: string;
  model: string;
  status: LelemStatus;
  budgetRemaining: number;
  totalSpent: number;
  totalTokens: number;
  turnCount: number;
  lastMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LelemSnapshot = TranscriptPage & {
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
    allowanceRemaining: number;
    initial: number;
    spent: number;
    contributors: number;
    activeKeys: number;
    unavailableKeys: number;
    expiredKeys: number;
    nextExpiration: string | null;
  };
  totals: { tokens: number; turns: number };
};
