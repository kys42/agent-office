import { durationLabel, officeSchedule } from '../shared/lifecycle';
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
  LayoutGrid,
  Terminal,
  X,
} from 'lucide-react';
import type { Preferences, Snapshot, Provider } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { shortPath, ago } from '../lib/format';
import { ZONE_MATCH_LABELS, isCustomZone, ruleZoneKey } from '../shared/zones';
import { projectKey } from '../shared/office';
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
  terminalSend,
  onTerminalSend,
}: {
  snapshot: Snapshot;
  onPrefs: (p: Partial<Preferences>) => void;
  onRefresh: () => void;
  notify: (s: string) => void;
  /** Desktop only; undefined hides the setting (web preview, demo). */
  terminalSend?: boolean;
  onTerminalSend?: () => void;
}) {
  const p = snapshot.preferences;
  const projects = [
    ...new Set([...snapshot.sessions.map((s) => s.project), ...p.excludedProjects]),
  ].sort();
  const zoneRules = p.zoneRules ?? [];
  const zones = [...new Set(zoneRules.map(ruleZoneKey))].sort(
    (a, b) => Number(isCustomZone(b)) - Number(isCustomZone(a)) || a.localeCompare(b),
  );
  const members = (key: string) =>
    snapshot.sessions.filter(
      (s) => s.area && projectKey(s) === key && s.zone === 'office' && !s.attachedTo,
    ).length;
  return (
    <div className="settings-page page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>연결과 설정</h1>
          <p>어떤 동료를 만나고, 어떤 기록을 남길지 직접 정하세요.</p>
        </div>
      </header>
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
                <div className={`face face-lg face-${c.provider}`}>
                  <Sprite
                    provider={c.provider}
                    mood={c.state === 'connected' ? 'idle' : 'sleep'}
                    size={40}
                  />
                </div>
                <div>
                  <h3>
                    {PROVIDERS[c.provider].name}
                    <em>{c.count}개</em>
                  </h3>
                  <span className={`connection-state connection-${c.state}`}>
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
            <h2>사무실 설정</h2>
            <p>두 시점 모두 마지막 활동부터 계산해요. 고정한 동료는 자리를 지켜요.</p>
            <div className="setting-row">
              <div>
                <b>보관 공간 자동 이동</b>
                <p>끄면 대기 라운지에 머물러요. 직접 보관하는 기능은 그대로예요.</p>
              </div>
              <Toggle
                checked={p.autoArchive !== false}
                label="보관 공간 자동 이동"
                onChange={() =>
                  onPrefs({
                    autoArchive: p.autoArchive === false,
                    archiveDays: Math.max(
                      p.archiveDays ?? 7,
                      Math.floor((p.standbyHours ?? 4) / 24) + 1,
                    ),
                  })
                }
              />
            </div>
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
                퇴근 · 대기 라운지로
                <select
                  aria-label="대기까지 시간"
                  value={p.standbyHours ?? 4}
                  onChange={(e) => {
                    const standbyHours = Number(e.target.value);
                    onPrefs({
                      standbyHours,
                      archiveDays: Math.max(p.archiveDays ?? 7, Math.floor(standbyHours / 24) + 1),
                    });
                  }}
                >
                  {[...new Set([1, 2, 4, 8, 24, 48, 72, 168, 336, 720, 2160, p.standbyHours ?? 4])]
                    .sort((a, b) => a - b)
                    .map((h) => (
                      <option key={h} value={h}>
                        {durationLabel(h)} 뒤
                      </option>
                    ))}
                </select>
              </label>
              <label>
                보관 공간으로
                <select
                  aria-label="보관까지 기간"
                  disabled={p.autoArchive === false}
                  value={p.archiveDays ?? 7}
                  onChange={(e) => onPrefs({ archiveDays: Number(e.target.value) })}
                >
                  {[...new Set([1, 3, 7, 14, 30, 60, 90, 180, 365, p.archiveDays ?? 7])]
                    .sort((a, b) => a - b)
                    .map((d) => (
                      <option key={d} value={d} disabled={d * 24 <= (p.standbyHours ?? 4)}>
                        {d}일 뒤
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <p className="office-schedule-preview" aria-live="polite">
              마지막 활동 → {officeSchedule(p)}
            </p>
            <p className="helper-lifecycle-note">
              보조 동료는 결과를 남겨두고 메인의 다음 요청이 시작되면 자리에서 빠져요. 아직 일하거나
              확인을 기다리면 남아 있어요. 메인이 퇴근하면 이전 작업 기록으로 접어둬요.
            </p>
          </section>
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
            {terminalSend !== undefined && onTerminalSend && (
              <div className="setting-row">
                <Terminal size={18} />
                <div>
                  <b>터미널로 보내기</b>
                  <p>
                    Orca·tmux에서 쉬고 있는 Claude Code 세션에 업무 카드에서 바로 이어서 말해요. 그
                    터미널에 직접 친 것과 같아서, 권한 확인 없이 띄운 세션이면 그대로 실행돼요.
                    입력창에 써 둔 초안이 있으면 그 뒤에 이어 붙어요. 이 데스크탑 앱에서만 켤 수
                    있어요.
                  </p>
                </div>
                <Toggle checked={terminalSend} label="터미널로 보내기" onChange={onTerminalSend} />
              </div>
            )}
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
          <section className="settings-section zone-settings">
            <h2>
              <LayoutGrid size={16} /> 직접 나눈 사무실 구역
            </h2>
            <p>
              모노레포처럼 한 프로젝트에 동료가 몰릴 때 워크트리·폴더·브랜치별로 구역을 나눠요. 동료
              업무 카드의 프로젝트 옆 ‘구역’에서 만들 수 있어요.
            </p>
            {zones.length === 0 ? (
              <small>아직 나눈 구역이 없어요. 모두 프로젝트 기준으로 모여 있어요.</small>
            ) : (
              <ul className="zone-list">
                {zones.map((key) => {
                  const rules = zoneRules.filter((r) => ruleZoneKey(r) === key);
                  const name = rules[0].name;
                  return (
                    <li key={key}>
                      <div className="zone-list-head">
                        {isCustomZone(key) ? (
                          <input
                            aria-label={`${name} 구역 이름`}
                            defaultValue={name}
                            maxLength={40}
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (!next) e.target.value = name;
                              else if (next !== name)
                                onPrefs({
                                  zoneRules: zoneRules.map((r) =>
                                    ruleZoneKey(r) === key ? { ...r, name: next } : r,
                                  ),
                                });
                            }}
                            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                          />
                        ) : (
                          <b title="자동 프로젝트 구역에 합류시킨 규칙이에요">
                            {p.privacy ? '프로젝트' : name}
                            <em>프로젝트 구역</em>
                          </b>
                        )}
                        <small>보낸 동료 {members(key)}명</small>
                      </div>
                      <div className="project-chips">
                        {rules.map((r) => (
                          <button
                            key={r.id}
                            title={`${r.value} · 눌러서 규칙 삭제`}
                            onClick={() =>
                              onPrefs({ zoneRules: zoneRules.filter((x) => x.id !== r.id) })
                            }
                          >
                            {ZONE_MATCH_LABELS[r.match]} ·{' '}
                            {p.privacy
                              ? '숨김'
                              : r.match === 'session'
                                ? '세션 1개'
                                : r.match === 'branch'
                                  ? r.value
                                  : shortPath(r.value)}
                            <X size={11} />
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
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
                원본은 읽기만 해요. ‘터미널로 보내기’를 켠 경우에만 내가 쓴 내용을 그 터미널에
                입력해요. 내용 숨기기는 화면 표시만 바꾸며 OS의 캡처 차단 기능은 아니에요.
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
