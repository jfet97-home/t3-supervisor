import { Icon } from "./icons.js";

export const defaultPageSize = 25;
export function pageWindow(total: number, requestedPage: number, size = defaultPageSize) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(1, Math.min(pages, Math.trunc(requestedPage) || 1));
  const offset = (page - 1) * size;
  return {page, pages, offset, size, start: total ? offset + 1 : 0, end: Math.min(total, offset + size), total};
}
export function ListPager({total, page, onPage, size = defaultPageSize, label = "Results", disabled = false}: {
  total: number; page: number; disabled?: boolean; size?: number; label?: string; onPage: (page: number) => void;
}) {
  const range = pageWindow(total, page, size);
  return <nav className="list-pager" aria-label={`${label} pages`}>
    <p className="small muted" role="status">{range.start}–{range.end} of {total} <span>· Page {range.page} of {range.pages}</span></p>
    <div className="row"><button type="button" aria-disabled={disabled || range.page === 1} onClick={() => {if (!disabled && range.page > 1) onPage(range.page - 1);}}><Icon name="back" size={16}/>Previous</button>
      <button type="button" aria-disabled={disabled || range.page === range.pages} onClick={() => {if (!disabled && range.page < range.pages) onPage(range.page + 1);}}>Next<Icon name="arrow" size={16}/></button></div>
  </nav>;
}
