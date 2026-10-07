import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { webLink } from '../shared/links';

/**
 * A link from session text. Web pages open in the default browser on click (the real address
 * shows on hover, so a misleading label cannot hide it); anything else stays plain text.
 * The click never reaches the bubble or row around it.
 */
export function WebLink({ href, children }: { href?: string; children: ReactNode }) {
  const link = webLink(href);
  if (!link) return <span>{children}</span>;
  return (
    <a
      className="web-link"
      href={link}
      title={link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void api.openLink?.(link);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

// Bare web addresses in plain text; trailing punctuation belongs to the sentence.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?)\]}'"、。，）」』]+$/;

/** Plain text with its bare http(s) addresses as WebLinks (saved excerpts have no markdown). */
export function LinkifiedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const raw = m[0];
    const url = raw.replace(TRAILING, '');
    const start = m.index!;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <WebLink key={start} href={url}>
        {url}
      </WebLink>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
