import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { keepFileLinks } from '../shared/links';
import remarkGfm from 'remark-gfm';
import { parseArtifact } from '../shared/office';
import { api, isDesktop } from '../lib/api';
import { WebLink } from './WebLink';

const urlTransform = keepFileLinks(defaultUrlTransform);

/** The same message formatting in conversations, saved messages and their notes/context. */
export function MessageMarkdown({
  text,
  notify,
  interactive = true,
}: {
  text: string;
  notify: (s: string) => void;
  interactive?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={{
        a: ({ href, children }) => {
          if (!interactive) return <span>{children}</span>;
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
