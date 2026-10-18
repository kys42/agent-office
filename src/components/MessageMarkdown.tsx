import { ChatMarkdown } from './chat/ChatMarkdown';
import { desktopChatActions } from '../lib/chat-actions';

/** Desktop adapter used by conversations, saved messages and notes. */
export function MessageMarkdown({
  text,
  notify,
  interactive = true,
}: {
  text: string;
  notify: (message: string) => void;
  interactive?: boolean;
}) {
  return (
    <ChatMarkdown
      text={text}
      notify={notify}
      interactive={interactive}
      onOpenLink={desktopChatActions.openLink}
    />
  );
}
