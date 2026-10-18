/** Host capabilities only: shared chat UI never imports Electron or an Office API. */
export interface ChatActions {
  copyText(text: string): Promise<void>;
  /** Absent in a browser: the validated anchor follows its normal new-tab behavior. */
  openLink?(url: string): Promise<void>;
}

export const browserChatActions: ChatActions = {
  async copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Direct tailnet HTTP is not a secure context, so Clipboard API may be absent.
    // Keep this synchronous with the user's click and restore their input selection.
    const focused = document.activeElement;
    const selection = document.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
      : [];
    const input =
      focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        ? focused
        : null;
    const start = input?.selectionStart,
      end = input?.selectionEnd;
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(field);
    try {
      field.select();
      if (!document.execCommand('copy')) throw new Error('Copy unavailable');
    } finally {
      field.remove();
      if (focused instanceof HTMLElement && focused.isConnected)
        focused.focus({ preventScroll: true });
      if (input && start != null && end != null) input.setSelectionRange(start, end);
      else if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  },
};
