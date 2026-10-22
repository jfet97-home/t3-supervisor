import { relative, sep } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { slowTests } from "./slow-tests.js";

// files of the slow-integration class run at 60 s per test; a test of such a file that is not listed by title keeps
// the 10 s bound of every other test and fails here when it exceeds it
const listed = new Set(slowTests.map((test) => `${test.file}::${test.title}`));
let started = 0;

beforeEach(() => {
  started = performance.now();
});

afterEach((context) => {
  const file = relative(process.cwd(), context.task.file.filepath).split(sep).join("/");
  const title = [context.task.suite?.name, context.task.name].filter(Boolean).join(" > ");
  const elapsed = performance.now() - started;
  if (!listed.has(`${file}::${title}`) && elapsed > 10_000) {
    expect.fail(`a test outside the slow-integration class exceeded the 10 s bound (${Math.round(elapsed)} ms)`);
  }
});
