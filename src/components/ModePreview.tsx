import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot, ViewMode } from '../shared/types';
import { buildOfficeModel } from '../shared/office-model';
import { PET_SIZE, dockHeight } from '../shared/dock-geometry';
import { demoSnapshot } from '../lib/demo';
import { useI18n } from '../lib/i18n';
import { DeskPet } from './DeskPet';
import { DeskRow } from './DeskRow';
import { Office } from './Office';

const noop = () => {};
/** The big office is laid out in a room this size, then shrunk to the card's width. */
const OFFICE_ROOM = { width: 1200, height: 540 };
/** How small each look is drawn: its real height times this fits the card. */
const SCALE: Record<Exclude<ViewMode, 'office'>, number> = { pet: 0.6, dock: 0.42, tiny: 0.9 };
/** The pet's window keeps headroom for long bubbles; the preview shows its lower part. */
const PET_SHOWN = 250;

/**
 * A settings card's live preview (#324): the real pet, row, tiny row or big office, drawn small
 * from the person's own office (or the sample office while theirs is empty) with the choices
 * just saved. `preview` turns off everything that would reach outside it, and the box is inert:
 * nothing in it takes the mouse, the keyboard or a screen reader (the box itself says what it
 * shows). Names follow privacy like everywhere else.
 */
export function ModePreview({
  mode,
  snapshot,
  demo = false,
}: {
  mode: ViewMode;
  snapshot: Snapshot;
  demo?: boolean;
}) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth((w) => Math.round(el.clientWidth) || w);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sample = useMemo(() => demoSnapshot(), [locale]);
  const { model, sampled } = useMemo(() => {
    const own = buildOfficeModel(snapshot, Date.now());
    if (own.seats.length) return { model: own, sampled: false };
    // Nobody yet: the sample office, dressed in the person's own choices.
    const shown = { ...sample, preferences: snapshot.preferences };
    return { model: buildOfficeModel(shown, Date.now()), sampled: true };
  }, [snapshot, sample]);
  const p = snapshot.preferences;
  const room =
    mode === 'office'
      ? { ...OFFICE_ROOM, scale: width / OFFICE_ROOM.width }
      : mode === 'pet'
        ? { ...PET_SIZE, scale: SCALE.pet }
        : {
            width: width / SCALE[mode],
            height: dockHeight(false, mode === 'tiny'),
            scale: SCALE[mode],
          };
  const shown = mode === 'pet' ? PET_SHOWN : room.height;
  const height = Math.round(shown * room.scale);
  const left = Math.max(0, (width - room.width * room.scale) / 2);
  const title = t.settings.views.modes[mode].title;
  return (
    <figure className={`mode-preview mode-preview-${mode}`}>
      <div
        ref={box}
        className="mode-preview-box"
        role="img"
        aria-label={t.settings.views.preview(title)}
        data-sample={sampled || undefined}
        style={{ height }}
      >
        <div
          className="mode-preview-stage"
          inert
          style={{
            width: room.width,
            height: room.height,
            left,
            top: (shown - room.height) * room.scale,
            transform: `scale(${room.scale})`,
          }}
        >
          {mode === 'pet' ? (
            <DeskPet
              model={model}
              status={null}
              privacy={p.privacy}
              onReceipt={noop}
              onExpand={noop}
              onRefresh={noop}
              preview
            />
          ) : mode === 'office' ? (
            <Office
              sessions={model.scene}
              notices={model.notices}
              bubbleHours={model.bubbleHours}
              selected={null}
              onSelect={noop}
              onNews={noop}
              onReceipt={noop}
              reducedMotion={p.reducedMotion}
              privacy={p.privacy}
              onShowWaiting={noop}
              quotaOf={(s) => model.view(s.id)?.quota}
              helperStackAt={model.display.helperStackAt}
              show={model.display.views.office}
              demo={demo || sampled}
              preview
            />
          ) : (
            <DeskRow
              tiny={mode === 'tiny'}
              model={model}
              status={null}
              privacy={p.privacy}
              reducedMotion={p.reducedMotion}
              onReceipt={noop}
              onVeil={noop}
              onPin={noop}
              onCollapse={noop}
              onSwitch={noop}
              notify={noop}
              onRefresh={noop}
              demo={demo || sampled}
              preview
            />
          )}
        </div>
      </div>
      {sampled && <figcaption>{t.settings.views.demo}</figcaption>}
    </figure>
  );
}
