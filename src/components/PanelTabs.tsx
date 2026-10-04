import { Inbox, Users, X } from 'lucide-react';

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
  return (
    <div className="panel-tabs">
      <div role="tablist" aria-label="오른쪽 패널">
        <button
          role="tab"
          aria-selected={active === 'roster'}
          onClick={active === 'roster' ? undefined : onRoster}
        >
          <Users size={14} />
          동료
        </button>
        <button
          role="tab"
          aria-selected={active === 'inbox'}
          onClick={active === 'inbox' ? undefined : onInbox}
        >
          <Inbox size={14} />
          소식
          {unread > 0 && <b>{unread}</b>}
        </button>
      </div>
      {onClose && (
        <button className="icon-btn" aria-label="소식함 닫기" title="닫기 · Esc" onClick={onClose}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}
