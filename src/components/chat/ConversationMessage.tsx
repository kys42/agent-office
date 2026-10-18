import { ChevronDown, Copy, Bookmark, BookmarkCheck } from 'lucide-react';
import type { OfficeEvent, Session } from '../../shared/types';
import { PROVIDERS } from '../../shared/types';
import { isRemoteId } from '../../shared/federation';
import { conversationKind, CONVERSATION_LABELS } from '../../shared/conversation';
import { time, date } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { intlLocale } from '../../shared/i18n';
import { ChatMarkdown } from './ChatMarkdown';
import { browserChatActions, type ChatActions } from './actions';
export function ConversationMessage({
  event,
  actions = browserChatActions,
  provider,
  notify,
  expanded,
  onExpand,
  group,
  marked = false,
  onMark,
  focused = false,
  name,
  continued = false,
}: {
  event: OfficeEvent;
  actions?: ChatActions;
  provider: Session['provider'];
  name?: string;
  notify: (s: string) => void;
  expanded: boolean;
  onExpand: () => void;
  /** Set on a message shown on its own: where the reading position is kept. */
  group?: string;
  /** The message is bookmarked; `onMark` (absent where nothing is kept) toggles it. */
  marked?: boolean;
  onMark?: (on: boolean) => void;
  /** Just opened from its bookmark. */
  focused?: boolean;
  /** Follows a message from the same side and kind: who and when only show on hover. */
  continued?: boolean;
}) {
  const { t } = useI18n();
  const work = event.kind === 'tool' || event.kind === 'result';
  const limit = work ? 200 : 300;
  const long = event.text.length > limit || event.text.split('\n').length > 12;
  const text =
    expanded || !long
      ? event.text
      : event.text.slice(0, limit).split('\n').slice(0, 12).join('\n') + '…';
  const label =
    event.kind === 'user'
      ? t.conversation.you
      : event.kind === 'assistant'
        ? (name ?? PROVIDERS[provider].name)
        : event.kind === 'tool'
          ? t.conversation.toolUse
          : event.kind === 'result'
            ? t.conversation.toolResult
            : t.conversation.progressUpdate;
  return (
    <article
      className={`conversation-message message-${event.kind} category-${conversationKind(event)}${marked ? ' is-bookmarked' : ''}${focused ? ' is-focused' : ''}${continued ? ' is-continued' : ''}`}
      data-message-category={conversationKind(event)}
      data-group-id={group}
      data-event-id={event.id}
    >
      <div className="message-meta">
        <b>{label}</b>
        <span className={`message-category category-${conversationKind(event)}`}>
          {CONVERSATION_LABELS[conversationKind(event)]}
        </span>
        <time title={date(event.at)}>{time(event.at)}</time>
        <button
          aria-label={t.conversation.copyMessage}
          onClick={() =>
            actions
              .copyText(event.text)
              .then(() => notify(t.conversation.copied))
              .catch(() => notify(t.conversation.copyFailed))
          }
        >
          <Copy size={12} />
        </button>
        {onMark && event.kind !== 'lifecycle' && (
          <button
            className={`message-bookmark ${marked ? 'is-on' : ''}`}
            aria-pressed={marked}
            aria-label={marked ? t.conversation.unbookmark : t.conversation.bookmark}
            title={marked ? t.conversation.unbookmark : t.conversation.bookmark}
            onClick={() => onMark(!marked)}
          >
            {marked ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
          </button>
        )}
      </div>
      <div className="message-bubble">
        {event.excerpt && (
          <small
            className="retained-excerpt"
            title={isRemoteId(event.id) ? t.federation.excerptTitle : t.conversation.excerptTitle}
          >
            {isRemoteId(event.id) ? t.federation.excerpt : t.conversation.excerpt}
          </small>
        )}
        <div className="message-text">
          <ChatMarkdown text={text} onOpenLink={actions.openLink} notify={notify} />
        </div>
        {long && (
          <button className="message-expand" aria-expanded={expanded} onClick={onExpand}>
            {expanded
              ? t.conversation.showLess
              : t.conversation.showMore(event.text.length.toLocaleString(intlLocale()))}
            <ChevronDown size={13} />
          </button>
        )}
      </div>
    </article>
  );
}
