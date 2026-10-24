import assert from "node:assert/strict";
import { it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepsAndWorkflowsGuide } from "../ui/src/steps-and-workflows-guide.js";

it("steps and workflows guide documents the approved layout, syntax and planning boundaries", () => {
  const html = renderToStaticMarkup(createElement(StepsAndWorkflowsGuide));

  assert.match(html, /\.t3-supervisor\//);
  assert.match(html, /project\.yaml/);
  assert.match(html, /steps\/e2e-testing\.md/);
  assert.match(html, /id: e2e-testing[\s\S]*name: End-to-end testing[\s\S]*description:/);
  assert.match(html, /There are no separate instruction or outcome fields/);
  assert.match(html, /step: e2e-testing/);
  assert.match(html, /id: check-migration-notes[\s\S]*description:/);
  assert.match(html, /Markdown body after the frontmatter must be empty/);
  assert.match(html, /workflow: reviewer/);
  assert.match(html, /sequence:/);
  assert.match(html, /parallel:/);
  assert.match(html, /workflows:\n  - path: workflows\/reviewer.yaml\n    summary:[^\n]*\n    required: true[\s\S]*steps:\n  - path: steps\/e2e-testing.md/);
  assert.doesNotMatch(html.slice(html.indexOf("workflows:\n  - path:"), html.indexOf("default_workflow: delivery")), /id:/, "the index example is path-only");
  assert.match(html, /default_workflow: delivery/);
  assert.match(html, /project\.yaml<\/code> requires separate <code>workflows<\/code> and <code>steps<\/code> lists/);
  assert.match(html, /Both the Supervisor and the supervised agent start there/);
  assert.match(html, /full definitions remain authoritative policy/);
  assert.match(html, /at most 2 logical lines and 240 characters/);
  assert.match(html, /purpose or applicability from the full description/);
  assert.match(html, /workflows: \[\]/);
  assert.match(html, /steps: \[\]/);
  assert.match(html, /not an exhaustive whitelist of possible task plans/);
  assert.match(html, /no separate top-level required list/);
  assert.match(html, /missing or invalid definitions do not silently lose their required flags/);
  assert.doesNotMatch(html, /required: \[\]|requires a <code>required<\/code> list/);
  assert.match(html, /fixed: true|fixed does not make the workflow a project-wide requirement/);
  assert.match(html, /implementation[\s\S]*e2e-testing[\s\S]*deployment/);
  assert.match(html, /including nested commitments/);
  assert.match(html, /total expanded-node and depth bounds/);
  assert.match(html, /The main agent must assign this entire workflow to one or more independent/);
  assert.match(html, /Requirements apply once to the current main task/);
  assert.match(html, /Direct and indirect workflow cycles are errors/);
  assert.match(html, /A <code>complete<\/code> read means the service finished reading the relevant files; it does not mean those definitions are valid/);
  assert.match(html, /A formal saved agreement requires a current, complete, valid definition snapshot and resolved commitments/);
  assert.match(html, /A known revision on an invalid collection identifies the observed files; it does not approve them as policy/);
  assert.match(html, /Templates, plans and evidence are different/);
  assert.match(html, /agreement does not prove that review, testing or other steps were executed/);
  assert.match(html, /no migration or compatibility layer/);
  assert.match(html, /References and skills/);
  assert.match(html, /<code>\[\]<\/code>/);
  assert.match(html, /skills\/use-project\/SKILL.md/);
  assert.match(html, /src\/migration.ts/);
  assert.match(html, /Definitions and Task show pointers read-only/);
  assert.match(html, /skills:/);
  assert.doesNotMatch(html, /scope:/);
  assert.match(html, /effect-v4-development/);
  assert.match(html, /missing or ambiguous names remain explicit gaps/);
  assert.doesNotMatch(html, /Project rules|Reusable blocks/);
});

it("guide FAQs use native disclosures with visible summaries and no headings inside triggers", () => {
  const html = renderToStaticMarkup(createElement(StepsAndWorkflowsGuide));
  const disclosures = [...html.matchAll(/<details class="panel guide-faq">([\s\S]*?)<\/details>/g)];

  assert(disclosures.length > 0, "the Guide must expose native FAQ disclosures");
  assert.equal(disclosures.length, [...html.matchAll(/<summary>/g)].length);
  for (const disclosure of disclosures) {
    assert.match(disclosure[1]!, /<summary>[^<]+<\/summary>/);
    assert.doesNotMatch(disclosure[1]!.match(/<summary>[\s\S]*?<\/summary>/)![0], /<h[1-6]/);
    assert.match(disclosure[1]!, /<p>/);
  }
  assert.match(html, /Does a workflow reference launch a reviewer agent\?/);
  assert.match(html, /What happens when a file is broken or workflows contain a cycle\?/);
  assert.match(html, /What happens if I edit the original task message\?[\s\S]*fresh occurrence IDs are fine for the revised task/);
});

it("the Guide teaches the operator journey first, then the authoring reference, with one focusable heading per contents entry", () => {
  const html = renderToStaticMarkup(createElement(StepsAndWorkflowsGuide));
  assert.match(html, /<h1 id="steps-guide-title">Guide<\/h1>/);
  const follow = html.indexOf("guide-follow-title"), write = html.indexOf(">Write steps and workflows</h2>");
  assert.ok(follow > 0 && write > follow, "the operator walkthrough comes before the authoring reference");
  const walkthrough = html.slice(follow, write);
  const order = ["<strong>Home</strong>", "<strong>Task</strong> shows", "<strong>Agent and Supervisor</strong>", "<strong>Plan note</strong>", "<strong>Supervision</strong> shows", "<strong>Definitions</strong>, read from a checkout you choose"];
  assert.deepEqual(order.map(label => walkthrough.indexOf(label) >= 0), order.map(() => true));
  assert.deepEqual([...order.map(label => walkthrough.indexOf(label))].sort((a, b) => a - b), order.map(label => walkthrough.indexOf(label)), "the walkthrough follows Home → Task → acceptance → evidence → Supervision → Definitions");
  for (const label of ["Needs attention", "Supervised work", "Proposed update awaiting acceptance", "Update proposed", "Supervisor assessment", "Earlier step records", "Evidence and history", "Supervisor health", "Stop supervision", "Project root", "Project settings"])
    assert.match(walkthrough, new RegExp(`<strong>${label}</strong>`));
  assert.match(walkthrough, /not evidence that work was done/);
  assert.match(walkthrough, /recorded progress stays as it is/);
  assert.doesNotMatch(html, /Projects page/);
  assert.match(html, /A project’s <strong>Definitions<\/strong> shows the active scope, source paths and origin/);
  assert.match(html, /A conversation’s <strong>Supervision<\/strong> view displays this team/);
  const contents = html.slice(html.indexOf('aria-label="Guide contents"'), html.indexOf("</nav>"));
  assert.match(contents, /<strong>Follow supervised work<\/strong><ol>[\s\S]*<\/ol><\/div><div><strong>Write steps and workflows<\/strong><ul>/);
  const ids = [...html.matchAll(/<h3 id="(guide-[a-z]+-title)" tabindex="-1">/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "every focus target is unique");
  assert.equal([...contents.matchAll(/<button type="button">/g)].length, ids.length, "every contents entry has its own heading");
  assert.equal(ids.length, 18);
});
