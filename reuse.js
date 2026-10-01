// Shared by the background worker and options page. Rules select eligible
// pages; they never make two different URLs equivalent.
globalThis.NTabReuse = (() => {
  const modes = new Set(["off", "rules", "all"]);
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

  function normalizeRule(rule) {
    if (typeof rule !== "string" || /\s/.test(rule)) {
      throw new Error("Use a full URL without spaces.");
    }
    if (!/^https?:\/\//i.test(rule)) {
      throw new Error("Use a full http:// or https:// URL or pattern.");
    }
    let url;
    try {
      url = new URL(rule);
    } catch {
      throw new Error("Use a full http:// or https:// URL or pattern.");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("Use an http:// or https:// URL without login credentials.");
    }
    return url.href;
  }

  function parseRules(text) {
    const rules = [];
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line) continue;
      try {
        rules.push(normalizeRule(line));
      } catch (err) {
        throw new Error(`Line ${index + 1}: ${err.message}`);
      }
    }
    return [...new Set(rules)];
  }

  function compileRules(rules) {
    return rules.map((rule) => {
      const url = new URL(normalizeRule(rule));
      // A host wildcard cannot consume a path, query, or port delimiter.
      const host = escape(url.host).replace(/\*/g, "[^/?#:]*");
      const path = escape(url.pathname + url.search + url.hash).replace(/\*/g, ".*");
      return new RegExp(`^${escape(url.protocol)}//${host}${path}$`);
    });
  }

  function settings(value) {
    let rules = [];
    try {
      if (Array.isArray(value.reuseRules)) rules = compileRules(value.reuseRules);
    } catch {
      // Invalid stored rules fail closed.
    }
    return { mode: modes.has(value.reuseMode) ? value.reuseMode : "off", rules };
  }

  function eligible(url, config) {
    return /^https?:\/\//i.test(url) &&
      (config.mode === "all" ||
        (config.mode === "rules" && config.rules.some((rule) => rule.test(url))));
  }

  return { parseRules, compileRules, settings, eligible };
})();
