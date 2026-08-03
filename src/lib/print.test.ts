import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrintBody } from "./print.ts";

const noAssets = () => undefined;

test("headings, paragraphs, and inline marks render", () => {
  const html = renderPrintBody("## Basics\n\nSome **strong** and *soft* `code` text.", noAssets);
  assert.match(html, /<h2>Basics<\/h2>/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /<em>soft<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("html in note text is escaped everywhere, including code", () => {
  const html = renderPrintBody("<img onerror=x>\n\n```\n<script>\n```", noAssets);
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("task lists, tables, quotes, and rules render", () => {
  const md = [
    "- [ ] open",
    "- [x] done",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "> quoted",
    "",
    "---",
  ].join("\n");
  const html = renderPrintBody(md, noAssets);
  assert.match(html, /<li class="print-task">/);
  assert.match(html, /<li class="print-task done">/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test("adjacent bullet and numbered runs keep their own list tags (SUB-901)", () => {
  const html = renderPrintBody("- a\n- b\n1) first\n2) second", noAssets);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/, "bullets close before the numbers");
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/, "numbered run keeps <ol>");
});

test("wikilinks flatten to text; embeds use the asset resolver", () => {
  const src = (n: string) => (n === "shot.png" ? "data:image/png;base64,AA" : undefined);
  const html = renderPrintBody("See [[Static Bouquet]] ![[shot.png]] ![[gone.png]]", src);
  assert.match(html, /<span class="print-link">Static Bouquet<\/span>/);
  assert.match(html, /<img src="data:image\/png;base64,AA" alt="shot.png">/);
  assert.match(html, /missing image · gone.png/);
});

test("embed names are resolved unescaped, so ampersands still find their asset", () => {
  // `&` survives sanitize_filename (vault/mod.rs), so it reaches disk verbatim;
  // `<`, `>` and `"` are replaced there and cannot name a real asset.
  const src = (n: string) =>
    n === "Rock & Roll cover.png" ? "data:image/png;base64,AA" : undefined;
  const html = renderPrintBody("![[Rock & Roll cover.png]]", src);
  assert.match(html, /<img src="data:image\/png;base64,AA" alt="Rock &amp; Roll cover.png">/);
  assert.ok(!html.includes("print-missing"));
});

test("missing embeds still render their name escaped, never as live markup", () => {
  const html = renderPrintBody('![[gone & "<img onerror=x>".png]]', noAssets);
  assert.match(
    html,
    /<span class="print-missing">missing image · gone &amp; &quot;&lt;img onerror=x&gt;&quot;.png<\/span>/
  );
  assert.ok(!html.includes("<img"));
});

test("non-image embeds (audio) print as named placeholders, never img tags", () => {
  const html = renderPrintBody("![[vessel-master-v2.wav]]", () => "data:image/png;base64,AA");
  assert.match(html, /<span class="print-embed">embedded file · vessel-master-v2.wav<\/span>/);
  assert.ok(!html.includes("<img"));
});

test("code fences swallow markdown and inline rules stay out of code spans", () => {
  const html = renderPrintBody("```ts\n**not bold** ![[x.png]]\n```\n\na `**lit**` span", noAssets);
  assert.ok(!html.includes("<strong>"), "no emphasis inside fences or code spans");
  assert.match(html, /<code>\*\*lit\*\*<\/code>/);
  assert.match(html, /\*\*not bold\*\* !\[\[x.png\]\]/);
});

test("md links keep parenthesized URLs whole (SUB-902)", () => {
  const html = renderPrintBody("[x](https://en.wikipedia.org/wiki/A_(b)) tail", noAssets);
  assert.match(html, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/A_\(b\)">x<\/a> tail/);
  // plain links unchanged
  const plain = renderPrintBody("[y](https://ok.com/path)", noAssets);
  assert.match(plain, /<a href="https:\/\/ok\.com\/path">y<\/a>/);
});

test("a spaced info string still opens a fence — content below stays prose (SUB-898)", () => {
  const html = renderPrintBody(
    "before\n```rust ignore\nlet x = 1;\n```\nafter paragraph\n\n# Real heading",
    noAssets
  );
  assert.match(html, /<pre><code>let x = 1;<\/code><\/pre>/, "fence body prints as code");
  assert.match(html, /<p>after paragraph<\/p>/, "text after the closer is prose again");
  assert.match(html, /<h1>Real heading<\/h1>/, "headings below the fence still render");
});
