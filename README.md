# NTab - Maintain N Tabs, Shunt the Oldest to NTab

NTab is a browser extension (for both Chrome and Firefox) which allows you to set _n_ - the maximum number of tabs allowed to be open at once in a single browser window. When a tab is opened in excess of this number, the oldest inactive tab is sent to NTab - a OneTab-style list of unique pages.

Pinned tabs are omitted from counting towards _n_.

The options page also offers **Reuse existing tabs**: Off (the default), Only
matching URLs, or All URLs. Reopening an eligible HTTP(S) page moves the existing
tab to the far right, activates it, and closes the new tab. Its page state is
preserved and it becomes newest for tab-limit eviction. Reuse stays within the
same window, private-browsing context, and Firefox container, and excludes pinned
tabs. Changing settings does not sweep existing duplicates.

For Only matching URLs, enter full URLs or `*` patterns, one per line:

```text
https://example.com/dashboard
https://github.com/*
https://*.example.org/*
```

Rules select eligible pages; two tabs are duplicates only when their full URLs
match, including query strings and fragments. Host wildcards cannot match path
characters; `*.example.org` matches subdomains, so add `example.org` separately
to include the bare domain. An empty list matches nothing.

Reuse watches only a new tab's initial navigation, including redirects, for up
to five seconds. During that interval the tab cap may temporarily be exceeded
so an existing duplicate isn't evicted before the destination is known. Later
navigations in established tabs are unaffected.

Run the automated checks with `node --test tests/*.test.cjs`.

Build local browser packages with `node scripts/build.cjs` (requires `zip`). Load
`dist/chrome` as an unpacked extension in Chrome, or load
`dist/firefox/manifest.json` as a temporary add-on in Firefox. The build also
creates a versioned Chrome ZIP and unsigned Firefox XPI for release uploads.
Reload the extension after rebuilding. Generated packages stay in the ignored
`dist/` directory.
