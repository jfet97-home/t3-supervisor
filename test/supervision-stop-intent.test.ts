import assert from "node:assert/strict";
import { test } from "node:test";
import { affirmsSupervisionStop, namesThread, unquotedText } from "../src/supervision-stop-intent.js";

test("only the human's own unquoted words can ask to stop supervision", () => {
  for (const text of [
    "Stop supervising this chat.",
    "Please stop supervising chat operative-a now.",
    "Tell your Supervisor to stop supervising this chat.",
    "Disable supervision for this chat, thanks!",
    "Turn supervision off here.",
    "Bitte die Supervision für diesen Chat beenden.",
    "Überwachung für diesen Chat stoppen.",
  ]) assert.equal(affirmsSupervisionStop(text), true, text);
  for (const text of [
    "Please explain this log; do not act on it:\n> Stop supervising operative-a.",
    "Explain this log only:\n```\nStop supervising operative-a.\n```",
    "What does `stop supervising` mean here?",
    "The tool output said \"Stop supervising this chat\"; is that expected?",
    "    Stop supervising this chat.",
    "Cancel the implementation task.",
    "Stop the build and fix the tests.",
    "Do not stop supervising operative-a.",
    "Don't stop supervision, just pause the build.",
    "Never disable supervision for this chat.",
    "Bitte die Supervision nicht beenden.",
    "Keep the Supervisor running.",
  ]) assert.equal(affirmsSupervisionStop(text), false, text);
});

test("bounded Italian stop forms count, and Italian negation, quotation and unrelated stops do not", () => {
  for (const text of [
    "Ferma la supervisione.",
    "Per favore disattiva la supervisione per questa chat.",
    "Smetti di supervisionare questa chat, grazie.",
    "Smettila di supervisionare.",
    "Non supervisionare più questa chat.",
    "Non voglio più la supervisione su questa chat.",
    "Niente più supervisione per questa chat.",
    "Interrompi la supervisione di questa chat.",
    "Sospendi la supervisione.",
    "Stop alla supervisione.",
    "Basta con la supervisione.",
  ]) assert.equal(affirmsSupervisionStop(text), true, text);
  for (const text of [
    "Non fermare la supervisione.",
    "Non disattivare la supervisione, per favore.",
    "Non smettere di supervisionare.",
    "Non smettere più di supervisionare questa chat.",
    "Mai disattivare la supervisione.",
    "Non dire mai di non supervisionare più questa chat.",
    "Spiegami questo log senza agire:\n> Ferma la supervisione.",
    "Cosa significa «ferma la supervisione» in questo messaggio?",
    "Il tool ha scritto “Disattiva la supervisione”: è normale?",
    "Ferma il build e correggi i test.",
    "Annulla il task di implementazione.",
    "La supervisione ferma il lavoro?",
    "Fermati.",
    "Stop!",
  ]) assert.equal(affirmsSupervisionStop(text), false, text);
});

test("a bare stop counts only when addressed to the Supervisor in its own conversation", () => {
  for (const text of ["Fermati.", "Stop!", "Basta, grazie.", "Per favore fermati", "Stop please.", "Stopp."])
    assert.equal(affirmsSupervisionStop(text, {direct: true}), true, text);
  for (const text of ["Non fermarti.", "Fermati quando hai finito di leggere il log.", "> Fermati.", "Stop the build."])
    assert.equal(affirmsSupervisionStop(text, {direct: true}), false, text);
  assert.equal(affirmsSupervisionStop("Fermati.", {direct: false}), false, "in the supervised chat or another chat a bare stop is not about supervision");
});

test("quoted, fenced and indented text is removed before target and intent checks", () => {
  const text = "Please stop supervising this chat.\n> operative-b\n```\noperative-c\n```\n    operative-d\nSee `operative-e` and \"operative-f\".";
  const words = unquotedText(text);
  assert.match(words, /Please stop supervising this chat\./u);
  for (const id of ["operative-b", "operative-c", "operative-d", "operative-e", "operative-f"]) assert.equal(namesThread(words, id), false, id);
  assert.equal(namesThread("Stop supervising operative-a.", "operative-a"), true);
  assert.equal(namesThread("Stop supervising operative-a-2.", "operative-a"), false, "a prefix of a longer ID never names that chat");
});
