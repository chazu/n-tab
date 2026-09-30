const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_N = 10;
const input = document.getElementById("n");
const status = document.getElementById("status");

api.storage.local.get("n").then(({ n }) => {
  input.value = Number.isInteger(n) && n >= 1 ? n : DEFAULT_N;
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = parseInt(input.value, 10);
  if (!Number.isInteger(n) || n < 1) return;
  await api.storage.local.set({ n });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 1500);
});
