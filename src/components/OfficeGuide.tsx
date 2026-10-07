import { useState } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  Inbox,
  PawPrint,
  MessageSquare,
  Palette,
  Search,
  Gauge,
  Terminal,
  Clock3,
  LayoutGrid,
  Eye,
  Keyboard,
  ShieldCheck,
  Check,
  Plug,
} from 'lucide-react';
import type { Snapshot } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { useI18n } from '../lib/i18n';
import { Modal } from './Modal';
import { Sprite } from './Sprite';

export type GuideAction =
  | 'office'
  | 'inbox'
  | 'pet'
  | 'card'
  | 'appearance'
  | 'memory'
  | 'usage'
  | 'terminal'
  | 'activity'
  | 'space'
  | 'privacy'
  | 'keys'
  | 'demo'
  | 'settings';
const steps = ['welcome', 'attention', 'pet', 'ready'] as const;
const features = [
  ['inbox', Inbox],
  ['pet', PawPrint],
  ['card', MessageSquare],
  ['appearance', Palette],
  ['memory', Search],
  ['usage', Gauge],
  ['terminal', Terminal],
  ['activity', Clock3],
  ['space', LayoutGrid],
  ['privacy', Eye],
  ['keys', Keyboard],
] as const;

export function OfficeGuide({
  initialMode,
  snapshot,
  demo,
  desktop,
  hasColleague,
  onAction,
  onClose,
}: {
  initialMode: 'tour' | 'features';
  snapshot: Snapshot | null;
  demo: boolean;
  desktop: boolean;
  hasColleague: boolean;
  onAction: (action: GuideAction) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const g = t.guide;
  const [mode, setMode] = useState(initialMode);
  const [step, setStep] = useState(0);
  const copy = g.steps[steps[step]];
  const blocked = (id: GuideAction) =>
    id === 'card' && !hasColleague
      ? g.needsColleague
      : id === 'terminal' && !desktop
        ? g.desktopOnly
        : id === 'terminal' && demo
          ? g.liveOnly
          : id === 'pet' && desktop && demo
            ? g.liveOnly
            : null;
  return (
    <Modal title={g.title} onClose={onClose} wide>
      <div className="office-guide">
        <div className="guide-tabs" role="group" aria-label={g.title}>
          <button aria-pressed={mode === 'tour'} onClick={() => setMode('tour')}>
            {g.tour}
          </button>
          <button aria-pressed={mode === 'features'} onClick={() => setMode('features')}>
            {g.features}
          </button>
        </div>
        <div className="guide-scroll" key={`${mode}-${step}`}>
          {mode === 'tour' ? (
            <>
              <div className="guide-heading" aria-live="polite">
                <span className="eyebrow">{g.step(step + 1)}</span>
                <h1>{copy.title}</h1>
                <p>{copy.body}</p>
              </div>
              {step === 0 && (
                <>
                  <div className="guide-diorama" aria-hidden="true">
                    {(['claude', 'codex', 'openclaw'] as const).map((provider, i) => (
                      <div className="guide-desk" key={provider}>
                        <span className={`guide-bubble guide-tone-${i}`}>
                          {[g.progress, g.question, g.answer][i]}
                        </span>
                        <Sprite
                          provider={provider}
                          mood={(['work', 'call', 'done'] as const)[i]}
                          size={88}
                        />
                        <div className="guide-table">
                          <i />
                          <i />
                          <i />
                        </div>
                        <b>{PROVIDERS[provider].short}</b>
                        <small>{[g.working, g.waiting, g.result][i]}</small>
                      </div>
                    ))}
                  </div>
                  <p className="guide-caption">{g.sample}</p>
                  <div className="guide-local">
                    <Plug size={16} />
                    <p>{g.local}</p>
                  </div>
                </>
              )}
              {step === 1 && (
                <>
                  <div className="guide-queue">
                    {(['codex', 'openclaw', 'claude'] as const).map((provider, i) => (
                      <div className={`guide-queue-row guide-tone-${[1, 2, 0][i]}`} key={provider}>
                        <Sprite
                          provider={provider}
                          mood={(['call', 'done', 'work'] as const)[i]}
                          size={48}
                        />
                        <div>
                          <b>{[g.waiting, g.result, g.working][i]}</b>
                          <p>{[g.question, g.answer, g.progress][i]}</p>
                        </div>
                        {i === 1 ? <Inbox size={18} /> : <ArrowRight size={18} />}
                      </div>
                    ))}
                  </div>
                  <p className="guide-caption">{g.sample}</p>
                  <div className="guide-local">
                    <MessageSquare size={16} />
                    <p>{g.cardHint}</p>
                  </div>
                </>
              )}
              {step === 2 && (
                <>
                  <div className="guide-pet-scene" aria-hidden="true">
                    <div className="guide-mini-pet">
                      <Sprite
                        provider="claude"
                        appearance={{ character: 'slime', color: 'original', accessory: 'none' }}
                        size={72}
                      />
                      <PawPrint size={15} />
                    </div>
                    <ArrowRight className="guide-unfold" size={22} />
                    <div className="guide-mini-row">
                      {(['claude', 'codex', 'openclaw'] as const).map((provider) => (
                        <div key={provider}>
                          <Sprite provider={provider} size={56} />
                          <div className="guide-table">
                            <i />
                            <i />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="guide-caption">{g.rowHint}</p>
                  <div className="guide-local">
                    <PawPrint size={16} />
                    <p>{g.petHint}</p>
                  </div>
                </>
              )}
              {step === 3 && (
                <>
                  <div className="guide-connections">
                    <h3>{g.connectionTitle}</h3>
                    {demo ? (
                      <p>{g.demoConnection}</p>
                    ) : snapshot ? (
                      <>
                        <div className="guide-connection-list">
                          {snapshot.connectors.map((c) => (
                            <div key={c.provider}>
                              <Sprite
                                provider={c.provider}
                                mood={c.state === 'connected' ? 'idle' : 'sleep'}
                                size={40}
                              />
                              <b>{PROVIDERS[c.provider].short}</b>
                              <span className={`connection-state connection-${c.state}`}>
                                {t.settings.connectors[c.state]}
                              </span>
                            </div>
                          ))}
                        </div>
                        {!hasColleague && <p>{g.empty}</p>}
                      </>
                    ) : (
                      <p>{g.connecting}</p>
                    )}
                  </div>
                  <div className="guide-starter-actions">
                    <button onClick={() => onAction('appearance')}>
                      <Palette size={19} />
                      <b>{g.cards.appearance.action}</b>
                      <ArrowRight size={16} />
                    </button>
                    <button onClick={() => onAction('settings')}>
                      <Plug size={19} />
                      <b>{g.connectionAction}</b>
                      <ArrowRight size={16} />
                    </button>
                    {!demo && (
                      <button onClick={() => onAction('demo')}>
                        <PawPrint size={19} />
                        <b>{g.demoAction}</b>
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </div>
                </>
              )}
              <div className="guide-safety">
                <ShieldCheck size={15} />
                <p>{g.safety}</p>
              </div>
            </>
          ) : (
            <>
              <div className="guide-heading">
                <span className="eyebrow">Agent Office</span>
                <h1>{g.browse}</h1>
                <p>{g.browseHint}</p>
              </div>
              <div className="guide-feature-grid">
                {features.map(([id, Icon]) => {
                  const card = g.cards[id];
                  const reason = blocked(id);
                  return (
                    <section className="guide-feature" key={id}>
                      <Icon className="guide-feature-icon" size={22} />
                      <h3>{card.title}</h3>
                      <p>{card.body}</p>
                      <small>{card.where}</small>
                      <button disabled={!!reason} onClick={() => onAction(id)}>
                        {reason ?? card.action}
                        {!reason && <ArrowRight size={14} />}
                      </button>
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="guide-footer">
          {mode === 'tour' ? (
            <>
              <div className="guide-progress" role="group" aria-label={g.tour}>
                {steps.map((id, i) => (
                  <button
                    key={id}
                    aria-label={`${g.step(i + 1)} · ${g.steps[id].label}`}
                    aria-current={i === step ? 'step' : undefined}
                    onClick={() => setStep(i)}
                  >
                    <span>{i < step ? <Check size={12} /> : i + 1}</span>
                  </button>
                ))}
              </div>
              <div className="guide-footer-actions">
                {step === 0 ? (
                  <button className="button subtle" onClick={onClose}>
                    {g.later}
                  </button>
                ) : (
                  <button className="button subtle" onClick={() => setStep(step - 1)}>
                    <ArrowLeft size={14} />
                    {g.back}
                  </button>
                )}
                <button
                  className="button primary"
                  onClick={() => (step === 3 ? onAction('office') : setStep(step + 1))}
                >
                  {step === 3 ? g.start : g.next}
                  <ArrowRight size={15} />
                </button>
              </div>
            </>
          ) : (
            <button className="button primary" onClick={() => onAction('office')}>
              {g.start}
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
