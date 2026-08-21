/** What a caught value says to a reader.

    `String(e)` on an Error yields "Error: no note named “Nowhere”" — the
    class name is a JavaScript detail, and on a dashboard it reads as part of
    the sentence the app is telling its user. The dashboard surfaces that put
    a caught failure into user-facing copy run it through here, so the message
    is the message and nothing else. This is not a sweep: plenty of panes
    still stringify their own catches, and each one is its own decision about
    what a reader should be shown. */
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
