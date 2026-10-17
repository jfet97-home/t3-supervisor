let csrf = "";
export const getCsrfToken = () => csrf;
const sessionKey = "supervisor-session";
export const getSessionToken = () => {
  try { return localStorage.getItem(sessionKey) ?? ""; } catch { return ""; }
};
export const setSessionToken = (session: string) => {
  try { localStorage.setItem(sessionKey, session); }
  catch { throw new Error("Your browser blocked saved sign-in. Allow site storage for Supervisor and try again."); }
};
export const restoreTabSession = () => {
  const previous = sessionStorage.getItem(sessionKey);
  if (!getSessionToken() && previous) setSessionToken(previous);
  sessionStorage.removeItem(sessionKey);
};
export const watchSession = (changed: () => void) => {
  const listener = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === sessionKey || event.key === null)) {
      csrf = "";
      changed();
    }
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
};
export const sessionHeaders = () => ({"x-supervisor-session": getSessionToken()});

export const loadAccess = async (): Promise<boolean> => {
  const session = getSessionToken();
  const response = await fetch("/api/csrf", {credentials: "omit", headers: {"x-supervisor-session": session}});
  if (session !== getSessionToken()) return false;
  if (!response.ok) {
    csrf = "";
    if (response.status === 401 && typeof window !== "undefined") {
      clearAccess(session);
      window.dispatchEvent(new Event("supervisor-auth-required"));
    }
    return false;
  }
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("csrf" in value) || typeof value.csrf !== "string") return false;
  csrf = value.csrf;
  return true;
};

export const clearAccess = (expectedSession = getSessionToken()) => {
  csrf = "";
  if (getSessionToken() === expectedSession) {
    try { localStorage.removeItem(sessionKey); } catch { /* storage can be blocked */ }
  }
};
