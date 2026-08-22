/** What a caught value says to a reader.

    `String(e)` on an Error yields "Error: no note named “Nowhere”" — the
    class name is a JavaScript detail, and on a dashboard it reads as part of
    the sentence the app is telling its user. Every dashboard surface that
    puts a caught failure into user-facing copy runs it through here, so the
    message is the message and nothing else. Outside the dashboards it is
    still a choice, not a rule: a pane whose copy wants the class name (a
    kind's runtime card, where its author is the reader) keeps it
    deliberately. */
export function errText(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).trim();
  // `new Error()` carries an empty message, so a sentence interpolating it
  // ends on air — "launchd refresh failed — ". The class name is a poor
  // sentence, but it is at least a statement that something threw.
  return text || (e instanceof Error ? e.name : "") || "unknown error";
}

/** The same text with room for the sentence's own full stop. A message that
    ends on its own meets it and prints "…..", which is the doubling the jobs
    empty line already guards against on its launchd prefixes. */
export function midSentence(text: string): string {
  return text.replace(/\s*\.+$/, "");
}

/** What a reader is told when the thing that failed threw something that
    isn't an Error at all.

    `errText` stringifies whatever it is handed, which is right for a caught
    Error and right for a thrown string — both carry a sentence. It is wrong
    for the rest: a kind that runs `throw null` produced a card whose whole
    body was the word "null", which reads as a value the app computed rather
    than as code that fell over. Naming the shape says which of the two it
    was, and keeps the sentence pointing at the code that threw. */
export function thrownText(e: unknown): string {
  if (e instanceof Error) return errText(e);
  if (typeof e === "string" && e.trim() !== "") return e.trim();
  return `it threw ${thrownShape(e)}, not an error`;
}

function thrownShape(e: unknown): string {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  if (typeof e === "string") return "an empty string";
  if (typeof e === "object") return "an object carrying no message";
  return `the ${typeof e} ${String(e)}`;
}
