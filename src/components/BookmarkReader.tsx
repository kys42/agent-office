import { createPortal } from 'react-dom';
import { ArrowUpRight, BookmarkCheck } from 'lucide-react';
import type { Bookmark } from '../shared/types';
import { savedConversation } from '../shared/bookmarks';
import { PROVIDERS } from '../shared/types';
import { conversationKind } from '../shared/conversation';
import { useI18n } from '../lib/i18n';
import { date, time } from '../lib/format';
import { Modal } from './Modal';
import { MessageMarkdown } from './MessageMarkdown';

/** Read the saved copy in order, without replacing the notes or fetching the live conversation. */
import { FilesHere } from './WebLink';
import { isRemoteId } from '../shared/federation';

export function BookmarkReader({
  bookmark: b,
  name,
  canOpen,
  onOpen,
  onClose,
  notify,
}: {
  bookmark: Bookmark;
  name: string;
  canOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const { t } = useI18n();
  const lines = savedConversation(b);
  return createPortal(
    <Modal title={t.memory.read} onClose={onClose} wide>
      <div className="bookmark-reader">
        <div className="bookmark-reader-heading">
          <b>{name}</b>
          <p>{t.memory.savedCopy}</p>
          {!canOpen && <small>{t.memory.sourceGone}</small>}
          {b.context.omitted > 0 && <small>{t.memory.omitted(b.context.omitted)}</small>}
          {b.context.tools > 0 && <small>{t.memory.tools(b.context.tools)}</small>}
        </div>
        <ol className="bookmark-timeline">
          {lines.map((line) => {
            const kind = conversationKind({ ...line, id: line.eventId, sourceRef: '' });
            const saved = line.eventId === b.eventId;
            return (
              <li key={line.eventId}>
                <article
                  className={`conversation-message message-${line.kind} category-${kind}${saved ? ' is-bookmarked' : ''}`}
                  data-saved={saved}
                >
                  <div className="message-meta">
                    <b>
                      {line.kind === 'user'
                        ? t.conversation.you
                        : PROVIDERS[b.source.provider].name}
                    </b>
                    <span className={`message-category category-${kind}`}>
                      {t.shared.conversation[kind]}
                    </span>
                    <time title={date(line.at)}>{time(line.at)}</time>
                    {saved && (
                      <span className="bookmark-saved-label">
                        <BookmarkCheck size={12} />
                        {t.memory.savedMessage}
                      </span>
                    )}
                  </div>
                  <div className="message-bubble">
                    {(line.truncated || line.excerpt) && (
                      <small className="retained-excerpt">
                        {line.truncated ? t.memory.truncated : t.memory.excerpt}
                      </small>
                    )}
                    <div className="message-text">
                      {/* A connected office's paths are on its own computer: shown, not opened. */}
                      <FilesHere.Provider value={!isRemoteId(b.sessionId)}>
                        <MessageMarkdown text={line.text} notify={notify} />
                      </FilesHere.Provider>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
        {b.note && (
          <section className="bookmark-note bookmark-reader-note">
            <h3>{t.memory.myNote}</h3>
            <div className="message-text">
              <MessageMarkdown text={b.note} notify={notify} />
            </div>
          </section>
        )}
      </div>
      <div className="bookmark-reader-actions">
        <button className="button subtle" onClick={onClose}>
          {t.memory.backToNotes}
        </button>
        {canOpen && (
          <button className="button primary" onClick={onOpen}>
            {t.memory.open}
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>
    </Modal>,
    document.body,
  );
}
