import { it } from "vitest";
import { mark } from "./phase-marker.js";

it("b waits forever after writing its marker", async () => {
  mark("phase-b-hang");
  await new Promise<never>(() => undefined);
});
