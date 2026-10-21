// deterministic necessary conditions for a human STOP of one chat's supervision. The assistant still decides whether the
// human asked for a stop; these checks only deny what cannot be one: quoted or pasted text, negated or unrelated
// instructions, and messages that name a different or a second chat.

// double, angle and single quoted spans. A span never contains its own opening mark, so every scan stops at the next one and
// a long line costs linear time. A single quote opens only before a word and closes only after one, so "don't" and
// "dell'utente" stay text
const quotedSpan = /"[^"\n]*"|“[^“”\n]*”|„[^„“”\n]*[“”]|«[^«»\n]*»|»[^»«\n]*«|‹[^‹›\n]*›|›[^›‹\n]*‹|(?<![\p{L}\p{N}])'(?=\S)(?:[^'\n]|(?<=[\p{L}\p{N}])')*?(?<=\S)'(?![\p{L}\p{N}])|[‘‚](?:[^‘‚’\n]|’(?=[\p{L}\p{N}]))*?[‘’](?![\p{L}\p{N}])/gu;

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
  return kept.join("\n").replace(/`+[^`\n]*`+/gu, " ").replace(quotedSpan, " ");
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
// a stop, pause or interruption word aimed at another stop reverses the request
const stopWord = "(?:stop\\p{L}*|disabl\\p{L}*|deactivat\\p{L}*|end(?:s|ed|ing)?|cancel\\p{L}*|paus\\p{L}*|halting|ceas\\p{L}*|quit(?:s|ting)?|" +
  "interrupt\\p{L}*|suspen\\p{L}*|turning|switching|shut\\p{L}*|beend\\p{L}*|deaktivier\\p{L}*|abschalt\\p{L}*|ausschalt\\p{L}*|" +
  "abstell\\p{L}*|unterbrech\\p{L}*|ferm\\p{L}*|disattiv\\p{L}*|interromp\\p{L}*|interruz\\p{L}*|sospen\\p{L}*|spegn\\p{L}*|speng\\p{L}*|smett\\p{L}*)";
// up to `count` words between a verb and supervision, none of them a stop word: "end the pause of supervision" resumes it
const between = (count: number) => `(?:\\s+(?!${stopWord}${end})\\S+){0,${count}}?`;
// after an article a stop word is a noun, as in "end the pause of supervision"
const notNoun = `(?<!${start}(?:the|an?|this|that|la|il|lo|una?|questa|questo|die|der|das|den|eine[nm]?)\\s+|${start}l['’])`;
// "stop supervising this chat", "disable the Supervisor", "ferma la supervisione"
const verbThenNoun = new RegExp(`${start}${notNoun}(?:${verbs})${end}${between(4)}\\s+${noun}`, "iu");
const nounThenVerb = new RegExp(`${start}${noun}${between(5)}\\s+(?:${verbFinal})${end}`, "iu");
// stopping, avoiding or preventing a stop asks to keep supervision: "stop interrupting the supervision", "smetti di
// fermare la supervisione", "hör auf, die Supervision zu beenden"; such a sentence never counts
const reversal = new RegExp(`${start}(?:(?:stop|quit|cease|avoid|prevent|refrain\\s+from|smett\\p{L}*\\s+di|basta\\s+con|evit\\p{L}*(?:\\s+di)?)${end}` +
  `(?:\\s+[^\\s,]+){0,2}?\\s+|(?:hör\\p{L}*(?:\\s+\\S+)?\\s+auf|aufhören|aufzuhören|vermeid\\p{L}*|verhinder\\p{L}*)${end}(?:[\\s,]+[^\\s,]+){0,4}?[\\s,]+)` +
  `${stopWord}${end}`, "iu");
const negationWords = `${start}(?:don['’]?t|do\\s+not|does\\s+not|doesn['’]?t|never|not|no\\s+need|no\\s+longer|without|instead\\s+of|rather\\s+than|` +
  `nicht|kein\\p{L}*|nie|statt|anstatt|non|mai|senza|nessun\\p{L}*|invece\\s+di|anziché|piuttosto\\s+che)${end}`;
// Italian says "no more" with its one negation: "non supervisionare più questa chat", "non voglio più la supervisione",
// "niente più supervisione"; such a clause counts only when it has no other negation, and "non voglio più" or "niente più"
// only with supervision itself as the object, so "non voglio più interrompere la supervisione" never does
const object = "(?:essere\\s+)?(?:(?:la|il|lo|l['’]|i|gli|le|un|una|alcun[ao]?|questa|questo|tua|tuo|sua|suo|vostra|vostro)\\s*){0,2}";
const noMore = new RegExp(`${start}(?:non\\s+(?:(?:mi|ci|la|lo)\\s+)?supervision\\p{L}*${between(3)}\\s+più|` +
  `(?:non\\s+(?:voglio|vogliamo)|niente)\\s+più\\s+${object}${noun})${end}`, "iu");
// addressed to the Supervisor in its own conversation, a bare "stop", "stop yourself" or "fermati" asks it to stop supervising
const bareStop = /^\s*(?:(?:per\s+favore|perfavore|please|bitte)\s+)?(?:stop(?:\s+yourself)?|stopp|fermati|fermatevi|basta(?:\s+così)?|smettila|halt|hör\s+auf)(?:\s+(?:per\s+favore|grazie|please|bitte|danke|thanks|subito|adesso|ora|now|jetzt))?\s*$/iu;

/**
 * Whether the human's unquoted words affirmatively ask to stop supervision (English, German or Italian): a clause must pair a
 * stop verb with supervision. A clause with any negation fails closed, except an Italian "no more" form whose negation is its
 * only one, and a sentence that asks to stop or avoid a stop fails closed, so a negated, reversed or unrelated instruction,
 * such as cancelling a task, never does. In the Supervisor's own conversation
 * (`direct`) a bare "stop", "stop yourself" or "fermati" clause is addressed to the Supervisor and also counts.
 */
export const affirmsSupervisionStop = (text: string, context: {direct?: boolean} = {}): boolean =>
  unquotedText(text).split(/[.!?;\n]+/u).some(sentence => !reversal.test(sentence) && sentence.split(/[:,]+/u).some(clause => {
    const negations = clause.match(new RegExp(negationWords, "giu"))?.length ?? 0;
    if (negations <= 1 && noMore.test(clause)) return true;
    if (negations > 0) return false;
    return verbThenNoun.test(clause) || nounThenVerb.test(clause) || context.direct === true && bareStop.test(clause);
  }));

// an exact whole-token mention of a chat ID; a prefix of a longer ID never names that chat
export const namesThread = (text: string, threadId: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9:_%.-])${threadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9:_%-]|\\.[A-Za-z0-9:_%-])`, "u").test(text);
