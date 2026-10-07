import { Inbox, Users, X } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/** The right panel has two homes — colleagues and news — reachable in one click from either. */
export function PanelTabs({
  active,
  unread,
  onRoster,
  onInbox,
  onClose,
}: {
  active: 'roster' | 'inbox';
  unread: number;
  onRoster?: () => void;
  onInbox?: () => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="panel-tabs">
      <div className="panel-switch" role="group" aria-label={t.app.panelTabs.label}>
        <button
          aria-pressed={active === 'roster'}
          onClick={active === 'roster' ? undefined : onRoster}
        >
          <Users size={14} />
          {t.app.panelTabs.roster}
        </button>
        <button
          aria-pressed={active === 'inbox'}
          onClick={active === 'inbox' ? undefined : onInbox}
        >
          <Inbox size={14} />
          {t.app.panelTabs.inbox}
          {unread > 0 && <b>{unread}</b>}
        </button>
      </div>
      {onClose && (
        <button
          className="icon-btn"
          aria-label={t.app.panelTabs.closeInbox}
          title={t.app.panelTabs.closeTitle}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
