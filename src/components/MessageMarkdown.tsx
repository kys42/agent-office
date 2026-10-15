import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseArtifact } from '../shared/office';
import { api, isDesktop } from '../lib/api';
import { WebLink } from './WebLink';

/** The same message formatting in conversations, saved messages and their notes/context. */
export function MessageMarkdown({ text, notify }: { text: string; notify: (s: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const link = href ? parseArtifact(href) : null;
          return link ? (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (isDesktop) {
                  e.preventDefault();
                  void api.openArtifact(link.url).catch((e) => notify(e.message));
                }
              }}
            >
              {children}
            </a>
          ) : (
            <WebLink href={href}>{children}</WebLink>
          );
        },
        img: () => null,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
