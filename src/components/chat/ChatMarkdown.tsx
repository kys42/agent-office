import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { webLink } from '../../shared/links';
import type { ChatActions } from './actions';

/** One safe Markdown renderer for desktop, mobile web and future host shells. */
export function ChatMarkdown({
  text,
  interactive = true,
  onOpenLink,
  notify,
}: {
  text: string;
  interactive?: boolean;
  onOpenLink?: ChatActions['openLink'];
  notify: (message: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: () => null,
        a: ({ href, children }) => {
          const link = interactive ? webLink(href) : null;
          if (!link) return <span>{children}</span>;
          return (
            <a
              className="web-link"
              href={link}
              title={link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.stopPropagation();
                if (onOpenLink) {
                  event.preventDefault();
                  void onOpenLink(link).catch((error) =>
                    notify(error instanceof Error ? error.message : String(error)),
                  );
                }
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
