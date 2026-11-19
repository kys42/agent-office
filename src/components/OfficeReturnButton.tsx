import { useI18n } from '../lib/i18n';
import { dockLookName, type DockLook } from '../shared/dock-look';
import { DockLookIcon } from './DockLookIcon';

/**
 * The big office's floating way back to the desktop dock: a large translucent pill at the
 * bottom of the office, named after the look the dock was left in (the header's small dock
 * button does the same, this one is just easy to find). The App decides when it shows.
 */
export function OfficeReturnButton({ look, onReturn }: { look: DockLook; onReturn: () => void }) {
  const { t } = useI18n();
  const label = t.app.returnButton.label[dockLookName(look)];
  return (
    <button
      type="button"
      className="office-return-button"
      aria-label={label}
      title={t.app.returnButton.title}
      onClick={onReturn}
    >
      <DockLookIcon look={look} size={17} className="dock-view-current office-return-icon" />
      <span>{label}</span>
    </button>
  );
}
