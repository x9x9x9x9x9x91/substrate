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

test("looksLikeUrl accepts dotless hosts — intranet names (SUB-1280)", () => {
  assert.equal(looksLikeUrl("http://nas/"), true, "single-label intranet host");
  assert.equal(looksLikeUrl("http://intranet:8080/"), true, "single-label host with port");
  assert.equal(looksLikeUrl("https://nas"), true, "single-label host, no trailing slash");
  assert.equal(looksLikeUrl("http://192.168.1.10:8080/admin"), true, "IPv4 literal");
  assert.equal(looksLikeUrl(String.raw`http://nas\share`), true, "backslash inside the path is a path, not an empty authority");
});

// the recognizer must stay no looser than the engine: create_reference derives the
// capture title from the host-and-path display form and validate_note_title
// refuses [ and ], so a bracketed IPv6 host would show a capture row that can
// only end in an error toast
test("looksLikeUrl rejects bracketed IPv6 hosts the capture pipeline cannot title (SUB-1280)", () => {
  assert.equal(looksLikeUrl("http://[::1]:5173/"), false, "IPv6 loopback literal with port");
  assert.equal(looksLikeUrl("http://[2001:db8::1]/"), false, "IPv6 literal");
  assert.equal(looksLikeUrl("https://[2001:db8::1]:8443/admin"), false, "IPv6 literal with port and path");
});

test("looksLikeUrl rejects everything else", () => {
  assert.equal(looksLikeUrl("example.com"), false, "no scheme");
  assert.equal(looksLikeUrl("ftp://example.com"), false, "wrong scheme");
  assert.equal(looksLikeUrl("https://example.com and more words"), false, "spaces");
  assert.equal(looksLikeUrl("read https://example.com"), false, "prefix text");
  assert.equal(looksLikeUrl("status:live"), false);
  assert.equal(looksLikeUrl(""), false);
  // dotless hosts are accepted only behind an explicit scheme — bare text stays text
  assert.equal(looksLikeUrl("foo/bar"), false, "bare path-ish word");
  assert.equal(looksLikeUrl("a:b"), false, "bare colon pair");
  assert.equal(looksLikeUrl("nas"), false, "bare intranet name, no scheme");
  assert.equal(looksLikeUrl("nas:5000/shares"), false, "bare host:port, no scheme");
  assert.equal(looksLikeUrl("[::1]:5173"), false, "bare IPv6 literal, no scheme");
  assert.equal(looksLikeUrl("http:///path"), false, "scheme with empty host");
  // WHATWG treats \\ as / for special schemes, so the backslash spellings of an
  // empty authority promote the first path segment to a host exactly the same way
  assert.equal(looksLikeUrl(String.raw`http://\path`), false, "empty authority, backslash spelling");
  assert.equal(looksLikeUrl(String.raw`http://\\path`), false, "empty authority, double backslash");
  assert.equal(looksLikeUrl(String.raw`http:/\path`), false, "empty authority, mixed slash spelling");
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
