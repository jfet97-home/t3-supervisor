import { defineConfig } from "vitest/config";
import fixture from "./vitest.handle-fixture.config.js";

// the handle gate must fail closed when resource inspection is unavailable
export default defineConfig({ ...fixture, test: { ...fixture.test, setupFiles: ["test/harness/fixtures/no-resource-info.setup.ts", "test/support/handle-gate.ts"] } });
