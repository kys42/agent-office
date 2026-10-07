import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WebLink } from './WebLink';

// A single "~" is ordinary text ("9/28~10/2"); only "~~" strikes through.
const plugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]];
const inline = ['p', 'strong', 'em', 'del', 'code', 'br', 'a'];

/**
 * Short message text with inline style only (bold, italic, code, strike) for small bubbles.
 * Web links (written or bare URLs) open in the browser; other links read as plain text.
 */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      allowedElements={inline}
      unwrapDisallowed
      components={{
        p: ({ children }) => <span className="md-p">{children} </span>,
        a: ({ href, children }) => <WebLink href={href}>{children}</WebLink>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
