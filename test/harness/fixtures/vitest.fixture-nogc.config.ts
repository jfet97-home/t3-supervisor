import { defineConfig } from "vitest/config";
import fixture from "./vitest.fixture.config.js";

// the same nested run without --expose-gc (mergeConfig would concatenate execArgv): the collection must fail closed
export default defineConfig({ ...fixture, test: { ...fixture.test, execArgv: [] } });
