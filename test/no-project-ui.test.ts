import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {NoProjectPanel, StartSupervisionPanel} from "../ui/src/no-project.js";
import {StopNotice} from "../ui/src/stop-notice.js";

test("No Project presents three named native modes independently of shared definitions", () => {
  const html = renderToStaticMarkup(createElement(NoProjectPanel, {active: false, onStateChange: () => {}}));
  assert.equal((html.match(/type="radio"/gu) ?? []).length, 3);
  assert.match(html, /<legend>Activation mode<\/legend>/u);
  assert.match(html.match(/<input[^>]*value="on_request"[^>]*>/u)?.[0] ?? "", /checked=""/u);
  assert.match(html, /With shared definitions off, plans use task-local steps/u);
});
test("Start is a collapsed progressive picker with a visible associated search label", () => {
  const html = renderToStaticMarkup(createElement(StartSupervisionPanel, {active: false, onStateChange: () => {}, onChanged: () => {}}));
  assert.match(html, /<details><summary/u);
  assert.match(html, /<label for="start-chat-search">Find a chat<\/label>/u);
  assert.match(html, /aria-describedby="start-chat-help"/u);
  assert.doesNotMatch(html, /type="checkbox"/u);
});
test("Stop auditing exposes escaped source/caller/time and a named scoped Enable", () => {
  const html = renderToStaticMarkup(createElement(StopNotice, {audit: {route: "relay", callerThreadId: "caller", userMessageId: "<human-source>", stoppedAt: 1}, title: "Work", onEnable: () => {}}));
  assert.match(html, /t3-thread:\/\/v1\/caller/u);
  assert.match(html, /&lt;human-source&gt;/u);
  assert.match(html, /<time dateTime="1970-01-01T00:00:00.001Z"/u);
  assert.match(html, /aria-label="Enable supervision for Work"/u);
});
