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

type HistoryState = {hash: string; state: unknown};
export type NavigationHistory = {
  read: () => HistoryState;
  push: (href: string, state: object) => void;
  replace: (href: string, state: object) => void;
  go: (delta: number) => void;
};
const positionOf = (state: unknown): number | null => typeof state === "object" && state !== null && "supervisorPosition" in state && Number.isSafeInteger(state.supervisorPosition) ? state.supervisorPosition as number : null;

export function createNavigator(initial: Route, host: NavigationHistory, allow: NavigationGuard, changed: (route: Route) => void) {
  let route = initial;
  let position = positionOf(host.read().state) ?? 0;
  let restoring = false;
  const stateAt = (index: number) => { const previous = host.read().state; return {...(typeof previous === "object" && previous !== null ? previous : {}), supervisorPosition: index}; };
  const accept = (next: Route) => { route = next; changed(next); };
  return {
    start: () => host.replace(routeHref(route), stateAt(position)),
    navigate(next: Route) {
      if (restoring || routeHref(next) === routeHref(route) || !allow(next)) return;
      host.push(routeHref(next), stateAt(++position));
      accept(next);
    },
    historyChanged() {
      const observed = host.read();
      const targetPosition = positionOf(observed.state);
      const next = parseRoute(observed.hash);
      if (restoring) {
        if (targetPosition === position && routeHref(next) === routeHref(route)) restoring = false;
        return;
      }
      if (routeHref(next) === routeHref(route)) return;
      if (!allow(next)) {
        if (targetPosition !== null && targetPosition !== position) {
          restoring = true;
          host.go(position - targetPosition);
        } else host.replace(routeHref(route), stateAt(position));
        return;
      }
      position = targetPosition ?? position + 1;
      if (targetPosition === null) host.replace(routeHref(next), stateAt(position));
      accept(next);
    },
  };
}

export function useNavigation() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const guard = useRef<NavigationGuard>(() => true);
  const [controller] = useState(() => createNavigator(route, {
    read: () => ({hash: window.location.hash, state: history.state}),
    push: (href, state) => history.pushState(state, "", href),
    replace: (href, state) => history.replaceState(state, "", href),
    go: delta => history.go(delta),
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
    event.preventDefault(); navigate(to);
  }}>{children}</a>;
}
