// NTab background: enforce a per-window cap of N unpinned tabs, shunting the
// oldest excess tabs into the NTab list (unique by URL).

const api = globalThis.browser ?? globalThis.chrome;
if (!globalThis.NTabReuse) importScripts("reuse.js");

const DEFAULT_N = 10;
const NTAB_PAGE = api.runtime.getURL("ntab.html");
const SAVEABLE = /^(https?|ftp|file):/i;
const BLANK = /^(about:(blank|newtab|home)|chrome:\/\/newtab\/?|)$/i;
const OPENING_TIMEOUT_MS = 5000;

// Tab creation times, so "oldest" means oldest by creation, not tab position.
// Tabs without a record (e.g. restored after a browser restart) count as oldest.
const ages = api.storage.session ?? api.storage.local;
const openingTimers = new Map();
// Mark arrivals synchronously, before queued work can query a newer tab.
const arrivals = new Set();

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

async function getReuse() {
  return NTabReuse.settings(await api.storage.local.get(["reuseMode", "reuseRules"]));
}

async function recordAge(tabId) {
  const { created = {} } = await ages.get("created");
  // Keep creation ordering deterministic even for simultaneous openings.
  created[tabId] = Object.values(created).reduce((newest, age) => Math.max(newest, age + 1), Date.now());
  await ages.set({ created });
}

function cancelOpeningTimer(tabId) {
  clearTimeout(openingTimers.get(tabId));
  openingTimers.delete(tabId);
}

function scheduleOpening(tabId, entry) {
  cancelOpeningTimer(tabId);
  openingTimers.set(tabId, setTimeout(() => enqueue(async () => {
    await finishOpening(tabId);
    await enforce(entry.windowId);
  }), Math.max(0, entry.expiresAt - Date.now())));
}

async function finishOpening(tabId) {
  cancelOpeningTimer(tabId);
  arrivals.delete(tabId);
  const { opening = {} } = await ages.get("opening");
  if (tabId in opening) {
    delete opening[tabId];
    await ages.set({ opening });
  }
}

async function getTab(tabId) {
  try {
    return await api.tabs.get(tabId);
  } catch {
    return null; // The user may have closed it while work was queued.
  }
}

async function reuseTab(tab, config) {
  const url = tab.pendingUrl || tab.url || "";
  if (tab.pinned || !NTabReuse.eligible(url, config)) return false;
  const { created = {}, opening = {} } = await ages.get(["created", "opening"]);
  const tabs = await api.tabs.query({ windowId: tab.windowId });
  const existing = tabs
    .filter((other) => other.id !== tab.id && !other.pinned &&
      other.incognito === tab.incognito && other.cookieStoreId === tab.cookieStoreId &&
      (other.pendingUrl || other.url) === url &&
      (!(arrivals.has(other.id) || opening[other.id]) ||
        (created[other.id] !== undefined && created[other.id] < created[tab.id])))
    .sort((a, b) => (created[a.id] ?? 0) - (created[b.id] ?? 0) || a.index - b.index)[0];
  if (!existing) return false;

  await api.tabs.move(existing.id, { index: -1 });
  await api.tabs.update(existing.id, { active: true });
  // The user can navigate, pin, or move either tab while API calls are pending.
  // Recheck before closing anything, preserving the new tab if the match changed.
  const [current, retained] = await Promise.all([getTab(tab.id), getTab(existing.id)]);
  if (!current || !retained || current.pinned || retained.pinned ||
      current.windowId !== retained.windowId || current.incognito !== retained.incognito ||
      current.cookieStoreId !== retained.cookieStoreId ||
      (current.pendingUrl || current.url) !== url || (retained.pendingUrl || retained.url) !== url) {
    return false;
  }
  await api.tabs.remove(tab.id);
  // Refresh its eviction age without navigating or reloading it.
  await recordAge(existing.id);
  await finishOpening(existing.id);
  await finishOpening(tab.id);
  return true;
}

async function handleOpening(tabId) {
  const { opening = {} } = await ages.get("opening");
  if (!opening[tabId]) return;
  const tab = await getTab(tabId);
  if (!tab) {
    await finishOpening(tabId);
    return;
  }
  const config = await getReuse();
  const expired = opening[tabId].expiresAt <= Date.now();
  if (config.mode !== "off" && !expired && await reuseTab(tab, config)) {
    await enforce(tab.windowId);
    return;
  }
  // Keep watching the initial navigation for redirects, including Firefox's
  // transient about:blank. Ordinary later navigations never trigger reuse.
  if (config.mode === "off" || tab.pinned || expired ||
      (!tab.pendingUrl && tab.status === "complete" && !BLANK.test(tab.url || ""))) {
    await finishOpening(tabId);
  }
  await enforce(tab.windowId);
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
  const { opening = {} } = await ages.get("opening");
  // Never evict the potential retained tab while a new URL is unresolved.
  if (counted.some((tab) => arrivals.has(tab.id) || opening[tab.id]?.expiresAt > Date.now())) return;
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

api.tabs.onCreated.addListener((tab) => {
  arrivals.add(tab.id);
  return enqueue(async () => {
    await recordAge(tab.id);
    const config = await getReuse();
    if (config.mode === "off" || tab.pinned || tab.url?.startsWith(NTAB_PAGE)) {
      arrivals.delete(tab.id);
      await enforce(tab.windowId);
      return;
    }
    const { opening = {} } = await ages.get("opening");
    opening[tab.id] = { windowId: tab.windowId, expiresAt: Date.now() + OPENING_TIMEOUT_MS };
    await ages.set({ opening });
    scheduleOpening(tab.id, opening[tab.id]);
    await handleOpening(tab.id);
  });
});

// Unpinning a tab or moving one between windows can push a window over N.
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!("url" in change || "status" in change || "pinned" in change)) return;
  return enqueue(async () => {
    await handleOpening(tabId);
    if ("pinned" in change) await enforce(tab.windowId);
  });
});
api.tabs.onAttached.addListener((tabId, { newWindowId }) => enqueue(async () => {
  const { opening = {} } = await ages.get("opening");
  if (opening[tabId]) {
    const oldWindowId = opening[tabId].windowId;
    opening[tabId].windowId = newWindowId;
    await ages.set({ opening });
    scheduleOpening(tabId, opening[tabId]);
    await enforce(oldWindowId);
  }
  await enforce(newWindowId);
}));

api.tabs.onRemoved.addListener((tabId, info) => enqueue(async () => {
  await finishOpening(tabId);
  await forgetAge(tabId);
  if (!info.isWindowClosing) await enforce(info.windowId);
}));

// Lowering N in the options page applies immediately.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.n || changes.reuseMode)) return;
  enqueue(async () => {
    if ((await getReuse()).mode === "off") {
      const { opening = {} } = await ages.get("opening");
      for (const id of Object.keys(opening)) await finishOpening(Number(id));
    }
    for (const w of await api.windows.getAll()) await enforce(w.id);
  });
});

// MV3 workers can restart mid-navigation. Restore the bounded waits from
// session storage, and clear records for tabs that disappeared meanwhile.
enqueue(async () => {
  const { opening = {} } = await ages.get("opening");
  for (const [id, entry] of Object.entries(opening)) {
    const tabId = Number(id);
    const tab = await getTab(tabId);
    if (!tab) {
      await finishOpening(tabId);
    } else {
      if (entry.windowId !== tab.windowId) {
        entry.windowId = tab.windowId;
        const current = (await ages.get("opening")).opening || {};
        if (current[tabId]) {
          current[tabId].windowId = tab.windowId;
          await ages.set({ opening: current });
        }
      }
      scheduleOpening(tabId, entry);
      await handleOpening(tabId);
    }
  }
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
