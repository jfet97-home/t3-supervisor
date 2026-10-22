#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { isAbsolute } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Data, Effect, Layer, Option, Redacted, Runtime, Schema } from "effect";
import { CliConfig, Command, Flag, GlobalFlag } from "effect/cli";
import { loadDataDirectory } from "./config.js";
import { forgeDashboardToken } from "./service-auth.js";

// an absolute path as given; a relative one is rejected, never resolved (Flag.Directory would resolve it)
const AbsolutePath = Schema.String.check(Schema.makeFilter((path: string) => isAbsolute(path), { expected: "an absolute path" }));

const dataDirectory = Flag.String("data-dir").pipe(
  Flag.withSchema(AbsolutePath),
  Flag.withMetavar("absolute-path"),
  Flag.withDescription("State directory of the instance; overrides DATA_DIRECTORY"),
  Flag.optional,
);

// a usage error, after effect/cli rendered the help on stdout and any parse error on stderr
class CliUsageError extends Data.TaggedError("CliUsageError") {
  readonly [Runtime.errorExitCode] = 2;
}

const forgeFailure = "Could not issue a sign-in token. Run as the account that runs T3 Supervisor, after the service has initialized. If it uses a custom state directory, pass --data-dir <absolute-path> or the same DATA_DIRECTORY. Pending tokens expire after five minutes.";

const start = Command.make("start", { dataDirectory }, ({ dataDirectory }) => Effect.gen(function* () {
  // the server program reads DATA_DIRECTORY from the process environment when it starts
  if (Option.isSome(dataDirectory)) yield* Effect.sync(() => { process.env.DATA_DIRECTORY = dataDirectory.value; });
  // the server program runs under this cli's runMain; main.ts runs it itself only as the process entry
  const { server } = yield* Effect.promise(() => import("./main.js"));
  yield* server;
})).pipe(Command.withDescription("Run the supervisor service"));

const forge = Command.make("forge", { dataDirectory }, ({ dataDirectory }) => Effect.gen(function* () {
  // the data directory alone: no service configuration and no T3 credential is loaded
  const directory = Option.isSome(dataDirectory) ? dataDirectory.value : yield* Effect.sync(loadDataDirectory);
  const issued = yield* forgeDashboardToken(directory).pipe(
    // one fixed sentence for any failure; the cause is never printed and an interruption prints nothing
    Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(forgeFailure)),
  );
  yield* Console.log(Redacted.value(issued.token));
})).pipe(Command.withDescription("Issue a single-use dashboard sign-in token"));

const auth = Command.make("auth").pipe(Command.withDescription("Dashboard sign-in"), Command.withSubcommands([forge]));

const cli = Command.make("t3-supervisor").pipe(
  Command.withDescription("T3 Supervisor"),
  Command.withSubcommands([start, auth]),
  Command.withExamples([
    { command: "t3-supervisor start --data-dir /srv/t3-supervisor", description: "Run the service on an explicit state directory" },
    { command: "t3-supervisor auth forge --data-dir /srv/t3-supervisor", description: "Issue a sign-in token for that instance" },
  ]),
);

// help is the only built-in; a startup failure prints no stack (BC-CLI-04)
NodeRuntime.runMain(Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.catchTag("ShowHelp", () => Effect.fail(new CliUsageError())),
  Effect.provide(Layer.mergeAll(NodeServices.layer, CliConfig.layer({ builtIns: [GlobalFlag.Help] }))),
), { disableErrorReporting: true });
