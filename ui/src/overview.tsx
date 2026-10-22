import {StopNotice} from "./stop-notice.js";
import { useEffect, useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Data, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { DashboardOverviewInfo, DashboardWorkInfo } from "../../src/dashboard-overview.js";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import { ApiClient, classifyMutation } from "./api.js";
import { pollWhileVisible, uiRuntime } from "./atoms.js";
import { directoryRoute, RouteLink, type Route } from "./navigation.js";
import { Icon } from "./icons.js";

export const workRoute = (work: Pick<DashboardWorkInfo, "projectId" | "mainThreadId">): Route =>
  ({...directoryRoute, projectId: work.projectId, main: work.mainThreadId});

export function ReadTime({value, prefix = "Read"}: {value: number | null; prefix?: string}) {
  return <span className="small muted">{prefix} {value === null ? "time unavailable" : <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{new Date(value).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}</time>}</span>;
}

// a page sequence that cannot form one coherent prefix of the overview
export class OverviewRangeError extends Data.TaggedError("OverviewRangeError")<{readonly reason: "invalid_overview_page" | "overview_changed_during_read"}> {}

// reads a coherent fresh prefix of at least `count` conversations in pages, restarting once when the overview changes
// between pages and rejecting reordered or duplicate pages (the Effect form of readOverviewRange)
export const readOverviewPages = <E, R>(read: (offset: number) => Effect.Effect<DashboardOverviewInfo, E, R>, count: number) => {
  const attempt = Effect.gen(function* () {
    const first = yield* read(0);
    if (first.offset !== 0) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
    let latest = first;
    const work = [...first.work];
    while (latest.hasMore && work.length < count) {
      const offset = latest.offset + latest.work.length;
      if (!latest.work.length) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
      const next = yield* read(offset);
      if (next.revision !== first.revision) return Option.none<DashboardOverviewInfo>();
      if (next.offset !== offset || next.total !== first.total) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
      work.push(...next.work); latest = next;
    }
    if (new Set(work.map(item => item.mainThreadId)).size !== work.length) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
    return Option.some({...first, work, hasMore: latest.hasMore});
  });
  return Effect.flatMap(attempt, Option.match({
    onSome: Effect.succeed,
    onNone: () => Effect.flatMap(attempt, Option.match({onSome: Effect.succeed, onNone: () => Effect.fail(new OverviewRangeError({reason: "overview_changed_during_read"}))})),
  }));
};

export const overviewRefreshMillis = 30_000;
export const overviewFailureMessage = "The work overview could not be refreshed. The last successful read is kept; current state may have changed.";

// the work overview of a dashboard: while enabled (active and connected) it reads the loaded range, at least 100
// conversations and 100 more after a load-more request, and keeps its last successful read through refreshes and
// failures; disabling it interrupts the read in flight and keeps the last result; the poll is mounted only while enabled.
// it is not keyed by the auth epoch: a 401 refreshes access, which announces a session change, so an epoch-keyed read
// would repeat while signed out (the baseline read retried only on its interval)
export const makeOverview = (pollMillis: number) => {
  const enabled = Atom.make(false);
  const more = Atom.make(false);
  const read = uiRuntime.atom((get) => {
    if (!get(enabled)) return Effect.never;
    const loaded = Option.match(Option.flatMap(get.self<AsyncResult.AsyncResult<DashboardOverviewInfo, unknown>>(), AsyncResult.value), {onNone: () => 0, onSome: value => value.work.length});
    const extend = get.once(more);
    if (extend) get.set(more, false);
    const count = Math.max(100, loaded + (extend ? 100 : 0));
    return Effect.flatMap(ApiClient, client => readOverviewPages(offset =>
      classifyMutation(client.guidance.dashboardOverview({query: {offset: String(offset), limit: "100"}})), count));
  });
  return {enabled, more, read, polled: read.pipe(pollWhileVisible(pollMillis))};
};
export const overview = makeOverview(overviewRefreshMillis);

export interface OverviewState {
  readonly data: DashboardOverviewInfo | null;
  readonly loading: boolean;
  readonly error: string;
  readonly refresh: () => void;
  readonly loadMore: () => void;
}

// what the shell shows for an overview result: a paused read is not loading, and a failure stays visible until the
// next read starts
export const overviewView = (result: AsyncResult.AsyncResult<DashboardOverviewInfo, unknown>, enabled: boolean) => {
  const loading = enabled && result.waiting;
  return {data: Option.getOrNull(AsyncResult.value(result)), loading, error: AsyncResult.isFailure(result) && !loading ? overviewFailureMessage : ""};
};

export function useOverview(active: boolean, connected: boolean): OverviewState {
  const enabled = active && connected;
  const setEnabled = useAtomSet(overview.enabled);
  useEffect(() => setEnabled(enabled), [enabled, setEnabled]);
  const result = useAtomValue(enabled ? overview.polled : overview.read);
  const refresh = useAtomRefresh(overview.read);
  const setMore = useAtomSet(overview.more);
  return {...overviewView(result, enabled), refresh, loadMore: () => { setMore(true); refresh(); }};
}

export function WorkState({work}: {work: DashboardWorkInfo}) {
  return <div className="work-state"><span className={`pill ${work.attention.length ? "amber" : work.supervision === "enabled" ? "green" : ""}`}>
    {work.supervision === "stopped" ? "Stopped for this chat" : work.supervision === "disabled" ? "Supervision disabled" : work.attention.length ? "Needs attention" : "Supervision enabled"}
  </span><span className="small muted">{work.assessment ? `Assessed: ${work.assessment.status.replaceAll("_", " ")}` : work.planStatus ? `Plan: ${work.planStatus}` : "No plan recorded"}</span></div>;
}

export function WorkTable({work, data, navigate, empty = "No supervised conversations match these filters."}: {
  work: readonly DashboardWorkInfo[]; data: GuidanceSnapshot; navigate: (route: Route) => void; empty?: string;
}) {
  if (!work.length) return <div className="empty-state"><h3>No matching work</h3><p className="muted">{empty}</p></div>;
  return <div className="table-scroll" role="region" aria-label="Supervised conversations" tabIndex={0}>
    <table className="work-table"><thead><tr><th scope="col">Conversation / objective</th><th scope="col">Project</th><th scope="col">Native activity</th><th scope="col">Supervision / plan</th><th scope="col">Task updated</th></tr></thead>
      <tbody>{work.map(item => <tr key={item.mainThreadId}>
        <th scope="row"><RouteLink to={workRoute(item)} navigate={navigate}>{item.title}<Icon name="arrow" size={16}/></RouteLink><p className="work-objective">{item.objective ?? "No interpreted objective recorded."}</p>{item.assessment?.summary && <p className="small muted">{item.assessment.summary}</p>}{item.attention[0] && <p className="work-warning">{item.attention[0]}</p>}</th>
        <td>{data.projects.find(project => project.id === item.projectId)?.title ?? "Unavailable project"}</td>
        <td><span className={`native-state ${item.nativeState === "active" ? "active" : ""}`}><span className="dot"/>{({active: "Active", waiting: "Waiting", quiet: "Quiet", unknown: "Unknown"})[item.nativeState]}</span></td>
        <td><WorkState work={item}/></td><td><ReadTime value={item.updatedAt} prefix=""/></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function Home({data, overview, navigate, startPanel}: {data: GuidanceSnapshot; overview: OverviewState; navigate: (route: Route) => void; startPanel?: React.ReactNode}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [project, setProject] = useState("");
  const result = overview.data;
  const attention = result?.work.filter(item => item.attention.length > 0) ?? [];
  const work = result?.work.filter(item => (!project || item.projectId === project) &&
    (filter === "all" || filter === "attention" && item.attention.length > 0 || filter === "active" && item.nativeState === "active" || filter === "stopped" && item.supervision !== "enabled") &&
    `${item.title} ${item.objective ?? ""} ${item.reason}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="stack home-workspace">
    <div className="page-heading heading-actions"><div><h1>Work overview</h1><p className="muted">What needs your attention, and where work stands.</p></div><div className="row"><ReadTime value={result?.observedAt ?? null}/><button onClick={overview.refresh} disabled={!data.connected || overview.loading}><Icon name="refresh" size={17}/>{overview.loading ? "Refreshing…" : "Refresh overview"}</button></div></div>
    {(!data.connected || overview.error || result && !result.available) && <div className="notice" role="status"><strong>Current coverage is limited.</strong> {overview.error || (!data.connected ? "T3 is disconnected. Showing retained information; it may be out of date." : "Supervisor access is unavailable. Current supervision state has not been established.")}</div>}
    {result?.projects.some(item => !item.available) && <p className="notice">Some projects are unavailable. Their current work is not included in this overview.</p>}
    {!result && !overview.error && <div className="loading-state" role="status"><div className="skeleton"/><div className="skeleton"/><p>Reading current work…</p></div>}
    {result && <>
      <section className="attention-section" aria-labelledby="attention-heading"><div className="section-heading row between"><h2 id="attention-heading">Needs attention <span className="count">{result.attentionTotal}</span></h2><span className="small muted">Current state, separate from activity history</span></div>
        {attention.length > 0 ? <div className="attention-list">{attention.slice(0, 5).map(item => <RouteLink key={item.mainThreadId} to={workRoute(item)} navigate={navigate} className="attention-row"><Icon name="alert"/><div><strong>{item.title}</strong><p>{item.attention[0]}</p><span className="small muted">{data.projects.find(project => project.id === item.projectId)?.title} · <ReadTime value={item.updatedAt} prefix="Task updated"/></span></div><Icon name="arrow"/></RouteLink>)}</div>
          : <div className="quiet-state"><Icon name="check"/><div><strong>{data.connected && result.available && !overview.error ? "No attention items recorded in available projects" : "No attention items in the retained read"}</strong><p className="muted">Quiet or stopped supervision does not establish that a task is complete.</p></div></div>}
      </section>
      {startPanel}
      <section className="work-section" aria-labelledby="current-work-heading"><div className="section-heading row between"><div><h2 id="current-work-heading">Supervised work <span className="count">{result.total}</span></h2><p className="muted small">Native activity and Supervisor records describe different things.</p></div><RouteLink to={directoryRoute} navigate={navigate}>Browse projects<Icon name="arrow" size={16}/></RouteLink></div>
        <div className="filter-bar"><label className="search"><span className="sr-only">Search work</span><Icon name="search" size={18}/><input type="search" aria-label="Search work" placeholder="Search conversations or objectives" value={query} onChange={event => setQuery(event.target.value)}/></label><label><span className="sr-only">Filter by project</span><select aria-label="Filter by project" value={project} onChange={event => setProject(event.target.value)}><option value="">All projects</option>{result.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label><span className="sr-only">Filter work status</span><select aria-label="Filter work status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All states</option><option value="attention">Needs attention</option><option value="active">Native activity: active</option><option value="stopped">Supervision off</option></select></label></div>
        <WorkTable work={work} data={data} navigate={navigate} empty={result.total ? "Try another search or filter. Filters apply to the loaded conversations." : "Open a project to inspect its conversations and supervision settings. No bound main conversations were found in available projects."}/>
        {result.hasMore && <div className="pagination"><p className="muted small">{result.work.length} of {result.total} conversations loaded. Filters apply to this loaded set.</p><button disabled={overview.loading || !data.connected} onClick={overview.loadMore}>Load more conversations</button></div>}
      </section>
    </>}
    {result?.work.some(item => item.stop) && <section className="stack" aria-label="Stopped supervision"><h2>Stopped supervision</h2>{result.work.filter(item => item.stop).slice(0, 3).map(item => <StopNotice key={item.mainThreadId} audit={item.stop!} title={item.title} enableLabel="Review and enable" onEnable={() => navigate(workRoute(item))}/>)}</section>}
    <section aria-labelledby="recent-changes-title" className="stack"><div className="section-heading row between"><h2 id="recent-changes-title">Recent changes</h2><RouteLink to={{...directoryRoute, page: "activity"}} navigate={navigate}>All activity<Icon name="arrow" size={16}/></RouteLink></div>
      <ol className="recent-activity">{[...data.activity].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(item => {
        const thread = data.threads.find(thread => thread.id === item.threadId);
        return <li key={item.id}><span className="activity-mark"/><div><strong>{item.reason.replaceAll("_", " ")}</strong><p className="muted small">{item.state.replaceAll("_", " ")} · {thread?.title ?? "Supervisor"} · <ReadTime value={item.createdAt} prefix=""/></p></div>{thread?.projectId && <RouteLink to={workRoute({projectId: thread.projectId, mainThreadId: thread.id})} navigate={navigate}>Inspect<span className="sr-only"> {thread.title}</span></RouteLink>}</li>;
      })}</ol>{!data.activity.length && <p className="empty-inline muted">No recorded activity yet. New observations will appear here.</p>}
    </section>
  </section>;
}
