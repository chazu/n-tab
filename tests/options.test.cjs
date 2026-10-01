const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

async function options(initial = {}) {
  const values = structuredClone(initial);
  const writes = [];
  const elements = Object.fromEntries(["n", "status", "reuse-mode", "reuse-rules", "form"].map((id) => [id, {
    value: "", textContent: "", disabled: false, validity: "", listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    setCustomValidity(message) { this.validity = message; },
    reportValidity() { this.reported = true; },
  }]));
  const context = vm.createContext({ URL, setTimeout: () => 1, clearTimeout: () => {},
    browser: { storage: { local: {
      async get() { return structuredClone(values); },
      async set(value) { writes.push(structuredClone(value)); Object.assign(values, structuredClone(value)); },
    } } },
    document: { getElementById: (id) => elements[id] },
  });
  for (const file of ["reuse.js", "options.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "..", file), "utf8"), context);
  }
  await Promise.resolve();
  return {
    elements, values, writes,
    mode(value) { elements["reuse-mode"].value = value; elements["reuse-mode"].listeners.change(); },
    async submit() { await elements.form.listeners.submit({ preventDefault() {} }); },
  };
}

test("options default to Off with rules disabled", async () => {
  const h = await options();
  assert.equal(h.elements.n.value, 10);
  assert.equal(h.elements["reuse-mode"].value, "off");
  assert.equal(h.elements["reuse-rules"].disabled, true);
});

test("options restore and save N, mode, and normalized rules together", async () => {
  const h = await options({ n: 5, reuseMode: "rules", reuseRules: ["https://example.com/*"] });
  assert.equal(h.elements["reuse-rules"].disabled, false);
  assert.equal(h.elements["reuse-rules"].value, "https://example.com/*");
  h.elements.n.value = "8";
  h.elements["reuse-rules"].value = " HTTPS://EXAMPLE.COM \nhttps://github.com/*";
  await h.submit();
  assert.deepEqual(h.writes, [{ n: 8, reuseMode: "rules", reuseRules: ["https://example.com/", "https://github.com/*"] }]);
  assert.equal(h.elements.status.textContent, "Saved");
});

test("invalid active rules show an error without changing stored settings", async () => {
  const h = await options({ n: 5 });
  h.mode("rules");
  h.elements["reuse-rules"].value = "https://good.test/\nnot a url";
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.match(h.elements["reuse-rules"].validity, /Line 2:/);
  assert.equal(h.elements["reuse-rules"].reported, true);
  h.elements["reuse-rules"].listeners.input();
  assert.equal(h.elements["reuse-rules"].validity, "");
});

test("an invalid draft does not block switching Off or All URLs", async () => {
  for (const mode of ["off", "all"]) {
    const h = await options({ n: 5, reuseMode: "rules" });
    h.elements["reuse-rules"].value = "unfinished";
    h.mode(mode);
    await h.submit();
    assert.equal(h.values.reuseMode, mode);
    assert.deepEqual(h.values.reuseRules, ["unfinished"]);
    assert.equal(h.elements.status.textContent, "Saved");
  }
});

test("fractional tab caps aren't silently truncated", async () => {
  const h = await options();
  h.elements.n.value = "2.5";
  await h.submit();
  assert.deepEqual(h.writes, []);
});
