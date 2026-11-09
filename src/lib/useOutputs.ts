import { useEffect, useRef, useState } from 'react';
import type { SessionOutput } from '../shared/types';
import { OUTPUT_PAGE, OUTPUT_PAGE_MAX, refreshed } from '../shared/outputs';
import { api } from './api';

/**
 * The outputs list both views draw (the Outputs page, a work card's section): one page newest
 * first, narrowed by `text` and `sessionIds`, read again when `stamp` changes (a new output was
 * recorded, settings changed). Nothing is read in the demo, or where the office cannot list
 * outputs. `loadMore` appends the next page after the last one listed.
 */
export function useOutputs({
  text = '',
  sessionIds,
  stamp,
  demo,
  limit = OUTPUT_PAGE,
}: {
  text?: string;
  sessionIds?: string[];
  stamp: string;
  demo: boolean;
  limit?: number;
}) {
  // Stable across snapshots that allocate the same member ids again.
  const scope = JSON.stringify(sessionIds ? [...new Set(sessionIds)].sort() : null);
  const scopedIds = () => (JSON.parse(scope) as string[] | null) ?? undefined;
  const [list, setList] = useState<SessionOutput[]>([]);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(list);
  latest.current = list;
  // Which reading a page continues: a new query or a change elsewhere starts another.
  const generation = useRef(0);
  /** The query the list holds (text, scope, page size). */
  const listed = useRef<string | null>(null);
  const available = !demo && !!api.outputs;
  useEffect(() => {
    if (!available) {
      setList([]);
      setTotal(0);
      setMore(false);
      return;
    }
    const reading = ++generation.current;
    // The same list read again (an output was recorded, settings changed) keeps what was loaded
    // further down; another query starts over.
    const query = JSON.stringify([text, scope, limit]);
    const again = listed.current === query;
    let active = true;
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        // As many as were listed, up to a page's bound.
        const page = await api.outputs!({
          text,
          sessionIds: scopedIds(),
          limit: again ? Math.min(Math.max(latest.current.length, limit), OUTPUT_PAGE_MAX) : limit,
        });
        if (!active || reading !== generation.current) return;
        listed.current = query;
        const merged = again ? refreshed(latest.current, page.outputs, page.more) : null;
        setList(merged ?? page.outputs);
        // A kept tail goes on where it ended.
        if (!merged) setMore(page.more);
        setTotal(page.total);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [text, stamp, scope, available, limit]);
  const loadMore = async () => {
    const last = list.at(-1);
    if (!last || loadingMore || !api.outputs) return;
    const reading = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.outputs({
        text,
        sessionIds: scopedIds(),
        before: { createdAt: last.createdAt, id: last.id },
        limit,
      });
      if (reading !== generation.current || latest.current.at(-1)?.id !== last.id) return;
      setList([...latest.current, ...page.outputs]);
      setMore(page.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };
  return { list, more, total, loading, loadingMore, error, loadMore, available };
}
