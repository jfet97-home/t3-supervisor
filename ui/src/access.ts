let csrf = "";
export const getCsrfToken = () => csrf;

export const loadAccess = async (): Promise<boolean> => {
  const response = await fetch("/api/csrf", {credentials: "same-origin"});
  if (!response.ok) return false;
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("csrf" in value) || typeof value.csrf !== "string") return false;
  csrf = value.csrf;
  return true;
};
