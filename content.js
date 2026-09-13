// content.js — Media Extractor Pro v4.0
// Intelligent DOM scanning + page title + resolution/duration detection

(() => {
  const MEDIA_REGEX = /https?:\/\/[^\s"'<>]+\.(mp4|webm|mkv|m3u8|mpd|mp3|m4a|ogg|wav|flac|avi|mov|ts)(\?[^\s"'<>]*)?/gi;

  function getFilename(url) {
    try {
      let parts = url.split("?")[0].split("/").filter(Boolean);
      return parts.length ? decodeURIComponent(parts[parts.length - 1]) : "media_file";
    } catch { return "media_file"; }
  }

  function getDomain(url) {
    try { return new URL(url).hostname; } catch { return "unknown"; }
  }

  function getType(url) {
    const ext = url.split("?")[0].split(".").pop().toLowerCase();
    if (["mp4", "webm", "mkv", "avi", "mov", "ts"].includes(ext)) return "video";
    if (["mp3", "m4a", "ogg", "wav", "flac"].includes(ext)) return "audio";
    if (["m3u8", "mpd"].includes(ext)) return "stream";
    return "video";
  }

  function getPageTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content;
    return document.title || "";
  }

  let usesMediaSource = false;
  // Deep scan walks inline scripts, JSON-LD and same-origin iframes. It finds
  // more, and costs more on heavy pages, so it can be turned off.
  let deepScan = true;
  browser.storage.local.get("options").then((r) => {
    deepScan = !r.options || r.options.deepScan !== false;
  }).catch(() => {});

  function scanPage() {
    const found = new Map();

    function add(url, source, extra) {
      try {
        const resolved = new URL(url, document.location.href).href;
        // A blob: URL is a handle on a buffer the page filled through Media
        // Source Extensions. Nothing can fetch it, so it only pollutes the
        // list — the real stream shows up in the network layer instead.
        if (!/^https?:\/\//i.test(resolved)) {
          if (resolved.startsWith("blob:")) usesMediaSource = true;
          return;
        }
        if (!found.has(resolved)) {
          found.set(resolved, {
            url: resolved,
            domain: getDomain(resolved),
            filename: getFilename(resolved),
            type: getType(resolved),
            source,
            ...(extra || {})
          });
        } else if (extra) {
          Object.assign(found.get(resolved), extra);
        }
      } catch {}
    }

    // 1. <a> tags
    document.querySelectorAll("a[href]").forEach((a) => {
      if (MEDIA_REGEX.test(a.href)) add(a.href, "link");
      MEDIA_REGEX.lastIndex = 0;
    });

    // 2. <video> elements — read resolution & duration
    document.querySelectorAll("video").forEach((v) => {
      const extra = {};
      if (v.videoWidth && v.videoHeight) {
        extra.resolution = { width: v.videoWidth, height: v.videoHeight };
      }
      if (v.duration && isFinite(v.duration)) {
        extra.duration = v.duration;
      }
      if (v.src) add(v.src, "video", extra);
      if (v.currentSrc) add(v.currentSrc, "video", extra);
    });

    // 3. <source> elements
    document.querySelectorAll("source").forEach((s) => {
      if (s.src) {
        const parent = s.closest("video, audio");
        const extra = {};
        if (parent) {
          if (parent.videoWidth && parent.videoHeight) {
            extra.resolution = { width: parent.videoWidth, height: parent.videoHeight };
          }
          if (parent.duration && isFinite(parent.duration)) {
            extra.duration = parent.duration;
          }
        }
        add(s.src, "source", extra);
      }
    });

    // 4. <audio> elements
    document.querySelectorAll("audio").forEach((a) => {
      const extra = {};
      if (a.duration && isFinite(a.duration)) {
        extra.duration = a.duration;
      }
      if (a.src) add(a.src, "audio", extra);
      if (a.currentSrc) add(a.currentSrc, "audio", extra);
    });

    // 5. <embed> and <object>
    document.querySelectorAll("embed[src], object[data]").forEach((el) => {
      const url = el.src || el.getAttribute("data");
      if (url && MEDIA_REGEX.test(url)) add(url, "embed");
      MEDIA_REGEX.lastIndex = 0;
    });

    // 6. data-* attributes
    document.querySelectorAll("[data-src], [data-video], [data-url], [data-href], [data-video-url], [data-video-src], [data-media], [data-file]").forEach((el) => {
      ["data-src", "data-video", "data-url", "data-href", "data-video-url", "data-video-src", "data-media", "data-file"].forEach((attr) => {
        const val = el.getAttribute(attr);
        if (val && MEDIA_REGEX.test(val)) add(val, "data-attr");
        MEDIA_REGEX.lastIndex = 0;
      });
    });

    // 7. Inline scripts
    if (deepScan) document.querySelectorAll("script:not([src])").forEach((script) => {
      const text = script.textContent;
      if (!text) return;
      MEDIA_REGEX.lastIndex = 0;
      let match;
      while ((match = MEDIA_REGEX.exec(text)) !== null) {
        add(match[0], "script");
      }
    });

    // 8. Same-origin iframes
    if (deepScan) document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelectorAll("video, audio").forEach((el) => {
          if (el.src) add(el.src, "iframe");
          if (el.currentSrc) add(el.currentSrc, "iframe");
        });
        doc.querySelectorAll("source").forEach((s) => {
          if (s.src) add(s.src, "iframe");
        });
        doc.querySelectorAll("script:not([src])").forEach((script) => {
          const text = script.textContent;
          if (!text) return;
          MEDIA_REGEX.lastIndex = 0;
          let m;
          while ((m = MEDIA_REGEX.exec(text)) !== null) {
            add(m[0], "iframe-script");
          }
        });
      } catch {}
    });

    // 9. JSON-LD
    if (deepScan) document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const json = JSON.parse(script.textContent);
        extractUrlsFromJson(json).forEach((url) => add(url, "json-ld"));
      } catch {}
    });

    // 10. Meta tags
    document.querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"], meta[name="twitter:player:stream"]').forEach((meta) => {
      const url = meta.getAttribute("content");
      if (url) add(url, "meta");
    });

    return Array.from(found.values());
  }

  function extractUrlsFromJson(obj) {
    const urls = [];
    if (!obj || typeof obj !== "object") return urls;
    if (Array.isArray(obj)) {
      obj.forEach((item) => urls.push(...extractUrlsFromJson(item)));
    } else {
      for (const [, val] of Object.entries(obj)) {
        if (typeof val === "string" && MEDIA_REGEX.test(val)) {
          urls.push(val);
          MEDIA_REGEX.lastIndex = 0;
        } else if (typeof val === "object") {
          urls.push(...extractUrlsFromJson(val));
        }
      }
    }
    return urls;
  }

  let lastFoundUrls = new Set();

  function runScan() {
    usesMediaSource = false;
    const links = scanPage();
    const pageTitle = getPageTitle();

    // Worth reporting even with nothing found: it tells the popup the page
    // streams through MSE, so the user knows to let the video play.
    if (links.length === 0 && !usesMediaSource) return;

    const currentUrls = new Set(links.map((l) => l.url));
    const hasNew = links.some((l) => !lastFoundUrls.has(l.url));
    if (links.length > 0 && !hasNew && currentUrls.size === lastFoundUrls.size) return;

    lastFoundUrls = currentUrls;
    browser.runtime.sendMessage({ action: "media_links", links, pageTitle, usesMediaSource });
  }

  runScan();

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "rescan" || message.action === "forget") {
      lastFoundUrls.clear();
      if (message.action === "rescan") runScan();
    }
  });

  // A single page application swaps videos without ever reloading, so the
  // scan has to follow its navigations too.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    lastFoundUrls.clear();
    runScan();
  }, 1000);

  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(runScan, 1500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
