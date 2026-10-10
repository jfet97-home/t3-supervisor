import { readFile } from "node:fs/promises";
import { makeInputT3Client } from "../src/input-t3.js";

const readTokenFile = process.env.T3_TOKEN_FILE;
const responseTokenFile = process.env.T3_INPUT_TOKEN_FILE;
if (!readTokenFile || !responseTokenFile) throw new Error("Set private credential file paths");
const client = makeInputT3Client({
  baseUrl: process.env.T3_URL ?? "http://127.0.0.1:3773",
  readToken: (await readFile(readTokenFile, "utf8")).trim(),
  responseToken: (await readFile(responseTokenFile, "utf8")).trim(),
});
const descriptor = await client.descriptor();
const threads = await client.listThreads();
const threadId = process.env.T3_INPUT_PROBE_THREAD;
const requests = threadId ? await client.listRequests(threadId) : [];
console.log(JSON.stringify({
  environmentId: descriptor.environmentId,
  protocol: descriptor.orchestrationProtocolVersion,
  threads: threads.length,
  requests: requests.map((request) => ({
    requestId: request.requestId,
    status: request.status,
    capability: request.responseCapability.type,
    questionCount: request.questions.length,
  })),
}));
