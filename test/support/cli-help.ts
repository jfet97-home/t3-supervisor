// the help effect/cli renders for the supervisor commands on a pipe (BC-CLI-01), recorded from this build, and the
// detail a usage error adds on stderr (BC-CLI-02)

const flags = "FLAGS\n  --data-dir absolute-path    State directory of the instance; overrides DATA_DIRECTORY\n\n";
const globalFlags = "GLOBAL FLAGS\n  --help, -h       Show help information\n  --version, -v    Show version information\n";

export const rootHelp =
  "DESCRIPTION\n  T3 Supervisor\n\n" +
  "USAGE\n  t3-supervisor <subcommand> [flags]\n\n" +
  globalFlags + "\n" +
  "SUBCOMMANDS\n  start    Run the supervisor service\n  auth     Dashboard sign-in\n" +
  "EXAMPLES\n" +
  "  # Run the service on an explicit state directory\n  t3-supervisor start --data-dir /srv/t3-supervisor\n\n" +
  "  # Issue a sign-in token for that instance\n  t3-supervisor auth forge --data-dir /srv/t3-supervisor\n";

export const startHelp = "DESCRIPTION\n  Run the supervisor service\n\nUSAGE\n  t3-supervisor start [flags]\n\n" + flags + globalFlags;

export const forgeHelp = "DESCRIPTION\n  Issue a single-use dashboard sign-in token\n\nUSAGE\n  t3-supervisor auth forge [flags]\n\n" + flags + globalFlags;

export const usageError = (detail: string): string => `\nERROR\n  ${detail}\n`;

export const relativeDataDirectory = (value: string): string =>
  usageError(`Invalid value for flag --data-dir: "${value}". Expected: Schema validation failed: Expected an absolute path`);
