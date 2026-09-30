// NTab background: enforce a per-window cap of N unpinned tabs, shunting the
// oldest excess tabs into the NTab list (unique by URL).

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_N = 10;
const NTAB_PAGE = api.runtime.getURL("ntab.html");
const SAVEABLE = /^(https?|ftp|file):/i;
const BLANK = /^(about:(blank|newtab|home)|chrome:\/\/newtab\/?|)$/i;

// Tab creation times, so "oldest" means oldest by creation, not tab position.
// Tabs without a record (e.g. restored after a browser restart) count as oldest.
const ages = api.storage.session ?? api.storage.local;

// All storage read-modify-write and tab enforcement runs through one queue.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => console.error("ntab:", err));
  return queue;
}

async function getN() {
  const { n } = await api.storage.local.get("n");
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_N;
}

async function recordAge(tabId) {
  const { created = {} } = await ages.get("created");
  created[tabId] = Date.now();
  await ages.set({ created });
}

async function forgetAge(tabId) {
  const { created = {} } = await ages.get("created");
  if (tabId in created) {
    delete created[tabId];
    await ages.set({ created });
  }
}

async function saveTab(tab) {
  const { saved = {} } = await api.storage.local.get("saved");
  saved[tab.url] = {
    url: tab.url,
    title: tab.title || tab.url,
    favIconUrl: tab.favIconUrl || "",
    savedAt: Date.now(),
  };
  await api.storage.local.set({ saved });
}

async function enforce(windowId) {
  const n = await getN();
  const tabs = await api.tabs.query({ windowId, pinned: false });
  const counted = tabs.filter((t) => !t.url?.startsWith(NTAB_PAGE));
  let excess = counted.length - n;
  if (excess <= 0) return;

  const { created = {} } = await ages.get("created");
  const oldestFirst = counted
    .filter((t) => !t.active)
    .sort((a, b) => (created[a.id] ?? 0) - (created[b.id] ?? 0) || a.index - b.index);

  for (const tab of oldestFirst) {
    if (excess <= 0) break;
    const url = tab.url || "";
    if (SAVEABLE.test(url)) {
      await saveTab(tab);
    } else if (!BLANK.test(url)) {
      continue; // can't be restored later, so don't close it
    }
    await api.tabs.remove(tab.id);
    excess--;
  }
}

api.tabs.onCreated.addListener((tab) =>
  enqueue(async () => {
    await recordAge(tab.id);
    await enforce(tab.windowId);
  })
);

// Unpinning a tab or moving one between windows can push a window over N.
api.tabs.onUpdated.addListener(
  (tabId, _change, tab) => enqueue(() => enforce(tab.windowId)),
  { properties: ["pinned"] }
);
api.tabs.onAttached.addListener((_tabId, { newWindowId }) =>
  enqueue(() => enforce(newWindowId))
);

api.tabs.onRemoved.addListener((tabId) => enqueue(() => forgetAge(tabId)));

// Lowering N in the options page applies immediately.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.n) return;
  enqueue(async () => {
    for (const w of await api.windows.getAll()) await enforce(w.id);
  });
});

// Toolbar button: focus the NTab page if it is open, otherwise open it.
api.action.onClicked.addListener(async () => {
  const [existing] = await api.tabs.query({ url: NTAB_PAGE });
  if (existing) {
    await api.tabs.update(existing.id, { active: true });
    await api.windows.update(existing.windowId, { focused: true });
  } else {
    await api.tabs.create({ url: NTAB_PAGE });
  }
});
