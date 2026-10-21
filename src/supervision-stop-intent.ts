// deterministic necessary conditions for a human STOP of one chat's supervision. The assistant still decides whether the
// human asked for a stop; these checks only deny what cannot be one: quoted or pasted text, negated or unrelated
// instructions, and messages that name a different or a second chat.

/**
 * The human's own words in a native message. Fenced and indented code, quoted replies, inline code and quoted spans are
 * removed, so text that the human only quotes or pastes never carries an instruction.
 */
export const unquotedText = (text: string): string => {
  const kept: string[] = [];
  let fence: {marker: string; length: number} | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (opener && opener[0] === fence.marker && opener.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/u.test(line)) fence = null;
      continue;
    }
    if (opener) {fence = {marker: opener[0]!, length: opener.length};continue;}
    if (/^ {0,3}>/u.test(line) || /^(?: {4}|\t)/u.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/`+[^`\n]*`+/gu, " ").replace(/"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»|»[^«\n]*«/gu, " ");
};

const start = "(?<![\\p{L}\\p{N}_])";
const end = "(?![\\p{L}\\p{N}_])";
const verbs = "stop(?:p(?:e|en|t)?)?|disable|deactivate|end|cancel|turn\\s+off|switch\\s+off|pause|halt|cease|" +
  "beende[nt]?|deaktivier(?:e|en|t)?|abschalten|ausschalten|abstellen|" +
  // Italian imperative, infinitive and polite forms: "ferma la supervisione", "smetti di supervisionare", "stop alla supervisione"
  "ferma(?:re|te)?|fermi|disattiva(?:re|te)?|disattivi|interromp(?:i|ere|ete|a)|sospend(?:i|ere|ete|a)|spegn(?:i|ere|ete)|speng[ae]|" +
  "smett(?:i|ere|ete|a|ila)\\s+di|basta(?:\\s+con)?";
// German puts the verb last ("Supervision beenden"), as does "supervision off"; Italian never relies on that order
const verbFinal = "beende[nt]?|deaktivier(?:e|en|t)?|abschalten|ausschalten|abstellen|stopp(?:en)?|off|aus";
const noun = "(?:supervis|überwach|beaufsichtig)\\p{L}*";
// "stop supervising this chat", "disable the Supervisor", "ferma la supervisione"
const verbThenNoun = new RegExp(`${start}(?:${verbs})${end}(?:\\s+\\S+){0,4}?\\s+${noun}`, "iu");
const nounThenVerb = new RegExp(`${start}${noun}(?:\\s+\\S+){0,5}?\\s+(?:${verbFinal})${end}`, "iu");
const negationWords = `${start}(?:don['’]?t|do\\s+not|does\\s+not|doesn['’]?t|never|not|no\\s+need|without|nicht|kein\\p{L}*|nie|non|mai|senza|nessun\\p{L}*)${end}`;
// Italian says "no more" with its one negation: "non supervisionare più questa chat", "non voglio più la supervisione",
// "niente più supervisione"; such a clause counts only when it has no other negation
const noMore = new RegExp(`${start}(?:non\\s+(?:(?:mi|ci|la|lo)\\s+)?supervision\\p{L}*(?:\\s+\\S+){0,3}?\\s+più|` +
  `non\\s+(?:voglio|vogliamo)\\s+più(?:\\s+\\S+){0,3}?\\s+${noun}|niente\\s+più(?:\\s+\\S+){0,2}?\\s+${noun})${end}`, "iu");
// addressed to the Supervisor in its own conversation, a bare "stop" or "fermati" asks it to stop supervising
const bareStop = /^\s*(?:(?:per\s+favore|perfavore|please|bitte)\s+)?(?:stop|stopp|fermati|fermatevi|basta(?:\s+così)?|smettila|halt|hör\s+auf)(?:\s+(?:per\s+favore|grazie|please|bitte|danke|thanks|subito|adesso|ora|now|jetzt))?\s*$/iu;

/**
 * Whether the human's unquoted words affirmatively ask to stop supervision (English, German or Italian): a clause must pair a
 * stop verb with supervision. A clause with any negation fails closed, except an Italian "no more" form whose negation is its
 * only one, so a negated or unrelated instruction, such as cancelling a task, never does. In the Supervisor's own conversation
 * (`direct`) a bare "stop" or "fermati" clause is addressed to the Supervisor and also counts.
 */
export const affirmsSupervisionStop = (text: string, context: {direct?: boolean} = {}): boolean =>
  unquotedText(text).split(/[.!?;:,\n]+/u).some(clause => {
    const negations = clause.match(new RegExp(negationWords, "giu"))?.length ?? 0;
    if (negations <= 1 && noMore.test(clause)) return true;
    if (negations > 0) return false;
    return verbThenNoun.test(clause) || nounThenVerb.test(clause) || context.direct === true && bareStop.test(clause);
  });

// an exact whole-token mention of a chat ID; a prefix of a longer ID never names that chat
export const namesThread = (text: string, threadId: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9:_%.-])${threadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9:_%-]|\\.[A-Za-z0-9:_%-])`, "u").test(text);
