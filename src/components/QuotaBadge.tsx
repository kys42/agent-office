import { useId } from 'react';
import { BatteryWarning } from 'lucide-react';
import { PROVIDERS } from '../shared/types';
import { intlLocale } from '../shared/i18n';
import type { QuotaExhaustion } from '../shared/quota';
import { useI18n } from '../lib/i18n';

const when = (at: number) => {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(intlLocale(), {
    ...(today ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};
const family = (model: string) => model.charAt(0).toUpperCase() + model.slice(1);

/**
 * The small badge on a desk whose tool used up its usage limit (#29): which limit, how far it
 * reaches (the whole account or one model), when it resets and when it was checked. It takes
 * focus so the explanation is there for the keyboard too; it never opens the desk.
 */
export function QuotaBadge({
  quota,
  className = '',
}: {
  quota: QuotaExhaustion;
  className?: string;
}) {
  const { t } = useI18n();
  const q = t.desk.quota;
  const tip = useId();
  const tool = PROVIDERS[quota.provider].short;
  return (
    <button
      type="button"
      className={`quota-badge ${className}`}
      data-solid
      aria-label={q.label(tool)}
      aria-describedby={tip}
      onClick={(e) => e.stopPropagation()}
    >
      <BatteryWarning size={11} strokeWidth={2.4} />
      <span className="quota-tip" role="tooltip" id={tip}>
        <b>{q.title(tool)}</b>
        {quota.windows.map((w) => (
          <span key={w.key}>
            {q.window(
              w.label,
              w.scope.kind === 'account' ? q.account : q.model(family(w.scope.model)),
            )}
            {' · '}
            {w.resetsAt ? q.resets(when(w.resetsAt)) : q.noReset}
          </span>
        ))}
        <small>{q.checked(when(quota.checkedAt))}</small>
        <small>{q.back}</small>
      </span>
    </button>
  );
}
