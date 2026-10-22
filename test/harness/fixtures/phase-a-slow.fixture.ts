import { it } from "vitest";
import { mark, pause } from "./phase-marker.js";

// shorter than the 8 s combined deadline of the runner self-test on its own
it("a takes three seconds", async () => {
  mark("phase-a-slow");
  await pause(3_000);
});
