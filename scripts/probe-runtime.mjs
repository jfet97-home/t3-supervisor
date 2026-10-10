import assert from "node:assert/strict";
import { chmodSync, copyFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { makeRecapper } from "/app/dist/recap.js";
import { buildContext, eligibleRuns } from "/app/dist/domain.js";
import { makeT3Client, T3Client } from "/app/dist/t3.js";

const directory = mkdtempSync(join(tmpdir(), "notification-policy-probe-"));
const authDirectory = join(directory, "auth");
mkdirSync(authDirectory, { mode: 0o700 });
const authPath = join(authDirectory, "auth.json");
copyFileSync("/run/secrets/codex-auth.json", authPath);
chmodSync(authPath, 0o600);
const config = {
  cxCommand: "/usr/local/bin/cx",
  cxHome: authDirectory,
  modelTimeoutMs: 360_000,
};
const previousOutcome = "Pulled main, installed dependencies, refreshed the knowledge base and verified a clean working tree.";
const baseContext = {
  thread: { id: "policy-probe", title: "Knowledge maintenance", projectId: "project", lineage: { parentThreadId: null, relationshipToParent: null } },
  project: { id: "project", title: "Configurator", workspaceRoot: "/workspace" },
};
const cases = [
  {
    name: "thanks_after_completed_work",
    notify: false,
    request: "okay thank you",
    finalAnswer: "You are welcome! Everything requested was already completed.",
  },
  {
    name: "repeat_without_new_work",
    notify: false,
    request: "okay, just confirm the same thing once more",
    finalAnswer: previousOutcome,
  },
  {
    name: "thanks_with_new_substantive_result",
    notify: true,
    request: "Thanks! Investigate and fix why production is missing the release we approved.",
    finalAnswer: "Traced the release mismatch through deployment records, live image identity and the registry manifest. Found an incorrect pinned image in production Compose. Corrected it, deployed the approved artifact, and verified production behavior against the regression case. Existing state and credentials were preserved.",
  },
  {
    name: "sign_in_link_refresh",
    notify: false,
    request: "The link expired; generate a fresh sign-in link.",
    finalAnswer: "Generated a fresh T3 OAuth sign-in link for you to open in Arc. Connection remains pending your approval.",
  },
  {
    name: "tool_inventory_question",
    notify: false,
    request: "Which tools are available on this MCP server?",
    finalAnswer: "Cataloged 82 tools for projects, threads, launches, queues, automations, browsers and integrations. Some tools require a remote calling thread.",
  },
  {
    name: "minor_cosmetic_change",
    notify: false,
    request: "Change the button label from Okay to Accept.",
    finalAnswer: "Changed the button label to Accept.",
  },
  {
    name: "routine_explanation",
    notify: false,
    request: "What does restart unless-stopped mean?",
    finalAnswer: "Docker restarts the service after a crash or Docker startup, except when you deliberately stopped it. A manually stopped service stays stopped until started.",
  },
  {
    name: "single_message_substantial_investigation",
    notify: true,
    request: "Investigate why the VPN stalls while ping keeps working. Compare the recorded evidence and identify a controlled next experiment.",
    finalAnswer: "Compared synchronized Pi/Mac packet captures, driver counters, routing and firewall evidence. The Pi answered a TCP request in 53 microseconds, but its first reply vanished before Mac reception; retransmission arrived one second later. Resource exhaustion and slow TCP processing are weakened. Pi radio/firmware versus AP drops remain unproven. Prepared a bounded alternative-AP experiment with Ethernet management and automatic stop conditions, preserving both verified evidence bundles.",
  },
  {
    name: "sustained_validation_result",
    notify: true,
    request: "Run the planned 45-minute bidirectional VPN regression test and report the result.",
    finalAnswer: "Completed the 45-minute recorded upload/download regression test. Reproduced IPv6 TCP loss after sustained traffic while IPv4, ARP and management remained healthy. Preserved paired captures and verified checksums, removed the temporary test server, and restored baseline connectivity. The firmware-versus-AP cause remains unresolved.",
  },
];
try {
  const recapper = makeRecapper(config);
  for (const item of cases) {
    const decision = await Effect.runPromise(recapper.recap({
      ...baseContext,
      messages: [
        { role: "user", text: item.request },
      ],
      finalAnswer: item.finalAnswer,
    }));
    const notify = decision !== null;
    const words = decision?.trim().split(/\s+/u).filter(Boolean).length ?? 0;
    console.log(JSON.stringify({ probe: item.name, model: "gpt-6-luna", reasoning: "max", notify, words }));
    assert.equal(notify, item.notify, `unexpected notification decision for ${item.name}`);
    assert.ok(words <= 30);
  }
  const snapshot = await Effect.runPromise(Effect.gen(function* () {
    const client = yield* T3Client;
    return yield* client.projection("3711eff4-1bed-4cdf-a9f0-2887679ff909");
  }).pipe(Effect.provide(makeT3Client({
    baseUrl: "http://host.docker.internal:3773",
    token: readFileSync("/run/secrets/t3-read-token", "utf8").trim(),
  })), Effect.scoped));
  for (const [ordinal, expected] of [[8, true], [9, false], [10, true]]) {
    const run = snapshot.projection.runs.find((candidate) => candidate.ordinal === ordinal);
    assert.ok(run);
    const context = buildContext(snapshot.projection, run.id, null);
    if (ordinal === 9) assert.ok(!JSON.stringify(context).includes("PR #2419"));
    const decision = await Effect.runPromise(recapper.recap(context));
    const words = decision?.trim().split(/\s+/u).filter(Boolean).length ?? 0;
    console.log(JSON.stringify({ probe: `real_omega_turn_${ordinal}`, model: "gpt-6-luna", reasoning: "max", notify: decision !== null, words }));
    assert.equal(decision !== null, expected);
    assert.ok(words <= 30);
    if (ordinal === 8) {
      const later = snapshot.projection.runs.find((candidate) => candidate.ordinal === 10);
      const busyProjection = {
        ...snapshot.projection,
        thread: { ...snapshot.projection.thread, activeRunId: later.id, activityRunStatus: "running" },
        runs: snapshot.projection.runs.map((candidate) => candidate.id === later.id ? { ...candidate, status: "running", completedAt: null } : candidate),
      };
      assert.ok(eligibleRuns(busyProjection, 0).some((candidate) => candidate.id === run.id));
      console.log(JSON.stringify({ probe: "real_omega_prior_completion_during_later_work", verified: true, notificationsSent: 0 }));
    }
  }
  const repeatedRun = snapshot.projection.runs.find((candidate) => candidate.ordinal === 9);
  const repeatedProjection = {
    ...snapshot.projection,
    messages: snapshot.projection.messages.map((message) => message.runId !== repeatedRun.id ? message : {
      ...message,
      text: message.role === "user"
        ? "Repeat the earlier report verbatim; do not do any new work."
        : "Verified the deployment and completed the investigation. ".repeat(1_200),
    }),
  };
  const repeatedContext = buildContext(repeatedProjection, repeatedRun.id, null);
  assert.equal(repeatedContext.messages[0]?.text, "Repeat the earlier report verbatim; do not do any new work.");
  const repeatedDecision = await Effect.runPromise(recapper.recap(repeatedContext));
  console.log(JSON.stringify({ probe: "long_repeated_report_keeps_request", model: "gpt-6-luna", reasoning: "max", notify: repeatedDecision !== null, words: repeatedDecision?.trim().split(/\s+/u).length ?? 0 }));
  assert.equal(repeatedDecision, null);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
