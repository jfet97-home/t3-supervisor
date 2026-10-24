import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {Home, WorkTable} from "../ui/src/overview.js";
import {activityTitle} from "../ui/src/activity-presentation.js";
import {FixtureModel, fixtureIds} from "./ui-fixture/scenarios.js";
import {conversationLabel, ConversationStatus, ConversationUnderstanding} from "../ui/src/conversation-status.js";
import {deriveConversationEngagement, emptyConversation, type ConversationEngagement} from "../src/supervision-conversation-contract.js";

const now = 1_800_000_000_000;
const model = new FixtureModel(() => now);
const data = model.guidanceSnapshot(now);
const overview = {data: null, loading: false, error: "The last successful read is kept.", refresh: () => {}, loadMore: () => {}};

it("a first-load failure cannot claim that a previous successful read is visible", () => {
  const html = renderToStaticMarkup(createElement(Home, {data, overview, navigate: () => {}}));
  assert.match(html, /Could not load current work/);
  assert.match(html, /No successful read is available/);
  assert.match(html, /Retry overview/);
  assert.doesNotMatch(html, /last successful read is kept|Reading current work/);
});

it("a disconnected empty overview shows reconnection guidance rather than a loading skeleton", () => {
  const html = renderToStaticMarkup(createElement(Home, {data: {...data, connected: false}, overview: {...overview, error: ""}, navigate: () => {}}));
  assert.match(html, /Reconnect to load current work/);
  assert.doesNotMatch(html, /Reading current work|Showing the last read/);
});

it("an attention reason repeated by an assessment is shown once per work row", () => {
  const first = model.dashboardOverview({}, now).work.find(work => work.mainThreadId === fixtureIds.threadA1)!;
  const reason = "The retry check needs an atomic event claim.";
  const html = renderToStaticMarkup(createElement(WorkTable, {data, navigate: () => {}, work: [{...first, attention: [reason], assessment: {status: "needs_attention", summary: reason, updatedAt: now}}]}));
  assert.equal((html.match(/>The retry check needs an atomic event claim\.</g) ?? []).length, 1);
  assert.match(html, /Needs attention/);
  assert.doesNotMatch(html, /Supervision enabled|Assessed: needs attention/);
});

it("unknown activity codes stay in inspection data instead of becoming list prose", () => {
  assert.equal(activityTitle({...data.activity[0]!, reason: "internal_unknown_code", state: "internal_pending_state"}), "Supervisor activity recorded");
  assert.equal(activityTitle({...data.activity[0]!, reason: "check_in_delivered"}), "Check-in delivered");
});

it("typed conversation availability controls Following independently of retained agreement and execution", () => {
  const current = {mode: "following" as const, availability: "current" as const, consideredAt: now};
  assert.equal(conversationLabel(current), "Following the conversation");
  assert.equal(conversationLabel({...current, mode: "engaged"}), "Engaged in the task");
  for (const availability of ["catching_up", "stale", "uncertain", "stopped", "unavailable"] as const)
    assert.doesNotMatch(conversationLabel({...current, availability})!, /Following/u);
  assert.doesNotMatch(conversationLabel(current, false)!, /Following/u);
  assert.doesNotMatch(conversationLabel(undefined)!, /Following/u);
  const html = renderToStaticMarkup(createElement(ConversationStatus, {engagement: {...current, availability: "catching_up"}, fresh: true}));
  assert.match(html, /Updating conversation understanding/u);assert.match(html, /aria-live="off"/u);
  const source = {messageId: "message", runId: "run", ordinal: 1, hash: "old", requester: "human" as const};
  const task = {status: "inferred", conversation: {...emptyConversation(now), considered: source, observed: {...source, hash: "edited"}}};
  assert.equal(deriveConversationEngagement({task, enabled: true, available: true}).availability, "catching_up");
  assert.equal(deriveConversationEngagement({task: {status: "needs_context", conversation: emptyConversation(now)}, enabled: true, available: true}).availability, "unavailable");
  for (const [enabled, available, expected] of [[false, true, "stopped"], [true, false, "unavailable"]] as const)
    assert.equal(deriveConversationEngagement({task, enabled, available}).availability, expected);
  const draft = renderToStaticMarkup(createElement(ConversationUnderstanding, {draft: {...emptyConversation(now).draft, objective: "Discuss the retry race"}}));
  assert.match(draft, /<details/u);assert.match(draft, /class="disclosure-title">Understanding and draft duties/u);
  assert.doesNotMatch(draft, /role="button"/u);
  const first = model.dashboardOverview({}, now).work[0]!;
  const row = (engagement: ConversationEngagement, fresh: boolean) => renderToStaticMarkup(createElement(WorkTable, {data, navigate: () => {}, fresh, work: [{...first, attention: [], engagement}]}));
  assert.match(row(current, true), /Following the conversation/u);
  assert.doesNotMatch(row(current, false), /Following the conversation/u);
});
