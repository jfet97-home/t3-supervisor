import {StopNotice} from "./stop-notice.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { DashboardOverview, readOverviewRange, type DashboardOverviewInfo, type DashboardWorkInfo } from "../../src/dashboard-overview.js";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import { loadAccess, sessionHeaders } from "./access.js";
import { directoryRoute, RouteLink, type Route } from "./navigation.js";
import { Icon } from "./icons.js";

export const workRoute = (work: Pick<DashboardWorkInfo, "projectId" | "mainThreadId">): Route =>
  ({...directoryRoute, projectId: work.projectId, main: work.mainThreadId});

export function ReadTime({value, prefix = "Read"}: {value: number | null; prefix?: string}) {
  return <span className="small muted">{prefix} {value === null ? "time unavailable" : <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{new Date(value).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}</time>}</span>;
}

export function useOverview(active: boolean, connected: boolean) {
  const [data, setData] = useState<DashboardOverviewInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(data); current.current = data;
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (more = false) => {
    if (!connected) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    const previous = current.current;
    const count = Math.max(100, (previous?.work.length ?? 0) + (more ? 100 : 0));
    try {
      const result = await readOverviewRange(async offset => {
        const response = await fetch(`/api/guidance/dashboard-overview?offset=${offset}&limit=100`, {credentials: "omit", headers: sessionHeaders(), signal: controller.signal});
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) await loadAccess();
          throw new Error("The work overview could not be refreshed.");
        }
        return Schema.decodeUnknownSync(DashboardOverview)(await response.json());
      }, count);
      if (!controller.signal.aborted) setData(result);
    } catch {
      if (!controller.signal.aborted) setError("The work overview could not be refreshed. The last successful read is kept; current state may have changed.");
    } finally {if (!controller.signal.aborted) setLoading(false);}
  }, [connected]);
  useEffect(() => {
    if (!active || !connected) {request.current?.abort(); setLoading(false); return;}
    void load();
    const timer = setInterval(() => {if (!document.hidden) void load();}, 30_000);
    return () => {clearInterval(timer); request.current?.abort();};
  }, [active, connected, load]);
  return {data, loading, error, refresh: () => {void load();}, loadMore: () => {void load(true);}};
}
export type OverviewState = ReturnType<typeof useOverview>;

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
