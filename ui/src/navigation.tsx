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

export function useNavigation() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const current = useRef(route);
  const guard = useRef<NavigationGuard>(() => true);
  const navigate = useCallback((next: Route, fromHistory = false) => {
    if (routeHref(next) === routeHref(current.current)) return;
    if (!guard.current(next)) {
      if (fromHistory) history.replaceState(null, "", routeHref(current.current));
      return;
    }
    current.current = next;
    rememberContext(next);
    if (!fromHistory) history.pushState(null, "", routeHref(next));
    setRoute(next);
  }, []);
  useEffect(() => {
    rememberContext(current.current);
    const changed = () => navigate(parseRoute(window.location.hash), true);
    window.addEventListener("hashchange", changed);
    window.addEventListener("popstate", changed);
    return () => { window.removeEventListener("hashchange", changed); window.removeEventListener("popstate", changed); };
  }, [navigate]);
  return {route, navigate, guard};
}

export function RouteLink({to, navigate, children, ...props}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {to: Route; navigate: (route: Route) => void}) {
  return <a {...props} href={routeHref(to)} onClick={event => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(to);
  }}>{children}</a>;
}
