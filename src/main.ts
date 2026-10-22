import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { environment } from "./config.js";
import { jsonLogger } from "./logging.js";
import { reportFailure, supervise, SupervisorLive } from "./supervisor.js";

// the server graph over the process environment as it is at start (the cli sets DATA_DIRECTORY before importing this
// module); a failure prints one classified line and no stack, cause, path or token (BC-CLI-04); a signal interrupts the
// program, which releases what it acquired in reverse order and exits 130
NodeRuntime.runMain(supervise(SupervisorLive.pipe(Layer.provide(ConfigProvider.layer(Effect.sync(environment))))).pipe(
  Effect.tapCause(reportFailure),
  Effect.provide(Logger.layer([jsonLogger])),
), { disableErrorReporting: true });
