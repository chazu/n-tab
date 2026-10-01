const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ URL });
vm.runInContext(readFileSync(join(__dirname, "..", "reuse.js"), "utf8"), context);
const reuse = context.NTabReuse;
const matches = (pattern, url) => reuse.eligible(url, reuse.settings({ reuseMode: "rules", reuseRules: [pattern] }));

test("rules trim blank lines, deduplicate, and canonicalize URLs", () => {
  assert.deepEqual(Array.from(reuse.parseRules("\n HTTPS://EXAMPLE.COM \r\nhttps://example.com/\n")), ["https://example.com/"]);
});

test("exact URLs require their full path, query, and fragment", () => {
  const rule = "https://example.com/page?a=1#here";
  assert.equal(matches(rule, rule), true);
  for (const url of ["https://example.com/page?a=2#here", "https://example.com/page?a=1#there", "https://example.com/page?a=1", "https://example.com/page?a=1#here/more"]) {
    assert.equal(matches(rule, url), false);
  }
});

test("wildcards support hosts and paths without crossing host boundaries", () => {
  const rule = "https://*.example.org/*";
  assert.equal(matches(rule, "https://app.example.org/path?q=1#section"), true);
  assert.equal(matches(rule, "https://deep.app.example.org/"), true);
  assert.equal(matches(rule, "https://example.org/"), false);
  assert.equal(matches(rule, "https://evil.test/path.example.org/page"), false);
  assert.equal(matches(rule, "https://evil.test/?x=.example.org/page"), false);
  assert.equal(matches("https://example.com/path*", "https://example.com/path"), true);
  assert.equal(matches("https://example.com/path*", "https://example.com/path/more"), true);
});

test("regex punctuation in URLs is literal", () => {
  const rule = "https://example.com/search?q=a+b.c";
  assert.equal(matches(rule, rule), true);
  assert.equal(matches(rule, "https://example.com/search?q=abXc"), false);
});

test("invalid rules report the original line number", () => {
  for (const rule of ["example.com", "https:example.com", "https:/example.com", "ftp://example.com/", "https://user:password@example.com/", "https://example.com/has space", "*://example.com/*"]) {
    assert.throws(() => reuse.parseRules(`\nhttps://good.test/\n${rule}`), /Line 3:/);
  }
});

test("empty or malformed settings fail closed, and all mode only allows HTTP(S)", () => {
  for (const value of [{}, { reuseMode: "unknown" }, { reuseMode: "rules", reuseRules: [] }, { reuseMode: "rules", reuseRules: ["invalid"] }]) {
    assert.equal(reuse.eligible("https://example.com/", reuse.settings(value)), false);
  }
  for (const url of ["about:blank", "extension://ntab/ntab.html", "file:///tmp/test", "ftp://example.com/"]) {
    assert.equal(reuse.eligible(url, reuse.settings({ reuseMode: "all" })), false);
  }
});
