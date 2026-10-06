import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// A single "~" is ordinary text ("9/28~10/2"); only "~~" strikes through.
const plugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]];
const inline = ['p', 'strong', 'em', 'del', 'code', 'br'];

/** Short message text with inline style only (bold, italic, code, strike) for small bubbles. */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      allowedElements={inline}
      unwrapDisallowed
      components={{ p: ({ children }) => <span className="md-p">{children} </span> }}
    >
      {text}
    </ReactMarkdown>
  );
}
