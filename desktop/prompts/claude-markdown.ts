import type { Nodes, Parents, PhrasingContent, Root, RootContent, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { cells, drawn } from '../composer/screen.js';

/*
 * Markdown as Claude Code 2.1.316 draws it in a terminal: what its plan dialog shows for the plan
 * an ExitPlanMode call wrote. Read from the installed bundle's renderer (marked tokens drawn by
 * one function, `FH`), not measured:
 *
 *   heading       its text alone (no `#`)          blockquote   `▎ ` before every non-blank line
 *   emphasis,     their text alone                 code block   its code verbatim; an info string
 *   strong, ~~~                                                 the highlighter does not know is
 *   inline code   its code (no backticks)                        drawn on a line of its own above
 *   list          `-` or the number, renumbered    table        `| a | b |` rows padded, and a
 *                 from its start; nested ordered                 `|-----|---|` rule: every column
 *                 lists `a.`, then `i.`; `[x] ` /                its widest cell (min 3) + 2 dashes
 *                 `[ ] ` for tasks                 rule         `---`
 *   link          by whether the terminal takes hyperlinks: the text alone (the address hidden
 *                 in an OSC 8 link) or `text (address)`; a link whose text is its address (bare
 *                 or `<…>`) the address; a title adds ` (address) ("title")` either way
 *   image         `alt (address)`                  html         as written
 *
 * Every other character is drawn as written, punctuation included. Anything this cannot draw the
 * same way for sure (footnotes, unresolved references, character references, deep quotes) holds
 * a character no screen shows, so a plan with it never matches where it would be on screen.
 */

/** Never on a screen: stands for a drawing this module cannot reproduce exactly. */
const UNKNOWN = '\u0000';
/** Claude Code's quote bar (`Bfs`). */
const BAR = '▎';
/** More code blocks with an info string than this: only "every label" or "no label". */
const MAX_LABELS = 5;

/** How one terminal draws: hyperlinks or not, and per code block whether its label shows. */
interface Way {
  hyperlinks: boolean;
  label: (index: number) => boolean;
}

const letters = (n: number) => {
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
};
const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];
const roman = (n: number) => {
  let out = '';
  for (const [value, mark] of ROMAN)
    while (n >= value) {
      out += mark;
      n -= value;
    }
  return out;
};
/** An ordered item's mark at a list depth (`X_o`/`cn`): numbers, then letters, then roman. */
function mark(depth: number, number: number, first: number, last: number): string {
  if (depth === 1 && first >= 1) return `${letters(number)}.`;
  if (depth === 2 && first >= 1 && last <= 3999) return `${roman(number)}.`;
  return `${number}.`;
}

class Drawing {
  private block = 0;
  constructor(
    private source: string,
    private way: Way,
    private definitions: Map<string, { url: string; title?: string | null }>,
  ) {}

  /** The node's text as the terminal draws it, line breaks kept (only quotes need them). */
  draw(node: Nodes, depth = 0, quotes = 0): string {
    switch (node.type) {
      case 'root':
        return this.all(node, depth, quotes);
      case 'paragraph':
        return this.inline(node.children) + '\n';
      case 'heading':
        return this.inline(node.children) + '\n\n';
      case 'thematicBreak':
        return '---\n';
      case 'blockquote': {
        // Nested quotes draw one bar (below six levels; deeper is not reproduced).
        if (quotes >= 5) return UNKNOWN;
        const inner = node.children
          .map((child) =>
            child.type === 'blockquote'
              ? this.draw(child, depth, quotes + 1).replace(new RegExp(`^${BAR} `, 'gm'), '')
              : this.draw(child, depth, quotes + 1),
          )
          .join('');
        return (
          inner
            .split('\n')
            .map((line) => (line.trim() ? `${BAR} ${line}` : line))
            .join('\n') + '\n'
        );
      }
      case 'code': {
        const info = [node.lang, node.meta].filter(Boolean).join(' ');
        const index = info ? this.block++ : -1;
        return (info && this.way.label(index) ? `${info}\n` : '') + node.value + '\n';
      }
      case 'list': {
        const first = node.start ?? 1;
        const last = first + node.children.length - 1;
        return node.children
          .map((item, i) => {
            const bullet = node.ordered ? mark(depth, first + i, first, last) : '-';
            const task = typeof item.checked === 'boolean' ? (item.checked ? '[x] ' : '[ ] ') : '';
            return `${bullet} ${task}${this.all(item, depth + 1, quotes)}`;
          })
          .join('');
      }
      case 'table':
        return this.table(node);
      case 'html':
        return node.value + '\n';
      case 'definition':
        return '';
      default:
        return UNKNOWN;
    }
  }

  private all(node: Parents, depth: number, quotes: number): string {
    return (node.children as RootContent[]).map((c) => this.draw(c, depth, quotes)).join('');
  }

  private table(node: Table): string {
    const [head, ...rows] = node.children;
    if (!head) return UNKNOWN;
    const columns = head.children.length;
    const text = (row: (typeof node.children)[number]) =>
      Array.from({ length: columns }, (_, i) =>
        row.children[i] ? this.inline(row.children[i].children) : '',
      );
    const all = [text(head), ...rows.map(text)];
    const widths = Array.from({ length: columns }, (_, i) =>
      Math.max(3, ...all.map((cellsOfRow) => cells(cellsOfRow[i]))),
    );
    const line = (row: string[]) => `| ${row.join(' | ')} |\n`;
    return (
      line(all[0]) +
      `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|\n` +
      all.slice(1).map(line).join('') +
      '\n'
    );
  }

  private inline(nodes: PhrasingContent[]): string {
    return nodes.map((node) => this.phrase(node)).join('');
  }

  private phrase(node: PhrasingContent): string {
    switch (node.type) {
      case 'text': {
        // A character reference (`&amp;`) is drawn as written by marked, decoded here: unknown.
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const raw = start !== undefined && end !== undefined ? this.source.slice(start, end) : '';
        return /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(raw) ? UNKNOWN : node.value;
      }
      case 'emphasis':
      case 'strong':
      case 'delete':
        return this.inline(node.children);
      case 'inlineCode':
        return node.value;
      case 'break':
        return '\n';
      case 'html':
        return node.value;
      case 'link':
        return this.link(node.url, this.inline(node.children), node.title);
      case 'linkReference': {
        const def = this.definitions.get(node.identifier.toLowerCase());
        return def ? this.link(def.url, this.inline(node.children), def.title) : UNKNOWN;
      }
      case 'image': {
        const title = node.title ? ` "${node.title}"` : '';
        if (!node.alt && !node.title) return node.url;
        return node.alt ? `${node.alt} (${node.url}${title})` : `(${node.url}${title})`;
      }
      default:
        return UNKNOWN;
    }
  }

  /** A link as the bundle's link renderer draws it (`case "link"` and `Cw`). */
  private link(url: string, text: string, title?: string | null): string {
    const titled = title ? ` ("${title}")` : '';
    if (/^mailto:/i.test(url)) {
      const address = url.replace(/^mailto:/i, '');
      return (text && text !== address ? `${text} (${address})` : address) + titled;
    }
    const differs = !!text && text !== url;
    const same = !differs || url === `http://${text}` || url === `https://${text}`;
    if (this.way.hyperlinks)
      return (differs ? text : url) + (differs && title ? ` (${url})` : '') + titled;
    return (differs && !same ? `${text} (${url})` : url) + titled;
  }
}

/**
 * The plan as the dialog may draw it, spacing and line wrapping left out: one per way a terminal
 * draws (hyperlinks or not; the label of each code block with an info string shown or not).
 * Every character of each is compared as drawn.
 */
export function drawnMarkdown(markdown: string): string[] {
  // The same plan is checked before and after every key: drawn once.
  let found = recent.get(markdown);
  if (!found) {
    found = drawWays(markdown);
    if (recent.size >= 8) recent.delete(recent.keys().next().value!);
    recent.set(markdown, found);
  }
  return found;
}
const recent = new Map<string, string[]>();

function drawWays(markdown: string): string[] {
  let tree: Root;
  try {
    tree = fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch {
    return [];
  }
  const definitions = new Map<string, { url: string; title?: string | null }>();
  let blocks = 0;
  const walk = (node: Nodes) => {
    if (node.type === 'definition')
      definitions.set(node.identifier.toLowerCase(), { url: node.url, title: node.title });
    if (node.type === 'code' && (node.lang || node.meta)) blocks++;
    if ('children' in node) for (const child of node.children) walk(child as Nodes);
  };
  walk(tree);
  // -1: every label shown.
  const masks = blocks <= MAX_LABELS ? Array.from({ length: 2 ** blocks }, (_, m) => m) : [0, -1];
  const out = new Set<string>();
  for (const hyperlinks of [false, true])
    for (const m of masks) {
      const way: Way = {
        hyperlinks,
        label: (index) => (m === -1 ? true : ((m >> index) & 1) === 1),
      };
      out.add(drawn(new Drawing(markdown, way, definitions).draw(tree)));
    }
  return [...out];
}
