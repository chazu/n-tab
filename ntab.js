const api = globalThis.browser ?? globalThis.chrome;

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const count = document.getElementById("count");

async function getSaved() {
  const { saved = {} } = await api.storage.local.get("saved");
  return saved;
}

async function remove(urls) {
  const saved = await getSaved();
  for (const url of urls) delete saved[url];
  await api.storage.local.set({ saved });
}

function row(item) {
  const li = document.createElement("li");

  const icon = document.createElement("img");
  icon.className = "favicon";
  icon.alt = "";
  if (item.favIconUrl) icon.src = item.favIconUrl;

  const link = document.createElement("a");
  link.href = item.url;
  link.textContent = item.title;
  link.title = item.url;
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    await api.tabs.create({ url: item.url });
    await remove([item.url]);
  });

  const host = document.createElement("span");
  host.className = "host";
  try {
    host.textContent = new URL(item.url).hostname;
  } catch {
    host.textContent = "";
  }

  const when = document.createElement("span");
  when.className = "when";
  when.textContent = new Date(item.savedAt).toLocaleString();

  const del = document.createElement("button");
  del.textContent = "Delete";
  del.addEventListener("click", () => remove([item.url]));

  li.append(icon, link, host, when, del);
  return li;
}

async function render() {
  const items = Object.values(await getSaved()).sort((a, b) => b.savedAt - a.savedAt);
  list.replaceChildren(...items.map(row));
  empty.hidden = items.length > 0;
  count.textContent = items.length ? `${items.length} saved` : "";
}

document.getElementById("restore-all").addEventListener("click", async () => {
  const items = Object.values(await getSaved());
  if (!items.length) return;
  // Restore in a background-less way: create tabs, then clear the list.
  for (const item of items) await api.tabs.create({ url: item.url, active: false });
  await remove(items.map((i) => i.url));
});

document.getElementById("clear-all").addEventListener("click", async () => {
  if (confirm("Delete all saved tabs?")) await api.storage.local.set({ saved: {} });
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.saved) render();
});

render();
