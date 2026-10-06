import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X, Gauge } from 'lucide-react';
import { api } from '../lib/api';
import { PROVIDERS, type ProviderQuota } from '../shared/types';
import { ago } from '../lib/format';
const demoQuotas = (): ProviderQuota[] =>
  ['claude', 'codex'].map((p, i) => ({
    provider: p as 'claude' | 'codex',
    state: 'ok',
    source: '합성 데모',
    checkedAt: Date.now(),
    message: '데모 수치 · 실제 계정을 조회하지 않아요.',
    windows: [
      { key: '5h', label: '5시간', usedPercent: 27 + i * 16, resetsAt: Date.now() + 7200_000 },
      {
        key: 'week',
        label: '일주일',
        usedPercent: 61 - i * 15,
        resetsAt: Date.now() + 86400_000 * 3,
      },
    ],
  }));
export function UsagePanel({
  demo,
  privacy,
  onClose,
}: {
  demo: boolean;
  privacy: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<ProviderQuota[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // On phones the dock follows the room in the page flow; bring it into view like the inspector.
    if (window.matchMedia('(max-width: 860px)').matches)
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  useEffect(() => {
    let alive = true;
    if (privacy) return;
    setBusy(true);
    setError('');
    (demo ? Promise.resolve(demoQuotas()) : api.quotas())
      .then((value) => {
        if (alive) setData(value);
      })
      .catch(() => {
        if (alive) setError('사용량에 연결하지 못했어요. 다시 확인해 주세요.');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [demo, privacy, refresh]);
  return (
    <aside className="inspector usage-dock" aria-label="사용량과 잔여 한도" ref={panelRef}>
      <header>
        <div>
          <small>OFFICE ENERGY</small>
          <h2>
            <Gauge size={21} /> 사용량과 잔여 한도
          </h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="사용량 닫기">
          <X size={19} />
        </button>
      </header>
      {privacy ? (
        <p>화면 내용 숨기기가 켜져 있어요.</p>
      ) : (
        <>
          <p className="usage-intro">
            동료들이 함께 쓰는 계정의 여유를 확인해요.
            <br />
            세션별 작업량과 비용은 동료를 눌러 볼 수 있어요.
          </p>
          <button className="button" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} />
            {busy ? '확인하는 중…' : '한도 새로 확인'}
          </button>
          {busy && !data.length && <p role="status">연결된 계정에서 한도를 읽고 있어요.</p>}
          {error && <p role="alert">{error}</p>}
          {!busy && !error && !data.length && <p>연결과 설정에서 공급자를 켜 주세요.</p>}
          {data.map((q) => (
            <section className="quota-card" key={q.provider}>
              <div className="quota-title">
                <b>{PROVIDERS[q.provider].name}</b>
                <span>
                  {q.state === 'ok' ? '계정 전체' : q.state === 'error' ? '조회 실패' : '정보 없음'}
                </span>
              </div>
              {q.windows.map((w) => {
                const expired = w.resetsAt !== null && w.resetsAt <= Date.now();
                return (
                  <div className="quota-window" key={w.key}>
                    <div>
                      <span>{w.label}</span>
                      <strong>
                        {expired
                          ? '재확인 필요'
                          : `${Math.round((100 - w.usedPercent) * 10) / 10}% 남음`}
                      </strong>
                    </div>
                    <progress
                      aria-label={`${PROVIDERS[q.provider].name} ${w.label} 잔여량`}
                      value={expired ? 0 : 100 - w.usedPercent}
                      max={100}
                    />
                    <small>
                      {w.resetsAt
                        ? `${new Date(w.resetsAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 갱신 예정`
                        : '갱신 시각 미제공'}
                    </small>
                  </div>
                );
              })}
              <p>{q.message}</p>
              <small>
                {q.source} · {ago(q.checkedAt)} 확인
              </small>
            </section>
          ))}
          <p className="fine-print">
            버튼을 눌렀을 때만 조회해요. 1분 안에 다시 열면 최근 조회를 사용해요. 조회 실패를 잔여량
            0으로 해석하지 않아요.
          </p>
        </>
      )}
    </aside>
  );
}
