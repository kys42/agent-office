import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL, defaultDock, fitPanels, readWidths } from '../src/shared/panel-widths';

test('Saved panel widths keep only sensible numbers, within their limits', () => {
  assert.deepEqual(readWidths(null), {});
  assert.deepEqual(readWidths('not json'), {});
  assert.deepEqual(readWidths('"300"'), {});
  assert.deepEqual(readWidths('{"side":"300px","dock":-5}'), { dock: PANEL.dockMin });
  assert.deepEqual(readWidths('{"side":99999,"dock":512.4}'), { side: PANEL.sideMax, dock: 512 });
  assert.deepEqual(readWidths('{"side":null,"dock":"x"}'), {});
});

test('Dragged widths shrink until the office keeps its room, and the stylesheet rules narrow windows', () => {
  const both = { sidebar: true, dock: true };
  // As saved on a wide screen.
  const wide = fitPanels({ side: 360, dock: 760 }, 1920, both);
  assert.equal(wide.side, 360);
  assert.equal(wide.dock, 760);
  assert.deepEqual(wide.css, { side: 360, dock: 760 });
  // Moved to a laptop: the right column gives way first, the office keeps 480px.
  const laptop = fitPanels({ side: 360, dock: 760 }, 1280, both);
  assert.equal(laptop.dock, 1280 - 360 - PANEL.stageMin);
  assert.equal(laptop.side, 360);
  // Even narrower: both at their minimum rather than none.
  const small = fitPanels({ side: 360, dock: 760 }, 1101, both);
  assert.equal(small.dock, PANEL.dockMin);
  assert.ok(small.side <= 1101 - PANEL.dockMin - PANEL.stageMin || small.side === PANEL.sideMin);
  // The menu folded away: its room goes to the right column.
  const folded = fitPanels({ side: 360, dock: 760 }, 1280, { sidebar: false, dock: true });
  assert.equal(folded.dock, 760);
  assert.equal(folded.side, 0);
  // Narrow windows float the card: nothing overrides the responsive layout.
  assert.deepEqual(fitPanels({ side: 360, dock: 760 }, 1000, both).css, {});
  // Nothing dragged: the defaults, and nothing to override.
  const plain = fitPanels({}, 1440, both);
  assert.equal(plain.dock, defaultDock(1440));
  assert.deepEqual(plain.css, {});
});
