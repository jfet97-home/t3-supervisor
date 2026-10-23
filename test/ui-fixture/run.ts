import { Cause, Console, Effect, Exit } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { parseArgs } from "node:util";
import { isScenarioName, scenarioCatalog, scenarioNames } from "./scenarios.js";
import { startUiFixture } from "./server.js";

const usage = "usage: npx tsx test/ui-fixture/run.ts --assets <dir> [--port N] [--scenario <name>]";

const options = () => {
  const {values} = parseArgs({options: {assets: {type: "string"}, port: {type: "string"}, scenario: {type: "string"}}, strict: true});
  if (!values.assets) throw new Error(`--assets is required\n${usage}`);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port must be an integer from 0 to 65535\n${usage}`);
  const scenario = values.scenario ?? "baseline";
  if (!isScenarioName(scenario)) throw new Error(`unknown scenario ${scenario}; one of: ${scenarioNames.join(", ")}`);
  return {assets: values.assets, port, scenario};
};

const program = Effect.scoped(Effect.gen(function*() {
  const input = yield* Effect.try({try: options, catch: cause => cause instanceof Error ? cause : new Error(String(cause))});
  // registered before the fixture so it runs after the fixture's own finalizers
  yield* Effect.addFinalizer(() => Console.log("ui fixture stopped; connections closed and the in-memory log released"));
  const fixture = yield* startUiFixture(input);
  yield* Console.log([
    "ui fixture: real compiled baseline UI assets, synthetic API data (recordings are labelled fixture)",
    `url: ${fixture.url}`,
    `assets: ${fixture.assetsDirectory}`,
    `sign-in token: ${fixture.token}`,
    `scenario: ${fixture.controller.scenario} (${scenarioCatalog[fixture.controller.scenario].description})`,
    "assets served byte-identical (sha256  bytes  path):",
    ...fixture.assets.map(asset => `  ${asset.sha256}  ${asset.bytes}  ${asset.path}`),
    "controls: POST /__fixture/reset, POST /__fixture/scenario/<name>, GET /__fixture/state, GET /__fixture/log",
    "stop with ctrl-c (SIGINT) or SIGTERM",
  ].join("\n"));
  return yield* Effect.never;
}));

// an interrupt from sigint or sigterm is the normal way to stop, so it exits 0 after the finalizers ran
NodeRuntime.runMain(program, {
  teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
});
