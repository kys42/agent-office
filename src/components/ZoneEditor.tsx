import { useMemo, useState } from 'react';
import { LayoutGrid, Plus, Undo2 } from 'lucide-react';
import type { Session, ZoneRule } from '../shared/types';
import { projectKey } from '../shared/office';
import { ZONE_MATCH_LABELS, sendToZone, zoneCandidates, zoneOptions } from '../shared/zones';
import { shortPath } from '../lib/format';

/** Explicit office areas: pick an existing zone or name a new one, then choose who follows. */
export function ZoneEditor({
  session,
  sessions,
  rules,
  onRules,
  onClose,
  initialZone,
}: {
  session: Session;
  sessions: Session[];
  rules: ZoneRule[];
  onRules: (rules: ZoneRule[]) => Promise<void>;
  onClose: () => void;
  /** Zone key preselected by a drop; `null` opens a new zone. */
  initialZone?: string | null;
}) {
  const here = projectKey(session);
  const zones = useMemo(() => zoneOptions(sessions, rules), [sessions, rules]);
  const candidates = useMemo(() => zoneCandidates(session), [session]);
  const current = rules.find((r) => r.id === session.area?.ruleId);
  const known = current ? candidates.findIndex((c) => c.match === current.match) : -1;
  const initial = Math.max(0, known);
  const [zone, setZone] = useState<string | null>(
    initialZone !== undefined
      ? initialZone
      : (zones.find((z) => z.key !== here && z.custom)?.key ?? null),
  );
  const [name, setName] = useState('');
  const [scope, setScope] = useState(initial);
  const [value, setValue] = useState(known >= 0 ? current!.value : candidates[initial].value);
  const [busy, setBusy] = useState(false);
  const target = { ...candidates[scope], value: value.trim() };
  const editable = target.match === 'branch' || target.match === 'path';
  const label = name.trim();
  const chosen = zone ? zones.find((z) => z.key === zone) : null;
  const destination = chosen ?? (label ? { key: `area:${label}`, name: label } : null);
  const unchanged = destination?.key === here && !current;

  const save = async (next: ZoneRule[]) => {
    setBusy(true);
    try {
      await onRules(next);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="zone-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!destination || !target.value || unchanged) return;
        void save(sendToZone(session, rules, target, destination));
      }}
    >
      <div className="zone-editor-head">
        <LayoutGrid size={13} />
        <b>사무실 구역 나누기</b>
        <small>같은 구역의 동료는 한 바닥에 모여요</small>
      </div>
      <fieldset className="zone-picker">
        <legend>보낼 구역</legend>
        <div>
          {zones.map((z) => (
            <button
              type="button"
              key={z.key}
              aria-pressed={zone === z.key}
              className={`${z.custom ? 'custom' : ''} ${zone === z.key ? 'active' : ''}`}
              onClick={() => setZone(z.key)}
            >
              <span>{z.name}</span>
              <small>{z.key === here ? '지금' : z.custom ? `${z.count}명` : '프로젝트'}</small>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={zone === null}
            className={`new ${zone === null ? 'active' : ''}`}
            onClick={() => setZone(null)}
          >
            <Plus size={11} /> 새 구역
          </button>
        </div>
      </fieldset>
      {zone === null && (
        <label>
          새 구역 이름
          <input
            autoFocus
            value={name}
            maxLength={40}
            placeholder="예: agent-lab"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <fieldset>
        <legend>어떤 동료를 보낼까요</legend>
        {candidates.map((c, i) => (
          <label key={c.match} className={scope === i ? 'active' : ''}>
            <input
              type="radio"
              name="zone-scope"
              checked={scope === i}
              onChange={() => {
                setScope(i);
                setValue(c.value);
              }}
            />
            <span>{ZONE_MATCH_LABELS[c.match]}</span>
            <code title={c.value}>
              {c.match === 'session'
                ? '지금 보는 세션'
                : c.match === 'branch'
                  ? c.value
                  : shortPath(c.value)}
            </code>
          </label>
        ))}
      </fieldset>
      {editable && (
        <label>
          {target.match === 'branch' ? '브랜치 패턴' : '폴더 경로'}
          <input value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          <small>
            {target.match === 'branch'
              ? '끝에 *를 붙이면 앞부분이 같은 브랜치를 모두 보내요 (예: kys42/lab-*)'
              : '이 폴더와 하위 폴더에서 일하는 동료를 보내요'}
          </small>
        </label>
      )}
      <p className="fine-print">
        {target.repo ? '같은 저장소 안에서만 적용돼요. ' : ''}앞으로 새로 오는 동료에게도 적용돼요.
        여러 규칙이 겹치면 세션 → 워크트리 → 더 깊은 폴더 → 더 긴 브랜치 순으로 우선해요.
      </p>
      <div className="zone-editor-actions">
        {current && (
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={() => void save(rules.filter((r) => r.id !== current.id))}
            title={`${ZONE_MATCH_LABELS[current.match]} 규칙을 지워요`}
          >
            <Undo2 size={13} /> 프로젝트 구역으로
          </button>
        )}
        <button type="button" className="button subtle" onClick={onClose}>
          취소
        </button>
        <button
          className="button primary"
          disabled={busy || !destination || !target.value || unchanged}
        >
          {destination ? `${destination.name} 구역으로 보내기` : '구역 지정'}
        </button>
      </div>
    </form>
  );
}
