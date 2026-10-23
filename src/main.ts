import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { environment } from "./config.js";
import { jsonLogger } from "./logging.js";
import { reportFailure, supervise, SupervisorLive } from "./supervisor.js";

// the server program over the process environment as it is at start (the cli sets DATA_DIRECTORY before it runs this);
// a failure prints one classified line and no stack, cause, path or token (BC-CLI-04)
export const server = supervise(SupervisorLive.pipe(Layer.provide(ConfigProvider.layer(Effect.sync(environment))))).pipe(
  Effect.tapCause(reportFailure),
  Effect.provide(Logger.layer([jsonLogger])),
);

// run directly (node dist/main.js), the module is the entry: a signal interrupts the program, which releases what it
// acquired in reverse order and exits 130; imported by the cli, it only provides the program
if (import.meta.main) NodeRuntime.runMain(server, { disableErrorReporting: true });
