import {RefreshAction} from "./refresh-action.js";
import { ListPager, pageWindow } from "./pagination.js";
import { StatusBadge } from "./supervision-status.js";
import { conversationLabel } from "./conversation-status.js";
import {activityTitle} from "./activity-presentation.js";
import { useEffect } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { type OverviewQuery, type DashboardOverviewInfo, type DashboardWorkInfo } from "../../src/dashboard-overview.js";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import { ApiClient, classifyMutation } from "./api.js";
import { authEpoch, environmentAtom, refreshOnDashboardChange, uiRuntime } from "./atoms.js";
import { directoryRoute, homeRoute, RouteLink, type Route } from "./navigation.js";
import { Icon } from "./icons.js";

/** A work row opens its task; a stopped row opens Supervision, where the stop record and Enable action are. */
export const workRoute = (work: Pick<DashboardWorkInfo, "projectId" | "mainThreadId"> & {stop?: DashboardWorkInfo["stop"]}): Route =>
  ({...directoryRoute, projectId: work.projectId, main: work.mainThreadId, section: work.stop ? "supervision" : "task"});

export function ReadTime({value, prefix = "Read"}: {value: number | null; prefix?: string}) {
  return <span className="small muted">{prefix} {value === null ? "time unavailable" : <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{new Date(value).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}</time>}</span>;
}

export const overviewFailureMessage = "The work overview could not be refreshed. The last successful read is kept; current state may have changed.";

// one typed page read follows the selected full-collection query, auth epoch and environment
// background hints re-read this exact selection; retained success/failure and other drafts remain independent
export type OverviewSelection = OverviewQuery & {page: number};
export const makeOverview = () => {
  const enabled = Atom.make(false);
  const selection = Atom.make<OverviewSelection>({q: "", projectId: "", filter: "all", page: 1});
  const read = uiRuntime.atom((get) => {
    if (!get(enabled)) return Effect.never;
    authEpoch(get); get(environmentAtom);
    const query = get(selection);
    return Effect.flatMap(ApiClient, client => classifyMutation(client.guidance.dashboardOverview({query: {q: query.q, projectId: query.projectId, filter: query.filter, offset: String((query.page - 1) * 25), limit: "25"}})));
  });
  return {enabled, selection, read, live: read.pipe(refreshOnDashboardChange("overview"))};
};
export const overview = makeOverview();

export interface OverviewState {
  readonly data: DashboardOverviewInfo | null;
  readonly loading: boolean;
  readonly error: string;
  readonly refresh: () => void;
}

// what the shell shows for an overview result: a paused read is not loading, and a failure stays visible until the
// next read starts
export const overviewView = (result: AsyncResult.AsyncResult<DashboardOverviewInfo, unknown>, enabled: boolean) => {
  const loading = enabled && result.waiting;
  return {data: Option.getOrNull(AsyncResult.value(result)), loading, error: AsyncResult.isFailure(result) && !loading ? overviewFailureMessage : ""};
};

export const homeSelection = (route: Route): OverviewSelection => ({q: route.q ?? "", projectId: route.workProject ?? "", filter: route.workFilter ?? "all", page: route.listPage ?? 1});

export function useOverview(active: boolean, connected: boolean, route: Route): OverviewState {
  const enabled = active && connected;
  const setSelection = useAtomSet(overview.selection);
  useEffect(() => {if (route.page === "home") setSelection(current => {
    const next = homeSelection(route);
    return JSON.stringify(current) === JSON.stringify(next) ? current : next;
  });}, [route.page, route.q, route.workProject, route.workFilter, route.listPage, setSelection]);
  const setEnabled = useAtomSet(overview.enabled);
  useEffect(() => setEnabled(enabled), [enabled, setEnabled]);
  const result = useAtomValue(enabled ? overview.live : overview.read);
  const refresh = useAtomRefresh(overview.read);
  return {...overviewView(result, enabled), refresh};
}

export function WorkState({work, fresh = true}: {work: DashboardWorkInfo; fresh?: boolean}) {
  const off = work.supervision !== "enabled";
  const conversation = conversationLabel(work.engagement, fresh, work.supervision === "stopped");
  const state = off ? work.supervision === "stopped" ? "Supervision stopped" : "Supervision disabled" : work.attention.length ? "Needs attention" : conversation ?? (work.assessment?.status === "completed" ? "Completed" : work.assessment?.status === "underway" ? "In progress" : work.planStatus === "agreed" ? "Plan agreed" : "Awaiting assessment");
  const outcome = work.assessment?.status === "completed" ? "Completed" : work.assessment?.status === "underway" ? "In progress" : work.planStatus === "agreed" ? "Plan agreed" : null;
  return <div className="work-state"><StatusBadge label={off ? state : conversation ?? state} tone={off ? "off" : fresh && work.engagement?.availability === "current" ? "on" : "unknown"} icon={off ? "pause" : fresh && work.engagement?.availability === "current" ? "shield" : "alert"}/>{!off && state !== conversation && <span className="pill amber">{state}</span>}{!off && conversation === "Engaged in the task" && outcome && <span className="small muted">{outcome}</span>}</div>;
}

export function WorkTable({work, data, navigate, empty = "No supervised conversations match these filters.", emptyTitle = "No matching work", fresh = true}: {
  work: readonly DashboardWorkInfo[]; data: GuidanceSnapshot; navigate: (route: Route) => void; empty?: string; emptyTitle?: string; fresh?: boolean;
}) {
  if (!work.length) return <div className="empty-state"><h3>{emptyTitle}</h3><p className="muted">{empty}</p></div>;
  return <div className="table-scroll" role="region" aria-label="Supervised conversations" tabIndex={0}>
    <table className="work-table"><thead><tr><th scope="col">Conversation / objective</th><th scope="col">Project</th><th scope="col">Native activity</th><th scope="col">Supervision / plan</th><th scope="col">Task updated</th></tr></thead>
      <tbody>{work.map(item => <tr key={item.mainThreadId}>
        <th scope="row"><RouteLink to={workRoute(item)} navigate={navigate} title={item.title}>{item.title}<Icon name="arrow" size={16}/></RouteLink><p className="work-objective" title={item.objective ?? undefined}>{item.objective ?? "No interpreted objective recorded."}</p>{(item.attention[0] || item.assessment?.summary) && <p className={item.attention[0] ? "work-warning work-summary" : "small muted work-summary"} title={item.attention[0] || item.assessment?.summary}>{item.attention[0] || item.assessment?.summary}</p>}</th>
        <td>{data.projects.find(project => project.id === item.projectId)?.title ?? "Unavailable project"}</td>
        <td><span className={`native-state ${item.nativeState === "active" ? "active" : ""}`}><span className="dot"/>{({active: "Active", waiting: "Waiting", quiet: "Quiet", unknown: "Unknown"})[item.nativeState]}</span></td>
        <td><WorkState work={item} fresh={fresh}/></td><td><ReadTime value={item.updatedAt} prefix=""/></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function Home({data, overview, navigate, startPanel, route = homeRoute}: {data: GuidanceSnapshot; overview: OverviewState; navigate: (route: Route, options?: {replace?: boolean}) => void; startPanel?: React.ReactNode; route?: Route}) {
  const selection = homeSelection(route);
  const setSelection = (change: (current: OverviewSelection) => OverviewSelection, replace = true) => {
    const next = change(selection);
    navigate({...route, q: next.q, workProject: next.projectId, workFilter: next.filter, listPage: next.page}, {replace});
  };
  const {q: query, filter, projectId: project, page} = selection;
  const result = overview.data;
  const attention = result?.attention ?? [];
  const range = pageWindow(result?.total ?? 0, page);
  const selectionCurrent = result && result.query.q === query.trim() && result.query.filter === filter && result.query.projectId === project && result.offset === (page - 1) * 25;
  useEffect(() => {if (selectionCurrent && !overview.loading && !overview.error && page !== range.page) setSelection(current => ({...current, page: range.page}));}, [selectionCurrent, overview.loading, overview.error, page, range.page, setSelection]);
  return <section className="stack home-workspace">
    <div className="page-heading heading-actions"><div><h1>Work overview</h1><p className="muted">What needs your attention, and where work stands.</p></div><div className="row"><ReadTime value={result?.observedAt ?? null}/><RefreshAction label="Refresh work overview" busy={overview.loading} enabled={data.connected} onRefresh={overview.refresh}/></div></div>
    {(!data.connected || overview.error || result && !result.available) && <div className="notice" role="status"><strong>Current coverage is limited.</strong> {result ? overview.error || (!data.connected ? "T3 is disconnected. Showing the last read; it may be out of date." : "Supervisor access is unavailable. Current supervision state has not been established.") : !data.connected ? "T3 is disconnected. Reconnect to load current work." : "Could not load current work. No successful read is available."} <button type="button" onClick={() => {if (data.connected && !overview.loading) overview.refresh();}} aria-disabled={!data.connected || overview.loading}>Retry overview</button></div>}
    {result?.projects.some(item => !item.available) && <p className="notice">Some projects are unavailable. Their current work is not included in this overview.</p>}
    {!result && !overview.error && data.connected && <div className="loading-state" role="status"><div className="skeleton"/><div className="skeleton"/><p>Reading current work…</p></div>}
    {result && <>
      <section className="attention-section" aria-labelledby="attention-heading"><div className="section-heading row between"><h2 id="attention-heading">Needs attention <span className="count">{result.attentionTotal}</span></h2><span className="small muted">Current state, separate from activity history</span></div>
        {attention.length > 0 ? <div className="attention-list">{attention.slice(0, 5).map(item => <RouteLink key={item.mainThreadId} to={workRoute(item)} navigate={navigate} className="attention-row"><Icon name="alert"/><div><strong>{item.title}</strong><p>{item.attention[0]}</p><span className="small muted">{data.projects.find(project => project.id === item.projectId)?.title} · <ReadTime value={item.updatedAt} prefix="Task updated"/></span></div><Icon name="arrow"/></RouteLink>)}</div>
          : <div className="quiet-state"><Icon name="check"/><div><strong>{data.connected && result.available && !overview.error ? "No attention items recorded in available projects" : "No attention items in the retained read"}</strong><p className="muted">Quiet or stopped supervision does not establish that a task is complete.</p></div></div>}
      </section>
      {startPanel}
      <section className="work-section" aria-labelledby="current-work-heading"><div className="section-heading row between"><div><h2 id="current-work-heading">Supervised work <span className="count">{result.total}</span></h2><p className="muted small">Native activity and Supervisor records describe different things.</p></div><RouteLink to={directoryRoute} navigate={navigate}>Browse projects<Icon name="arrow" size={16}/></RouteLink></div>
        {result.availableTotal > 0 && <div className="filter-bar"><label className="search"><span className="sr-only">Search work</span><Icon name="search" size={18}/><input type="search" aria-label="Search work" placeholder="Search conversations or objectives" value={query} onChange={event => setSelection(current => ({...current, q: event.target.value, page: 1}))}/></label><label><span className="sr-only">Filter by project</span><select aria-label="Filter by project" value={project} onChange={event => setSelection(current => ({...current, projectId: event.target.value, page: 1}))}><option value="">All projects</option>{result.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label><span className="sr-only">Filter work status</span><select aria-label="Filter work status" value={filter} onChange={event => setSelection(current => ({...current, filter: event.target.value as OverviewQuery["filter"], page: 1}))}><option value="all">All states</option><option value="attention">Needs attention</option><option value="active">Native activity: active</option><option value="stopped">Supervision off</option></select></label></div>}
        <p className="small muted">Search covers all {result.availableTotal} available supervised conversations. {result.total} match this query.</p>{!selectionCurrent && <p className="muted small">{overview.error ? "The selected query could not be read. Showing the previous range." : "Updating the selected query; the previous range remains visible."}</p>}<ListPager disabled={!selectionCurrent || overview.loading} label="Supervised work" total={result.total} page={Math.floor(result.offset / result.limit) + 1} onPage={page => setSelection(current => ({...current, page}), false)}/>
        <WorkTable fresh={data.connected && result.available && !overview.error} work={result.work} data={data} navigate={navigate} emptyTitle={result.availableTotal ? "No matching work" : "No supervised conversations yet"} empty={result.availableTotal ? "Try another search or filter. Search covers the full available collection." : "Open a project to inspect its conversations and supervision settings. No bound main conversations were found in available projects."}/>
        {result.total === 0 && <RouteLink to={directoryRoute} navigate={navigate} className="button-link primary-link">Choose a project</RouteLink>}

      </section>
    </>}
    <section aria-labelledby="recent-changes-title" className="stack"><div className="section-heading row between"><h2 id="recent-changes-title">Recent changes</h2><RouteLink to={{...directoryRoute, page: "activity"}} navigate={navigate}>All activity<Icon name="arrow" size={16}/></RouteLink></div>
      <ol className="recent-activity">{[...data.activity].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(item => {
        const thread = data.threads.find(thread => thread.id === item.threadId);
        return <li key={item.id}><span className="activity-mark"/><div><strong>{activityTitle(item)}</strong><p className="muted small">{thread?.title ?? "Supervisor"} · <ReadTime value={item.createdAt} prefix=""/></p></div>{thread?.projectId && <RouteLink to={workRoute({projectId: thread.projectId, mainThreadId: thread.id})} navigate={navigate}>Inspect<span className="sr-only"> {thread.title}</span></RouteLink>}</li>;
      })}</ol>{!data.activity.length && <p className="empty-inline muted">No recorded activity yet. New observations will appear here.</p>}
    </section>
  </section>;
}
