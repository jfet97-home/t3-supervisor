import { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Atom, AtomHttpApi } from "effect/reactivity";
import {
  SupervisorApi,
  type GuidanceRuleInput,
} from "../../src/guidance-contract.js";

let csrf = "";
export const loadSession = async (): Promise<boolean> => {
  const response = await fetch("/api/session", { credentials: "same-origin" });
  if (!response.ok) return false;
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("csrf" in value) ||
    typeof value.csrf !== "string"
  )
    return false;
  csrf = value.csrf;
  return true;
};
export const login = async (code: string): Promise<void> => {
  const response = await fetch("/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok)
    throw new Error(
      "Code invalid, expired or rate limited. Generate a new local code if needed.",
    );
  if (!(await loadSession())) throw new Error("Owner session unavailable.");
};
export const logout = async () => {
  await fetch("/api/logout", {
    method: "POST",
    headers: { "x-csrf-token": csrf },
    credentials: "same-origin",
  });
  csrf = "";
};
export class ApiClient extends AtomHttpApi.Service<ApiClient>()(
  "SupervisorUiApi",
  {
    api: SupervisorApi,
    baseUrl: globalThis.location.origin,
    httpClient: FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, {
          credentials: "same-origin",
        }),
      ),
    ),
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.setHeader(request, "x-csrf-token", csrf),
        ),
      ),
  },
) {}
export const snapshotAtom = ApiClient.query("guidance", "snapshot", {});
export const saveRuleAtom = ApiClient.mutation("guidance", "saveRule");
export const settingsAtom = ApiClient.mutation("guidance", "settings");
export const muteAtom = ApiClient.mutation("guidance", "mute");
export const classifyAtom = ApiClient.mutation("guidance", "classify");
export const actionAtom = ApiClient.mutation("guidance", "action");
export const previewAtom = ApiClient.mutation("guidance", "preview");
export const draftAtom = Atom.make<{
  input: GuidanceRuleInput;
  dirty: boolean;
} | null>(null);
