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

  // Request media from background
  const response = await browser.runtime.sendMessage({ action: "get_media" });
  if (response && response.media) {
    allMedia = deduplicateMedia(response.media);
    pageTitle = response.pageTitle || "";
    watchMode = response.watchMode || false;
    updateWatchButton();
    updateQueueBar(response.queueLength || 0, response.activeDownloads || 0);
    render();
    probeMetadata(allMedia);
  } else {
    showEmpty();
  }

  // Trigger rescan
  browser.runtime.sendMessage({ action: "rescan" });

  // Listen for messages
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "media_links" || message.action === "new_media") {
      browser.runtime.sendMessage({ action: "get_media" }).then((resp) => {
        if (resp && resp.media) {
          const newMedia = deduplicateMedia(resp.media);
          const oldUrls = new Set(allMedia.map((m) => m.url));
          const changed = newMedia.length !== allMedia.length || newMedia.some((m) => !oldUrls.has(m.url));
          if (!changed) return;
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
      renderSingleButton(message.url);
    }
    if (message.action === "queue_update") {
      updateQueueBar(message.queueLength, message.activeDownloads);
    }
    if (message.action === "watch_new_media") {
      if (watchMode && message.media) {
        showToast(`Watch: auto-downloading ${message.media.filename}`);
        downloadMedia(message.media);
      }
    }
  });

  // Search
  document.getElementById("searchInput").addEventListener("input", render);

  // Filter chips
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
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
    filteredMedia.filter((m) => selectedUrls.has(m.url)).forEach((m) => downloadMedia(m));
  });

  // Download all
  document.getElementById("downloadAll").addEventListener("click", () => {
    filteredMedia.forEach((m) => downloadMedia(m));
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
  document.getElementById("renamePattern").addEventListener("input", updateRenamePreview);

  // Watch mode
  document.getElementById("watchBtn").addEventListener("click", async () => {
    const resp = await browser.runtime.sendMessage({ action: "toggle_watch" });
    if (resp) {
      watchMode = resp.watchMode;
      updateWatchButton();
      showToast(watchMode ? "Watch mode ON — new media will auto-download" : "Watch mode OFF");
    }
  });

  // Rescan
  document.getElementById("rescanBtn").addEventListener("click", () => {
    const btn = document.getElementById("rescanBtn");
    btn.style.transition = "transform 0.4s";
    btn.style.transform = "rotate(360deg)";
    setTimeout(() => { btn.style.transform = ""; btn.style.transition = ""; }, 400);
    browser.runtime.sendMessage({ action: "rescan" });
    setTimeout(() => {
      browser.runtime.sendMessage({ action: "get_media" }).then((resp) => {
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
    const fp = m.fingerprint || m.url;
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

function getExtension(filename) {
  const ext = filename.split("?")[0].split(".").pop().toUpperCase();
  return ext.length <= 5 ? ext : "";
}

function getTypeIcon(type) {
  if (type === "video") return "\uD83C\uDFAC";
  if (type === "audio") return "\uD83C\uDFB5";
  if (type === "stream") return "\uD83D\uDCE1";
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
  return { label: "DOM", cls: "dom" };
}

// ── Video metadata probing ──

function probeMetadata(mediaList) {
  mediaList.forEach((m) => {
    if (metadataCache.has(m.url)) return;
    if (m.type !== "video" || m.url.startsWith("stream://")) return;
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
  document.getElementById("mediaCount").textContent = `${allMedia.length} media found`;
  document.getElementById("videoCount").textContent = videoCount;
  document.getElementById("audioCount").textContent = audioCount;
  document.getElementById("streamCount").textContent = streamCount;

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
  item.className = "media-item" + (media.duplicate ? " is-duplicate" : "");
  item.dataset.url = media.url;

  const isSelected = selectedUrls.has(media.url);
  const dlState = downloadStates[media.url];
  const isStream = media.isConsolidatedStream;
  const isHLSMaster = media.isHLSMaster;

  const qualityHtml = media.quality ? `<span class="quality-badge">${media.quality}p</span>` : "";
  const dupeHtml = media.duplicate ? `<span class="duplicate-badge">DUPE</span>` : "";
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
  const sourceHtml = `<span class="source-badge ${src.cls}">${src.label}</span>`;

  // Stream badges
  const streamBadge = isStream
    ? `<span class="stream-badge">${media.segmentCount ? media.segmentCount + " segments" : (isHLSMaster && media.availableQualities ? media.availableQualities.map((q) => q + "p").join(", ") : "STREAM")}</span>`
    : "";
  const streamTypeTag = isStream && media.streamType
    ? `<span class="tag stream">${media.streamType.toUpperCase()}</span>`
    : isHLSMaster
      ? `<span class="tag stream">HLS</span>`
      : `<span class="tag ${media.type}">${getExtension(media.filename) || media.type.toUpperCase()}</span>`;

  const thumbHtml = !isStream && media.type === "video"
    ? `<video src="${escapeHtml(media.url)}" preload="metadata" muted></video>${durOverlay}`
    : `<span class="type-icon">${isStream ? "\uD83D\uDCE1" : getTypeIcon(media.type)}</span>`;

  const copyUrl = isStream ? (media.manifestUrl || media.realUrls?.[0] || media.url) : media.url;

  item.innerHTML = `
    <input type="checkbox" class="media-check" data-url="${escapeHtml(media.url)}" ${isSelected ? "checked" : ""}>
    <div class="media-thumb">${thumbHtml}</div>
    <div class="media-info">
      <div class="media-filename" title="${escapeHtml(media.filename)}">${isStream ? "\uD83D\uDD17 " : ""}${escapeHtml(media.filename)}</div>
      <div class="media-meta">
        ${streamTypeTag}
        ${qualityHtml}
        ${resHtml}
        ${streamBadge}
        ${sourceHtml}
        ${dupeHtml}
        <span>${escapeHtml(media.domain)}</span>
        ${sizeHtml}
        ${durHtml}
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
  checkbox.addEventListener("change", () => {
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
  dlBtn.addEventListener("click", () => downloadMedia(media));

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

  groupEl.innerHTML = `
    <div class="quality-group-header">
      <span class="arrow">&#9654;</span>
      <div class="media-info" style="flex:1;min-width:0">
        <div class="media-filename" title="${escapeHtml(best.filename)}">${escapeHtml(best.filename)}</div>
        <div class="media-meta">
          <span class="tag ${best.type}">${getExtension(best.filename) || best.type.toUpperCase()}</span>
          <span>${variantCount} qualities available</span>
          <span>${escapeHtml(best.domain)}</span>
        </div>
      </div>
      <div class="media-actions">
        <button class="copy-btn action-btn" data-url="${escapeHtml(best.url)}" title="Copy best URL">${COPY_ICON}</button>
        <button class="dl-btn action-btn" data-url="${escapeHtml(best.url)}" data-filename="${escapeHtml(best.filename)}">
          <span class="btn-text">\u2193</span>
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
    varEl.className = "quality-variant";
    varEl.innerHTML = `
      <div class="variant-info">
        <span class="quality-badge">${v.quality || "?"}p</span>
        <span style="font-size:10px;color:var(--text-dim)">${v.bandwidth ? (v.bandwidth / 1000).toFixed(0) + " kbps" : ""}</span>
        <span style="font-size:10px;color:var(--text-dim)">${v.size ? formatSize(v.size) : ""}</span>
      </div>
      <div class="media-actions">
        <button class="copy-btn action-btn" title="Copy URL">${COPY_ICON}</button>
        <button class="dl-btn action-btn"><span class="btn-text">\u2193</span></button>
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
  if (state.state === "downloading") {
    const pct = state.progress > 0 ? Math.round(state.progress) : 0;
    const label = state.label && state.progress >= 90 ? "MUX" : pct + "%";
    return `<div class="progress-fill" style="width:${pct}%"></div><span class="btn-text">${label}</span>`;
  }
  if (state.state === "queued") return '<span class="btn-text">Q</span>';
  if (state.state === "done") return '<span class="btn-text">\u2713</span>';
  return '<span class="btn-text">\u2193</span>';
}

function showEmpty() {
  document.getElementById("mediaList").innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">\uD83D\uDCED</div>
      <div class="empty-title">No media found</div>
      <div class="empty-desc">Try refreshing the page or click rescan.<br>Navigate to a page with videos or audio.</div>
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

  document.getElementById("downloadAll").disabled = totalCount === 0;
  document.getElementById("downloadSelected").disabled = selCount === 0;
  document.getElementById("downloadBest").disabled = totalCount === 0;
  document.getElementById("batchRenameBtn").disabled = totalCount === 0;
  document.getElementById("exportBtn").disabled = totalCount === 0;

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
  const preview = document.getElementById("hoverPreview");
  const previewVideo = preview.querySelector("video");
  let hoverTimeout = null;

  document.getElementById("mediaList").addEventListener("mouseover", (e) => {
    const thumb = e.target.closest(".media-thumb");
    if (!thumb) return;
    const item = thumb.closest(".media-item");
    if (!item) return;
    const url = item.dataset.url;
    if (!url || url.startsWith("stream://")) return;

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
      duration: m.duration ? formatDuration(m.duration) : null
    }));
    const content = JSON.stringify(data, null, 2);
    downloadAsFile(content, "media-data.json", "application/json");
    showToast("Exported as .json");
    return;
  }
}

function downloadAsFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  browser.downloads.download({ url, filename }).then(() => {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// ── Download ──

function downloadMedia(media) {
  if (downloadStates[media.url] && (downloadStates[media.url].state === "downloading" || downloadStates[media.url].state === "queued")) return;

  downloadStates[media.url] = { state: "queued", progress: 0 };
  renderSingleButton(media.url);

  browser.runtime.sendMessage({
    action: "download",
    url: media.url,
    filename: media.filename,
    pageTitle,
    quality: media.quality
  }).then((response) => {
    if (response && response.downloadId) {
      downloadStates[media.url] = { state: "downloading", progress: 0 };
      renderSingleButton(media.url);
      trackDownload(media.url, response.downloadId);
    } else if (response && response.segments) {
      downloadStates[media.url] = { state: "done", progress: 100 };
      renderSingleButton(media.url);
    } else if (response && response.error) {
      showToast("Error: " + response.error);
      delete downloadStates[media.url];
      renderSingleButton(media.url);
    } else {
      downloadStates[media.url] = { state: "done" };
      renderSingleButton(media.url);
    }
  }).catch(() => {
    delete downloadStates[media.url];
    renderSingleButton(media.url);
  });
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

  const bestItems = Array.from(bestByFingerprint.values());
  showToast(`Downloading ${bestItems.length} best quality files`);
  bestItems.forEach((m) => downloadMedia(m));
}

function trackDownload(url, downloadId) {
  const interval = setInterval(() => {
    browser.runtime.sendMessage({ action: "download_progress", downloadId }).then((resp) => {
      if (!resp) return;
      if (resp.state === "complete") {
        downloadStates[url] = { state: "done", progress: 100 };
        renderSingleButton(url);
        clearInterval(interval);
      } else if (resp.state === "interrupted") {
        delete downloadStates[url];
        renderSingleButton(url);
        clearInterval(interval);
      } else if (resp.totalBytes > 0) {
        const pct = (resp.bytesReceived / resp.totalBytes) * 100;
        downloadStates[url] = { state: "downloading", progress: pct };
        renderSingleButton(url);
      }
    });
  }, 500);
}

function renderSingleButton(url) {
  const btn = document.querySelector(`.dl-btn[data-url="${CSS.escape(url)}"]`);
  if (!btn) return;
  const state = downloadStates[url];
  btn.className = "dl-btn action-btn " + (state ? state.state : "");
  btn.innerHTML = state ? getDlButtonContent(state) : '<span class="btn-text">\u2193</span>';
}

// ── Batch rename ──

function openBatchRename() {
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
      + ext;
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

  browser.runtime.sendMessage({
    action: "batch_download",
    items: items.map((m) => ({
      url: m.url,
      filename: m.filename,
      quality: m.quality,
      domain: m.domain
    })),
    renamePattern: pattern,
    pageTitle
  }).then((resp) => {
    if (resp && resp.queued) {
      showToast(`${resp.queued} downloads queued with custom names`);
      items.forEach((m) => {
        downloadStates[m.url] = { state: "queued", progress: 0 };
        renderSingleButton(m.url);
      });
    }
  });
}
