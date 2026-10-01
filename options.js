const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_N = 10;
const input = document.getElementById("n");
const status = document.getElementById("status");
const mode = document.getElementById("reuse-mode");
const rules = document.getElementById("reuse-rules");
let statusTimer;

function updateRulesState() {
  rules.disabled = mode.value !== "rules";
  rules.setCustomValidity("");
}

mode.addEventListener("change", updateRulesState);
rules.addEventListener("input", () => rules.setCustomValidity(""));

api.storage.local.get(["n", "reuseMode", "reuseRules"]).then((value) => {
  const { n } = value;
  input.value = Number.isInteger(n) && n >= 1 ? n : DEFAULT_N;
  mode.value = NTabReuse.settings(value).mode;
  rules.value = Array.isArray(value.reuseRules) ? value.reuseRules.join("\n") : "";
  updateRulesState();
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < 1) return;
  let reuseRules;
  try {
    reuseRules = NTabReuse.parseRules(rules.value);
  } catch (err) {
    if (rules.disabled) {
      // Turning reuse off (or choosing All URLs) must not be blocked by an
      // unfinished rule. Keep the draft so it can be corrected later.
      reuseRules = rules.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } else {
      clearTimeout(statusTimer);
      status.textContent = err.message;
      rules.setCustomValidity(err.message);
      rules.reportValidity();
      return;
    }
  }
  try {
    await api.storage.local.set({ n, reuseMode: mode.value, reuseRules });
    clearTimeout(statusTimer);
    status.textContent = "Saved";
    statusTimer = setTimeout(() => (status.textContent = ""), 1500);
  } catch (err) {
    status.textContent = `Couldn't save: ${err.message}`;
  }
});
