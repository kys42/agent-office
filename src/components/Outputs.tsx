import { useState } from 'react';
import {
  Copy,
  Eye,
  ExternalLink,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileBraces,
  FileType,
  FolderOpen,
  Globe,
  LoaderCircle,
  PackageOpen,
  Presentation,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { Session, SessionOutput } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { groupOutputs, previewFormat } from '../shared/outputs';
import { projectColor } from '../shared/office-layout';
import { api } from '../lib/api';
import { writeClipboard } from '../lib/clipboard';
import { ago, date, shortPath, time } from '../lib/format';
import { isMac } from '../lib/platform';
import { useI18n } from '../lib/i18n';
import { useOutputs } from '../lib/useOutputs';

/** What kind of output a row shows, by its extension. */
function OutputIcon({ output: o }: { output: SessionOutput }) {
  const size = 16;
  if (o.kind === 'link') return <Sparkles size={size} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(o.ext))
    return <FileImage size={size} />;
  if (['csv', 'tsv', 'xlsx'].includes(o.ext)) return <FileSpreadsheet size={size} />;
  if (o.ext === 'pptx') return <Presentation size={size} />;
  if (o.ext === 'html' || o.ext === 'htm') return <Globe size={size} />;
  if (o.ext === 'json') return <FileBraces size={size} />;
  if (o.ext === 'pdf' || o.ext === 'docx') return <FileType size={size} />;
  return <FileText size={size} />;
}

/**
 * One output: its name, folder, whose it is and when, whether it is still there, and what the
 * desktop can do with it (read it beside the office, open it, show it in its folder, copy its
 * path). The page never holds the real path: every action names the output's id and the
 * desktop's main process looks the path up. Hidden screen content hides names and actions; the
 * web preview and the demo only list.
 */
export function OutputRow({
  output: o,
  owner,
  privacy,
  demo,
  notify,
}: {
  output: SessionOutput;
  /** Whose it is, when the list does not already say (the work card does). */
  owner?: string;
  privacy: boolean;
  demo: boolean;
  notify: (s: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const actions = !privacy && !demo && !!api.outputAction;
  const missing = o.kind === 'file' && o.exists === false;
  const preview = o.kind === 'file' && !!previewFormat(o.ext);
  const run = async (what: 'open' | 'reveal' | 'copy' | 'preview') => {
    if (busy) return;
    setBusy(true);
    try {
      const done = await api.outputAction!(what, o.id);
      if (done === 'missing') notify(t.outputs.missingToast);
      else if (done === 'copied')
        notify(o.kind === 'link' ? t.outputs.linkCopied : t.outputs.copied);
      else if (done === 'revealed' && what === 'open') notify(t.outputs.revealed);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyShown = () =>
    void writeClipboard(o.path)
      .then(() => notify(o.kind === 'link' ? t.outputs.linkCopied : t.outputs.copied))
      .catch(() => notify(t.outputs.copyFailed));
  const reveal = isMac ? t.outputs.revealMac : t.outputs.revealOther;
  return (
    <li
      className={`output-row ${missing ? 'is-missing' : ''} output-${o.kind}`}
      data-output-id={o.id}
    >
      <span className="output-icon" aria-hidden>
        <OutputIcon output={o} />
      </span>
      <div className="output-body">
        <b className="output-name" title={privacy ? undefined : o.path}>
          {privacy ? t.outputs.hiddenName : o.name}
        </b>
        <span className="output-meta">
          {o.kind === 'file' && (
            <code className="output-dir" title={privacy ? undefined : o.dir}>
              {privacy ? t.outputs.hiddenPath : shortPath(o.dir)}
            </code>
          )}
          {o.kind === 'link' && (
            <code className="output-dir">{privacy ? t.outputs.hiddenPath : o.path}</code>
          )}
        </span>
        <span className="output-facts">
          {owner && <span className="output-owner">{owner}</span>}
          <span className={`output-via via-${o.via}`}>{t.outputs.via[o.via]}</span>
          <time title={`${date(o.createdAt)} ${time(o.createdAt)}`}>{ago(o.createdAt)}</time>
          {missing && <span className="output-missing">{t.outputs.missing}</span>}
        </span>
      </div>
      {actions ? (
        <span className="output-actions">
          {preview && (
            <button
              aria-label={`${t.outputs.preview} · ${o.name}`}
              title={t.outputs.previewTitle}
              disabled={busy || missing}
              onClick={() => void run('preview')}
            >
              <Eye size={13} />
              <span>{t.outputs.preview}</span>
            </button>
          )}
          <button
            aria-label={`${o.kind === 'link' ? t.outputs.openLink : t.outputs.open} · ${o.name}`}
            title={o.kind === 'link' ? t.outputs.openLink : t.outputs.openTitle}
            disabled={busy || missing}
            onClick={() => void run('open')}
          >
            <ExternalLink size={13} />
            <span>{t.outputs.open}</span>
          </button>
          {o.kind === 'file' && (
            <button
              className="icon-only"
              aria-label={`${reveal} · ${o.name}`}
              title={reveal}
              disabled={busy || missing}
              onClick={() => void run('reveal')}
            >
              <FolderOpen size={13} />
            </button>
          )}
          <button
            className="icon-only"
            aria-label={`${o.kind === 'link' ? t.outputs.copyLink : t.outputs.copyPath} · ${o.name}`}
            title={o.kind === 'link' ? t.outputs.copyLink : t.outputs.copyPath}
            disabled={busy}
            onClick={() => void run('copy')}
          >
            <Copy size={13} />
          </button>
        </span>
      ) : (
        // The web preview only lists: the shown path can still be copied from here.
        !privacy &&
        !demo && (
          <span className="output-actions">
            <button
              className="icon-only"
              aria-label={`${o.kind === 'link' ? t.outputs.copyLink : t.outputs.copyPath} · ${o.name}`}
              title={o.kind === 'link' ? t.outputs.copyLink : t.outputs.copyPath}
              onClick={copyShown}
            >
              <Copy size={13} />
            </button>
          </span>
        )
      )}
    </li>
  );
}

/**
 * The Outputs page beside the Memory drawer (#350): every output sessions made, by project and
 * then by teammate, newest first. Paths only; a file is read only when previewed.
 */
export function OutputsPage({
  sessions,
  demo,
  privacy,
  stamp,
  visibility,
  notify,
}: {
  sessions: Session[];
  demo: boolean;
  privacy: boolean;
  /** Changes whenever an output is recorded. */
  stamp: string;
  /** The settings that decide which outputs are shown (excluded projects, tools). */
  visibility: string;
  notify: (s: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const outputs = useOutputs({ text: query, stamp, visibility, demo });
  const groups = groupOutputs(outputs.list, sessions);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return (
    <div className="memory-page outputs-page page">
      <header className="page-head">
        <div>
          <span className="eyebrow">{t.outputs.eyebrow}</span>
          <h1>{t.outputs.title}</h1>
          <p>{t.outputs.intro}</p>
        </div>
      </header>
      <div className="memory-search">
        {outputs.loading ? <LoaderCircle size={19} className="spin" /> : <Search size={19} />}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.outputs.placeholder}
          aria-label={t.outputs.searchLabel}
          maxLength={200}
          disabled={demo}
        />
        {query && (
          <button className="icon-btn" aria-label={t.outputs.clear} onClick={() => setQuery('')}>
            <X size={15} />
          </button>
        )}
      </div>
      {demo ? (
        <div className="empty-state">
          <PackageOpen size={30} />
          <p>{t.outputs.demo}</p>
        </div>
      ) : (
        <>
          <div className="results-header">
            <span>
              {outputs.loading && !outputs.list.length ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                t.outputs.results(outputs.total)
              )}
            </span>
            <span>{t.outputs.sort}</span>
          </div>
          {!api.outputAction && outputs.list.length > 0 && (
            <p className="outputs-web-note">{t.outputs.webOnly}</p>
          )}
          {outputs.error && <div className="inline-error">{outputs.error}</div>}
          <div className="output-groups" role="region" aria-label={t.outputs.groupsLabel}>
            {groups.map((g) => (
              <section className="output-group" key={g.project}>
                <h2 className="output-project">
                  <span
                    className="source-dot"
                    style={{ background: projectColor(g.project) }}
                    aria-hidden
                  />
                  {privacy ? t.outputs.hiddenProject : g.project}
                </h2>
                {g.colleagues.map((c) => {
                  const session = byId.get(c.sessionId);
                  const provider = session?.provider ?? c.outputs[0].source.provider;
                  return (
                    <div className="output-colleague" key={c.sessionId}>
                      <h3>
                        {privacy ? t.outputs.hiddenTeammate : c.name}
                        <span className="memory-provider">{PROVIDERS[provider].short}</span>
                      </h3>
                      <ul className="output-list">
                        {c.outputs.map((o) => (
                          <OutputRow
                            key={o.id}
                            output={o}
                            privacy={privacy}
                            demo={demo}
                            notify={notify}
                          />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
          {outputs.more && (
            <button
              className="older-messages"
              disabled={outputs.loadingMore}
              onClick={() => void outputs.loadMore()}
            >
              {t.outputs.more}
            </button>
          )}
          {!outputs.loading && !outputs.error && !outputs.list.length && (
            <div className="empty-state">
              <PackageOpen size={30} />
              <h3>{query.trim() ? t.outputs.noMatch : t.outputs.emptyTitle}</h3>
              {!query.trim() && <p>{t.outputs.emptyBody}</p>}
            </div>
          )}
        </>
      )}
      <p className="page-note">{t.outputs.note}</p>
    </div>
  );
}

/**
 * A work card's Outputs tab (산출물): every output of its runs, newest first, a page at a time,
 * and in the big office a way to the Outputs page. The card reads the list (`useOutputs`) so its
 * tab can carry the count; nothing is read for a remote office's teammate.
 */
export function SessionOutputs({
  outputs,
  demo,
  privacy,
  notify,
  onAll,
}: {
  outputs: ReturnType<typeof useOutputs>;
  demo: boolean;
  privacy: boolean;
  notify: (s: string) => void;
  /** Open the Outputs page (absent where there is none, e.g. a card window). */
  onAll?: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="info-group card-outputs" aria-label={t.outputs.cardTitle}>
      <h3>
        {t.outputs.cardTitle}
        {outputs.loading && !outputs.list.length ? (
          <LoaderCircle size={12} className="spin" />
        ) : (
          outputs.total > 0 && <span className="card-outputs-count">{outputs.total}</span>
        )}
      </h3>
      {outputs.error && <div className="inline-error">{outputs.error}</div>}
      {outputs.list.length ? (
        <ul className="output-list">
          {outputs.list.map((o) => (
            <OutputRow key={o.id} output={o} privacy={privacy} demo={demo} notify={notify} />
          ))}
        </ul>
      ) : (
        !outputs.loading && !outputs.error && <p className="info-note">{t.outputs.cardEmpty}</p>
      )}
      {outputs.more && (
        <button
          className="info-row info-link card-outputs-more"
          disabled={outputs.loadingMore}
          onClick={() => void outputs.loadMore()}
        >
          <span>
            {outputs.loadingMore && <LoaderCircle size={12} className="spin" />}
            {t.outputs.more}
          </span>
        </button>
      )}
      {onAll && outputs.total > 0 && (
        <button className="info-row info-link card-outputs-all" onClick={onAll}>
          <span>{t.outputs.cardAll}</span>
        </button>
      )}
    </section>
  );
}
