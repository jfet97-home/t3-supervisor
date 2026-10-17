import { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { AtomHttpApi } from "effect/reactivity";
import { SupervisorApi } from "../../src/guidance-contract.js";

import { getCsrfToken, getSessionToken } from "./access.js";
export { getCsrfToken, loadAccess } from "./access.js";

export class ApiClient extends AtomHttpApi.Service<ApiClient>()(
  "SupervisorUiApi",
  {
    api: SupervisorApi,
    baseUrl: globalThis.location.origin,
    httpClient: FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, {
          credentials: "omit",
        }),
      ),
    ),
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.setHeaders(request, {"x-csrf-token": getCsrfToken(), "x-supervisor-session": getSessionToken()}),
        ),
      ),
  },
) {}
export const snapshotAtom = ApiClient.query("guidance", "snapshot", {});
export const threadPolicyAtom = ApiClient.mutation("guidance", "threadPolicy");
