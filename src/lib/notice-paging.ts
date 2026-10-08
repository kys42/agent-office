import { createContext, useContext } from 'react';
import type { NoticeQuery } from '../shared/types';

/**
 * Whether news lists must read older notices by page (the snapshot carries only a bounded
 * part), and how to mark a whole list read. Provided by each window's office core.
 */
export interface NoticePaging {
  paged: boolean;
  /** Changes with the office's notice counts, so paged lists read again. */
  stats?: string;
  readAll?: (query: NoticeQuery, asOf: number) => Promise<void>;
}
export const NoticePagingContext = createContext<NoticePaging>({ paged: false });
export const useNoticePaging = () => useContext(NoticePagingContext);
