import { createRequire } from "node:module";
import { Schema } from "effect";

// node's module loader reads the same package manifest in source checkouts and installed archives
export const buildInfo = Schema.decodeUnknownSync(Schema.Struct({
  version: Schema.String,
  gitHead: Schema.optional(Schema.String),
}))(createRequire(import.meta.url)("../package.json"));
