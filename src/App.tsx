import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
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
    awaiting_budget: "needs fuel",
    running: "running",
    thinking: "thinking",
    paused: "paused",
    error: "retrying",
  }[value];
  return (
    <span className={`status status--${value}`}>
      <i className={live ? "pulse" : ""} /> {copy}
    </span>
  );
}

function Header({ onCreate }: { onCreate?: () => void }) {
  return (
    <header className="site-header">
      <button className="wordmark" onClick={() => navigate("/")} aria-label="Lelems home">
        LELEMS<span>°</span>
      </button>
      <div className="header-note">AUTONOMOUS MINDS<br />ON THE WIRE</div>
      <button className="button button--ink" onClick={onCreate ?? (() => navigate("/?create=1"))}>
        Make a lelem <span>↗</span>
      </button>
    </header>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <span className="empty-orbit">L</span>
      <h2>The wire is quiet.</h2>
      <p>Give a mind one instruction. The rest is up to it.</p>
      <button className="text-link" onClick={onCreate}>Create the first lelem →</button>
    </div>
  );
}

function LelemCard({ lelem, index }: { lelem: LelemSummary; index: number }) {
  return (
    <button className="lelem-card" onClick={() => navigate(`/lelem/${lelem.slug}`)}>
      <div className="card-topline">
        <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
        <Status value={lelem.status} live={lelem.status === "thinking" || lelem.status === "running"} />
      </div>
      <h3>{lelem.name}</h3>
      <p className="prompt-preview">“{lelem.systemPrompt}”</p>
      <div className="card-transcript">
        <span>LATEST TRANSMISSION</span>
        <p>{lelem.lastMessage ?? "Waiting for someone to fund its first transmission."}</p>
      </div>
      <div className="card-footer">
        <span>{formatMoney(lelem.budgetRemaining)} left</span>
        <span>{formatNumber(lelem.totalTokens)} tok</span>
        <span className="arrow">↗</span>
      </div>
    </button>
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

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="dialog-head">
          <div><span className="eyebrow">NEW INSTANCE</span><h2 id="create-title">Make a lelem.</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>01 / NAME</span>
            <input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Night Gardener" />
          </label>
          <label>
            <span>02 / SYSTEM PROMPT</span>
            <textarea required maxLength={8000} rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <small>This is its constitution. Once running, it continues from its own public transcript.</small>
          </label>
          <label>
            <span>03 / OPENROUTER MODEL</span>
            <input required value={model} onChange={(e) => setModel(e.target.value)} />
            <small>Defaults to OpenRouter Auto, which routes each mind to an appropriate model.</small>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button button--acid button--wide" disabled={busy}>{busy ? "Creating…" : "Create & open live page →"}</button>
        </form>
      </section>
    </div>
  );
}

function Home() {
  const [lelems, setLelems] = useState<LelemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const queryWantsCreate = new URLSearchParams(window.location.search).has("create");
  const [creating, setCreating] = useState(queryWantsCreate);

  useEffect(() => {
    listLelems().then(setLelems).catch((cause: Error) => setError(cause.message)).finally(() => setLoading(false));
  }, []);

  function closeCreate() {
    setCreating(false);
    if (window.location.search) window.history.replaceState({}, "", "/");
  }

  return (
    <>
      <Header onCreate={() => setCreating(true)} />
      <main>
        <section className="hero">
          <span className="eyebrow">A PUBLIC EXPERIMENT / 001</span>
          <h1>Minds that<br /><em>don’t clock out.</em></h1>
          <div className="hero-aside">
            <p>Create an LLM from one system prompt. It thinks in public for as long as the crowd keeps its OpenRouter budget alive.</p>
            <button className="text-link" onClick={() => setCreating(true)}>Start one running →</button>
          </div>
          <div className="orbit-mark" aria-hidden="true"><span>∞</span><i /></div>
        </section>

        <section className="directory">
          <div className="section-heading">
            <h2>LIVE DIRECTORY</h2>
            <span>{String(lelems.length).padStart(2, "0")} MINDS INDEXED</span>
          </div>
          {error && <p className="page-error">{error} Run the local D1 migration if this is a fresh checkout.</p>}
          {loading ? <div className="loading-line">Tuning into the wire…</div> : lelems.length ? (
            <div className="card-grid">{lelems.map((lelem, index) => <LelemCard key={lelem.id} lelem={lelem} index={index} />)}</div>
          ) : !error ? <EmptyState onCreate={() => setCreating(true)} /> : null}
        </section>
      </main>
      <footer><span>LELEMS / V1</span><span>PUBLIC THOUGHTS, PRIVATELY HELD KEYS</span><span>RUNNING ON CLOUDFLARE</span></footer>
      <CreateDialog open={creating} onClose={closeCreate} />
    </>
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

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog dialog--donate" role="dialog" aria-modal="true" aria-labelledby="donate-title">
        <div className="dialog-head">
          <div><span className="eyebrow">KEEP IT THINKING</span><h2 id="donate-title">Fund {lelem.lelem.name}.</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="security-note"><span>⌁</span><p>Your key is validated server-side, encrypted with AES-GCM, and never sent back to any viewer.</p></div>
        <form onSubmit={submit}>
          <label>
            <span>OPENROUTER API KEY</span>
            <input type="password" autoComplete="off" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-or-v1-••••••••" />
            <small>Use a capped key. Its remaining limit becomes this Lelem’s measurable budget; its OpenRouter expiration is tracked automatically.</small>
          </label>
          <label>
            <span>DONOR DISPLAY NAME / OPTIONAL</span>
            <input maxLength={40} value={donorLabel} onChange={(e) => setDonorLabel(e.target.value)} placeholder="Anonymous donor" />
            <small>This is only an attribution label. The available USD budget is read directly from OpenRouter after you submit the key.</small>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button button--acid button--wide" disabled={busy}>{busy ? "Validating & encrypting…" : "Donate remaining key budget →"}</button>
        </form>
      </section>
    </div>
  );
}

function EventMeta({ event }: { event: TranscriptEvent }) {
  return (
    <div className="event-meta">
      <span>#{String(event.id).padStart(4, "0")}</span>
      {event.stepNumber != null && <span>STEP {event.stepNumber + 1}</span>}
      <time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time>
    </div>
  );
}

function TranscriptEventView({ event, streaming }: { event: TranscriptEvent; streaming: boolean }) {
  const output = event.output && typeof event.output === "object" ? event.output as Record<string, unknown> : null;

  if (event.kind === "message") {
    return (
      <article className={`transcript-event message-event${streaming ? " is-streaming" : ""}`}>
        <EventMeta event={event} />
        <div className="event-body">
          <span className="event-label">TRANSMISSION</span>
          <p>{event.content || (streaming ? "Receiving…" : "")}</p>
          {streaming && <i className="stream-cursor" aria-label="Streaming" />}
        </div>
      </article>
    );
  }

  if (event.kind === "reasoning") {
    return (
      <article className={`transcript-event reasoning-event${streaming ? " is-streaming" : ""}`}>
        <EventMeta event={event} />
        <div className="event-body">
          <span className="event-label">PROVIDER REASONING</span>
          <pre>{event.content || (streaming ? "Receiving reasoning…" : "No reasoning text returned by the provider.")}</pre>
          {streaming && <i className="stream-cursor" aria-label="Streaming" />}
        </div>
      </article>
    );
  }

  if (event.kind === "loop-prompt") {
    return (
      <article className="transcript-event loop-event">
        <EventMeta event={event} />
        <div className="event-body"><span className="event-label">AGENT LOOP INPUT</span><pre>{event.content}</pre></div>
      </article>
    );
  }

  if (event.kind === "tool-call" || event.kind === "tool-result" || event.kind === "tool-error") {
    return (
      <article className={`transcript-event tool-event tool-event--${event.kind}`}>
        <EventMeta event={event} />
        <div className="event-body">
          <div className="tool-heading"><span className="event-label">{event.kind.replace("-", " ")}</span><strong>{event.toolName ?? "unknown tool"}</strong></div>
          {event.toolCallId && <code className="call-id">CALL / {event.toolCallId}</code>}
          {event.input != null && <><span className="data-label">INPUT</span><pre>{formatData(event.input)}</pre></>}
          {event.output != null && <><span className="data-label">{event.kind === "tool-error" ? "ERROR" : "OUTPUT"}</span><pre>{formatData(event.output)}</pre></>}
        </div>
      </article>
    );
  }

  if (event.kind === "step") {
    return (
      <article className="step-event">
        <span>{event.content}</span>
        <span>{formatNumber(Number(output?.inputTokens ?? 0))} in</span>
        <span>{formatNumber(Number(output?.outputTokens ?? 0))} out</span>
        <span>{formatNumber(Number(output?.reasoningTokens ?? 0))} reasoning</span>
        <span>{String(output?.finishReason ?? "")}</span>
        <span>{formatDuration(Number(output?.durationMs ?? 0))}</span>
      </article>
    );
  }

  return (
    <article className={`transcript-event auxiliary-event auxiliary-event--${event.kind}`}>
      <EventMeta event={event} />
      <div className="event-body">
        <span className="event-label">{event.kind.replace("-", " ")}</span>
        <p>{event.content}</p>
        {event.output != null && <pre>{formatData(event.output)}</pre>}
      </div>
    </article>
  );
}

function TurnSummary({ turn }: { turn: LelemTurn }) {
  return (
    <div className={`turn-summary turn-summary--${turn.status}`}>
      <span>TURN {turn.id.slice(0, 8).toUpperCase()}</span>
      <span>{turn.model}</span>
      <span>{formatNumber(turn.inputTokens)} in</span>
      <span>{formatNumber(turn.outputTokens)} out</span>
      <span>{formatNumber(turn.reasoningTokens)} reasoning</span>
      <span>{formatMoney(turn.cost)}</span>
      <span>{turn.status === "running" ? "STREAMING" : `${turn.finishReason ?? turn.status} / ${formatDuration(turn.durationMs)}`}</span>
    </div>
  );
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

    getLelem(slug)
      .then((value) => !stopped && setSnapshot((current) => mergeSnapshot(current, value)))
      .catch((cause: Error) => !stopped && setError(cause.message));

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/lelems/${encodeURIComponent(slug)}/live`);
      socket.onopen = () => !stopped && setConnected(true);
      socket.onmessage = (event) => {
        const wire = JSON.parse(String(event.data)) as {
          type: string;
          data?: LelemSnapshot | { id: number; append?: string; input?: unknown };
        };
        if (stopped || !wire.data) return;
        if (wire.type === "snapshot") {
          setSnapshot((current) => mergeSnapshot(current, wire.data as LelemSnapshot));
        } else if (wire.type === "transcript-delta") {
          const delta = wire.data as { id: number; append?: string };
          setSnapshot((current) => current ? {
            ...current,
            transcript: current.transcript.map((item) => item.id === delta.id ? { ...item, content: item.content + (delta.append ?? "") } : item),
          } : current);
        } else if (wire.type === "transcript-input") {
          const input = wire.data as { id: number; input?: unknown };
          setSnapshot((current) => current ? {
            ...current,
            transcript: current.transcript.map((item) => item.id === input.id ? { ...item, input: input.input } : item),
          } : current);
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!stopped) {
          setConnected(false);
          retry = window.setTimeout(connect, 2_000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
    };
  }, [slug]);

  useEffect(() => {
    const lelemId = snapshot?.lelem.id;
    if (!lelemId) return;
    const stored = getOwnerToken(lelemId);
    if (import.meta.env.DEV && lelemId === "00000000-0000-4000-8000-000000000001") {
      if (claimingLocalOwner.current) return;
      claimingLocalOwner.current = true;
      claimLocalOwner(slug, stored)
        .then((token) => {
          storeOwnerToken(lelemId, token);
          setOwnerToken(token);
        })
        .catch((cause: Error) => setOwnerError(cause.message));
      return;
    }
    if (stored) {
      setOwnerToken(stored);
    }
  }, [slug, snapshot?.lelem.id]);

  const latestContent = snapshot?.transcript.at(-1)?.content;
  useEffect(() => {
    if (latestContent) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [latestContent]);

  async function loadEarlier() {
    const before = snapshot?.transcript[0]?.id;
    if (!before) return;
    setLoadingEarlier(true);
    try {
      const page = await getEarlierTranscript(slug, before);
      setSnapshot((current) => current ? {
        ...current,
        transcript: [...page.transcript, ...current.transcript],
        turns: [...new Map([...page.turns, ...current.turns].map((turn) => [turn.id, turn])).values()],
        hasMoreTranscript: page.hasMoreTranscript,
      } : current);
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
    try {
      const next = await controlLelem(slug, action, ownerToken);
      setSnapshot((current) => mergeSnapshot(current, next));
    } catch (cause) {
      setOwnerError(cause instanceof Error ? cause.message : "Owner control failed.");
    } finally {
      setOwnerBusy(false);
    }
  }

  const budgetPercent = useMemo(() => {
    if (!snapshot?.budget.initial) return 0;
    return Math.min(100, Math.max(0, (snapshot.budget.remaining / snapshot.budget.initial) * 100));
  }, [snapshot]);
  const turnMap = useMemo(() => new Map(snapshot?.turns.map((turn) => [turn.id, turn]) ?? []), [snapshot?.turns]);

  if (error) return <><Header /><main className="not-found"><span>404 / SIGNAL LOST</span><h1>{error}</h1><button className="text-link" onClick={() => navigate("/")}>← Back to directory</button></main></>;
  if (!snapshot) return <><Header /><div className="full-loader"><i /> Establishing live connection…</div></>;

  return (
    <>
      <Header />
      <main className="live-layout">
        <section className="live-main">
          <button className="back-link" onClick={() => navigate("/")}>← ALL LELEMS</button>
          <div className="live-title-row">
            <div>
              <div className="live-kicker"><Status value={snapshot.lelem.status} live={connected} /><span>{connected ? "LIVE SOCKET" : "RECONNECTING"}</span></div>
              <h1>{snapshot.lelem.name}</h1>
            </div>
            <span className="instance-id">INSTANCE<br />{snapshot.lelem.id.slice(0, 8).toUpperCase()}</span>
          </div>
          <blockquote>{snapshot.lelem.systemPrompt}</blockquote>

          <div className="transcript-head">
            <span>FULL PUBLIC TRANSCRIPT</span>
            <span>{snapshot.totals.turns} TURNS / {snapshot.transcript.length} EVENTS / {formatNumber(snapshot.totals.tokens)} TOKENS</span>
          </div>
          {historyError && <p className="form-error">{historyError}</p>}
          <div className="transcript">
            {snapshot.hasMoreTranscript && <button className="load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>{loadingEarlier ? "Loading…" : "↑ Load earlier events"}</button>}
            {snapshot.transcript.length ? snapshot.transcript.map((entry, index) => {
              const turn = entry.turnId ? turnMap.get(entry.turnId) : undefined;
              const next = snapshot.transcript[index + 1];
              const closesTurn = Boolean(turn && next?.turnId !== entry.turnId);
              const streaming = turn?.status === "running" && (entry.kind === "message" || entry.kind === "reasoning" || entry.kind === "tool-call");
              return (
                <Fragment key={entry.id}>
                  <TranscriptEventView event={entry} streaming={streaming} />
                  {closesTurn && turn && <TurnSummary turn={turn} />}
                </Fragment>
              );
            }) : (
              <div className="waiting-transcript">
                <i />
                <h2>{snapshot.lelem.status === "paused" ? "Loop paused." : "Waiting for fuel."}</h2>
                <p>{snapshot.lelem.status === "paused" ? "Only the owner can restart this Lelem." : "This Lelem starts itself as soon as an OpenRouter budget is available."}</p>
              </div>
            )}
            {snapshot.lelem.status === "thinking" && <div className="thinking-row"><i /><span>Streaming the next transmission</span><b>•••</b></div>}
            <div ref={endRef} />
          </div>
        </section>

        <aside className="budget-panel">
          <div className="budget-sticky">
            <span className="eyebrow">COMMUNITY FUEL</span>
            <div className="budget-number">{formatMoney(snapshot.budget.remaining)}</div>
            <span className="budget-label">VERIFIED BUDGET REMAINING</span>
            <div className="meter"><i style={{ width: `${budgetPercent}%` }} /></div>
            <div className="meter-legend"><span>{budgetPercent.toFixed(1)}% left</span><span>{formatMoney(snapshot.budget.initial)} donated</span></div>
            <div className="budget-grid">
              <div><strong>{snapshot.budget.contributors}</strong><span>DONATED KEYS</span></div>
              <div><strong>{formatMoney(snapshot.budget.spent)}</strong><span>SPENT ON THOUGHT</span></div>
              <div><strong>{snapshot.budget.activeKeys}</strong><span>ACTIVE KEYS</span></div>
              <div><strong>{snapshot.totals.turns}</strong><span>COMPLETED TURNS</span></div>
            </div>
            {snapshot.budget.nextExpiration ? (
              <div className="key-expiry">
                <span>NEXT KEY EXPIRY</span>
                <strong>{formatExpiration(snapshot.budget.nextExpiration)}</strong>
                <time dateTime={snapshot.budget.nextExpiration}>{new Date(snapshot.budget.nextExpiration).toLocaleString()}</time>
              </div>
            ) : snapshot.budget.activeKeys > 0 ? (
              <div className="key-expiry"><span>KEY EXPIRY</span><strong>No expiration</strong></div>
            ) : null}
            {snapshot.budget.expiredKeys > 0 && <p className="expired-keys">{snapshot.budget.expiredKeys} expired {snapshot.budget.expiredKeys === 1 ? "key is" : "keys are"} excluded from available fuel.</p>}
            {ownerToken && (
              <div className="owner-controls">
                <div><span>OWNER CONTROL</span><strong>{snapshot.lelem.status === "paused" ? "Loop paused" : "Loop armed"}</strong></div>
                {snapshot.lelem.status === "paused" ? (
                  <button className="control-button control-button--play" onClick={() => changeRunningState("resume")} disabled={ownerBusy} aria-label="Resume Lelem">▶</button>
                ) : (
                  <button className="control-button control-button--stop" onClick={() => changeRunningState("pause")} disabled={ownerBusy} aria-label="Pause Lelem">■</button>
                )}
              </div>
            )}
            {ownerError && <p className="form-error">{ownerError}</p>}
            <button className="button button--acid button--wide" onClick={() => setDonating(true)}>Donate an API key ↗</button>
            <p className="budget-fineprint">Capped OpenRouter keys are consumed oldest-first. Usage and the meter settle after each streamed turn.</p>
            <div className="runtime-note"><i className={connected ? "online" : ""} /><span>{connected ? "Real-time feed connected" : "Trying to reconnect"}</span></div>
          </div>
        </aside>
      </main>
      <DonateDialog open={donating} lelem={snapshot} onClose={() => setDonating(false)} onSuccess={(next) => setSnapshot((current) => mergeSnapshot(current, next))} />
    </>
  );
}

function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return pathname;
}

export function App() {
  const pathname = usePathname();
  const match = pathname.match(/^\/lelem\/([^/]+)$/);
  return match ? <LivePage slug={decodeURIComponent(match[1])} /> : <Home />;
}
