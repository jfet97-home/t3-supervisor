import React, { useCallback, useEffect, useRef, useState } from "react";

export type ProjectSection = "progress" | "plan" | "definitions" | "settings";
export type Route = {page: "projects" | "activity" | "settings" | "guide"; projectId: string; main: string | null; section: ProjectSection};
export const directoryRoute: Route = {page: "projects", projectId: "", main: null, section: "progress"};
export const projectSections: readonly ProjectSection[] = ["progress", "plan", "definitions", "settings"];
export type NavigationGuard = (next: Route) => boolean;

export function parseRoute(hash: string): Route {
  try {
    const url = new URL(hash.replace(/^#/, "") || "/projects", "http://supervisor.local");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const page = parts[0];
    if (page === "projects") {
      const section = projectSections.find(value => value === parts[2]) ?? "progress";
      return {...directoryRoute, projectId: parts[1] ?? "", section, main: url.searchParams.get("main")};
    }
    if (page === "activity" || page === "settings" || page === "guide") return {...directoryRoute, page};
  } catch { /* Invalid addresses return to the project directory. */ }
  return directoryRoute;
}

export function routeHref(route: Route): string {
  if (route.page !== "projects" || !route.projectId) return `#/${route.page}`;
  const query = route.main === null ? "" : `?${new URLSearchParams({main: route.main})}`;
  return `#/projects/${encodeURIComponent(route.projectId)}/${route.section}${query}`;
}

export function rememberContext(route: Route) {
  if (!route.projectId || route.main === null) return;
  try { sessionStorage.setItem(`supervisor-context:${route.projectId}`, JSON.stringify({main: route.main, section: route.section})); } catch { /* Navigation also works without storage. */ }
}

export function openProject(projectId: string): Route {
  const fallback = {...directoryRoute, projectId};
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`supervisor-context:${projectId}`) ?? "null");
    if (typeof value === "object" && value !== null && "main" in value && typeof value.main === "string" && "section" in value && projectSections.includes(value.section as ProjectSection)) {
      return {...fallback, main: value.main, section: value.section as ProjectSection};
    }
  } catch { /* An absent or invalid remembered context opens the chooser. */ }
  return fallback;
}

type HistoryState = {hash: string; state: unknown; index?: number | null; length?: number};
export type NavigationHistory = {
  read: () => HistoryState;
  push: (href: string, state: object) => void;
  replace: (href: string, state: object) => void;
  go: (delta: number) => void;
  later?: (callback: () => void, ms: number) => void;
};
const restoreTimeoutMs = 1000;
const maxRestoreSteps = 100;
const historyOf = (state: unknown): string | null => typeof state === "object" && state !== null && "supervisorHistory" in state && typeof state.supervisorHistory === "string" ? state.supervisorHistory : null;
const markerOf = (state: unknown): number | null => typeof state === "object" && state !== null && "supervisorPosition" in state && Number.isSafeInteger(state.supervisorPosition) ? state.supervisorPosition as number : null;
const newHistory = () => Math.random().toString(36).slice(2);

// positions are relative entry indices; without the Navigation API, entries this page has not marked have unknown positions
export function createNavigator(initial: Route, host: NavigationHistory, allow: NavigationGuard, changed: (route: Route) => void) {
  let route = initial;
  const first = host.read();
  let lineage = historyOf(first.state) ?? newHistory();
  let position: number | null = first.index ?? markerOf(first.state) ?? 0;
  let unknownHash: string | null = null;
  let length = first.length;
  let restore: {token: number; mode: "exact" | "forward" | "back"; rejected: number | null; from: string | null; steps: number} | null = null;
  let tokens = 0;
  const positionAt = (observed: HistoryState) => observed.index ?? (historyOf(observed.state) === lineage ? markerOf(observed.state) : null);
  const stateAt = (index: number) => { const previous = host.read().state; return {...(typeof previous === "object" && previous !== null ? previous : {}), supervisorPosition: index, supervisorHistory: lineage}; };
  const synced = () => { length = host.read().length; };
  const accept = (next: Route) => { route = next; changed(next); };
  const indexed = (index: number) => { position = index; unknownHash = null; };
  const unindexed = (hash: string) => { position = null; unknownHash = hash; };
  const mark = (href: string) => {
    if (position === null) { lineage = newHistory(); indexed(0); } else indexed(position + 1);
    host.replace(href, stateAt(position!));
    synced();
  };
  const restart = () => { lineage = newHistory(); indexed(0); host.push(routeHref(route), stateAt(0)); synced(); };
  const recover = () => {
    // a requested traversal produced no event; resynchronize without overwriting an entry whose position is unknown
    restore = null;
    const observed = host.read();
    const target = positionAt(observed);
    if (target === null) { if (position !== null || observed.hash !== unknownHash) restart(); return; }
    indexed(target);
    if (routeHref(parseRoute(observed.hash)) !== routeHref(route)) host.replace(routeHref(route), stateAt(target));
    synced();
  };
  const traverse = (delta: number, mode: "exact" | "forward" | "back", rejected: number | null, from: string | null, steps: number) => {
    const token = ++tokens;
    restore = {token, mode, rejected, from, steps};
    host.go(delta);
    host.later?.(() => { if (restore?.token === token) recover(); }, restoreTimeoutMs);
  };
  // moves from a rejected entry back to the entry the page shows; unindexed history is walked one entry at a time
  const towardCurrent = (observed: HistoryState, target: number | null, steps: number) => {
    if (steps > maxRestoreSteps) { restore = null; restart(); }
    else if (target !== null && position !== null) traverse(position - target, "exact", target, null, steps);
    else if (target !== null) traverse(-(target + 1), "back", target, observed.hash, steps);
    else traverse(1, "forward", null, observed.hash, steps);
  };
  const continueRestore = (observed: HistoryState, target: number | null, next: Route): boolean => {
    const pending = restore!;
    if (target !== null && target === position) {
      restore = null;
      if (routeHref(next) !== routeHref(route)) host.replace(routeHref(route), stateAt(target));
      synced();
      return true;
    }
    if (target !== null && target === pending.rejected) return true;
    if (pending.mode === "exact") { restore = null; return false; }
    if (target !== null) {
      if (pending.mode === "forward") towardCurrent(observed, target, pending.steps + 1);
      else { restore = null; restart(); }
      return true;
    }
    if (observed.hash === pending.from) return true;
    if (position === null && observed.hash === unknownHash) { restore = null; synced(); return true; }
    if (pending.steps >= maxRestoreSteps) { restore = null; restart(); return true; }
    traverse(pending.mode === "back" ? -1 : 1, pending.mode, null, observed.hash, pending.steps + 1);
    return true;
  };
  return {
    start: () => { host.replace(routeHref(route), stateAt(position ?? 0)); synced(); },
    navigate(next: Route) {
      if (restore || routeHref(next) === routeHref(route) || !allow(next)) return;
      if (position === null) { route = next; restart(); changed(next); return; }
      host.push(routeHref(next), stateAt(position + 1));
      indexed(host.read().index ?? position + 1);
      synced();
      accept(next);
    },
    historyChanged() {
      const observed = host.read();
      const target = positionAt(observed);
      const next = parseRoute(observed.hash);
      if (restore && continueRestore(observed, target, next)) return;
      // a changed history length means the browser added this entry right after the current one
      const added = target === null && (observed.length === undefined || observed.length !== length);
      if (routeHref(next) === routeHref(route)) {
        if (target !== null) indexed(target);
        else if (added) mark(routeHref(route));
        else unindexed(observed.hash);
        synced();
        return;
      }
      if (!allow(next)) {
        if (added) mark(routeHref(route));
        else if (target !== null && target === position) { host.replace(routeHref(route), stateAt(target)); synced(); }
        else towardCurrent(observed, target, 0);
        return;
      }
      if (target !== null) indexed(target);
      else if (added) mark(routeHref(next));
      else unindexed(observed.hash);
      synced();
      accept(next);
    },
  };
}

export function useNavigation() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const guard = useRef<NavigationGuard>(() => true);
  const [controller] = useState(() => createNavigator(route, {
    read: () => ({hash: window.location.hash, state: history.state, index: window.navigation?.currentEntry?.index ?? null, length: history.length}),
    push: (href, state) => history.pushState(state, "", href),
    replace: (href, state) => history.replaceState(state, "", href),
    go: delta => history.go(delta),
    later: (callback, ms) => { window.setTimeout(callback, ms); },
  }, next => guard.current(next), next => { rememberContext(next); setRoute(next); }));
  const navigate = useCallback((next: Route) => controller.navigate(next), [controller]);
  useEffect(() => {
    controller.start();
    rememberContext(route);
    const changed = () => controller.historyChanged();
    window.addEventListener("hashchange", changed);
    window.addEventListener("popstate", changed);
    return () => { window.removeEventListener("hashchange", changed); window.removeEventListener("popstate", changed); };
  }, [controller]);
  return {route, navigate, guard};
}

export function RouteLink({to, navigate, children, ...props}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {to: Route; navigate: (route: Route) => void}) {
  return <a {...props} href={routeHref(to)} onClick={event => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const previous = parseRoute(window.location.hash);
    navigate(to);
    if (routeHref(parseRoute(window.location.hash)) !== routeHref(to)) return;
    requestAnimationFrame(() => {
      const pageChanged = previous.page !== to.page || previous.projectId !== to.projectId || !to.projectId;
      const heading = pageChanged
        ? [...document.querySelectorAll<HTMLElement>("#workspace h1")].find(element => !element.closest("[hidden]"))
        : document.getElementById("project-section-heading");
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    });
  }}>{children}</a>;
}
