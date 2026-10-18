import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUp,
  Search,
  LogOut,
  RefreshCw,
  MessageCircle,
  Building2,
  Smartphone,
} from 'lucide-react';
import type { MobileAgent, MobileDetail, MobileReceipt, MobileSnapshot } from '../shared/mobile';
import { conversationEvents, conversationKind } from '../shared/conversation';
import { MOODS } from '../shared/types';
import { m, setLocale, resolveLocale, getLocale } from '../shared/i18n';
import '../styles/tokens.css';
import './mobile.css';
setLocale(resolveLocale('auto', navigator.languages));
document.documentElement.lang = getLocale();
class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? m().mobile.badCode
        : status === 429
          ? m().mobile.rateLimit
          : m().mobile.connectionSend,
    );
  }
}
async function api<T>(route: string, value: unknown = {}): Promise<T> {
  const res = await fetch(`/mobile/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Office-Mobile': '1' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}
// randomUUID requires HTTPS; getRandomValues also works on the encrypted tailnet HTTP link.
function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const s = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const time = (at: number) =>
  new Date(at).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
const labels = {
  request: m().mobile.me,
  progress: m().mobile.progress,
  reply: m().mobile.reply,
  message: m().mobile.message,
  work: m().mobile.tools,
};
const safeLink = (href?: string) => (href && /^https?:\/\//i.test(href) ? href : undefined);
function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private tabs may deny storage; retain the in-memory draft. */
  }
}
function Avatar({ agent }: { agent: MobileAgent }) {
  return (
    <span className={`avatar ${agent.provider}`} aria-hidden="true">
      {agent.provider === 'claude' ? '✳' : agent.provider === 'codex' ? '⌘' : '◈'}
    </span>
  );
}
function Chat({
  agent,
  enabled,
  onBack,
  onExpired,
}: {
  agent: MobileAgent;
  enabled: boolean;
  onBack: () => void;
  onExpired: () => void;
}) {
  const [detail, setDetail] = useState<MobileDetail | null>(null);
  const [target, setTarget] = useState<{
    canSend: boolean;
    desktop: boolean;
    queues: boolean;
  } | null>(null);
  const [tools, setTools] = useState(false);
  const draftKey = `mobile:draft:${agent.id}`,
    pendingKey = `mobile:pending:${agent.id}`;
  const [draft, setDraft] = useState(() => load(draftKey, ''));
  const [pending, setPending] = useState<{ requestId: string; text: string } | null>(() =>
    load(pendingKey, null),
  );
  const [busy, setBusy] = useState(false),
    [olderBusy, setOlderBusy] = useState(false);
  const [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const live = useRef(true),
    scroller = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    initial = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const readVersion = useRef(0);
  const remote = agent.officeId !== 'local';
  const read = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const [next, targets] = await Promise.all([
        api<MobileDetail>('detail', { id: agent.id }),
        api<Record<string, typeof target>>('targets', { ids: [agent.id] }),
      ]);
      if (!live.current || version !== readVersion.current) return;
      setDetail((old) => {
        // Remote detail is a bounded snapshot, not pageable history. A server may
        // reduce sharing to excerpts at any refresh, so never retain old full text.
        if (remote) return { ...next, older: false };
        const head = next.events[0];
        const joins = head ? (old?.events.findIndex((e) => e.id === head.id) ?? -1) : -1;
        if (!old || !next.older || joins < 0) return next;
        const events = [...old.events.slice(0, joins), ...next.events];
        return {
          ...next,
          older: old.older || events.length > 1000,
          events: events.slice(-1000),
        };
      });
      setTarget(targets[agent.id] ?? null);
      setError('');
    } catch (e) {
      if (!live.current || version !== readVersion.current) return;
      if (remote) setDetail(null);
      setError(e instanceof Error ? e.message : m().mobile.connectionFailed);
      setTarget(null);
      if (e instanceof ApiError && e.status === 401) onExpired();
    }
  }, [agent.id, remote, onExpired]);
  useEffect(() => {
    live.current = true;
    let running = false;
    const poll = async () => {
      if (running || document.hidden) return;
      running = true;
      await read();
      running = false;
    };
    void poll();
    const timer = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      live.current = false;
      readVersion.current++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [read]);
  useEffect(() => {
    if (detail && (initial.current || atBottom.current)) {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
      initial.current = false;
    }
  }, [detail]);
  const older = async () => {
    const first = detail?.events[0];
    if (!first || olderBusy || remote) return;
    setOlderBusy(true);
    atBottom.current = false;
    const top = scroller.current?.scrollTop ?? 0,
      height = scroller.current?.scrollHeight ?? 0;
    try {
      const next = await api<MobileDetail>('detail', {
        id: agent.id,
        before: { id: first.id, at: first.at },
      });
      if (!live.current) return;
      setDetail((old) => {
        const events = new Map([...next.events, ...(old?.events ?? [])].map((e) => [e.id, e]));
        return { ...next, events: [...events.values()] };
      });
      requestAnimationFrame(() => {
        if (scroller.current)
          scroller.current.scrollTop = top + scroller.current.scrollHeight - height;
      });
    } catch {
      setError(m().mobile.olderFailed);
    } finally {
      if (live.current) setOlderBusy(false);
    }
  };
  const settle = (receipt: MobileReceipt, input: { requestId: string; text: string }) => {
    // An older unmounted chat must never clear a newer request or its draft.
    const held = load(pendingKey, pendingRef.current);
    if (held?.requestId !== input.requestId) return;
    if (receipt.status === 'sent') {
      if (load(draftKey, '') === input.text) save(draftKey, '');
      save(pendingKey, null);
      if (live.current) {
        setPending(null);
        if (draftRef.current === input.text) setDraft('');
        setNotice(m().mobile.sent);
        void read();
      }
    } else if (receipt.status === 'blocked') {
      save(pendingKey, null);
      if (live.current) {
        setPending(null);
        setNotice(m().mobile.draftOccupied);
      }
    } else if (live.current) setNotice(m().mobile.uncertain);
  };
  const send = async () => {
    if (busy || pending || !draft.trim() || !enabled || !target?.canSend) return;
    const input = { requestId: uuid(), text: draft };
    save(pendingKey, input);
    pendingRef.current = input;
    setPending(input);
    setBusy(true);
    setNotice(m().mobile.sending);
    try {
      settle(await api<MobileReceipt>('send', { id: agent.id, ...input }), input);
    } catch {
      if (live.current) setNotice(m().mobile.checkBelow);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const check = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      settle(await api<MobileReceipt>('receipt', { requestId: pending.requestId }), pending);
    } catch {
      setNotice(m().mobile.notConfirmed);
    } finally {
      setBusy(false);
    }
  };
  const events = conversationEvents(
    detail?.events.map((e) => ({ ...e, sourceRef: '' })) ?? [],
  ).filter((e) => tools || e.kind === 'user' || e.kind === 'assistant');
  const reason = agent.stale
    ? m().mobile.officeOffline
    : !enabled
      ? m().mobile.enableSend
      : !target?.canSend
        ? m().mobile.noTarget
        : target.desktop
          ? m().mobile.sendDesktop
          : target.queues
            ? m().mobile.sendQueue
            : m().mobile.sendTerminal;
  return (
    <section className="chat">
      <header className="chat-header">
        <button className="icon-button" aria-label={m().mobile.back} onClick={onBack}>
          <ArrowLeft size={22} />
        </button>
        <Avatar agent={agent} />
        <div>
          <h2>{agent.name}</h2>
          <p>
            {agent.office} · {agent.project}
          </p>
        </div>
      </header>
      <div className="chat-tools">
        <span>{MOODS[agent.status].label}</span>
        <label>
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} />{' '}
          {m().mobile.tools}
        </label>
      </div>
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <div
        className="messages"
        ref={scroller}
        onScroll={() => {
          const e = scroller.current!;
          atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80;
        }}
      >
        {detail?.older && (
          <button
            className="older"
            disabled={olderBusy || detail.events.length >= 1000}
            onClick={() => void older()}
          >
            {olderBusy
              ? m().mobile.loading
              : detail.events.length >= 1000
                ? m().mobile.pageLimit
                : m().mobile.older}
          </button>
        )}
        {!detail && !error && <p className="empty">{m().mobile.loadingChat}</p>}
        {detail && !events.length && <p className="empty">{m().mobile.emptyChat}</p>}
        {events.map((e) => (
          <article className={`message ${e.kind === 'user' ? 'mine' : ''}`} key={e.id}>
            <div className="message-meta">
              {labels[conversationKind(e)]} · {time(e.at)}
              {e.excerpt && m().mobile.excerpt}
            </div>
            <div className="message-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: () => null,
                  a: ({ href, children }) =>
                    safeLink(href) ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ) : (
                      <span>{children}</span>
                    ),
                }}
              >
                {e.text}
              </ReactMarkdown>
            </div>
          </article>
        ))}
      </div>
      <footer className="composer">
        <p className="send-reason">{reason}</p>
        {notice && <p role="status">{notice}</p>}
        {pending && !busy && (
          <div className="recovery">
            <button onClick={() => void check()}>{m().mobile.checkReceipt}</button>
            <button
              onClick={() => {
                save(pendingKey, null);
                setPending(null);
                setNotice(m().mobile.retryHint);
              }}
            >
              {m().mobile.checkedOriginal}
            </button>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label={m().mobile.message}
            placeholder={m().mobile.placeholder}
            maxLength={20000}
            rows={2}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              save(draftKey, e.target.value);
            }}
          />
          <button
            className="send-button"
            type="submit"
            aria-label={m().mobile.send}
            disabled={
              busy || !!pending || !enabled || !target?.canSend || agent.stale || !draft.trim()
            }
          >
            <ArrowUp size={22} />
          </button>
        </form>
      </footer>
    </section>
  );
}
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [loginBusy, setLoginBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [office, setOffice] = useState(''),
    [project, setProject] = useState(''),
    [status, setStatus] = useState('all');
  const authGeneration = useRef(0),
    loggingOut = useRef(false);
  const expired = useCallback(() => {
    authGeneration.current++;
    setAuthenticated(false);
    setSnapshot(null);
    setSelected(null);
  }, []);
  const refresh = useCallback(async () => {
    if (loggingOut.current) return;
    const generation = authGeneration.current;
    try {
      const s = await api<MobileSnapshot>('state');
      if (generation !== authGeneration.current || loggingOut.current) return;
      setSnapshot(s);
      setAuthenticated(true);
      setError('');
      if (s.privacy) setSelected(null);
    } catch (e) {
      if (generation !== authGeneration.current || loggingOut.current) return;
      if (e instanceof ApiError && e.status === 401) expired();
      else {
        setError(m().mobile.disconnected);
        setAuthenticated((v) => (v === null ? false : v));
      }
    }
  }, [expired]);
  useEffect(() => {
    let running = false;
    const poll = async () => {
      if (running || document.hidden) return;
      running = true;
      await refresh();
      running = false;
    };
    void poll();
    const t = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh]);
  const login = async () => {
    authGeneration.current++;
    setLoginBusy(true);
    try {
      await api('login', { accessCode: code.trim() });
      authGeneration.current++;
      setCode('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : m().mobile.connectionFailed);
    } finally {
      setLoginBusy(false);
    }
  };
  if (!authenticated)
    return (
      <main className="login">
        <div className="login-mark">
          <Smartphone size={32} />
        </div>
        <p className="eyebrow">AGENT OFFICE</p>
        <h1>
          {m().mobile.welcomeFirst}
          <br />
          {m().mobile.welcomeLast}
        </h1>
        <p>
          {m().mobile.codeHintFirst}
          <br />
          {m().mobile.codeHintLast}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <label htmlFor="code">{m().mobile.accessCode}</label>
          <input
            id="code"
            type="password"
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="primary" disabled={loginBusy || !code.trim()}>
            {loginBusy ? m().mobile.connecting : m().mobile.connect}
          </button>
        </form>
        {error && (
          <p role="alert" className="banner">
            {error}
          </p>
        )}
        <small>
          {m().mobile.tailnetHint}
          <br />
          {m().mobile.expiryHint}
        </small>
      </main>
    );
  const all = snapshot?.agents ?? [],
    chosen = all.find((a) => a.id === selected);
  const offices = [...new Map(all.map((a) => [a.officeId, a.office])).entries()];
  const projects = [
    ...new Set(all.filter((a) => !office || a.officeId === office).map((a) => a.project)),
  ].sort();
  const agents = all
    .filter(
      (a) =>
        (!office || a.officeId === office) &&
        (!project || a.project === project) &&
        (status === 'all' ||
          (status === 'working'
            ? ['work', 'think'].includes(a.status)
            : ['call', 'error'].includes(a.status))) &&
        [a.name, a.project, a.office, ...a.tags]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => MOODS[a.status].rank - MOODS[b.status].rank || b.updatedAt - a.updatedAt);
  return (
    <main className={`mobile-app ${chosen ? 'has-chat' : ''}`}>
      <section className="roster">
        <header className="roster-header">
          <div>
            <p className="eyebrow">AGENT OFFICE</p>
            <h1>{m().mobile.ourOffice}</h1>
          </div>
          <div className="header-actions">
            <button
              className="icon-button"
              aria-label={m().mobile.refresh}
              onClick={() => void refresh()}
            >
              <RefreshCw size={19} />
            </button>
            <button
              className="icon-button"
              aria-label={m().mobile.logout}
              onClick={async () => {
                loggingOut.current = true;
                authGeneration.current++;
                try {
                  await api('logout');
                  try {
                    sessionStorage.clear();
                  } catch {
                    /* A blocked store must not prevent logout. */
                  }
                  expired();
                } catch {
                  setError(m().mobile.logoutFailed);
                } finally {
                  loggingOut.current = false;
                }
              }}
            >
              <LogOut size={19} />
            </button>
          </div>
        </header>
        {error && (
          <p role="alert" className="banner">
            {error}
          </p>
        )}
        <div className="overview">
          <span>
            <i className={error ? 'offline-dot' : 'online-dot'} />
            {error ? m().mobile.offline : m().mobile.live}
          </span>
          <strong>
            {all.length}
            <small> {m().mobile.colleagues}</small>
          </strong>
        </div>
        <div className="filters">
          <div className="search">
            <Search size={18} />
            <input
              aria-label={m().mobile.searchLabel}
              placeholder={m().mobile.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-row">
            <select
              aria-label={m().mobile.office}
              value={office}
              onChange={(e) => {
                setOffice(e.target.value);
                setProject('');
              }}
            >
              <option value="">{m().mobile.allOffices}</option>
              {offices.map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label={m().mobile.project}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">{m().mobile.allProjects}</option>
              {projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
          <nav aria-label={m().mobile.workStatus}>
            {[
              ['all', m().mobile.all],
              ['working', m().mobile.working],
              ['attention', m().mobile.attention],
            ].map(([value, label]) => (
              <button aria-pressed={status === value} key={value} onClick={() => setStatus(value)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="agent-list">
          {snapshot?.privacy ? (
            <div className="empty">
              <Building2 />
              <h2>{m().mobile.privacy}</h2>
              <p>
                {m().mobile.privacyFirst}
                <br />
                {m().mobile.privacyLast}
              </p>
            </div>
          ) : !agents.length ? (
            <p className="empty">{m().mobile.emptyAgents}</p>
          ) : (
            agents.map((a) => (
              <button
                className={`agent ${selected === a.id ? 'selected' : ''}`}
                onClick={() => setSelected(a.id)}
                key={a.id}
              >
                <Avatar agent={a} />
                <div className="agent-main">
                  <div className="agent-heading">
                    <h2>{a.name}</h2>
                    <span className={`state ${a.status}`}>
                      {a.stale ? m().mobile.offline : MOODS[a.status].label}
                    </span>
                  </div>
                  <p className="agent-project">
                    {a.office} · {a.project}
                  </p>
                  <p className="agent-preview">{a.preview || m().mobile.recentHint}</p>
                  <div className="agent-meta">
                    <span>
                      {a.provider}
                      {a.tags.length ? ` · ${a.tags.join(' · ')}` : ''}
                    </span>
                    <time>{time(a.updatedAt)}</time>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
        <footer className="roster-footer">
          {snapshot?.lastSync
            ? `${time(snapshot.lastSync)} ${m().mobile.synced}`
            : m().mobile.waitingRecords}
        </footer>
      </section>
      {chosen ? (
        <Chat
          key={chosen.id}
          agent={chosen}
          enabled={!!snapshot?.sendEnabled && !error}
          onBack={() => setSelected(null)}
          onExpired={expired}
        />
      ) : (
        <section className="chat-placeholder">
          <MessageCircle size={36} />
          <h2>{m().mobile.selectAgent}</h2>
          <p>{m().mobile.selectHint}</p>
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
