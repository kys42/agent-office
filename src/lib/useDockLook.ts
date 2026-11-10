import { useEffect, useState } from 'react';
import { api } from './api';
import { DEFAULT_DOCK_LOOK, readDockLook, type DockLook } from '../shared/dock-look';

/**
 * The dock's look as the desktop main process keeps it (the big office's dock button goes back
 * to it). A browser preview has no dock window to ask: the pet, which its button opens.
 */
export function useDockLook(): DockLook {
  const [look, setLook] = useState<DockLook>(DEFAULT_DOCK_LOOK);
  useEffect(() => {
    let live = true;
    const stop = api.onDockLook?.((raw) => setLook(readDockLook(raw)));
    api
      .dockLook?.()
      .then((raw) => {
        if (live) setLook(readDockLook(raw));
      })
      .catch(() => {});
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return look;
}
