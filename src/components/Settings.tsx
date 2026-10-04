import {
  Plug,
  ShieldCheck,
  Folder,
  RotateCw,
  Check,
  ChevronRight,
  Copy,
  Eye,
  Pause,
  Sparkles,
} from 'lucide-react';
import type { Preferences, Snapshot, Provider } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { shortPath, ago } from '../lib/format';
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      className={`toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
export function Settings({
  snapshot,
  onPrefs,
  onRefresh,
  notify,
}: {
  snapshot: Snapshot;
  onPrefs: (p: Partial<Preferences>) => void;
  onRefresh: () => void;
  notify: (s: string) => void;
}) {
  const p = snapshot.preferences;
  const projects = [
    ...new Set([...snapshot.sessions.map((s) => s.project), ...p.excludedProjects]),
  ].sort();
  return (
    <div className="settings-page">
      <div className="page-intro">
        <span className="eyebrow">MAKE YOURSELF AT HOME</span>
        <h1>편안하게 함께 일하려면.</h1>
        <p>어떤 동료를 만나고, 어떤 기록을 남길지 직접 정하세요.</p>
      </div>
      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title">
            <h2>우리 사무실에 연결된 도구</h2>
            <button className="icon-btn" aria-label="연결 새로고침" onClick={onRefresh}>
              <RotateCw size={16} />
            </button>
          </div>
          {snapshot.connectors.map((c) => (
            <div className="connector-card" key={c.provider}>
              <div className="connector-title">
                <div className={`avatar avatar-${c.provider}`}>
                  <Sprite provider={c.provider} size={48} />
                </div>
                <div>
                  <h3>{PROVIDERS[c.provider].name}</h3>
                  <span className={`connection-${c.state}`}>
                    {c.state === 'connected'
                      ? '기록 연결됨'
                      : c.state === 'paused'
                        ? '연결 쉬는 중'
                        : c.state === 'missing'
                          ? '기록 없음'
                          : '연결 확인 필요'}
                  </span>
                </div>
                <Toggle
                  checked={p.enabledProviders.includes(c.provider)}
                  label={`${PROVIDERS[c.provider].name} 수집`}
                  onChange={() =>
                    onPrefs({
                      enabledProviders: p.enabledProviders.includes(c.provider)
                        ? p.enabledProviders.filter((x) => x !== c.provider)
                        : [...p.enabledProviders, c.provider],
                    })
                  }
                />
              </div>
              <code>{p.privacy ? '로컬 기록 경로 숨김' : shortPath(c.path)}</code>
              <p>{c.message}</p>
              <small>
                {c.lastSync ? `${ago(c.lastSync)} 확인` : '아직 확인 전'} · 원본 수정 없음
              </small>
            </div>
          ))}
        </section>
        <div>
          <section className="settings-section">
            <h2>내 작업 리듬에 맞게</h2>
            <div className="setting-row">
              <Pause size={18} />
              <div>
                <b>수집 잠시 쉬기</b>
                <p>기존 기록은 그대로 볼 수 있어요.</p>
              </div>
              <Toggle
                checked={p.paused}
                label="수집 일시정지"
                onChange={() => onPrefs({ paused: !p.paused })}
              />
            </div>
            <div className="setting-row">
              <Sparkles size={18} />
              <div>
                <b>움직임 줄이기</b>
                <p>동료들이 자리에서 조용히 함께해요.</p>
              </div>
              <Toggle
                checked={p.reducedMotion}
                label="움직임 줄이기"
                onChange={() => onPrefs({ reducedMotion: !p.reducedMotion })}
              />
            </div>
            <div className="setting-row">
              <Eye size={18} />
              <div>
                <b>화면의 내용 숨기기</b>
                <p>제목·프로젝트·대화 내용을 가려요.</p>
              </div>
              <Toggle
                checked={p.privacy}
                label="화면 내용 숨기기"
                onChange={() => onPrefs({ privacy: !p.privacy })}
              />
            </div>
          </section>
          <section className="settings-section">
            <h2>도구마다 불러올 최근 기록</h2>
            <p>
              이 범위 안의 세션을 사무실과 기억 서랍에 담아요. 큰 파일은 처음과 최근 구간을 읽어요.
            </p>
            <select
              className="record-limit"
              aria-label="도구별 수집할 세션 수"
              value={p.maxSessions}
              onChange={(e) => onPrefs({ maxSessions: Number(e.target.value) })}
            >
              <option value={60}>최근 60개</option>
              <option value={120}>최근 120개</option>
              <option value={300}>최근 300개</option>
            </select>
          </section>
          <section className="settings-section">
            <h2>사무실에서 쉬어가는 시간</h2>
            <p>최근 활동을 기준으로 공간을 구분해요. 고정한 동료는 자리를 지켜요.</p>
            <div className="lifecycle-settings">
              <label>
                말풍선 유지
                <select
                  aria-label="말풍선 유지 시간"
                  value={p.bubbleHours ?? 3}
                  onChange={(e) => onPrefs({ bubbleHours: Number(e.target.value) })}
                >
                  {[1, 3, 6, 12, 24].map((h) => (
                    <option key={h} value={h}>
                      {h}시간
                    </option>
                  ))}
                </select>
              </label>
              <label>
                대기 라운지로
                <select
                  aria-label="대기까지 시간"
                  value={p.standbyHours ?? 4}
                  onChange={(e) => onPrefs({ standbyHours: Number(e.target.value) })}
                >
                  {[1, 2, 4, 8, 24].map((h) => (
                    <option key={h} value={h}>
                      {h}시간 뒤
                    </option>
                  ))}
                </select>
              </label>
              <label>
                보관 공간으로
                <select
                  aria-label="보관까지 기간"
                  value={p.archiveDays ?? 7}
                  onChange={(e) => onPrefs({ archiveDays: Number(e.target.value) })}
                >
                  {[3, 7, 14, 30, 90].map((d) => (
                    <option key={d} value={d}>
                      {d}일 뒤
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          <section className="settings-section scope-settings">
            <h2>기록에서 제외할 프로젝트</h2>
            <p>사무실·검색·인수인계·MCP에서 함께 숨겨져요.</p>
            <div className="project-chips">
              {projects.map((project) => (
                <button
                  key={project}
                  className={p.excludedProjects.includes(project) ? 'excluded' : ''}
                  onClick={() =>
                    onPrefs({
                      excludedProjects: p.excludedProjects.includes(project)
                        ? p.excludedProjects.filter((x) => x !== project)
                        : [...p.excludedProjects, project],
                    })
                  }
                >
                  {p.excludedProjects.includes(project) && <Check size={12} />}{' '}
                  {p.privacy ? '프로젝트' : project}
                </button>
              ))}
            </div>
          </section>
          <section className="local-promise">
            <ShieldCheck size={25} />
            <div>
              <h3>이 컴퓨터 안에서만.</h3>
              <p>
                인증 파일을 가져오거나 모델을 호출하지 않아요. 로그 속 흔한 토큰 패턴은 가리고,
                원본은 읽기만 해요. 내용 숨기기는 화면 표시만 바꾸며 OS의 캡처 차단 기능은 아니에요.
              </p>
            </div>
          </section>
          <section className="settings-section mcp-card">
            <span className="eyebrow">MEMORY, WITH YOUR AGENTS</span>
            <h2>MCP로 기억을 꺼내요</h2>
            <p>
              앱과 같은 로컬 저장소에서 목록·검색·근거·인수인계를 읽어요. 개발 저장소의{' '}
              <code>npm run mcp</code>로 연결할 수 있어요.
            </p>
            <small>읽기 전용 · 자동 설치 없음 · 앱을 먼저 실행해 주세요</small>
          </section>
        </div>
      </div>
    </div>
  );
}
