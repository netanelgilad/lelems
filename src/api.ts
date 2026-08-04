import type { LelemSnapshot, LelemSummary, TranscriptPage } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function ownerTokenKey(lelemId: string): string {
  return `lelem-owner:${lelemId}`;
}

export function getOwnerToken(lelemId: string): string | null {
  try {
    return window.localStorage.getItem(ownerTokenKey(lelemId));
  } catch {
    return null;
  }
}

export function storeOwnerToken(lelemId: string, token: string): void {
  try {
    window.localStorage.setItem(ownerTokenKey(lelemId), token);
  } catch {
    // The controls remain unavailable when browser storage is disabled.
  }
}

export async function listLelems(): Promise<LelemSummary[]> {
  return (await request<{ lelems: LelemSummary[] }>("/api/lelems")).lelems;
}

export async function createLelem(input: {
  name: string;
  systemPrompt: string;
  model: string;
}): Promise<LelemSummary> {
  const result = await request<{ lelem: LelemSummary; ownerToken: string }>("/api/lelems", {
    method: "POST",
    body: JSON.stringify(input),
  });
  storeOwnerToken(result.lelem.id, result.ownerToken);
  return result.lelem;
}

export async function getLelem(idOrSlug: string): Promise<LelemSnapshot> {
  return (await request<{ snapshot: LelemSnapshot }>(`/api/lelems/${encodeURIComponent(idOrSlug)}`)).snapshot;
}

export async function donateKey(
  idOrSlug: string,
  input: { apiKey: string; donorLabel: string },
): Promise<LelemSnapshot> {
  return (
    await request<{ snapshot: LelemSnapshot }>(`/api/lelems/${encodeURIComponent(idOrSlug)}/donations`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).snapshot;
}

export async function getEarlierTranscript(idOrSlug: string, before: number): Promise<TranscriptPage> {
  return request<TranscriptPage>(
    `/api/lelems/${encodeURIComponent(idOrSlug)}/transcript?before=${encodeURIComponent(String(before))}`,
  );
}

export async function claimLocalOwner(idOrSlug: string, currentToken: string | null): Promise<string> {
  const result = await request<{ ownerToken: string }>(
    `/api/lelems/${encodeURIComponent(idOrSlug)}/claim-local-owner`,
    {
      method: "POST",
      headers: currentToken ? { authorization: `Bearer ${currentToken}` } : undefined,
    },
  );
  return result.ownerToken;
}

export async function controlLelem(
  idOrSlug: string,
  action: "pause" | "resume",
  ownerToken: string,
): Promise<LelemSnapshot> {
  return (
    await request<{ snapshot: LelemSnapshot }>(`/api/lelems/${encodeURIComponent(idOrSlug)}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    })
  ).snapshot;
}
