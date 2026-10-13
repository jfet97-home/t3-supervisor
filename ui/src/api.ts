import { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Atom, AtomHttpApi } from "effect/reactivity";
import {
  SupervisorApi,
  type GuidanceRuleInput,
} from "../../src/guidance-contract.js";

let csrf = "";
export const loadAccess = async (): Promise<boolean> => {
  const response = await fetch("/api/csrf", { credentials: "same-origin" });
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
export const threadPolicyAtom = ApiClient.mutation("guidance", "threadPolicy");
export const settingsAtom = ApiClient.mutation("guidance", "settings");
export const muteAtom = ApiClient.mutation("guidance", "mute");
export const classifyAtom = ApiClient.mutation("guidance", "classify");
export const actionAtom = ApiClient.mutation("guidance", "action");
export const previewAtom = ApiClient.mutation("guidance", "preview");
export const draftAtom = Atom.make<{
  input: GuidanceRuleInput;
  dirty: boolean;
} | null>(null);
