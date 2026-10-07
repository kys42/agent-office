import { api } from './api';
import { m } from '../shared/i18n';

/** Copy text for the person and say so; a blocked clipboard is reported, not swallowed. */
export async function copyText(text: string, notify: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    notify(m().inspector.copied);
  } catch {
    notify(m().inspector.copyDenied);
  }
}

/**
 * Bring a session's terminal to the front (desktop only). When that terminal is gone, the
 * main process hands back the resume command instead, and it goes to the clipboard.
 */
export async function jumpOrCopy(id: string, notify: (message: string) => void) {
  const result = await api.jump!(id);
  if (result.action === 'copy') await copyText(result.text, notify);
  else notify(result.text);
}
