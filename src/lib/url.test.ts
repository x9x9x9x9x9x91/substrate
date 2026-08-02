import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeUrl, urlDisplayTitle, contactHref } from "./url.ts";
import { parseQuery } from "./query.ts";

test("looksLikeUrl accepts pasted links", () => {
  assert.equal(looksLikeUrl("https://example.com"), true);
  assert.equal(looksLikeUrl("  https://example.com/a/b?q=1#x  "), true);
  assert.equal(looksLikeUrl("http://sub.domain.co.uk/path"), true);
  assert.equal(looksLikeUrl("http://localhost:5173/dev"), true);
});

test("looksLikeUrl rejects everything else", () => {
  assert.equal(looksLikeUrl("example.com"), false, "no scheme");
  assert.equal(looksLikeUrl("ftp://example.com"), false, "wrong scheme");
  assert.equal(looksLikeUrl("https://example.com and more words"), false, "spaces");
  assert.equal(looksLikeUrl("read https://example.com"), false, "prefix text");
  assert.equal(looksLikeUrl("status:live"), false);
  assert.equal(looksLikeUrl(""), false);
});

test("urlDisplayTitle strips scheme, www and trailing slash", () => {
  assert.equal(urlDisplayTitle("https://www.example.com/blog/a-post/"), "example.com/blog/a-post");
  assert.equal(urlDisplayTitle("http://example.com"), "example.com");
  assert.equal(urlDisplayTitle("https://example.com/"), "example.com");
});

test("contactHref builds mailto as typed, tel with spaces/dashes stripped (SUB-181)", () => {
  assert.equal(contactHref("email", "booking@umbra.example"), "mailto:booking@umbra.example");
  assert.equal(contactHref("phone", "+49 30 1234567"), "tel:+49301234567");
  assert.equal(contactHref("phone", "+49-30-7654321"), "tel:+49307654321");
  assert.equal(contactHref("phone", "+49 30 123 456 78"), "tel:+493012345678");
});

test("parseQuery leaves URLs whole instead of eating them as filters", () => {
  const p = parseQuery("https://example.com/a");
  assert.equal(p.text, "https://example.com/a");
  assert.equal(p.filters.length, 0);
  assert.equal(p.trailing, null);
});

test("parseQuery still treats normal operators as filters", () => {
  const p = parseQuery("status:live drift");
  assert.deepEqual(p.filters, [{ key: "status", values: ["live"] }]);
  assert.equal(p.text, "drift");
});
