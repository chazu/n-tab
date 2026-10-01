const { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const files = ["background.js", "reuse.js", "options.js", "options.html", "ntab.js", "ntab.html", "style.css"];

for (const browser of ["chrome", "firefox"]) {
  const dir = join(root, "dist", browser);
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(join(root, file), join(dir, file));
  const variant = structuredClone(manifest);
  if (browser === "chrome") {
    delete variant.background.scripts;
    delete variant.browser_specific_settings;
  } else {
    delete variant.background.service_worker;
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(variant, null, 2) + "\n");
}

const temp = mkdtempSync(join(tmpdir(), "ntab-build-"));
const archives = [];
try {
  for (const browser of ["chrome", "firefox"]) {
    const extension = browser === "chrome" ? "zip" : "xpi";
    const name = `ntab-${browser}-v${manifest.version}.${extension}`;
    execFileSync("zip", ["-q", join(temp, name), "manifest.json", ...files], { cwd: join(root, "dist", browser) });
    copyFileSync(join(temp, name), join(root, "dist", name));
    archives.push(`dist/${name}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`Built dist/chrome, dist/firefox, ${archives.join(", ")}`);
