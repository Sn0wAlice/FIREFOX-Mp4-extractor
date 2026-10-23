// popup.js — Media Extractor Pro v4.0
// Smart dedup, download queue, hover preview, size filter, source badges,
// watch mode, batch rename, best quality, duration/resolution display

const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

let allMedia = [];
let filteredMedia = [];
let groupedMedia = [];
let currentFilter = "all";
let currentSort = "name";
let selectedUrls = new Set();
let downloadStates = {};
let pageTitle = "";
let currentTheme = "dark";
let options = {};
let watchMode = false;
let activeTabId = null;
let detached = false;
// Every message names its tab, so a detached window keeps talking about the
// page it was opened from.
const send = (message) => browser.runtime.sendMessage({ tabId: activeTabId, ...message });
let sizeFilterMB = 0;
let metadataCache = new Map(); // url -> { resolution, duration }

// ── Init ──

document.addEventListener("DOMContentLoaded", async () => {
  // Load theme
  const stored = await browser.storage.local.get("theme");
  currentTheme = stored.theme || "dark";
  if (currentTheme === "auto") {
    currentTheme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  applyTheme();

  // Load options
  const optResult = await browser.storage.local.get("options");
  options = optResult.options || {};
  // Reopen on the category tab used last, whatever browser tab this is.
  const { lastFilter, lastSearch } = await browser.storage.local.get(["lastFilter", "lastSearch"]);
  document.getElementById("searchInput").value = lastSearch || "";
  const lastChip = lastFilter && document.querySelector(`.chip[data-filter="${CSS.escape(lastFilter)}"]`);
  if (lastChip) {
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === lastChip));
    currentFilter = lastFilter;
  }
  applyDefaultSort();

  // Detached into its own window: the tab is in the URL, the window's own
  // active tab is this page.
  detached = new URLSearchParams(location.search).has("tab");
  activeTabId = detached
    ? Number(new URLSearchParams(location.search).get("tab"))
    : (await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0]?.id ?? null;
  document.body.classList.toggle("detached", detached);

  // Request media from background
  // Rejects when the background is not up yet; the popup must still wire its
  // buttons below rather than die here.
  let response = null;
  try { response = await send({ action: "get_media" }); } catch {}
  if (response && response.media) {
    allMedia = deduplicateMedia(response.media);
    pageTitle = response.pageTitle || "";
    updateNotice(response);
    watchMode = response.watchMode || false;
    updateWatchButton();
    updateQueueBar(response.queueLength || 0, response.activeDownloads || 0);
    renderZipStatus(response.zipStatus);
    renderPlaylistStatus(response.playlist);
    render();
    probeMetadata(allMedia);
  } else {
    showEmpty();
  }

  // Trigger rescan
  send({ action: "rescan" }).catch(() => {});

  // Listen for messages
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "media_links" || message.action === "new_media" || message.action === "mse_update") {
      send({ action: "get_media" }).then((resp) => {
        if (resp && resp.media) {
          const newMedia = deduplicateMedia(resp.media);
          const oldUrls = new Set(allMedia.map((m) => m.url));
          // An MSE capture keeps its URL while it grows, so its progress
          // counts as a change too.
          const changed = message.action === "mse_update" || newMedia.length !== allMedia.length || newMedia.some((m) => !oldUrls.has(m.url));
          if (!changed) return;
          updateNotice(resp);
          allMedia = newMedia;
          if (resp.pageTitle) pageTitle = resp.pageTitle;
          render();
          probeMetadata(allMedia);
        }
      });
    }
    if (message.action === "hls_progress") {
      if (message.progress < 0) {
        downloadStates[message.url] = { state: "downloading", progress: 95, label: message.label || "Remuxing..." };
      } else {
        downloadStates[message.url] = { state: "downloading", progress: message.progress, label: message.label };
      }
      renderDownloadState(message.url);
    }
    if (message.action === "queue_update") {
      updateQueueBar(message.queueLength, message.activeDownloads);
    }
    if (message.action === "dl_update") {
      handleDownloadUpdate(message);
    }
    if (message.action === "zip_progress") renderZipStatus(message.status);
    if (message.action === "playlist_progress" && message.tabId === activeTabId) renderPlaylistStatus(message.status);
    if (message.action === "playlist_done" && message.tabId === activeTabId) {
      // Dev builds keep the page list on screen to read it after the run.
      if (document.getElementById("playlistDebug").hidden) renderPlaylistStatus(null);
      else {
        document.getElementById("playlistBtn").classList.remove("active");
        document.getElementById("playlistLabel").textContent += message.cancelled ? " — stopped" : " — done";
      }
      showToast((message.cancelled ? "Playlist stopped" : "Playlist done") + ` — ${message.found} media added`);
    }
    if (message.action === "zip_done") {
      if (message.cancelled) {
        showToast("Zip stopped");
        (message.urls || []).forEach((url) => {
          if (downloadStates[url]?.state !== "done") { delete downloadStates[url]; renderDownloadState(url); }
        });
      } else if (message.error) showToast("Zip: " + message.error);
      else showToast(`Zip ready: ${message.count} files` + (message.failed ? ` (${message.failed} failed)` : ""));
    }
    if (message.action === "watch_new_media") {
      // The background already queued it; only reflect that here.
      if (message.media) {
        showToast(`Watch: auto-downloading ${message.media.filename}`);
        downloadStates[message.media.url] = { state: "queued", progress: 0 };
        renderDownloadState(message.media.url);
      }
    }
  });

  // Playlist mode: crawl the same-site links of the page
  // Child-only is on by default; the base path is the current page's unless
  // the user typed one, and the last one typed is kept.
  const childOnlyBox = document.getElementById("playlistChildOnly");
  const baseInput = document.getElementById("playlistBase");
  browser.storage.local.get(["playlistChildOnly", "playlistBasePath"]).then((r) => {
    childOnlyBox.checked = r.playlistChildOnly !== false;
    baseInput.value = r.playlistBasePath || "";
    baseInput.disabled = !childOnlyBox.checked;
  });
  childOnlyBox.addEventListener("change", () => {
    baseInput.disabled = !childOnlyBox.checked;
    browser.storage.local.set({ playlistChildOnly: childOnlyBox.checked });
  });
  baseInput.addEventListener("input", () => browser.storage.local.set({ playlistBasePath: baseInput.value.trim() }));
  const asDir = (p) => (p.startsWith("/") ? p : "/" + p).replace(/\/?$/, "/");
  document.getElementById("playlistBtn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const tab = await browser.tabs.get(activeTabId).catch(() => null);
    let path = "";
    try { path = new URL(tab.url).pathname; } catch {}
    baseInput.placeholder = asDir(path);
    document.getElementById("playlistMenu").classList.toggle("show");
  });
  document.getElementById("playlistMenu").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => document.getElementById("playlistMenu").classList.remove("show"));
  document.getElementById("playlistStart").addEventListener("click", async () => {
    document.getElementById("playlistMenu").classList.remove("show");
    const basePath = childOnlyBox.checked ? asDir(baseInput.value.trim() || baseInput.placeholder || "/") : null;
    const resp = await send({ action: "playlist_start", basePath }).catch(() => null);
    if (!resp || resp.error) showToast("Playlist: " + (resp ? resp.error : "unavailable"));
    else if (!resp.count) showToast(basePath ? `Playlist: no link under ${basePath}` : "Playlist: no same-site link on this page");
    else showToast(`Playlist: scanning ${resp.count} pages in the background`);
  });
  document.getElementById("playlistCancel").addEventListener("click", () => {
    if (!document.getElementById("playlistBtn").classList.contains("active")) return renderPlaylistStatus(null);
    send({ action: "playlist_stop" }).catch(() => {});
  });

  // Firefox closes the popup as soon as it loses focus, which a download does
  // (downloads panel, "Save as"). A window of its own stays open.
  document.getElementById("detachBtn").addEventListener("click", async () => {
    if (activeTabId == null) return;
    await browser.windows.create({
      type: "popup", width: 600, height: 700,
      url: browser.runtime.getURL("popup.html?tab=" + activeTabId)
    });
    window.close();
  });

  // Stop the zip being built
  document.getElementById("zipCancel").addEventListener("click", () => {
    if (zipJobUrl) send({ action: "cancel_download", url: zipJobUrl }).catch(() => {});
  });

  // Search
  document.getElementById("searchInput").addEventListener("input", (e) => {
    browser.storage.local.set({ lastSearch: e.target.value }).catch(() => {});
    render();
  });

  // Filter chips
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      browser.storage.local.set({ lastFilter: currentFilter }).catch(() => {});
      applyDefaultSort();
      render();
    });
  });

  // Sort
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    currentSort = e.target.value;
    render();
  });

  // Size filter
  document.getElementById("sizeFilter").addEventListener("input", (e) => {
    sizeFilterMB = parseInt(e.target.value);
    const label = document.getElementById("sizeFilterLabel");
    if (sizeFilterMB === 0) {
      label.textContent = "0";
    } else if (sizeFilterMB < 1) {
      label.textContent = (sizeFilterMB * 1024).toFixed(0) + "K";
    } else {
      label.textContent = sizeFilterMB + "M";
    }
    render();
  });

  // Select all
  document.getElementById("selectAll").addEventListener("change", (e) => {
    if (e.target.checked) {
      filteredMedia.forEach((m) => selectedUrls.add(m.url));
    } else {
      selectedUrls.clear();
    }
    updateCheckboxes();
    updateFooter();
  });

  // Download selected
  document.getElementById("downloadSelected").addEventListener("click", () => {
    downloadBatch(filteredMedia.filter((m) => selectedUrls.has(m.url)));
  });

  // Download all
  document.getElementById("downloadAll").addEventListener("click", () => {
    downloadBatch(filteredMedia);
  });

  // Download best quality
  document.getElementById("downloadBest").addEventListener("click", () => {
    downloadBestQuality();
  });

  // Batch rename
  document.getElementById("batchRenameBtn").addEventListener("click", openBatchRename);
  document.getElementById("renameCancelBtn").addEventListener("click", () => {
    document.getElementById("renameModal").classList.remove("active");
  });
  document.getElementById("renameConfirmBtn").addEventListener("click", executeBatchRename);
  document.getElementById("renamePattern").addEventListener("input", (e) => {
    e.target.dataset.touched = "1";
    updateRenamePreview();
  });

  // Watch mode
  document.getElementById("watchBtn").addEventListener("click", async () => {
    const resp = await send({ action: "toggle_watch" });
    if (resp) {
      watchMode = resp.watchMode;
      updateWatchButton();
      showToast(watchMode ? "Watch mode ON — new media will auto-download" : "Watch mode OFF");
    }
  });

  // Clear everything this tab has collected. A single page application never
  // reloads, so without this the list keeps every video ever opened in it.
  document.getElementById("clearBtn").addEventListener("click", async () => {
    await send({ action: "clear_media" });
    allMedia = [];
    filteredMedia = [];
    selectedUrls.clear();
    downloadStates = {};
    metadataCache.clear();
    document.getElementById("noticeBar").classList.remove("visible");
    render();
    showToast("Panel cleared — play the video again to detect it");
  });

  // Rescan
  document.getElementById("rescanBtn").addEventListener("click", () => {
    const btn = document.getElementById("rescanBtn");
    btn.style.transition = "transform 0.4s";
    btn.style.transform = "rotate(360deg)";
    setTimeout(() => { btn.style.transform = ""; btn.style.transition = ""; }, 400);
    send({ action: "rescan" }).catch(() => {});
    setTimeout(() => {
      send({ action: "get_media" }).then((resp) => {
        if (resp && resp.media) {
          allMedia = deduplicateMedia(resp.media);
          if (resp.pageTitle) pageTitle = resp.pageTitle;
          render();
          probeMetadata(allMedia);
        }
      });
    }, 500);
  });

  // Options
  document.getElementById("optionsBtn").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
  });

  // Theme toggle
  document.getElementById("themeBtn").addEventListener("click", () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    browser.storage.local.set({ theme: currentTheme });
    applyTheme();
  });

  // Export button
  document.getElementById("exportBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("exportMenu").classList.toggle("show");
  });

  // Export options
  document.querySelectorAll(".export-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      exportMedia(opt.dataset.format);
      document.getElementById("exportMenu").classList.remove("show");
    });
  });

  // Close export menu on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".export-wrap")) {
      document.getElementById("exportMenu").classList.remove("show");
    }
  });

  // Hover preview setup
  setupHoverPreview();
});

// ── Theme ──

function applyTheme() {
  document.documentElement.className = currentTheme === "light" ? "light" : "";
  const btn = document.getElementById("themeBtn");
  btn.innerHTML = currentTheme === "light" ? "&#9790;" : "&#9788;";
}

// ── Watch mode ──

function updateWatchButton() {
  const btn = document.getElementById("watchBtn");
  btn.classList.toggle("active", watchMode);
  btn.title = watchMode ? "Watch mode ON — click to disable" : "Watch mode — auto-download new media";
}

// ── Queue bar ──

// Says out loud what was hidden and why, so nothing disappears silently.
function updateNotice(response) {
  const bar = document.getElementById("noticeBar");
  const parts = [];

  if (response.adsHidden > 0) {
    parts.push(`<b>${response.adsHidden}</b> advertising item${response.adsHidden > 1 ? "s" : ""} hidden`);
  }
  if (response.usesMediaSource || (response.media || []).some((m) => m.isMseCapture)) {
    parts.push("<b>MSE capture:</b> only the part of the video already played is saved. " +
      "To get the whole video, play it to the end without skipping (speed it up in the player if it allows). " +
      "Long videos take as long to capture and use a lot of memory (several GB for a film in HD).");
  }

  // One span: the bar is a flex row and would split <b> from its sentence.
  bar.innerHTML = `<span>${parts.join(" &middot; ")}</span>`;
  bar.classList.toggle("visible", parts.length > 0);
}

// "Zip — 3/6 files · dash.mp4" with the share of the whole batch done.
let zipJobUrl = null;

function renderZipStatus(status) {
  const bar = document.getElementById("zipBar");
  zipJobUrl = status ? status.jobUrl : null;
  bar.classList.toggle("visible", !!status);
  if (!status) return;
  const zipping = status.phase === "zipping";
  const pct = zipping ? 100 : Math.round(((status.done + status.fraction) / status.total) * 100);
  bar.classList.toggle("zipping", zipping);
  document.getElementById("zipLabel").textContent = zipping
    ? `Building zip (${status.done - status.failed} files)…`
    : `Zip — ${status.done}/${status.total} files` + (status.current ? ` · ${status.current}` : "") +
      (status.failed ? ` · ${status.failed} failed` : "");
  document.getElementById("zipPct").textContent = pct + "%";
  document.getElementById("zipFill").style.width = pct + "%";
}

function renderPlaylistStatus(status) {
  document.getElementById("playlistBar").classList.toggle("visible", !!status);
  document.getElementById("playlistBtn").classList.toggle("active", !!status);
  if (!status) return;
  const pct = Math.round((status.done / status.total) * 100);
  document.getElementById("playlistLabel").textContent = `Playlist — ${status.done}/${status.total} pages · ${status.found} media`;
  document.getElementById("playlistPct").textContent = pct + "%";
  document.getElementById("playlistFill").style.width = pct + "%";
  // Dev builds only: every page crawled, with its state.
  const debug = document.getElementById("playlistDebug");
  debug.hidden = !status.pages;
  if (status.pages) {
    debug.innerHTML = status.pages.map((p) =>
      `<div class="pl-${escapeHtml(p.state.split(":")[0])}" title="${escapeHtml(p.url)}">` +
      `<b>${escapeHtml(p.state)}${p.state === "done" ? " · " + p.found : ""}${p.secs != null ? " · " + p.secs + "s" : ""}</b> ${escapeHtml(p.url)}</div>` +
      (p.errors || []).map((e) => `<div class="pl-err" title="${escapeHtml(e)}">&nbsp;&nbsp;\u26a0 ${escapeHtml(e)}</div>`).join("")).join("");
  }
}

function updateQueueBar(queueLength, active) {
  const bar = document.getElementById("queueBar");
  if (queueLength === 0 && active === 0) {
    bar.classList.remove("visible");
    return;
  }
  bar.classList.add("visible");
  document.getElementById("queueCount").textContent = queueLength + active;
  document.getElementById("queueInfo").textContent = `(${active} active, ${queueLength} pending)`;
}

// ── Helpers ──

function deduplicateMedia(media) {
  const byFingerprint = new Map();
  media.forEach((m) => {
    // Without smart dedup, entries are only merged when their URL matches.
    const fp = options.smartDedup === false ? m.url : (m.fingerprint || m.url);
    if (!byFingerprint.has(fp)) {
      byFingerprint.set(fp, { ...m });
    } else {
      const existing = byFingerprint.get(fp);
      // Merge alt sources
      if (!existing.altSources) existing.altSources = [existing.source];
      if (!existing.altSources.includes(m.source)) existing.altSources.push(m.source);
      // Keep better data
      if (!existing.size && m.size) existing.size = m.size;
      if (!existing.quality && m.quality) existing.quality = m.quality;
      if (!existing.duration && m.duration) existing.duration = m.duration;
      if (!existing.resolution && m.resolution) existing.resolution = m.resolution;
      // Prefer network source
      if (m.source === "network" && existing.source === "dom") {
        existing.url = m.url;
        existing.source = "network";
        if (m.size) existing.size = m.size;
      }
    }
  });
  return Array.from(byFingerprint.values());
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The filename comes from the page, so the extension drawn from it is escaped
// like any other value on its way into innerHTML.
function getExtension(filename) {
  const ext = filename.split("?")[0].split(".").pop().toUpperCase();
  return ext.length <= 5 ? escapeHtml(ext) : "";
}

function getTypeIcon(type) {
  if (type === "video") return "\uD83C\uDFAC";
  if (type === "audio") return "\uD83C\uDFB5";
  if (type === "stream") return "\uD83D\uDCE1";
  if (type === "image") return "\uD83D\uDDBC";
  return "\uD83D\uDCC1";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}

function getSourceLabel(media) {
  if (media.altSources && media.altSources.length > 0) {
    const unique = [...new Set([media.source, ...media.altSources])];
    if (unique.length > 1) return { label: unique.length + "x", cls: "multi" };
  }
  const src = media.source || "dom";
  if (src === "network") return { label: "NET", cls: "network" };
  if (src === "hls-master" || src === "hls-media") return { label: "HLS", cls: "hls" };
  if (src === "auto-detected") return { label: "AUTO", cls: "auto" };
  if (src === "mse") return { label: "MSE", cls: "mse" };
  // FULL: the real picture found behind a thumbnail
  if (src === "image-full") return { label: "FULL", cls: "image" };
  if (src === "image" || src === "image-link" || src === "image-meta") return { label: "IMG", cls: "image" };
  if (src === "image-net") return { label: "NET", cls: "image" };
  return { label: "DOM", cls: "dom" };
}

// ── Video metadata probing ──

function probeMetadata(mediaList) {
  mediaList.forEach((m) => {
    if (metadataCache.has(m.url)) return;
    if (m.type !== "video" || m.url.startsWith("stream://") || m.isMseCapture) return;
    if (m.resolution && m.duration) {
      metadataCache.set(m.url, { resolution: m.resolution, duration: m.duration });
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.crossOrigin = "anonymous";

    const timeout = setTimeout(() => { video.src = ""; }, 5000);

    video.addEventListener("loadedmetadata", () => {
      clearTimeout(timeout);
      const info = {};
      if (video.videoWidth && video.videoHeight) {
        info.resolution = { width: video.videoWidth, height: video.videoHeight };
      }
      if (video.duration && isFinite(video.duration)) {
        info.duration = video.duration;
      }
      if (info.resolution || info.duration) {
        metadataCache.set(m.url, info);
        // Update the media entry and re-render that item's meta
        if (info.resolution) m.resolution = info.resolution;
        if (info.duration) m.duration = info.duration;
        updateMediaMeta(m.url);
      }
      video.src = "";
    });

    video.addEventListener("error", () => {
      clearTimeout(timeout);
      video.src = "";
    });

    video.src = m.url;
  });
}

function updateMediaMeta(url) {
  const metaEl = document.querySelector(`.media-item[data-url="${CSS.escape(url)}"] .media-meta`);
  if (!metaEl) return;
  const media = allMedia.find((m) => m.url === url);
  if (!media) return;

  // Add resolution badge if not already there
  if (media.resolution && !metaEl.querySelector(".resolution-badge")) {
    const badge = document.createElement("span");
    badge.className = "resolution-badge";
    badge.textContent = `${media.resolution.width}x${media.resolution.height}`;
    metaEl.insertBefore(badge, metaEl.children[1] || null);
  }

  // Add duration if not already there
  if (media.duration && !metaEl.querySelector(".duration-text")) {
    const dur = document.createElement("span");
    dur.className = "duration-text";
    dur.textContent = formatDuration(media.duration);
    metaEl.appendChild(dur);
  }

  // Update thumbnail duration overlay
  const thumb = document.querySelector(`.media-item[data-url="${CSS.escape(url)}"] .media-thumb`);
  if (thumb && media.duration && !thumb.querySelector(".duration-overlay")) {
    const overlay = document.createElement("span");
    overlay.className = "duration-overlay";
    overlay.textContent = formatDuration(media.duration);
    thumb.appendChild(overlay);
  }
}

// ── Quality grouping ──

function groupByQuality(mediaList) {
  if (options.groupQuality === false) {
    return mediaList.map((m) => ({ type: "single", media: m }));
  }

  const groups = new Map();
  const standalone = [];

  mediaList.forEach((m) => {
    if (m.quality && m.groupHash) {
      if (!groups.has(m.groupHash)) {
        groups.set(m.groupHash, { base: m, variants: [] });
      }
      groups.get(m.groupHash).variants.push(m);
    } else {
      standalone.push({ type: "single", media: m });
    }
  });

  const result = [...standalone];
  groups.forEach((group) => {
    if (group.variants.length > 1) {
      group.variants.sort((a, b) => (b.quality || 0) - (a.quality || 0));
      result.push({ type: "group", base: group.variants[0], variants: group.variants });
    } else {
      result.push({ type: "single", media: group.variants[0] });
    }
  });

  return result;
}

// ── Render ──

function render() {
  const query = document.getElementById("searchInput").value.toLowerCase().trim();

  filteredMedia = allMedia.filter((m) => {
    if (currentFilter !== "all" && m.type !== currentFilter) return false;
    if (query && !m.filename.toLowerCase().includes(query) && !m.domain.toLowerCase().includes(query)) return false;
    // Size filter
    if (sizeFilterMB > 0 && m.size) {
      if (m.size < sizeFilterMB * 1024 * 1024) return false;
    }
    return true;
  });

  // Sort
  filteredMedia.sort((a, b) => {
    if (currentSort === "name") return a.filename.localeCompare(b.filename);
    if (currentSort === "size") return (b.size || 0) - (a.size || 0);
    if (currentSort === "type") return a.type.localeCompare(b.type);
    if (currentSort === "domain") return a.domain.localeCompare(b.domain);
    if (currentSort === "quality") return (b.quality || 0) - (a.quality || 0);
    return 0;
  });

  // Stats
  const videoCount = allMedia.filter((m) => m.type === "video").length;
  const audioCount = allMedia.filter((m) => m.type === "audio").length;
  const streamCount = allMedia.filter((m) => m.type === "stream").length;
  const imageCount = allMedia.filter((m) => m.type === "image").length;
  document.getElementById("mediaCount").textContent = `${allMedia.length} media found`;
  document.getElementById("videoCount").textContent = videoCount;
  document.getElementById("audioCount").textContent = audioCount;
  document.getElementById("streamCount").textContent = streamCount;
  document.getElementById("imageCount").textContent = imageCount;

  const list = document.getElementById("mediaList");

  if (filteredMedia.length === 0) {
    showEmpty();
    return;
  }

  list.innerHTML = "";

  groupedMedia = groupByQuality(filteredMedia);

  groupedMedia.forEach((entry) => {
    if (entry.type === "group") {
      renderQualityGroup(list, entry);
    } else {
      renderMediaItem(list, entry.media);
    }
  });

  updateFooter();
}

function renderMediaItem(container, media) {
  const item = document.createElement("div");
  const isSelected = selectedUrls.has(media.url);
  const dlState = downloadStates[media.url];

  const showDupes = options.detectDuplicates !== false;
  const baseClass = "media-item" + (media.duplicate && showDupes ? " is-duplicate" : "") + (media.isMseCapture ? " is-mse" : "");
  item.className = baseClass + progressRowClass(dlState);
  item.dataset.rowClass = baseClass;
  item.dataset.url = media.url;
  item.dataset.progressUrl = media.url;
  const isStream = media.isConsolidatedStream;
  const isHLSMaster = media.isHLSMaster;

  const qualityHtml = media.quality ? `<span class="quality-badge">${media.quality}p</span>` : "";
  const dupeHtml = media.duplicate && showDupes ? `<span class="duplicate-badge">DUPE</span>` : "";
  const sizeHtml = media.size ? `<span>${formatSize(media.size)}</span>` : "";

  // Resolution
  const cached = metadataCache.get(media.url);
  const res = media.resolution || (cached && cached.resolution);
  const resHtml = res ? `<span class="resolution-badge">${res.width}x${res.height}</span>` : "";

  // Duration
  const dur = media.duration || (cached && cached.duration);
  const durHtml = dur ? `<span class="duration-text">${formatDuration(dur)}</span>` : "";
  const durOverlay = dur ? `<span class="duration-overlay">${formatDuration(dur)}</span>` : "";

  // Source badge
  const src = getSourceLabel(media);
  const sourceHtml = options.showSource === false
    ? ""
    : `<span class="source-badge ${src.cls}">${src.label}</span>`;

  // Stream badges
  const streamBadge = isStream
    ? `<span class="stream-badge">${media.segmentCount ? media.segmentCount + " segments" : (isHLSMaster && media.availableQualities ? media.availableQualities.map((q) => q + "p").join(", ") : "STREAM")}</span>`
    : "";
  const streamTypeTag = isStream && media.streamType
    ? `<span class="tag stream">${media.streamType.toUpperCase()}</span>`
    : isHLSMaster
      ? `<span class="tag stream">HLS</span>`
      : `<span class="tag ${media.type}">${getExtension(media.filename) || media.type.toUpperCase()}</span>`;

  const isImage = media.type === "image";
  // The thumbnail the page itself shows is the cheap preview of a full picture.
  const thumbHtml = isImage && options.showThumbnails !== false
    ? `<img src="${escapeHtml(media.thumbUrl || media.url)}" loading="lazy" alt="">`
    : !isStream && !media.isMseCapture && media.type === "video" && options.showThumbnails !== false
      ? `<video src="${escapeHtml(media.url)}" preload="metadata" muted></video>${durOverlay}`
      : `<span class="type-icon">${isStream ? "\uD83D\uDCE1" : getTypeIcon(media.type)}</span>`;

  const mseHtml = media.isMseCapture ? `<span class="mse-coverage">${mseCoverageText(media)}</span>` : "";

  const copyUrl = isStream ? (media.manifestUrl || media.firstSegmentUrl || media.url) : media.url;

  item.innerHTML = `
    ${progressBarHtml(dlState)}
    <input type="checkbox" class="media-check" data-url="${escapeHtml(media.url)}" ${isSelected ? "checked" : ""}>
    <div class="media-thumb">${thumbHtml}</div>
    <div class="media-info">
      <div class="media-filename" title="${escapeHtml(media.filename)}">${isStream ? "\uD83D\uDD17 " : ""}${escapeHtml(media.filename)}</div>
      <div class="media-meta">
        <span class="progress-label">${progressLabelText(dlState)}</span>
        ${streamTypeTag}
        ${qualityHtml}
        ${resHtml}
        ${streamBadge}
        ${sourceHtml}
        ${media.playlistPage ? `<span title="${escapeHtml(media.playlistPage)}">\u2630 ${escapeHtml((media.playlistTitle || media.playlistPage).slice(0, 40))}</span>` : ""}
        ${dupeHtml}
        <span>${escapeHtml(media.domain)}</span>
        ${sizeHtml}
        ${durHtml}
        ${mseHtml}
      </div>
    </div>
    <div class="media-actions">
      <button class="copy-btn action-btn" data-url="${escapeHtml(copyUrl)}" title="${isStream ? "Copy first segment URL" : "Copy URL"}">${COPY_ICON}</button>
      <button class="dl-btn action-btn ${dlState ? dlState.state : ""}" data-url="${escapeHtml(media.url)}" data-filename="${escapeHtml(media.filename)}" title="${isStream ? "Download & merge all segments" : "Download"}">
        ${dlState ? getDlButtonContent(dlState) : '<span class="btn-text">\u2193</span>'}
      </button>
    </div>
  `;

  // Checkbox
  const checkbox = item.querySelector(".media-check");
  if (checkbox) checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedUrls.add(media.url);
    else selectedUrls.delete(media.url);
    updateFooter();
  });

  // Copy URL
  const copyBtn = item.querySelector(".copy-btn");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(copyUrl).then(() => {
      copyBtn.classList.add("copied");
      copyBtn.innerHTML = "\u2713";
      showToast(isStream ? "Stream URL copied" : "URL copied to clipboard");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.innerHTML = COPY_ICON;
      }, 1500);
    });
  });

  // Download
  const dlBtn = item.querySelector(".dl-btn");
  dlBtn.addEventListener("click", () => toggleDownload(media));

  // Video thumbnail
  if (!isStream && media.type === "video") {
    const vid = item.querySelector("video");
    if (vid) vid.addEventListener("loadeddata", () => { vid.currentTime = 1; });
  }

  container.appendChild(item);
}

function renderQualityGroup(container, group) {
  const groupEl = document.createElement("div");
  groupEl.className = "quality-group";

  const best = group.base;
  const variantCount = group.variants.length;
  const bestState = downloadStates[best.url];

  groupEl.innerHTML = `
    <div class="quality-group-header${progressRowClass(bestState)}" data-progress-url="${escapeHtml(best.url)}" data-row-class="quality-group-header">
      ${progressBarHtml(bestState)}
      <span class="arrow">&#9654;</span>
      <div class="media-info" style="flex:1;min-width:0">
        <div class="media-filename" title="${escapeHtml(best.filename)}">${escapeHtml(best.filename)}</div>
        <div class="media-meta">
          <span class="progress-label">${progressLabelText(bestState)}</span>
          <span class="tag ${best.type}">${getExtension(best.filename) || best.type.toUpperCase()}</span>
          <span>${variantCount} qualities available</span>
          <span>${escapeHtml(best.domain)}</span>
        </div>
      </div>
      <div class="media-actions">
        <button class="copy-btn action-btn" data-url="${escapeHtml(best.url)}" title="Copy best URL">${COPY_ICON}</button>
        <button class="dl-btn action-btn ${bestState ? bestState.state : ""}" data-url="${escapeHtml(best.url)}" data-filename="${escapeHtml(best.filename)}">
          ${bestState ? getDlButtonContent(bestState) : '<span class="btn-text">\u2193</span>'}
        </button>
      </div>
    </div>
    <div class="quality-variants"></div>
  `;

  const header = groupEl.querySelector(".quality-group-header");
  const variants = groupEl.querySelector(".quality-variants");
  const arrow = groupEl.querySelector(".arrow");

  header.addEventListener("click", (e) => {
    if (e.target.closest(".action-btn")) return;
    arrow.classList.toggle("open");
    variants.classList.toggle("open");
  });

  const copyBtn = groupEl.querySelector(".copy-btn");
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(best.url).then(() => {
      copyBtn.classList.add("copied");
      copyBtn.innerHTML = "\u2713";
      showToast("URL copied to clipboard");
      setTimeout(() => { copyBtn.classList.remove("copied"); copyBtn.innerHTML = COPY_ICON; }, 1500);
    });
  });

  const dlBtn = groupEl.querySelector(".dl-btn");
  dlBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    downloadMedia(best);
  });

  group.variants.forEach((v) => {
    const varEl = document.createElement("div");
    const vState = downloadStates[v.url];
    varEl.className = "quality-variant" + progressRowClass(vState);
    varEl.dataset.rowClass = "quality-variant";
    varEl.dataset.progressUrl = v.url;
    varEl.innerHTML = `
      ${progressBarHtml(vState)}
      <div class="variant-info">
        <span class="progress-label">${progressLabelText(vState)}</span>
        <span class="quality-badge">${v.quality || "?"}p</span>
        <span style="font-size:10px;color:var(--text-dim)">${v.bandwidth ? (v.bandwidth / 1000).toFixed(0) + " kbps" : ""}</span>
        <span style="font-size:10px;color:var(--text-dim)">${v.size ? formatSize(v.size) : ""}</span>
      </div>
      <div class="media-actions">
        <button class="copy-btn action-btn" title="Copy URL">${COPY_ICON}</button>
        <button class="dl-btn action-btn ${vState ? vState.state : ""}" data-url="${escapeHtml(v.url)}" data-filename="${escapeHtml(v.filename)}">
          ${vState ? getDlButtonContent(vState) : '<span class="btn-text">\u2193</span>'}
        </button>
      </div>
    `;

    varEl.querySelector(".copy-btn").addEventListener("click", () => {
      navigator.clipboard.writeText(v.url).then(() => showToast(`${v.quality}p URL copied`));
    });

    varEl.querySelector(".dl-btn").addEventListener("click", () => downloadMedia(v));

    variants.appendChild(varEl);
  });

  container.appendChild(groupEl);
}

function getDlButtonContent(state) {
  if (state.state === "cancelling") return '<span class="btn-text">\u2026</span>';
  if (state.state === "downloading") {
    if (isMuxing(state)) return '<span class="btn-text">MUX</span>';
    return `<span class="btn-text">${Math.round(state.progress > 0 ? state.progress : 0)}%</span>`;
  }
  if (state.state === "queued") return '<span class="btn-text">Q</span>';
  if (state.state === "done") return '<span class="btn-text">\u2713</span>';
  return '<span class="btn-text">\u2193</span>';
}

// ── Row progress ──
// A download fills its whole row rather than the 28px button, so the bar is
// readable and the background script's status text has somewhere to live.

function isMuxing(state) {
  return state.state === "downloading" && state.progress >= 90 && !!state.label;
}

function progressRowClass(state) {
  if (!state) return "";
  if (state.state === "cancelling") return " is-queued";
  if (state.state === "queued") return " is-queued";
  if (state.state === "done") return " is-done";
  if (state.state === "downloading") return isMuxing(state) ? " is-downloading is-muxing" : " is-downloading";
  return "";
}

function progressWidth(state) {
  if (!state) return 0;
  if (state.state === "done" || state.state === "queued") return 100;
  return Math.max(0, Math.min(100, state.progress || 0));
}

function progressLabelText(state) {
  if (!state) return "";
  if (state.state === "cancelling") return "Stopping\u2026";
  if (state.state === "queued") return "Queued";
  if (state.state === "done") return "Done";
  if (state.state !== "downloading") return "";
  return state.label || Math.round(state.progress || 0) + "%";
}

function progressBarHtml(state) {
  return `<div class="row-progress" style="width:${progressWidth(state)}%"></div>`;
}

function showEmpty() {
  document.getElementById("mediaList").innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">\uD83D\uDCED</div>
      <div class="empty-title">No media found</div>
      <div class="empty-desc">Let the video play for a few seconds, then rescan.<br>Players that stream through MSE only reveal their segments once playing.</div>
    </div>
  `;
  document.getElementById("downloadAll").disabled = true;
  document.getElementById("downloadSelected").disabled = true;
  document.getElementById("downloadBest").disabled = true;
  document.getElementById("batchRenameBtn").disabled = true;
  document.getElementById("exportBtn").disabled = true;
}

function updateCheckboxes() {
  document.querySelectorAll(".media-check[data-url]").forEach((cb) => {
    cb.checked = selectedUrls.has(cb.dataset.url);
  });
}

function updateFooter() {
  const selCount = selectedUrls.size;
  const totalCount = filteredMedia.length;
  for (const id of ["downloadAll", "downloadBest", "batchRenameBtn", "exportBtn"]) {
    document.getElementById(id).disabled = totalCount === 0;
  }
  document.getElementById("downloadSelected").disabled = selCount === 0;

  document.getElementById("downloadSelected").textContent = selCount > 0 ? `DL (${selCount})` : "DL Selected";

  const selectedMedia = filteredMedia.filter((m) => selectedUrls.has(m.url));
  const selectedSize = selectedMedia.reduce((s, m) => s + (m.size || 0), 0);
  document.getElementById("selectionInfo").textContent = selCount > 0
    ? `${selCount} selected` + (selectedSize ? ` \u2014 ${formatSize(selectedSize)}` : "")
    : `${totalCount} items`;

  const totalSize = filteredMedia.reduce((s, m) => s + (m.size || 0), 0);
  document.getElementById("totalSize").textContent = totalSize > 0 ? `Total: ${formatSize(totalSize)}` : "";
}

// ── Hover preview ──

function setupHoverPreview() {
  if (options.hoverPreview === false) return;
  const preview = document.getElementById("hoverPreview");
  const previewVideo = preview.querySelector("video");
  let hoverTimeout = null;

  document.getElementById("mediaList").addEventListener("mouseover", (e) => {
    const thumb = e.target.closest(".media-thumb");
    if (!thumb) return;
    const item = thumb.closest(".media-item");
    if (!item) return;
    const url = item.dataset.url;
    if (!url || url.startsWith("stream://") || url.startsWith("mse://")) return;

    const media = allMedia.find((m) => m.url === url);
    if (!media || media.type !== "video") return;

    hoverTimeout = setTimeout(() => {
      const rect = thumb.getBoundingClientRect();
      preview.style.left = (rect.right + 8) + "px";
      preview.style.top = Math.max(0, rect.top - 40) + "px";

      previewVideo.src = url;
      previewVideo.currentTime = 0;
      previewVideo.play().catch(() => {});
      preview.classList.add("active");
    }, 400);
  });

  document.getElementById("mediaList").addEventListener("mouseout", (e) => {
    const thumb = e.target.closest(".media-thumb");
    if (!thumb && !e.target.closest(".hover-preview")) {
      clearTimeout(hoverTimeout);
      preview.classList.remove("active");
      previewVideo.pause();
      previewVideo.src = "";
    }
  });

  // Also hide on scroll
  document.getElementById("mediaList").addEventListener("scroll", () => {
    clearTimeout(hoverTimeout);
    preview.classList.remove("active");
    previewVideo.pause();
    previewVideo.src = "";
  });
}

// ── Export ──

function exportMedia(format) {
  const mediaToExport = selectedUrls.size > 0
    ? filteredMedia.filter((m) => selectedUrls.has(m.url))
    : filteredMedia;

  if (format === "clipboard") {
    const urls = mediaToExport.map((m) => m.url).join("\n");
    navigator.clipboard.writeText(urls).then(() => {
      showToast(`${mediaToExport.length} URLs copied to clipboard`);
    });
    return;
  }

  if (format === "txt") {
    const content = mediaToExport.map((m) => m.url).join("\n");
    downloadAsFile(content, "media-urls.txt", "text/plain");
    showToast("Exported as .txt");
    return;
  }

  if (format === "json") {
    const data = mediaToExport.map((m) => ({
      url: m.url,
      filename: m.filename,
      domain: m.domain,
      type: m.type,
      size: m.size || null,
      quality: m.quality || null,
      source: m.source || null,
      resolution: m.resolution || null,
      duration: m.duration ? formatDuration(m.duration) : null,
      page: m.playlistPage || null
    }));
    const content = JSON.stringify(data, null, 2);
    downloadAsFile(content, "media-data.json", "application/json");
    showToast("Exported as .json");
    return;
  }
}

// Saved by the background: a blob: URL made here dies with the popup, which
// closes as soon as the "Save as" dialog takes the focus.
function downloadAsFile(content, filename, mimeType) {
  send({ action: "export_file", content, filename, mimeType })
    .then((resp) => { if (resp && resp.error) showToast("Export failed: " + resp.error); })
    .catch((err) => showToast("Export failed: " + err.message));
}

// ── Download ──

// The same button starts and stops: once a download is running it becomes the
// only place to stop it.
function toggleDownload(media) {
  const state = downloadStates[media.url];
  if (state && (state.state === "downloading" || state.state === "queued")) {
    cancelDownload(media.url);
    return;
  }
  downloadMedia(media);
}

function cancelDownload(url) {
  downloadStates[url] = { state: "cancelling", progress: 0 };
  renderDownloadState(url);
  send({ action: "cancel_download", url }).catch(() => {});
}

// "12:34 / 45:00 captured" — how much of the video the player has fed so far.
function mseCoverageText(media) {
  if (media.drm) return "DRM protected — cannot be saved";
  if (!media.duration) return "captured so far";
  const pct = Math.min(100, Math.round((media.capturedUntil / media.duration) * 100));
  return `${formatDuration(media.capturedUntil)} / ${formatDuration(media.duration)} captured (${pct}%)`;
}

function downloadMedia(media) {
  if (media.isMseCapture) {
    if (media.drm) { showToast("DRM protected — this video cannot be saved"); return; }
    if (media.duration && media.capturedUntil < media.duration - 2) {
      showToast(`Partial: only ${mseCoverageText(media)} — play to the end for the full video`);
    }
  }
  if (downloadStates[media.url] && (downloadStates[media.url].state === "downloading" || downloadStates[media.url].state === "queued")) return;

  downloadStates[media.url] = { state: "queued", progress: 0 };
  renderDownloadState(media.url);

  send({
    action: "download",
    url: media.url,
    filename: media.filename,
    pageTitle,
    quality: media.quality
  }).then((response) => {
    // The item is only queued at this point; progress and completion arrive
    // later as dl_update messages from the background script.
    if (response && response.error) {
      showToast("Error: " + response.error);
      delete downloadStates[media.url];
      renderDownloadState(media.url);
    }
  }).catch(() => {
    delete downloadStates[media.url];
    renderDownloadState(media.url);
  });
}

function handleDownloadUpdate(message) {
  const url = message.url;

  if (message.state === "started") {
    downloadStates[url] = { state: "downloading", progress: 0 };
    renderDownloadState(url);
    trackDownload(url, message.downloadId);
    return;
  }

  if (message.state === "done") {
    downloadStates[url] = { state: "done", progress: 100 };
    renderDownloadState(url);
    if (message.fallback) showToast("Remux failed — saved as .ts");
    if (message.separateAudio) showToast("Audio track saved separately: " + message.audioFilename);
    if (message.subtitles) showToast(`${message.subtitles.length} subtitle track(s) saved`);
    return;
  }

  if (message.state === "cancelled") {
    delete downloadStates[url];
    renderDownloadState(url);
    showToast("Download stopped");
    return;
  }

  if (message.state === "error") {
    showToast("Error: " + message.error);
    delete downloadStates[url];
    renderDownloadState(url);
  }
}

// Download best quality of each unique video
function downloadBestQuality() {
  // Group by fingerprint, pick highest quality
  const bestByFingerprint = new Map();
  filteredMedia.forEach((m) => {
    const fp = m.fingerprint || m.url;
    const existing = bestByFingerprint.get(fp);
    if (!existing || (m.quality || 0) > (existing.quality || 0) || (!existing.size && m.size)) {
      bestByFingerprint.set(fp, m);
    }
  });

  downloadBatch(Array.from(bestByFingerprint.values()));
}

// Several files go out as one zip built by the background page, so the
// browser asks for a location once instead of once per file.
function downloadBatch(items, renamePattern = null) {
  items = items.filter((m) => !["downloading", "queued"].includes(downloadStates[m.url]?.state));
  if (items.length === 0) return;
  if (items.length === 1 && !renamePattern) { downloadMedia(items[0]); return; }

  send({
    action: "batch_download",
    items: items.map((m) => ({ url: m.url, filename: m.filename, quality: m.quality, domain: m.domain })),
    renamePattern,
    pageTitle
  }).then((resp) => {
    if (!resp || !resp.queued) return;
    showToast(resp.zip
      ? `Fetching ${resp.queued} files — saved as one zip when done`
      : `${resp.queued} download(s) queued`);
    items.forEach((m) => {
      downloadStates[m.url] = { state: "queued", progress: 0 };
      renderDownloadState(m.url);
    });
  }).catch(() => {});
}

// Each category tab opens on the sort order chosen for it in the settings.
function applyDefaultSort() {
  const sort = options.sortDefaults && options.sortDefaults[currentFilter];
  if (!sort) return;
  currentSort = sort;
  document.getElementById("sortSelect").value = sort;
}

function trackDownload(url, downloadId) {
  const interval = setInterval(() => {
    send({ action: "download_progress", downloadId }).catch(() => null).then((resp) => {
      if (!resp) { clearInterval(interval); return; }
      if (resp.state === "complete") {
        downloadStates[url] = { state: "done", progress: 100 };
        renderDownloadState(url);
        clearInterval(interval);
      } else if (resp.state === "interrupted") {
        delete downloadStates[url];
        renderDownloadState(url);
        clearInterval(interval);
      } else if (resp.totalBytes > 0) {
        const pct = (resp.bytesReceived / resp.totalBytes) * 100;
        downloadStates[url] = { state: "downloading", progress: pct };
        renderDownloadState(url);
      }
    });
  }, 500);
}

function renderDownloadState(url) {
  const state = downloadStates[url];
  const sel = CSS.escape(url);

  document.querySelectorAll(`[data-progress-url="${sel}"]`).forEach((row) => {
    row.className = (row.dataset.rowClass || row.className) + progressRowClass(state);
    const fill = row.querySelector(".row-progress");
    if (fill) fill.style.width = progressWidth(state) + "%";
    const label = row.querySelector(".progress-label");
    if (label) label.textContent = progressLabelText(state);
  });

  document.querySelectorAll(`.dl-btn[data-url="${sel}"]`).forEach((btn) => {
    btn.className = "dl-btn action-btn " + (state ? state.state : "");
    btn.innerHTML = state ? getDlButtonContent(state) : '<span class="btn-text">\u2193</span>';
  });
}

// ── Batch rename ──

function openBatchRename() {
  const field = document.getElementById("renamePattern");
  if (!field.dataset.touched && options.defaultRenamePattern) {
    field.value = options.defaultRenamePattern;
  }
  document.getElementById("renameModal").classList.add("active");
  updateRenamePreview();
}

function updateRenamePreview() {
  const pattern = document.getElementById("renamePattern").value;
  const preview = document.getElementById("renamePreview");
  const items = selectedUrls.size > 0
    ? filteredMedia.filter((m) => selectedUrls.has(m.url))
    : filteredMedia;

  const samples = items.slice(0, 5).map((m, i) => {
    const ext = m.filename.includes(".") ? "." + m.filename.split(".").pop() : "";
    const base = m.filename.includes(".") ? m.filename.slice(0, m.filename.lastIndexOf(".")) : m.filename;
    const cleanTitle = (pageTitle || "").replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    const q = m.quality ? m.quality + "p" : "";
    const padded = String(i + 1).padStart(String(items.length).length, "0");

    return pattern
      .replace(/\{title\}/gi, cleanTitle || "untitled")
      .replace(/\{filename\}/gi, base)
      .replace(/\{domain\}/gi, m.domain)
      .replace(/\{date\}/gi, new Date().toISOString().slice(0, 10))
      .replace(/\{quality\}/gi, q)
      .replace(/\{index\}/gi, padded)
      .replace(/\{ext\}/gi, ext)
      + (/\{ext\}/i.test(pattern) ? "" : ext);
  });

  preview.innerHTML = samples.map((s) => escapeHtml(s)).join("<br>");
  if (items.length > 5) preview.innerHTML += `<br>... +${items.length - 5} more`;
}

function executeBatchRename() {
  const pattern = document.getElementById("renamePattern").value;
  const items = selectedUrls.size > 0
    ? filteredMedia.filter((m) => selectedUrls.has(m.url))
    : filteredMedia;

  document.getElementById("renameModal").classList.remove("active");
  downloadBatch(items, pattern);
}
