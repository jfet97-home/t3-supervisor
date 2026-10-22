import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

it("waits forever after writing its marker", async () => {
  writeFileSync(join(process.env.HARNESS_MARKERS ?? "", "hang.json"), JSON.stringify({ worker: process.pid }));
  await new Promise<never>(() => undefined);
});
