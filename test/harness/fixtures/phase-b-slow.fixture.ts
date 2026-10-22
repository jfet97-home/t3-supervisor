import { it } from "vitest";
import { mark, pause } from "./phase-marker.js";

// shorter than the 8 s combined deadline of the runner self-test on its own
it("b takes six seconds", async () => {
  mark("phase-b-slow");
  await pause(6_000);
});
