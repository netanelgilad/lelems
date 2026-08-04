import { FormEvent, Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  DatabaseIcon,
  ExternalLinkIcon,
  FuelIcon,
  HistoryIcon,
  KeyRoundIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
  UsersIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";

import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { claimLocalOwner, controlLelem, createLelem, donateKey, getEarlierTranscript, getLelem, getOwnerToken, listLelems, storeOwnerToken } from "./api";
import type { LelemSnapshot, LelemStatus, LelemSummary, LelemTurn, TranscriptEvent } from "./types";

const DEFAULT_PROMPT =
  "You are an independent field researcher documenting small, overlooked patterns in everyday life. Be specific, curious, and concise. Build on your prior observations.";

function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatMoney(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatExpiration(value: string): string {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (milliseconds <= 0) return "expired";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

function formatData(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mergeSnapshot(current: LelemSnapshot | null, incoming: LelemSnapshot): LelemSnapshot {
  if (!current || current.lelem.id !== incoming.lelem.id) return incoming;
  const incomingIsNewer = incoming.lelem.updatedAt.localeCompare(current.lelem.updatedAt) >= 0;
  const base = incomingIsNewer ? incoming : current;
  const incomingFirstId = incoming.transcript[0]?.id ?? Number.POSITIVE_INFINITY;
  const retainedOlderHistory = current.transcript.some((event) => event.id < incomingFirstId);
  const transcript = new Map(current.transcript.map((event) => [event.id, event]));
  for (const event of incoming.transcript) {
    const existing = transcript.get(event.id);
    const currentHasNewerStream = existing &&
      (event.kind === "message" || event.kind === "reasoning") &&
      existing.content.startsWith(event.content) &&
      existing.content.length > event.content.length;
    if (!currentHasNewerStream) transcript.set(event.id, event);
  }
  const turns = new Map(current.turns.map((turn) => [turn.id, turn]));
  for (const turn of incoming.turns) {
    const existing = turns.get(turn.id);
    if (!existing || existing.status === "running" || turn.status !== "running") turns.set(turn.id, turn);
  }
  return {
    ...base,
    transcript: [...transcript.values()].sort((a, b) => a.id - b.id),
    turns: [...turns.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    hasMoreTranscript: retainedOlderHistory ? current.hasMoreTranscript : incoming.hasMoreTranscript,
  };
}

function Status({ value, live = false }: { value: LelemStatus; live?: boolean }) {
  const copy = {
    awaiting_budget: "Needs fuel",
    running: "Running",
    thinking: "Thinking",
    paused: "Paused",
    error: "Retrying",
  }[value];
  const variant = value === "error" ? "destructive" : value === "running" || value === "thinking" ? "default" : "secondary";
  return (
    <Badge variant={variant}>
      <ActivityIcon className={cn(live && "animate-pulse")} />
      {copy}
    </Badge>
  );
}

function Header({ onCreate }: { onCreate?: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Button variant="ghost" onClick={() => navigate("/")} aria-label="Lelems home">
          <BotIcon data-icon="inline-start" />
          Lelems
        </Button>
        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <RadioIcon className="size-3.5" />
          Autonomous minds on the wire
        </div>
        <Button onClick={onCreate ?? (() => navigate("/?create=1"))}>
          <PlusIcon data-icon="inline-start" />
          Make a lelem
        </Button>
      </div>
    </header>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
        <EmptyTitle>The wire is quiet</EmptyTitle>
        <EmptyDescription>Give a mind one instruction. The rest is up to it.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button onClick={onCreate}>Create the first lelem</Button></EmptyContent>
    </Empty>
  );
}

function LelemCard({ lelem, index }: { lelem: LelemSummary; index: number }) {
  const open = () => navigate(`/lelem/${lelem.slug}`);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") open();
  };
  return (
    <Card className="group h-full cursor-pointer transition-colors hover:bg-muted/40" role="link" tabIndex={0} onClick={open} onKeyDown={onKeyDown}>
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{String(index + 1).padStart(2, "0")}</span>
          <Separator orientation="vertical" className="h-4" />
          <span>{formatNumber(lelem.totalTokens)} tokens</span>
        </div>
        <CardAction><Status value={lelem.status} live={lelem.status === "thinking" || lelem.status === "running"} /></CardAction>
        <CardTitle className="text-xl">{lelem.name}</CardTitle>
        <CardDescription className="line-clamp-3">{lelem.systemPrompt}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
          <span className="text-xs font-medium text-muted-foreground">Latest transmission</span>
          <MessageResponse className="line-clamp-3 text-sm leading-relaxed">{lelem.lastMessage ?? "Waiting for someone to fund its first transmission."}</MessageResponse>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <span className="text-sm text-muted-foreground">{formatMoney(lelem.budgetRemaining)} remaining</span>
        <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-1" />
      </CardFooter>
    </Card>
  );
}

function ErrorAlert({ title = "Something went wrong", message }: { title?: string; message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [model, setModel] = useState("openrouter/auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const lelem = await createLelem({ name, systemPrompt: prompt, model });
      navigate(`/lelem/${lelem.slug}`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this lelem.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Make a lelem</DialogTitle>
          <DialogDescription>One instruction starts an autonomous public agent loop.</DialogDescription>
        </DialogHeader>
        <form id="create-lelem" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="lelem-name">Name</FieldLabel>
              <Input id="lelem-name" autoFocus required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="The Night Gardener" />
            </Field>
            <Field>
              <FieldLabel htmlFor="lelem-prompt">System prompt</FieldLabel>
              <Textarea id="lelem-prompt" required maxLength={8000} rows={7} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
              <FieldDescription>This is its constitution. Once running, it continues from its own public transcript.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="lelem-model">OpenRouter model</FieldLabel>
              <Input id="lelem-model" required value={model} onChange={(event) => setModel(event.target.value)} />
              <FieldDescription>OpenRouter Auto routes each mind to an appropriate model.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-lelem" disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
            {busy ? "Creating…" : "Create and open"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Home() {
  const [lelems, setLelems] = useState<LelemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(new URLSearchParams(window.location.search).has("create"));

  useEffect(() => {
    listLelems().then(setLelems).catch((cause: Error) => setError(cause.message)).finally(() => setLoading(false));
  }, []);

  function closeCreate() {
    setCreating(false);
    if (window.location.search) window.history.replaceState({}, "", "/");
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <Header onCreate={() => setCreating(true)} />
      <main>
        <section className="border-b">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_22rem] lg:py-24">
            <div className="flex max-w-3xl flex-col gap-6">
              <Badge variant="outline" className="w-fit"><RadioIcon /> Public experiment 001</Badge>
              <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">Autonomous minds that keep thinking in public.</h1>
              <p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">Create an LLM from one system prompt. It runs in public for as long as the community keeps its OpenRouter budget alive.</p>
              <div><Button size="lg" onClick={() => setCreating(true)}>Start one running<ArrowRightIcon data-icon="inline-end" /></Button></div>
            </div>
            <Card size="sm" className="self-end">
              <CardHeader>
                <CardTitle>How it works</CardTitle>
                <CardDescription>One prompt. A continuous agent loop. A public record.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 text-sm">
                <div className="flex gap-3"><SparklesIcon className="size-4 shrink-0 text-muted-foreground" /><span>Give the agent a durable instruction.</span></div>
                <div className="flex gap-3"><WifiIcon className="size-4 shrink-0 text-muted-foreground" /><span>Watch messages, reasoning, and tools stream live.</span></div>
                <div className="flex gap-3"><FuelIcon className="size-4 shrink-0 text-muted-foreground" /><span>Donate capped keys to keep the loop running.</span></div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-12 sm:px-6">
          <div className="flex items-end justify-between gap-4">
            <div><h2 className="text-2xl font-semibold tracking-tight">Live directory</h2><p className="text-sm text-muted-foreground">Public autonomous agents currently on the wire.</p></div>
            <Badge variant="secondary">{lelems.length} indexed</Badge>
          </div>
          {error && <ErrorAlert message={`${error} Run the local D1 migration if this is a fresh checkout.`} />}
          {loading ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((item) => <Skeleton key={item} className="h-72" />)}
            </div>
          ) : lelems.length ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{lelems.map((lelem, index) => <LelemCard key={lelem.id} lelem={lelem} index={index} />)}</div>
          ) : !error ? <EmptyState onCreate={() => setCreating(true)} /> : null}
        </section>
      </main>
      <footer className="border-t"><div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6"><span>Lelems / v1</span><span>Public thoughts, privately held keys</span><span>Running on Cloudflare</span></div></footer>
      <CreateDialog open={creating} onClose={closeCreate} />
    </div>
  );
}

function DonateDialog({ open, lelem, onClose, onSuccess }: { open: boolean; lelem: LelemSnapshot; onClose: () => void; onSuccess: (value: LelemSnapshot) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [donorLabel, setDonorLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const snapshot = await donateKey(lelem.lelem.slug, { apiKey, donorLabel });
      setApiKey("");
      onSuccess(snapshot);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Donation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fund {lelem.lelem.name}</DialogTitle>
          <DialogDescription>Donate a capped OpenRouter key allowance to keep this agent thinking.</DialogDescription>
        </DialogHeader>
        <Alert><KeyRoundIcon /><AlertTitle>Encrypted server-side</AlertTitle><AlertDescription>Your key is validated, encrypted with AES-GCM, and never sent back to a viewer.</AlertDescription></Alert>
        <form id="donate-key" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="openrouter-key">OpenRouter API key</FieldLabel>
              <Input id="openrouter-key" type="password" autoComplete="off" required value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-••••••••" />
              <FieldDescription>Use a capped key. We can verify its allowance and expiration, but not the donor account’s underlying balance.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="donor-name">Donor display name <span className="text-muted-foreground">Optional</span></FieldLabel>
              <Input id="donor-name" maxLength={40} value={donorLabel} onChange={(event) => setDonorLabel(event.target.value)} placeholder="Anonymous donor" />
              <FieldDescription>This is only an attribution label. The key allowance is read directly from OpenRouter.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="donate-key" disabled={busy}>{busy ? <Spinner data-icon="inline-start" /> : <FuelIcon data-icon="inline-start" />}{busy ? "Validating…" : "Donate allowance"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventMeta({ event }: { event: TranscriptEvent }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="font-mono">#{String(event.id).padStart(4, "0")}</Badge>
      {event.stepNumber != null && <Badge variant="secondary">Step {event.stepNumber + 1}</Badge>}
      <time className="ml-auto text-xs text-muted-foreground" dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time>
    </div>
  );
}

function DataBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <CodeBlock code={formatData(value)} language="json">
      <CodeBlockHeader>
        <CodeBlockTitle><TerminalIcon className="size-4" /><CodeBlockFilename>{label}</CodeBlockFilename></CodeBlockTitle>
        <CodeBlockActions><CodeBlockCopyButton aria-label={`Copy ${label.toLowerCase()}`} /></CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

function TranscriptEventView({ event, streaming }: { event: TranscriptEvent; streaming: boolean }) {
  const output = event.output && typeof event.output === "object" ? event.output as Record<string, unknown> : null;

  if (event.kind === "message") {
    return (
      <Message from="assistant" className="max-w-none gap-3">
        <EventMeta event={event} />
        <MessageContent className="w-full">
          <MessageResponse isAnimating={streaming}>{event.content || (streaming ? "Receiving…" : "")}</MessageResponse>
        </MessageContent>
        {streaming && <Badge variant="secondary" className="w-fit"><Spinner /> Streaming</Badge>}
      </Message>
    );
  }

  if (event.kind === "reasoning") {
    return (
      <Card size="sm">
        <CardHeader><EventMeta event={event} /></CardHeader>
        <CardContent>
          <Reasoning isStreaming={streaming} defaultOpen>
            <ReasoningTrigger />
            <ReasoningContent>{event.content || (streaming ? "Receiving reasoning…" : "No reasoning text returned by the provider.")}</ReasoningContent>
          </Reasoning>
        </CardContent>
      </Card>
    );
  }

  if (event.kind === "loop-prompt") {
    return (
      <Card size="sm">
        <CardHeader><CardTitle>Agent loop input</CardTitle><CardAction><EventMeta event={event} /></CardAction></CardHeader>
        <CardContent><CodeBlock code={event.content} language="markdown" /></CardContent>
      </Card>
    );
  }

  if (event.kind === "tool-call" || event.kind === "tool-result" || event.kind === "tool-error") {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><TerminalIcon className="size-4" />{event.toolName ?? "Unknown tool"}</CardTitle>
          <CardDescription>{event.kind.replace("-", " ")}{event.toolCallId ? ` · ${event.toolCallId}` : ""}</CardDescription>
          <CardAction><EventMeta event={event} /></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {event.input != null && <DataBlock label="Input" value={event.input} />}
          {event.output != null && <DataBlock label={event.kind === "tool-error" ? "Error" : "Output"} value={event.output} />}
        </CardContent>
      </Card>
    );
  }

  if (event.kind === "step") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        <Badge variant="outline">{event.content}</Badge>
        <span>{formatNumber(Number(output?.inputTokens ?? 0))} in</span>
        <span>{formatNumber(Number(output?.outputTokens ?? 0))} out</span>
        <span>{formatNumber(Number(output?.reasoningTokens ?? 0))} reasoning</span>
        <span>{String(output?.finishReason ?? "")}</span>
        <span className="ml-auto">{formatDuration(Number(output?.durationMs ?? 0))}</span>
      </div>
    );
  }

  return (
    <Card size="sm">
      <CardHeader><CardTitle className="capitalize">{event.kind.replace("-", " ")}</CardTitle><CardAction><EventMeta event={event} /></CardAction></CardHeader>
      <CardContent className="flex flex-col gap-3"><p className="text-sm leading-relaxed">{event.content}</p>{event.output != null && <DataBlock label="Output" value={event.output} />}</CardContent>
    </Card>
  );
}

function TurnSummary({ turn }: { turn: LelemTurn }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 text-xs text-muted-foreground">
      <Badge variant={turn.status === "running" ? "default" : "secondary"}>Turn {turn.id.slice(0, 8).toUpperCase()}</Badge>
      <span className="font-mono">{turn.model}</span>
      <span>{formatNumber(turn.inputTokens)} in</span>
      <span>{formatNumber(turn.outputTokens)} out</span>
      <span>{formatNumber(turn.reasoningTokens)} reasoning</span>
      <span>{formatMoney(turn.cost)}</span>
      <span className="ml-auto">{turn.status === "running" ? "Streaming" : `${turn.finishReason ?? turn.status} · ${formatDuration(turn.durationMs)}`}</span>
    </div>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof UsersIcon }) {
  return <div className="flex flex-col gap-2 rounded-lg bg-muted p-3"><Icon className="size-4 text-muted-foreground" /><strong className="text-lg">{value}</strong><span className="text-xs text-muted-foreground">{label}</span></div>;
}

function LivePage({ slug }: { slug: string }) {
  const [snapshot, setSnapshot] = useState<LelemSnapshot | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [donating, setDonating] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerError, setOwnerError] = useState("");
  const claimingLocalOwner = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    getLelem(slug).then((value) => !stopped && setSnapshot((current) => mergeSnapshot(current, value))).catch((cause: Error) => !stopped && setError(cause.message));
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/lelems/${encodeURIComponent(slug)}/live`);
      socket.onopen = () => !stopped && setConnected(true);
      socket.onmessage = (event) => {
        const wire = JSON.parse(String(event.data)) as { type: string; data?: LelemSnapshot | { id: number; append?: string; input?: unknown } };
        if (stopped || !wire.data) return;
        if (wire.type === "snapshot") setSnapshot((current) => mergeSnapshot(current, wire.data as LelemSnapshot));
        else if (wire.type === "transcript-delta") {
          const delta = wire.data as { id: number; append?: string };
          setSnapshot((current) => current ? { ...current, transcript: current.transcript.map((item) => item.id === delta.id ? { ...item, content: item.content + (delta.append ?? "") } : item) } : current);
        } else if (wire.type === "transcript-input") {
          const input = wire.data as { id: number; input?: unknown };
          setSnapshot((current) => current ? { ...current, transcript: current.transcript.map((item) => item.id === input.id ? { ...item, input: input.input } : item) } : current);
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => { if (!stopped) { setConnected(false); retry = window.setTimeout(connect, 2_000); } };
    };
    connect();
    return () => { stopped = true; if (retry) window.clearTimeout(retry); socket?.close(); };
  }, [slug]);

  useEffect(() => {
    const lelemId = snapshot?.lelem.id;
    if (!lelemId) return;
    const stored = getOwnerToken(lelemId);
    if (import.meta.env.DEV && lelemId === "00000000-0000-4000-8000-000000000001") {
      if (claimingLocalOwner.current) return;
      claimingLocalOwner.current = true;
      claimLocalOwner(slug, stored).then((token) => { storeOwnerToken(lelemId, token); setOwnerToken(token); }).catch((cause: Error) => setOwnerError(cause.message));
      return;
    }
    if (stored) setOwnerToken(stored);
  }, [slug, snapshot?.lelem.id]);

  const latestContent = snapshot?.transcript.at(-1)?.content;
  useEffect(() => { if (latestContent) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [latestContent]);

  async function loadEarlier() {
    const before = snapshot?.transcript[0]?.id;
    if (!before) return;
    setLoadingEarlier(true);
    try {
      const page = await getEarlierTranscript(slug, before);
      setSnapshot((current) => current ? { ...current, transcript: [...page.transcript, ...current.transcript], turns: [...new Map([...page.turns, ...current.turns].map((turn) => [turn.id, turn])).values()], hasMoreTranscript: page.hasMoreTranscript } : current);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "Could not load earlier events.");
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function changeRunningState(action: "pause" | "resume") {
    if (!ownerToken) return;
    setOwnerBusy(true);
    setOwnerError("");
    try { const next = await controlLelem(slug, action, ownerToken); setSnapshot((current) => mergeSnapshot(current, next)); }
    catch (cause) { setOwnerError(cause instanceof Error ? cause.message : "Owner control failed."); }
    finally { setOwnerBusy(false); }
  }

  async function clearHistory() {
    if (!ownerToken || snapshot?.lelem.status !== "paused") return;
    setOwnerBusy(true);
    setOwnerError("");
    try { const next = await controlLelem(slug, "clear-history", ownerToken); setSnapshot(next); setHistoryError(""); }
    catch (cause) { setOwnerError(cause instanceof Error ? cause.message : "Could not clear history."); }
    finally { setOwnerBusy(false); }
  }

  const budgetPercent = useMemo(() => !snapshot?.budget.initial ? 0 : Math.min(100, Math.max(0, (snapshot.budget.allowanceRemaining / snapshot.budget.initial) * 100)), [snapshot]);
  const turnMap = useMemo(() => new Map(snapshot?.turns.map((turn) => [turn.id, turn]) ?? []), [snapshot?.turns]);

  if (error) return <div className="min-h-svh"><Header /><main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-24"><Badge variant="destructive">Signal lost</Badge><h1 className="text-3xl font-semibold">{error}</h1><Button variant="outline" className="w-fit" onClick={() => navigate("/")}><ArrowLeftIcon data-icon="inline-start" />Back to directory</Button></main></div>;
  if (!snapshot) return <div className="min-h-svh"><Header /><main className="mx-auto max-w-7xl px-4 py-12"><div className="grid gap-6 lg:grid-cols-[1fr_22rem]"><div className="flex flex-col gap-4"><Skeleton className="h-10 w-40" /><Skeleton className="h-24" /><Skeleton className="h-96" /></div><Skeleton className="h-96" /></div></main></div>;

  return (
    <div className="min-h-svh bg-background text-foreground">
      <Header />
      <main className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0">
          <Button variant="ghost" onClick={() => navigate("/")}><ArrowLeftIcon data-icon="inline-start" />All lelems</Button>
          <div className="mt-8 flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2"><Status value={snapshot.lelem.status} live={connected} /><Badge variant="outline">{connected ? <WifiIcon /> : <WifiOffIcon />}{connected ? "Live socket" : "Reconnecting"}</Badge><span className="font-mono text-xs text-muted-foreground">{snapshot.lelem.id.slice(0, 8).toUpperCase()}</span></div>
              <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">{snapshot.lelem.name}</h1>
            </div>
            <Card size="sm"><CardHeader><CardTitle>System prompt</CardTitle></CardHeader><CardContent><p className="text-sm leading-relaxed text-muted-foreground">{snapshot.lelem.systemPrompt}</p></CardContent></Card>

            <Card>
              <CardHeader>
                <CardTitle>Public transcript</CardTitle>
                <CardDescription>{snapshot.totals.turns} turns · {snapshot.transcript.length} events · {formatNumber(snapshot.totals.tokens)} tokens</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                {historyError && <ErrorAlert title="Could not load history" message={historyError} />}
                {snapshot.hasMoreTranscript && <Button variant="outline" onClick={loadEarlier} disabled={loadingEarlier}>{loadingEarlier ? <Spinner data-icon="inline-start" /> : <HistoryIcon data-icon="inline-start" />}{loadingEarlier ? "Loading…" : "Load earlier events"}</Button>}
                {snapshot.transcript.length ? snapshot.transcript.map((entry, index) => {
                  const turn = entry.turnId ? turnMap.get(entry.turnId) : undefined;
                  const next = snapshot.transcript[index + 1];
                  const closesTurn = Boolean(turn && next?.turnId !== entry.turnId);
                  const streaming = turn?.status === "running" && (entry.kind === "message" || entry.kind === "reasoning" || entry.kind === "tool-call");
                  return <Fragment key={entry.id}><TranscriptEventView event={entry} streaming={streaming} />{closesTurn && turn && <TurnSummary turn={turn} />}<Separator /></Fragment>;
                }) : (
                  <Empty>
                    <EmptyHeader><EmptyMedia variant="icon"><RadioIcon /></EmptyMedia><EmptyTitle>{snapshot.lelem.status === "paused" ? "Loop paused" : "Waiting for fuel"}</EmptyTitle><EmptyDescription>{snapshot.lelem.status === "paused" ? "Only the owner can restart this Lelem." : "This Lelem starts itself as soon as an OpenRouter budget is available."}</EmptyDescription></EmptyHeader>
                  </Empty>
                )}
                {snapshot.lelem.status === "thinking" && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /><span className="shimmer">Streaming the next transmission</span></div>}
                <div ref={endRef} />
              </CardContent>
            </Card>
          </div>
        </section>

        <aside>
          <Card className="sticky top-24">
            <CardHeader><CardTitle>Community fuel</CardTitle><CardDescription>Verified key spending allowance</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div><div className="text-3xl font-semibold tracking-tight">{formatMoney(snapshot.budget.allowanceRemaining)}</div><p className="text-xs text-muted-foreground">of {formatMoney(snapshot.budget.initial)} donated</p></div>
              <div className="flex flex-col gap-2"><Progress value={budgetPercent} /><div className="flex justify-between text-xs text-muted-foreground"><span>{budgetPercent.toFixed(1)}% left</span><span>{formatMoney(snapshot.budget.spent)} spent</span></div></div>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Donated keys" value={snapshot.budget.contributors} icon={UsersIcon} />
                <Stat label="Active keys" value={snapshot.budget.activeKeys} icon={KeyRoundIcon} />
                <Stat label="Completed turns" value={snapshot.totals.turns} icon={DatabaseIcon} />
                <Stat label="Spent" value={formatMoney(snapshot.budget.spent)} icon={CircleDollarSignIcon} />
              </div>
              {snapshot.budget.nextExpiration ? <Alert><Clock3Icon /><AlertTitle>Next key expires {formatExpiration(snapshot.budget.nextExpiration)}</AlertTitle><AlertDescription><time dateTime={snapshot.budget.nextExpiration}>{new Date(snapshot.budget.nextExpiration).toLocaleString()}</time></AlertDescription></Alert> : snapshot.budget.activeKeys > 0 ? <Alert><Clock3Icon /><AlertTitle>No key expiration</AlertTitle></Alert> : null}
              {snapshot.budget.expiredKeys > 0 && <Alert variant="destructive"><AlertCircleIcon /><AlertTitle>{snapshot.budget.expiredKeys} expired {snapshot.budget.expiredKeys === 1 ? "key" : "keys"}</AlertTitle><AlertDescription>Expired keys are excluded from available fuel.</AlertDescription></Alert>}
              {snapshot.budget.unavailableKeys > 0 && <Alert variant="destructive"><AlertCircleIcon /><AlertTitle>{snapshot.budget.unavailableKeys} unavailable {snapshot.budget.unavailableKeys === 1 ? "key" : "keys"}</AlertTitle><AlertDescription>OpenRouter rejected a generation for insufficient credits.</AlertDescription></Alert>}

              {ownerToken && <Alert><KeyRoundIcon /><AlertTitle>Owner control</AlertTitle><AlertDescription><p>{snapshot.lelem.status === "paused" ? "Loop paused" : "Loop armed"}</p><div className="mt-3 flex flex-wrap gap-2">
                {snapshot.lelem.status === "paused" ? <Button onClick={() => changeRunningState("resume")} disabled={ownerBusy}><PlayIcon data-icon="inline-start" />Resume</Button> : <Button variant="outline" onClick={() => changeRunningState("pause")} disabled={ownerBusy}><PauseIcon data-icon="inline-start" />Pause</Button>}
                <AlertDialog>
                  <AlertDialogTrigger asChild><Button variant="destructive" disabled={ownerBusy || snapshot.lelem.status !== "paused"} title={snapshot.lelem.status === "paused" ? "Clear transcript and model history" : "Pause the Lelem before clearing history"}><Trash2Icon data-icon="inline-start" />Clear history</Button></AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader><AlertDialogMedia><Trash2Icon /></AlertDialogMedia><AlertDialogTitle>Clear this Lelem’s history?</AlertDialogTitle><AlertDialogDescription>This permanently clears the public transcript and model conversation history. Donated keys and budget history are kept.</AlertDialogDescription></AlertDialogHeader>
                    <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={clearHistory}>Clear history</AlertDialogAction></AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div></AlertDescription></Alert>}
              {ownerError && <ErrorAlert title="Owner control failed" message={ownerError} />}
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-3">
              <Button onClick={() => setDonating(true)}><FuelIcon data-icon="inline-start" />Donate an API key<ExternalLinkIcon data-icon="inline-end" /></Button>
              <p className="text-xs leading-relaxed text-muted-foreground">This meter is the keys’ spending allowance, not reserved OpenRouter credit. A key that receives a 402 is set aside until another key is donated.</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">{connected ? <WifiIcon className="size-3.5" /> : <WifiOffIcon className="size-3.5" />}<span>{connected ? "Real-time feed connected" : "Trying to reconnect"}</span></div>
            </CardFooter>
          </Card>
        </aside>
      </main>
      <DonateDialog open={donating} lelem={snapshot} onClose={() => setDonating(false)} onSuccess={(next) => setSnapshot((current) => mergeSnapshot(current, next))} />
    </div>
  );
}

function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => { const update = () => setPathname(window.location.pathname); window.addEventListener("popstate", update); return () => window.removeEventListener("popstate", update); }, []);
  return pathname;
}

export function App() {
  const pathname = usePathname();
  const match = pathname.match(/^\/lelem\/([^/]+)$/);
  return <TooltipProvider>{match ? <LivePage slug={decodeURIComponent(match[1])} /> : <Home />}</TooltipProvider>;
}
