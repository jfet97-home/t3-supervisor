import { createServer } from "node:http";
import { it } from "vitest";

it("leaves a server listening", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
