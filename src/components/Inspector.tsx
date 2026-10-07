import { branchInfo } from '../shared/branch';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  X,
  Pin,
  ExternalLink,
  Folder,
  GitBranch,
  Clock,
  Copy,
  PackageOpen,
  Check,
  Pencil,
  Archive,
  RefreshCw,
  ArrowRight,
  FileText,
  Download,
  Terminal,
  LayoutGrid,
} from 'lucide-react';
import type { Session, SessionPatch, Handoff, OfficeNotice, ZoneRule } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import { sessionScopeLabel } from '../shared/residents';
import { Sprite } from './Sprite';
import { Modal } from './Modal';
import { ago, compact, shortPath, time, date } from '../lib/format';
import { api, isDesktop } from '../lib/api';
import { Conversation } from './Conversation';
import { ArtifactCards } from './ArtifactCards';
import { sessionName, parentSession } from '../shared/office';
import { NowCard, nowState } from './NowCard';
import { unreadNoticeCount } from '../shared/notices';
import { NewsFeed, type ReceiptHandler } from './News';
import { presentSession, PHASE_LABELS } from '../shared/presentation';
import { zoneLabel } from '../shared/zones';
import { ZoneEditor } from './ZoneEditor';
import { TerminalSend } from './TerminalSend';
import { useSendTargets } from '../lib/useSendTargets';
export function Inspector({
  session,
  sessions,
  notices,
  memberIds,
  onReceipt,
  onSelect,
  showNews,
  onClose,
  onPatch,
  onReturn,
  notify,
  demo,
  privacy,
  zoneRules,
  onZoneRules,
  terminalSend = false,
}: {
  session: Session;
  sessions: Session[];
  notices: OfficeNotice[];
  /** All runs of the colleague in the room, so the now card matches the roster. */
  memberIds?: string[];
  onReceipt: ReceiptHandler;
  onSelect: (id: string) => void;
  showNews?: string | null;
  onClose: () => void;
  onReturn: (id: string) => void;
  onPatch: (id: string, p: SessionPatch) => Promise<void>;
  notify: (s: string) => void;
  demo: boolean;
  privacy: boolean;
  zoneRules?: ZoneRule[];
  onZoneRules?: (rules: ZoneRule[]) => Promise<void>;
  terminalSend?: boolean;
}) {
  const [s, setS] = useState(session);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panelRef.current!;
    el.focus({ preventScroll: true });
    // On phones the card follows the room in the page flow; bring it into view.
    if (window.matchMedia('(max-width: 860px)').matches)
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [session.id]);
  const [tab, setTab] = useState<'overview' | 'history' | 'notes' | 'news'>('history');
  useEffect(() => {
    if (tab !== 'history') {
      const scroller = panelRef.current?.querySelector('.inspector-scroll');
      if (scroller) scroller.scrollTop = 0;
    }
  }, [tab, session.id]);
  const [alias, setAlias] = useState(session.alias);
  const [editing, setEditing] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [notes, setNotes] = useState(session.notes);
  const [notesDirty, setNotesDirty] = useState(false);
  const [packet, setPacket] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let valid = true;
    setS((previous) =>
      previous.id === session.id
        ? {
            ...previous,
            ...session,
            events: [
              ...new Map([...previous.events, ...session.events].map((e) => [e.id, e])).values(),
            ]
              .sort((a, b) => a.at - b.at)
              .slice(-180),
          }
        : session,
    );
    setLoadError('');
    if (!demo)
      api
        .detail(session.id)
        .then((s) => {
          if (valid) setS(s);
        })
        .catch((e) => {
          if (valid) setLoadError(e.message);
        });
    return () => {
      valid = false;
    };
  }, [
    session.id,
    session.revision,
    session.events,
    session.alias,
    session.notes,
    session.pinned,
    session.archived,
    session.completed,
    session.area?.ruleId,
    session.area?.name,
    demo,
  ]);
  useEffect(() => {
    setAlias(session.alias);
    setNotes(session.notes);
    setNotesDirty(false);
    setEditing(false);
    setZoneOpen(false);
    setTab('history');
    setPacket(null);
  }, [session.id]);
  useEffect(() => {
    if (showNews) setTab('news');
  }, [showNews]);
  useEffect(() => {
    if (!notesDirty) setNotes(session.notes);
  }, [session.notes, notesDirty]);
  useEffect(() => {
    if (!editing) setAlias(session.alias);
  }, [session.alias, editing]);
  // Where a follow-up can go (live Orca/tmux terminal or Codex CLI queue), shared with the
  // office bubbles. Keyed by session, so a switch never shows the previous colleague's target.
  const locatable = !demo && (session.provider === 'claude' || session.provider === 'codex');
  const { targets, markSent } = useSendTargets(locatable ? [session.id] : [], {
    enabled: locatable,
    stamp: session.updatedAt,
  });
  const live = targets[session.id] ?? null;
  const closePacket = useCallback(() => setPacket(null), []);
  const patch = async (p: SessionPatch) => {
    try {
      await onPatch(s.id, p);
      if (p.notes !== undefined) setNotesDirty(false);
      notify('기록해 두었어요');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const handoff = async () => {
    setBusy(true);
    try {
      const result = demo
        ? {
            markdown: `# ${s.title}\n\n데모 인수인계입니다. 실제 세션에서 업무 근거를 묶어 보세요.\n\n${s.notes}`,
            revision: s.revision,
            createdAt: Date.now(),
          }
        : await api.handoff(s.id, s.revision);
      setPacket(result);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('클립보드에 복사했어요');
    } catch {
      notify('복사 권한이 없어요. 파일로 저장해 주세요.');
    }
  };
  const parent = parentSession(s, sessions);
  const children = sessions.filter((x) => parentSession(x, sessions)?.id === s.id);
  const personaRuns = s.actor
    ? sessions.filter((x) => x.actor?.id === s.actor!.id).sort((a, b) => b.updatedAt - a.updatedAt)
    : [];
  const news = notices.filter((n) => n.sessionId === s.id);
  const members = new Set(memberIds ?? [s.id]);
  const colleagueNews = notices.filter((n) => members.has(n.sessionId) || n.sessionId === s.id);
  const state = nowState(s, colleagueNews);
  const resumeLabel = live?.canFocus
    ? `${live.kind === 'orca' ? 'Orca' : 'tmux'}로 이동`
    : live?.kind === 'codex'
      ? '재개 명령 복사'
      : s.provider === 'codex' && isDesktop
        ? 'Codex에서 열기'
        : '재개 명령 복사';
  const resume = async () => {
    try {
      if (api.jump) {
        const result = await api.jump(s.id);
        if (result.action === 'copy') await copy(result.text);
        else notify(result.text);
        return;
      }
      const value = await api.resume(s.id);
      if (s.provider !== 'codex' || !isDesktop) await copy(value);
      else notify(value);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const presentation = presentSession(s);
  return (
    <>
      <aside className="inspector" aria-label="동료의 업무 카드" ref={panelRef} tabIndex={-1}>
        <div className="inspector-top">
          <span className="inspector-crumb">
            <i style={{ background: PROVIDERS[s.provider].color }} />
            {PROVIDERS[s.provider].name}
            {s.agentName && !privacy ? <em> · {s.agentName}</em> : ''}
          </span>
          <div>
            <button
              className={`icon-btn ${s.pinned ? 'gold' : ''}`}
              aria-label={s.pinned ? '고정 해제' : '사무실에 고정'}
              title={s.pinned ? '고정 해제' : '사무실에 고정 · 자리를 지켜요'}
              onClick={() => patch({ pinned: !s.pinned })}
            >
              <Pin size={15} />
            </button>
            <button
              className="icon-btn"
              aria-label="업무 카드 닫기"
              title="닫기 · Esc"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="inspector-heading">
          <div className={`profile-avatar face-${s.provider} status-${s.status}`}>
            <Sprite provider={s.provider} mood={s.status} size={64} />
          </div>
          <div className="inspector-title">
            {editing ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await patch({ alias });
                  setEditing(false);
                }}
                className="name-editor"
              >
                <label className="sr-only" htmlFor="nickname">
                  새 별명
                </label>
                <input
                  autoFocus
                  id="nickname"
                  value={alias}
                  maxLength={60}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder="별명을 붙여 주세요"
                />
                <button className="icon-btn" type="submit" aria-label="별명 저장">
                  <Check size={17} />
                </button>
              </form>
            ) : (
              <h2>
                {privacy ? '내용을 숨긴 동료' : sessionName(s)}
                <button
                  className="icon-btn"
                  aria-label="이름 바꾸기"
                  title="별명 붙이기"
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={12} />
                </button>
              </h2>
            )}
            <p className="inspector-project">
              <Folder size={12} />
              <span>
                {privacy ? '프로젝트 숨김' : s.area ? `${s.area.name} · ${s.project}` : s.project}
              </span>
              {!privacy && onZoneRules && (
                <button
                  className={`zone-trigger ${zoneOpen ? 'active' : ''}`}
                  aria-expanded={zoneOpen}
                  title="이 동료를 직접 나눈 사무실 구역으로 보내요"
                  onClick={() => setZoneOpen((v) => !v)}
                >
                  <LayoutGrid size={11} />
                  구역
                </button>
              )}
              {s.alias && !privacy && <span title={s.title}>원래 이름 · {s.title}</span>}
            </p>
            <div className="status-line">
              <span className={`status-pill pill-${s.status}`}>
                <i style={{ background: MOODS[s.status].color }} />
                {MOODS[s.status].label}
              </span>
              <span>
                {ago(s.updatedAt)} ·{' '}
                {s.statusEvidence === 'derived' ? '기록 기반 추정' : '관측 기록'}
              </span>
            </div>
          </div>
        </div>
        {zoneOpen && !privacy && onZoneRules && (
          <ZoneEditor
            key={s.id}
            session={s}
            sessions={sessions}
            rules={zoneRules ?? []}
            onRules={onZoneRules}
            onClose={() => setZoneOpen(false)}
          />
        )}
        {!privacy && (
          <div className="relation-strip">
            <span title={branchInfo(s).detail}>
              <GitBranch size={12} />
              {branchInfo(s).label}
            </span>
            {parent && (
              <button onClick={() => onSelect(parent.id)}>
                {s.relation?.kind === 'fork' ? '분기 원본' : '부모 작업'} · {sessionName(parent)}
              </button>
            )}
            {!parent && s.relation?.parentNativeId && <span>부모 작업 미수집</span>}
          </div>
        )}
        {personaRuns.length > 0 && (
          <label className="persona-run-picker">
            <span>
              {privacy ? '페르소나' : s.actor?.name} · 실행 기록 {personaRuns.length}개
            </span>
            <select
              aria-label="페르소나의 실행 기록"
              value={s.id}
              onChange={(e) => onSelect(e.target.value)}
            >
              {personaRuns.map((run) => (
                <option value={run.id} key={run.id}>
                  {sessionScopeLabel(run)} · {privacy ? '숨긴 기록' : sessionName(run)} ·{' '}
                  {ago(run.updatedAt)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="inspector-now">
          <NowCard
            key={s.id}
            session={s}
            notices={colleagueNews}
            privacy={privacy}
            onReceipt={onReceipt}
            onResume={resume}
            resumeLabel={resumeLabel}
            canResume={!demo}
            canType={!!live && terminalSend}
            typeQueues={!!live?.queues}
            onShowNews={() => setTab('news')}
          />
          {live && (
            <TerminalSend
              key={s.id}
              target={live}
              enabled={terminalSend}
              privacy={privacy}
              onSend={async (text) => {
                const id = s.id;
                notify(await api.send!(id, text));
                markSent(id);
              }}
            />
          )}
        </div>
        <div className="inspector-tabs" role="tablist" aria-label="업무 카드 항목">
          {(['history', 'news', 'overview', 'notes'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'overview'
                ? '작업 정보'
                : t === 'history'
                  ? '대화'
                  : t === 'news'
                    ? `소식 ${unreadNoticeCount(news) || ''}`
                    : '기억 메모'}
              {t === 'notes' && s.notes && <i />}
            </button>
          ))}
        </div>
        <div className={`inspector-scroll ${tab === 'news' ? 'news-tab-scroll' : ''}`}>
          {!privacy && children.length > 0 && (
            <details className="related-runs">
              <summary>연결된 보조·분기 작업 {children.length}개</summary>
              {children.map((child) => (
                <button key={child.id} onClick={() => onSelect(child.id)}>
                  {child.relation?.kind === 'fork' ? '분기' : sessionScopeLabel(child)} ·{' '}
                  {sessionName(child)}
                </button>
              ))}
            </details>
          )}
          {loadError && <div className="inline-error">{loadError}</div>}

          {(tab === 'history' || tab === 'overview') && (
            <ArtifactCards
              id={s.id}
              urls={s.artifacts}
              demo={demo}
              privacy={privacy}
              notify={notify}
            />
          )}

          {privacy ? (
            <div className="privacy-placeholder">
              <Folder size={28} />
              <h3>공유할 땐, 잠시 숨겨요</h3>
              <p>상단의 눈 아이콘을 누르면 내용을 다시 볼 수 있어요.</p>
            </div>
          ) : tab === 'news' ? (
            <NewsFeed
              key={s.id + (showNews ?? '')}
              includeBackground
              initialFilter={showNews ? 'all' : 'final'}
              notices={news}
              sessions={sessions}
              privacy={privacy}
              onReceipt={onReceipt}
            />
          ) : tab === 'overview' ? (
            <>
              <p className="activity-evidence">현재 표시 · {s.statusReason}</p>
              <p className="activity-evidence">
                마지막 실행 관측 · {PHASE_LABELS[presentation.runtime.phase]} ·{' '}
                {ago(presentation.runtime.at)}
                {presentation.stale ? ' (현재 실행 여부는 미확인)' : ''}
                <br />
                {presentation.runtime.reason}
              </p>
              {s.relation?.role && <p className="activity-evidence">역할 · {s.relation.role}</p>}
              <section className="detail-section">
                <h3>일하고 있는 곳</h3>
                <dl>
                  <div>
                    <dt>
                      <Folder size={14} />
                      프로젝트
                    </dt>
                    <dd>{s.project}</dd>
                  </div>
                  <div>
                    <dt>
                      <LayoutGrid size={14} />
                      구역
                    </dt>
                    <dd>
                      {s.area ? `${zoneLabel(s)} · 직접 나눔` : `${s.project} · 프로젝트 기준`}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <GitBranch size={14} />
                      브랜치
                    </dt>
                    <dd title={branchInfo(s).detail}>{branchInfo(s).label}</dd>
                  </div>
                  <div>
                    <dt>
                      <Clock size={14} />
                      마지막 활동
                    </dt>
                    <dd>
                      {date(s.updatedAt)} {time(s.updatedAt)}
                    </dd>
                  </div>
                </dl>
                <button
                  className="path-copy"
                  onClick={() => copy(s.cwd ?? '')}
                  disabled={!s.cwd}
                  title={s.cwd ?? ''}
                >
                  <code>{shortPath(s.cwd)}</code>
                  <Copy size={13} />
                </button>
                <p className="fine-print">
                  세션 시작 기록의 위치예요. 실제 실행 위치는 아래에서 구분해요.
                </p>
              </section>
              {s.workingLocation && (
                <section className="detail-section working-location">
                  <h3>최근 실제 작업 위치</h3>
                  <code>{s.workingLocation.path}</code>
                  <p>
                    {s.workingLocation.source === 'tool-workdir'
                      ? '도구 실행 폴더'
                      : '명시적 cd 명령'}{' '}
                    · {new Date(s.workingLocation.at).toLocaleString('ko-KR')}
                  </p>
                  <small>
                    {s.workspace?.locationSource
                      ? 'Git 저장소를 확인해 팀과 책상 브랜치에 반영해요.'
                      : '위치 기록은 있지만 Git 저장소는 확인되지 않았어요.'}{' '}
                    PR 링크나 단순 파일 읽기로는 자리를 옮기지 않아요.
                  </small>
                </section>
              )}
              <section className="detail-section">
                <div className="section-title">
                  <h3>작업의 크기</h3>
                  <span className="small-badge">
                    {s.usage.scope === 'sample' ? '수집 구간' : '세션 누적'}
                  </span>
                </div>
                <div className="model-line">
                  <span className="model-symbol">✳</span>
                  <div>
                    <b>{s.model || '모델 정보 미수집'}</b>
                    <small>{s.usage.source}</small>
                  </div>
                </div>
                <div className="cost-card">
                  <span>이 동료가 쌓은 작업량</span>
                  <strong>
                    {s.cost?.usd != null
                      ? `$${s.cost.usd.toLocaleString('en-US', { minimumFractionDigits: s.cost.usd < 0.01 ? 4 : 2, maximumFractionDigits: s.cost.usd < 0.01 ? 4 : 2 })}`
                      : '비용 미확인'}
                  </strong>
                  <b>관측 누적 · API 기본 요금 환산</b>
                  <small>
                    {s.cost
                      ? `${s.cost.priced}개 계산 · ${s.cost.unpriced}개 모델 요금 미확인 · ${compact(s.cost.tokens)} 토큰 관측`
                      : '다음 수집부터 기록별 사용량을 쌓아요.'}
                  </small>
                  <p>
                    구독료나 실제 청구액이 아니에요. 수집한 기록만 누적하며, Fast·긴 문맥 할증·도구
                    비용은 제외해요.
                  </p>
                  <details>
                    <summary>계산 기준 보기</summary>
                    <p>
                      메시지별 모델·입출력·캐시 사용량을 현재 표준 기본 단가로 환산해요. 같은 기록은
                      중복 계산하지 않아요. 기록이 빠졌거나 요금표에 없는 모델은 합계에 포함하지
                      않아요.
                    </p>
                    <small>{s.cost?.rateVersion}</small>
                    <p>
                      <a
                        href="https://developers.openai.com/api/docs/pricing"
                        target="_blank"
                        rel="noreferrer"
                      >
                        OpenAI 요금표
                      </a>{' '}
                      ·{' '}
                      <a
                        href="https://platform.claude.com/docs/en/about-claude/pricing"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Claude 요금표
                      </a>
                    </p>
                  </details>
                </div>
                <div className="usage-grid">
                  <div>
                    <span>입력 토큰</span>
                    <strong>{compact(s.usage.input)}</strong>
                  </div>
                  <div>
                    <span>출력 토큰</span>
                    <strong>{compact(s.usage.output)}</strong>
                  </div>
                  <div>
                    <span>전체 토큰</span>
                    <strong>{compact(s.usage.total)}</strong>
                  </div>
                </div>
                {s.usage.contextUsed !== null &&
                s.usage.contextWindow !== null &&
                s.usage.contextWindow > 0 ? (
                  <div className="context">
                    <div>
                      <span>최근 입력 / 문맥 한도</span>
                      <b>
                        {Math.min(
                          100,
                          Math.round((s.usage.contextUsed / s.usage.contextWindow) * 100),
                        )}
                        %
                      </b>
                    </div>
                    <progress value={s.usage.contextUsed} max={s.usage.contextWindow} />
                    <small>최근 입력 기준의 근사치 · 누적 사용량과 달라요</small>
                  </div>
                ) : (
                  <p className="fine-print">현재 문맥 사용량은 이 기록에서 확인되지 않았어요.</p>
                )}
              </section>
              <section className="source-note">
                <span className="live-dot" />
                <div>
                  <b>
                    {s.sourceKind === 'sqlite'
                      ? '로컬 데이터베이스'
                      : s.sourceKind === 'demo'
                        ? '데모 데이터'
                        : '로컬 세션 기록'}
                  </b>
                  <p>
                    {s.partial
                      ? '용량을 제한해 처음과 최근 구간을 읽었어요.'
                      : '수집된 원본 구간을 바탕으로 보여드려요.'}
                  </p>
                  <p>원본은 읽기 전용으로 연결돼 있어요.</p>
                </div>
              </section>
            </>
          ) : tab === 'history' ? (
            <Conversation key={s.id} session={s} notices={news} notify={notify} />
          ) : (
            <div className="notes-editor">
              <span className="eyebrow">다음의 나에게</span>
              <h3>기억하고 싶은 맥락을 남겨요.</h3>
              <p>결정한 이유, 남은 일, 다음에 확인할 것을 적어두면 인수인계에 함께 담겨요.</p>
              <label className="sr-only" htmlFor="notes">
                업무 메모
              </label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setNotesDirty(true);
                }}
                maxLength={12000}
                placeholder="예: 캐시는 5분으로 정했어요. 다음 작업에서는 네트워크가 끊겼을 때를 확인해 주세요."
              />
              <button className="button primary" onClick={() => patch({ notes })}>
                <Check size={16} />
                메모 저장
              </button>
              <button
                className={`completion-button ${s.completed ? 'checked' : ''}`}
                onClick={() => patch({ completed: !s.completed })}
              >
                <span>{s.completed && <Check size={14} />}</span>
                <div>
                  <b>이 업무의 결과를 확인했어요</b>
                  <small>응답 상태와 별도로, 내가 직접 남기는 확인이에요.</small>
                </div>
              </button>
            </div>
          )}
        </div>
        <div className="inspector-actions">
          {s.zone && s.zone !== 'office' && (
            <button className="return-office" onClick={() => onReturn(s.id)}>
              사무실에 자리 마련하기 <ArrowRight size={14} />
            </button>
          )}
          {state === 'attention' ? (
            <button className="button primary" onClick={resume} disabled={demo}>
              <Terminal size={16} />
              {resumeLabel}
              <ArrowRight size={16} />
            </button>
          ) : (
            <button className="button primary" onClick={handoff} disabled={busy || privacy}>
              <PackageOpen size={17} />
              {busy ? '기록을 모으는 중…' : '인수인계 꾸리기'}
              <ArrowRight size={16} />
            </button>
          )}
          <div>
            {state === 'attention' ? (
              <button className="button subtle" onClick={handoff} disabled={busy || privacy}>
                <PackageOpen size={14} />
                {busy ? '기록을 모으는 중…' : '인수인계 꾸리기'}
              </button>
            ) : (
              <button className="button subtle" disabled={demo} onClick={resume}>
                <Terminal size={14} />
                {resumeLabel}
              </button>
            )}
            <button
              className="icon-btn"
              aria-label="원본 위치 열기"
              disabled={demo || !isDesktop}
              onClick={() => api.reveal(s.id).catch((e) => notify(e.message))}
            >
              <Folder size={16} />
            </button>
            <button
              className="icon-btn"
              aria-label={s.archived ? '보관 해제' : '세션 보관'}
              onClick={() => patch({ archived: !s.archived })}
            >
              <Archive size={16} />
            </button>
          </div>
        </div>
      </aside>
      {packet && (
        <Modal title="다음 동료에게 건네는 기록" onClose={closePacket} wide>
          <div className="handoff-intro">
            <PackageOpen size={24} />
            <div>
              <b>맥락을 이어서, 설명은 짧게.</b>
              <p>내용을 확인한 뒤 복사하거나 파일로 저장하세요.</p>
            </div>
          </div>
          <textarea
            className="handoff-text"
            aria-label="인수인계 내용"
            value={packet.markdown}
            onChange={(e) => setPacket({ ...packet, markdown: e.target.value })}
          />
          <div className="modal-footer">
            <span>다른 세션으로 자동 전송되지 않아요.</span>
            <button
              className="button subtle"
              onClick={async () => {
                try {
                  if (await api.exportFile('agent-office-handoff.md', packet.markdown))
                    notify('인수인계 파일을 저장했어요');
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              <Download size={15} />
              파일 저장
            </button>
            <button className="button primary" onClick={() => copy(packet.markdown)}>
              <Copy size={15} />
              복사하기
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
