import { Data } from "effect";

// the T3 read token could not be loaded; it carries no path, file content or cause, so rendering it leaks none
export class T3TokenUnavailable extends Data.TaggedError("T3TokenUnavailable") {}
