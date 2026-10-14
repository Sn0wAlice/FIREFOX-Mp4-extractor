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

  // Inline scripts rarely change once inserted, but some pages carry megabytes
  // of JSON in them and mutate the DOM constantly, so each one is matched once.
  const scriptCache = new WeakMap();
  function scriptUrls(script) {
    let urls = scriptCache.get(script);
    if (!urls) {
      urls = (script.textContent || "").match(MEDIA_REGEX) || [];
      scriptCache.set(script, urls);
    }
    return urls;
  }

  let usesMediaSource = false;
  // Deep scan walks inline scripts, JSON-LD and same-origin iframes. It finds
  // more, and costs more on heavy pages, so it can be turned off.
  let deepScan = true;
  let detectImages = true;
  let minImageSize = 150;
  function readOptions(o) {
    deepScan = !o || o.deepScan !== false;
    detectImages = !o || o.detectImages !== false;
    minImageSize = o && Number.isFinite(o.minImageSize) ? o.minImageSize : 150;
  }
  browser.storage.local.get("options").then((r) => readOptions(r.options)).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.options) readOptions(changes.options.newValue);
  });

  // ── Images ──
  // A board or gallery shows a small thumbnail and keeps the real picture one
  // click away. The thumbnail is never what the user wants, so for every <img>
  // the full-size version is looked for first and the thumbnail is dropped
  // when one is found.

  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|jxl)(\?|#|$)/i;
  // Attributes sites use to point at the full-size picture (lightbox, zoom,
  // WordPress attachments, lazy loaders).
  const FULL_ATTRS = [
    "data-full", "data-full-url", "data-fullsrc", "data-full-src", "data-original",
    "data-orig-file", "data-orig-src", "data-large-file", "data-large", "data-zoom-image",
    "data-zoom-src", "data-hires", "data-highres", "data-big", "data-image-full", "data-lightbox-src"
  ];
  const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-lazy", "data-url"];

  // URL rules of large image hosts whose thumbnails are a fixed rewrite of
  // the original. Only rules known to be exact live here: a guessed URL
  // that does not exist would replace a working thumbnail with nothing.
  function knownOriginal(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "pbs.twimg.com" && u.searchParams.has("name")) {
        u.searchParams.set("name", "orig");
        return u.href;
      }
      if (u.hostname === "upload.wikimedia.org" && u.pathname.includes("/thumb/")) {
        // /wikipedia/commons/thumb/a/ab/File.jpg/220px-File.jpg
        const m = u.pathname.match(/^(.*)\/thumb(\/.+)\/[^/]+$/);
        if (m) return u.origin + m[1] + m[2];
      }
      if (u.hostname === "preview.redd.it") {
        return "https://i.redd.it" + u.pathname;
      }
      // Imgur: a 7-character id plus a size letter (s, b, t, m, l, h).
      if (u.hostname === "i.imgur.com") {
        const m = u.pathname.match(/^\/([A-Za-z0-9]{7})[sbtmlh](\.[a-z]+)$/);
        if (m) return u.origin + "/" + m[1] + m[2];
      }
      // WordPress keeps the uploaded original next to its resized copies
      // (photo-300x200.jpg). Limited to its uploads folder: elsewhere a
      // -WxH suffix can be part of the real name.
      if (u.pathname.includes("/wp-content/uploads/")) {
        const stripped = u.pathname.replace(/-\d{2,5}x\d{2,5}(\.[a-z]+)$/i, "$1");
        if (stripped !== u.pathname) return u.origin + stripped;
      }
    } catch {}
    return null;
  }

  // Largest candidate of a srcset, by width descriptor or density.
  function largestFromSrcset(srcset) {
    let best = null, bestScore = 0;
    for (const part of (srcset || "").split(/,\s+/)) {
      const [url, desc = "1x"] = part.trim().split(/\s+/);
      if (!url) continue;
      const score = parseFloat(desc) * (desc.endsWith("w") ? 1 : 1000);
      if (score > bestScore) { best = url; bestScore = score; }
    }
    return best;
  }

  // Some hosts serve pictures from extensionless URLs (?format=jpg); the
  // saved file still needs one.
  function imageFilename(url) {
    const name = getFilename(url);
    if (/\.[a-z0-9]{3,4}$/i.test(name)) return name;
    let ext = "jpg";
    try { ext = new URL(url).searchParams.get("format") || ext; } catch {}
    return name + "." + ext;
  }

  function attrUrl(el, names) {
    for (const name of names) {
      const v = el && el.getAttribute(name);
      if (v && !v.startsWith("data:")) return v;
    }
    return null;
  }

  // Standard ad slot sizes (IAB) plus 4chan's 300x100 board banners, and
  // folders sites keep their banners in. A picture matching them is flagged;
  // the background hides it (and counts it) unless ads are shown.
  const AD_SIZES = new Set(["728x90", "970x90", "970x250", "468x60", "234x60", "320x50", "320x100",
    "300x250", "336x280", "300x600", "160x600", "120x600", "300x100", "250x250", "200x200"]);
  const AD_IMAGE_PATHS = /\/(contest_banners|banners?|ads?|adserver|sponsors?|promo)\//i;

  function looksLikeAd(url, w, h) {
    if (w && h && (AD_SIZES.has(w + "x" + h) || (w >= 5 * h && h <= 120))) return true;
    try { return AD_IMAGE_PATHS.test(new URL(url).pathname); } catch { return false; }
  }

  const MAX_STYLED = 5000;

  function scanImages(add, found) {
    const thumbs = new Set();
    const abs = (u) => { if (!u) return null; try { return new URL(u, location.href).href; } catch { return null; } };

    document.querySelectorAll("img").forEach((img) => {
      const shown = img.currentSrc || img.src;
      const shownOk = shown && /^https?:/i.test(shown);
      const link = img.closest("a[href]");

      // A thumbnail linking to a video: the video is the media, not the picture.
      if (link && MEDIA_REGEX.test(link.href)) {
        MEDIA_REGEX.lastIndex = 0;
        if (shownOk) thumbs.add(shown);
        return;
      }
      MEDIA_REGEX.lastIndex = 0;

      const full = abs(
        (link && IMAGE_EXT.test(link.href) && link.href) ||
        attrUrl(img, FULL_ATTRS) || attrUrl(link, FULL_ATTRS) ||
        (shownOk && knownOriginal(shown)) ||
        largestFromSrcset(img.getAttribute("srcset") || img.closest("picture")?.querySelector("source")?.getAttribute("srcset"))
      );

      if (full && full !== shown) {
        add(full, "image-full", { type: "image", filename: imageFilename(full), thumbUrl: shownOk ? shown : null });
        if (shownOk) thumbs.add(shown);
        return;
      }

      // No bigger version: the picture as shown, or its lazy source while it
      // still shows a placeholder (its size is unknown, lazy loading is used
      // for content pictures, not icons).
      if (shownOk) {
        // Size unknown until loaded; the load listener rescans then.
        if (!img.complete || !img.naturalWidth) return;
        // Icons, avatars, emoji, tracking pixels.
        if (Math.max(img.naturalWidth, img.naturalHeight) < minImageSize) return;
      }
      const own = shownOk ? shown : abs(attrUrl(img, LAZY_ATTRS));
      if (!own) return;
      add(own, "image", {
        type: "image",
        adLike: looksLikeAd(own, img.naturalWidth, img.naturalHeight),
        filename: imageFilename(own),
        // With srcset, naturalWidth is scaled by the chosen density.
        ...(img.naturalWidth && !img.srcset ? { resolution: { width: img.naturalWidth, height: img.naturalHeight } } : {})
      });
    });

    // CSS background-image: galleries and cards often draw their picture
    // this way. Same rule: a full-size link or attribute wins over the
    // background, which is otherwise kept when it is drawn big enough.
    const background = (el, css) => {
      const m = (css || "").match(/url\(["']?([^"')]+)["']?\)/);
      const shown = m && abs(m[1]);
      if (!shown || !/^https?:/i.test(shown)) return;
      const link = el.closest("a[href]");
      const full = abs(
        (link && IMAGE_EXT.test(link.href) && link.href) ||
        attrUrl(el, FULL_ATTRS) || attrUrl(link, FULL_ATTRS) || knownOriginal(shown)
      );
      if (full && full !== shown) {
        add(full, "image-full", { type: "image", filename: imageFilename(full), thumbUrl: shown });
        thumbs.add(shown);
        return;
      }
      const rect = el.getBoundingClientRect();
      if (Math.max(rect.width, rect.height) < minImageSize) return;
      add(shown, "image", { type: "image", filename: imageFilename(shown), adLike: looksLikeAd(shown, Math.round(rect.width), Math.round(rect.height)) });
    };
    const inline = document.querySelectorAll('[style*="url("]');
    inline.forEach((el) => background(el, el.style.backgroundImage));

    // Backgrounds set from stylesheets need the computed style of every
    // element, so only with deep scan on.
    // ponytail: capped at the first MAX_STYLED elements of huge pages.
    if (deepScan) {
      const done = new Set(inline);
      const all = document.body ? document.body.getElementsByTagName("*") : [];
      for (let i = 0; i < Math.min(all.length, MAX_STYLED); i++) {
        if (done.has(all[i])) continue;
        const css = getComputedStyle(all[i]).backgroundImage;
        if (css && css !== "none") background(all[i], css);
      }
    }

    // The picture the page declares as its own (article, product, post).
    // Often the only full-size reference on pages that lazy-load everything.
    const declared = document.querySelector('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]');
    const declaredUrl = declared && abs(declared.getAttribute("content"));
    if (declaredUrl) {
      const width = parseInt(document.querySelector('meta[property="og:image:width"]')?.getAttribute("content"), 10);
      if (!(width < minImageSize)) {
        add(declaredUrl, "image-meta", { type: "image", filename: imageFilename(declaredUrl) });
      }
    }

    // Plain links straight to a picture ("view full size", "original").
    document.querySelectorAll("a[href]").forEach((a) => {
      if (IMAGE_EXT.test(a.href) && !a.querySelector("img")) add(a.href, "image-link", { type: "image", filename: imageFilename(a.href) });
    });

    // A thumbnail may also have been added by another <img> using it.
    for (const url of thumbs) {
      const entry = found.get(url);
      if (entry && entry.type === "image" && entry.source !== "image-full") found.delete(url);
    }
  }

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
      scriptUrls(script).forEach((url) => add(url, "script"));
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
          scriptUrls(script).forEach((url) => add(url, "iframe-script"));
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

    // 11. Images, with the full-size version preferred over the thumbnail
    if (detectImages) scanImages(add, found);

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
  let mutationTimer = null;

  function runScan() {
    mutationTimer = null;
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
    // Rejects when the extension was reloaded under a still-open page.
    browser.runtime.sendMessage({ action: "media_links", links, pageTitle, usesMediaSource }).catch(() => {});
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

  // Throttled rather than debounced: on a page that never stops mutating
  // (tickers, live chats) a debounce would never fire at all.
  const observer = new MutationObserver(() => {
    if (!mutationTimer) mutationTimer = setTimeout(runScan, 1500);
  });
  // A picture's size is only known once loaded, which no DOM mutation reports.
  document.addEventListener("load", (e) => {
    if (detectImages && e.target.tagName === "IMG" && !mutationTimer) mutationTimer = setTimeout(runScan, 1500);
  }, true);

  // documentElement, not body: XML, SVG and some viewer documents have no body.
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
})();
