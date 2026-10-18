import { useState } from 'react';
import { FileText, Settings2, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useManagerState } from '../lib/useManagerState';
import type { ManagerCard, ManagerRequest } from '../shared/manager';
import { MOODS } from '../shared/types';
import { ago } from '../lib/format';
import { Modal } from './Modal';
import { Manager } from './Manager';
import '../styles/manager.css';

/** Role-specific commands inside the ordinary colleague card. */
export function ManagerTools({
  privacy,
  notify,
}: {
  privacy: boolean;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const state = useManagerState();
  const [settings, setSettings] = useState(false);
  const [pending, setPending] = useState(false);
  const run = async (request: ManagerRequest) => {
    setPending(true);
    try {
      await api.manager!(request);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="manager-tools">
        {!state?.ready && (
          <button
            className="button"
            disabled={pending || state?.running}
            onClick={() => void run({ action: 'start' })}
          >
            {state?.running ? t.manager.starting : t.manager.start}
          </button>
        )}
        <button
          className="button subtle"
          disabled={privacy || pending || !state?.ready}
          onClick={() => void run({ action: 'summary' })}
        >
          <FileText size={13} />
          {t.manager.summarize}
        </button>
        <button
          className="button subtle"
          disabled={privacy || pending || !state?.ready}
          onClick={() => void run({ action: 'chat', text: t.manager.statusPrompt })}
        >
          <Users size={13} />
          {t.manager.statusOverview}
        </button>
        <button
          className="icon-btn"
          aria-label={t.manager.configure}
          onClick={() => setSettings(true)}
        >
          <Settings2 size={14} />
        </button>
      </div>
      {settings && (
        <Modal title={t.manager.configure} onClose={() => setSettings(false)}>
          <Manager demo={false} notify={notify} />
        </Modal>
      )}
    </>
  );
}

/** Only the domain card types produced by validated Office tools can trigger navigation. */
export function ManagerRichContent({
  cards,
  notify,
}: {
  cards: ManagerCard[];
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const open = async (id: string) => {
    try {
      // Recheck visibility; a card may outlive a project being excluded.
      await api.detail(id);
      if (location.hash === '#card') await api.card?.('select', { id, news: false });
      else await api.window('main', id);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="manager-rich-content">
      {cards.map((card, i) => (
        <section className="manager-rich-card" key={i}>
          <small>
            {t.manager.observed} · {new Date(card.at).toLocaleString()}
          </small>
          {card.type === 'agents' ? (
            card.agents.map((agent) => (
              <button
                className="manager-agent-card"
                key={agent.id}
                onClick={() => void open(agent.id)}
              >
                <span>
                  <strong>{agent.name}</strong>
                  <small>
                    {agent.project} · {ago(agent.updatedAt)}
                  </small>
                </span>
                <span>{MOODS[agent.status].label} ↗</span>
              </button>
            ))
          ) : (
            <div className="manager-status-grid">
              {(['total', 'working', 'attention', 'results'] as const).map((key) => (
                <span key={key}>
                  <b>{card[key]}</b>
                  <small>{t.manager[key]}</small>
                </span>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
