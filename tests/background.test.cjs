const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const source = (name) => readFileSync(join(__dirname, "..", name), "utf8");
const clone = (value) => structuredClone(value);

function event() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    emit(...args) { for (const fn of listeners) fn(...args); },
  };
}

function harness({ settings = {}, initial = [], session = {}, chrome = false } = {}) {
  let now = 10000;
  let nextTimer = 1;
  const timers = new Map();
  const errors = [];
  const calls = [];
  const local = clone(settings);
  const state = clone(session);
  const tabs = new Map();
  const changed = event();
  const storage = (data, area) => ({
    async get(keys) {
      if (typeof keys === "string") keys = [keys];
      return clone(Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(data[key]) !== JSON.stringify(value)) {
          changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
        }
      }
      Object.assign(data, clone(values));
      if (Object.keys(changes).length) api.storage.onChanged.emit(changes, area);
    },
  });
  const reindex = (windowId) => [...tabs.values()]
    .filter((tab) => tab.windowId === windowId)
    .sort((a, b) => a.index - b.index)
    .forEach((tab, index) => { tab.index = index; });
  const add = (value) => {
    const tab = { windowId: 1, active: false, pinned: false, incognito: false,
      cookieStoreId: "firefox-default", status: "complete", ...value };
    if (tab.index === undefined) tab.index = [...tabs.values()].filter((t) => t.windowId === tab.windowId).length;
    if (tab.active) for (const other of tabs.values()) {
      if (other.windowId === tab.windowId) other.active = false;
    }
    tabs.set(tab.id, tab);
    return tab;
  };
  initial.forEach(add);
  const api = {
    runtime: { getURL: (path) => `extension://ntab/${path}` },
    storage: { local: storage(local, "local"), session: storage(state, "session"), onChanged: changed },
    tabs: {
      onCreated: event(), onUpdated: event(), onAttached: event(), onRemoved: event(),
      async get(id) {
        if (!tabs.has(id)) throw new Error("Tab not found");
        return clone(tabs.get(id));
      },
      async query(query) {
        return clone([...tabs.values()].filter((tab) => Object.entries(query).every(([key, value]) => tab[key] === value)));
      },
      async move(id, properties) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab not found");
        calls.push(["move", id, clone(properties)]);
        tab.index = properties.index === -1 ? Number.MAX_SAFE_INTEGER : properties.index;
        reindex(tab.windowId);
        return clone(tab);
      },
      async update(id, properties) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab not found");
        calls.push(["update", id, clone(properties)]);
        if (properties.active) for (const other of tabs.values()) {
          if (other.windowId === tab.windowId) other.active = false;
        }
        Object.assign(tab, properties);
        api.tabs.onUpdated.emit(id, clone(properties), clone(tab));
        return clone(tab);
      },
      async remove(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab not found");
        calls.push(["remove", id]);
        tabs.delete(id);
        reindex(tab.windowId);
        api.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false });
      },
    },
    windows: { async getAll() { return [...new Set([...tabs.values()].map((t) => t.windowId))].map((id) => ({ id })); } },
    action: { onClicked: event() },
  };
  let context;
  function start() {
    // Simulate worker termination: old listeners and timers disappear, storage remains.
    timers.clear();
    for (const key of ["onCreated", "onUpdated", "onAttached", "onRemoved"]) api.tabs[key] = event();
    api.storage.onChanged = event();
    context = vm.createContext({
      [chrome ? "chrome" : "browser"]: api, URL,
      console: { error: (...args) => errors.push(args.map(String).join(" ")) },
      Date: class extends Date { static now() { return now; } },
      setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout(id) { timers.delete(id); },
    });
    context.importScripts = (...paths) => paths.forEach((path) => vm.runInContext(source(path), context));
    if (!chrome) vm.runInContext(source("reuse.js"), context);
    vm.runInContext(source("background.js"), context);
  }
  start();
  async function flush() {
    for (let i = 0; i < 50; i++) {
      const queue = vm.runInContext("queue", context);
      await queue;
      if (queue === vm.runInContext("queue", context)) break;
      if (i === 49) throw new Error("Queue did not settle");
    }
    assert.deepEqual(errors, []);
  }
  return {
    api, tabs, calls, local, state, flush,
    async create(value) { this.arrive(value); await flush(); },
    arrive(value) { const tab = add(value); api.tabs.onCreated.emit(clone(tab)); },
    async update(id, change) {
      const tab = tabs.get(id);
      Object.assign(tab, change);
      api.tabs.onUpdated.emit(id, clone(change), clone(tab));
      await flush();
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
    async configure(values) { await api.storage.local.set(values); await flush(); },
    async restart() { await flush(); start(); await flush(); },
  };
}

const page = "https://example.com/dashboard";
const old = { id: 1, url: page };

test("reuse moves and activates the original before closing a duplicate at the cap", async () => {
  const h = harness({ settings: { n: 2, reuseMode: "all" }, initial: [old, { id: 2, url: "https://other.test/", active: true }] });
  await h.create({ id: 3, url: page, active: true });
  assert.deepEqual([...h.tabs.keys()], [1, 2]);
  assert.equal(h.tabs.get(1).index, 1);
  assert.equal(h.tabs.get(1).active, true);
  assert.deepEqual(h.calls, [["move", 1, { index: -1 }], ["update", 1, { active: true }], ["remove", 3]]);
  assert.equal(h.local.saved, undefined);
  assert.ok(h.state.created[1] > 10000);
  assert.deepEqual(h.state.opening, {});
});

test("the default remains off and preserves existing cap behavior", async () => {
  const h = harness({ settings: { n: 1 }, initial: [old] });
  await h.create({ id: 2, url: page, active: true });
  assert.deepEqual([...h.tabs.keys()], [2]);
  assert.equal(h.local.saved[page].url, page);
  assert.deepEqual(h.calls, [["remove", 1]]);
});

test("Firefox's initial blank defers eviction until its URL arrives", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "about:blank", status: "complete", active: true });
  assert.equal(h.tabs.size, 2);
  await h.update(2, { url: page, status: "loading" });
  assert.deepEqual([...h.tabs.keys()], [1]);
  assert.equal(h.local.saved, undefined);
});

test("Chrome pendingUrl works before URL commit and imports the shared rules", async () => {
  const h = harness({ chrome: true, settings: { n: 1, reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "", pendingUrl: page, status: "loading", active: true });
  assert.deepEqual([...h.tabs.keys()], [1]);
});

test("initial redirects can resolve to an existing eligible page", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "rules", reuseRules: [page] }, initial: [old] });
  await h.create({ id: 2, url: "https://redirect.test/", status: "loading", active: true });
  assert.equal(h.tabs.size, 2);
  await h.update(2, { url: page, status: "loading" });
  assert.deepEqual([...h.tabs.keys()], [1]);
});

test("unmatched navigation resumes the cap when loading completes", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "rules", reuseRules: [page] }, initial: [old] });
  await h.create({ id: 2, url: "https://unmatched.test/", status: "loading", active: true });
  await h.update(2, { status: "complete" });
  assert.deepEqual([...h.tabs.keys()], [2]);
  assert.equal(h.local.saved[page].url, page);
});

test("the bounded wait enforces the cap even if navigation never completes", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "about:blank", active: true });
  await h.advance(5000);
  assert.deepEqual([...h.tabs.keys()], [2]);
  assert.deepEqual(h.state.opening, {});
});

test("rapid duplicates retain the earlier arrival even when newer tabs are queried first", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" } });
  h.arrive({ id: 1, url: page, status: "loading", index: 1 });
  h.arrive({ id: 2, url: page, status: "loading", index: 0, active: true });
  await h.flush();
  assert.deepEqual([...h.tabs.keys()], [1]);
  assert.equal(h.tabs.get(1).active, true);
});

test("two simultaneous duplicates at the cap both retain the original", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old] });
  h.arrive({ id: 2, url: page, active: true });
  h.arrive({ id: 3, url: page, active: true });
  await h.flush();
  assert.deepEqual([...h.tabs.keys()], [1]);
  assert.equal(h.local.saved, undefined);
});

test("different windows, containers, privacy contexts, and pinned tabs are excluded", async () => {
  for (const difference of [{ windowId: 2 }, { cookieStoreId: "firefox-container-2" }, { incognito: true }, { pinned: true }]) {
    const h = harness({ settings: { reuseMode: "all" }, initial: [{ ...old, ...difference }] });
    await h.create({ id: 2, url: page, active: true });
    assert.equal(h.tabs.size, 2);
    assert.deepEqual(h.calls, []);
  }
  const h = harness({ settings: { reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: page, pinned: true });
  assert.equal(h.tabs.size, 2);
});

test("rules select pages without merging different queries or fragments", async () => {
  const h = harness({ settings: { reuseMode: "rules", reuseRules: ["https://example.com/*"] }, initial: [old] });
  await h.create({ id: 2, url: `${page}?view=2` });
  await h.create({ id: 3, url: `${page}#section` });
  assert.equal(h.tabs.size, 3);
  await h.create({ id: 4, url: `${page}?view=2` });
  assert.equal(h.tabs.size, 3);
  assert.equal(h.tabs.get(2).active, true);
});

test("ordinary later navigation and settings changes don't sweep old duplicates", async () => {
  const h = harness({ settings: { reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "https://other.test/" });
  await h.update(2, { url: page, status: "loading" });
  await h.configure({ reuseMode: "rules", reuseRules: [page] });
  assert.equal(h.tabs.size, 2);
  assert.deepEqual(h.calls, []);
});

test("a worker restart restores the initial-navigation wait", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "about:blank", active: true });
  await h.restart();
  await h.update(2, { url: page, status: "loading" });
  assert.deepEqual([...h.tabs.keys()], [1]);
});

test("a restarted worker restores the timeout and clears expired state", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "about:blank", active: true });
  await h.restart();
  await h.advance(5000);
  assert.deepEqual([...h.tabs.keys()], [2]);
  await h.restart();
  assert.deepEqual(h.state.opening, {});
});

test("closing the pending tab releases the deferred cap", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old, { id: 3, url: "https://other.test/", active: true }] });
  await h.create({ id: 2, url: "about:blank" });
  await h.api.tabs.remove(2);
  await h.flush();
  assert.deepEqual([...h.tabs.keys()], [3]);
  assert.deepEqual(h.state.opening, {});
});

test("disabling reuse immediately releases any deferred enforcement", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old] });
  await h.create({ id: 2, url: "about:blank", active: true });
  await h.configure({ reuseMode: "off" });
  assert.deepEqual([...h.tabs.keys()], [2]);
  assert.deepEqual(h.state.opening, {});
});

test("moving a pending tab between windows updates the deadline's enforcement target", async () => {
  const h = harness({ settings: { n: 1, reuseMode: "all" }, initial: [old, { id: 3, windowId: 2, url: "https://other.test/" }] });
  await h.create({ id: 2, url: "about:blank", active: true });
  h.tabs.get(2).windowId = 2;
  h.api.tabs.onAttached.emit(2, { newWindowId: 2 });
  await h.flush();
  await h.advance(5000);
  assert.deepEqual([...h.tabs.keys()], [1, 2]);
});

test("move failure keeps the new tab open", async () => {
  const h = harness({ settings: { reuseMode: "all" }, initial: [old] });
  // Use a rejected move without swallowing the background's diagnostic.
  h.api.tabs.move = async () => { throw new Error("Tab is being dragged"); };
  h.arrive({ id: 2, url: page, active: true });
  // flush intentionally asserts no errors; inspect the queue directly here.
  await assert.rejects(h.flush(), /Tab is being dragged/);
  assert.equal(h.tabs.size, 2);
  assert.equal(h.calls.some(([method]) => method === "remove"), false);
});

test("navigation during activation keeps the new tab open", async () => {
  const h = harness({ settings: { reuseMode: "all" }, initial: [old] });
  const update = h.api.tabs.update;
  h.api.tabs.update = async (id, properties) => {
    const result = await update(id, properties);
    h.tabs.get(2).url = "https://different.test/";
    return result;
  };
  await h.create({ id: 2, url: page, active: true });
  assert.equal(h.tabs.size, 2);
  assert.equal(h.tabs.get(2).url, "https://different.test/");
  assert.equal(h.calls.some(([method]) => method === "remove"), false);
});
