import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown';
import { keepFileLinks } from '../shared/links';
import remarkGfm from 'remark-gfm';
import { WebLink } from './WebLink';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** A message's soft line breaks are intentional in a compact bubble. Code stays literal. */
function messageBreaks() {
  return function visit(node: MarkdownNode) {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value?.includes('\n'))
        return child.value
          .split('\n')
          .flatMap((value, i) =>
            i ? [{ type: 'break' }, { type: 'text', value }] : [{ type: 'text', value }],
          );
      visit(child);
      return [child];
    });
  };
}

// A single "~" is ordinary text ("9/28~10/2"); only "~~" strikes through.
const plugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }], messageBreaks];
const elements = [
  'p',
  'strong',
  'em',
  'del',
  'code',
  'br',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'input',
  'blockquote',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];
// Stable component functions preserve selection and the scroll position during snapshot updates.
const components: Options['components'] = {
  a: ({ href, children }) => <WebLink href={href}>{children}</WebLink>,
  table: ({ children, ...props }) => {
    const { node: _node, ...tableProps } = props;
    return (
      <div
        className="bubble-table"
        tabIndex={0}
        onKeyDown={(e) => {
          // Arrow keys scroll this table, rather than paging to another desk.
          if (e.key.startsWith('Arrow')) e.stopPropagation();
        }}
      >
        <table {...tableProps}>{children}</table>
      </div>
    );
  },
};

const urlTransform = keepFileLinks(defaultUrlTransform);

/** Compact, safe message markdown that keeps paragraph, list and table structure. */
export function BubbleMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      allowedElements={elements}
      unwrapDisallowed
      components={components}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  );
}
