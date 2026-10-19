import { createContext, useContext, useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { markdownFileLink, webLink } from '../shared/links';

/**
 * A link from session text. Web pages open in the default browser on click (the real address
 * shows on hover, so a misleading label cannot hide it); anything else stays plain text.
 * The click never reaches the bubble or row around it.
 */
export function WebLink({ href, children }: { href?: string; children: ReactNode }) {
  const here = useContext(FilesHere);
  const link = webLink(href);
  const file = link ? null : markdownFileLink(href);
  if (file)
    return (
      <FileLink path={file} here={here}>
        {children}
      </FileLink>
    );
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

/**
 * Whether file paths in this text name files on this computer: false for a connected office's
 * colleagues, whose paths belong to their own computer (shown, never opened here).
 */
export const FilesHere = createContext(true);

/**
 * A file on this computer, named by a link in session text. The desktop app opens it on click
 * (documents in their app, anything else shown in its folder); a browser can't, so the path is
 * shown beside the label. The full path is on hover either way.
 */
function FileLink({ path, here, children }: { path: string; here: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  if (!api.openFile || !here)
    return (
      <span className="file-link is-text" title={path}>
        {children} <code>{path}</code>
      </span>
    );
  return (
    <a
      className={`web-link file-link ${missing ? 'is-missing' : ''}`}
      href={path}
      title={missing ? `${path}\n${t.desktop.fileMissing}` : path}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void api.openFile?.(path).then(
          (r) => setMissing(r === 'missing'),
          () => setMissing(true),
        );
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <FileText size={12} aria-hidden="true" />
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
