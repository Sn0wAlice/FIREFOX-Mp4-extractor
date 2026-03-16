// options.js — Media Extractor Pro v3.0

const DEFAULTS = {
  downloadFolder: "",
  filenamePattern: "original",
  minSize: 0,
  maxSize: 0,
  formats: ["mp4", "webm", "mkv", "avi", "mov", "ts", "m3u8", "mpd", "mp3", "m4a", "ogg", "wav", "flac"],
  networkIntercept: true,
  deepScan: true,
  showThumbnails: true,
  showBadge: true,
  groupQuality: true,
  detectDuplicates: true,
  hoverPreview: true,
  smartDedup: true,
  showSource: true,
  maxConcurrent: 2,
  defaultRenamePattern: "{title}_{quality}_{index}",
  blacklist: []
};

let currentBlacklist = [];

function loadOptions() {
  // Load theme
  browser.storage.local.get("theme").then((result) => {
    const theme = result.theme || "dark";
    document.querySelectorAll(".theme-option").forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.theme === theme);
    });
    applyTheme(theme);
  });

  browser.storage.local.get("options").then((result) => {
    const opts = result.options || DEFAULTS;

    document.getElementById("downloadFolder").value = opts.downloadFolder || "";
    document.getElementById("filenamePattern").value = opts.filenamePattern || "original";
    document.getElementById("minSize").value = opts.minSize || 0;
    document.getElementById("maxSize").value = opts.maxSize || 0;
    document.getElementById("networkIntercept").checked = opts.networkIntercept !== false;
    document.getElementById("deepScan").checked = opts.deepScan !== false;
    document.getElementById("showThumbnails").checked = opts.showThumbnails !== false;
    document.getElementById("showBadge").checked = opts.showBadge !== false;
    document.getElementById("groupQuality").checked = opts.groupQuality !== false;
    document.getElementById("detectDuplicates").checked = opts.detectDuplicates !== false;
    document.getElementById("hoverPreview").checked = opts.hoverPreview !== false;
    document.getElementById("smartDedup").checked = opts.smartDedup !== false;
    document.getElementById("showSource").checked = opts.showSource !== false;
    document.getElementById("maxConcurrent").value = opts.maxConcurrent || 2;
    document.getElementById("defaultRenamePattern").value = opts.defaultRenamePattern || "{title}_{quality}_{index}";

    // Formats
    const enabledFormats = opts.formats || DEFAULTS.formats;
    document.querySelectorAll("[data-fmt]").forEach((cb) => {
      cb.checked = enabledFormats.includes(cb.dataset.fmt);
    });

    // Blacklist
    currentBlacklist = opts.blacklist || [];
    renderBlacklist();
  });
}

function saveOptions() {
  const formats = [];
  document.querySelectorAll("[data-fmt]").forEach((cb) => {
    if (cb.checked) formats.push(cb.dataset.fmt);
  });

  const options = {
    downloadFolder: document.getElementById("downloadFolder").value.trim(),
    filenamePattern: document.getElementById("filenamePattern").value,
    minSize: parseInt(document.getElementById("minSize").value) || 0,
    maxSize: parseInt(document.getElementById("maxSize").value) || 0,
    formats,
    networkIntercept: document.getElementById("networkIntercept").checked,
    deepScan: document.getElementById("deepScan").checked,
    showThumbnails: document.getElementById("showThumbnails").checked,
    showBadge: document.getElementById("showBadge").checked,
    groupQuality: document.getElementById("groupQuality").checked,
    detectDuplicates: document.getElementById("detectDuplicates").checked,
    hoverPreview: document.getElementById("hoverPreview").checked,
    smartDedup: document.getElementById("smartDedup").checked,
    showSource: document.getElementById("showSource").checked,
    maxConcurrent: parseInt(document.getElementById("maxConcurrent").value) || 2,
    defaultRenamePattern: document.getElementById("defaultRenamePattern").value || "{title}_{quality}_{index}",
    blacklist: currentBlacklist
  };

  browser.storage.local.set({ options }).then(() => {
    showSavedMsg("Settings saved!");
  });
}

function resetOptions() {
  browser.storage.local.set({ options: DEFAULTS, theme: "dark" }).then(() => {
    loadOptions();
    showSavedMsg("Reset to defaults!");
  });
}

function showSavedMsg(text) {
  const msg = document.getElementById("savedMsg");
  msg.textContent = text;
  msg.classList.add("show");
  setTimeout(() => msg.classList.remove("show"), 2000);
}

// ── Blacklist ──

function renderBlacklist() {
  const container = document.getElementById("blacklistTags");
  container.innerHTML = "";

  currentBlacklist.forEach((pattern, index) => {
    const tag = document.createElement("div");
    tag.className = "tag-item";
    tag.innerHTML = `
      <span>${escapeHtml(pattern)}</span>
      <button class="tag-remove" data-index="${index}">\u00d7</button>
    `;
    tag.querySelector(".tag-remove").addEventListener("click", () => {
      currentBlacklist.splice(index, 1);
      renderBlacklist();
    });
    container.appendChild(tag);
  });
}

function addBlacklistEntry() {
  const input = document.getElementById("blacklistInput");
  const val = input.value.trim();
  if (!val) return;
  if (currentBlacklist.includes(val)) return;
  currentBlacklist.push(val);
  input.value = "";
  renderBlacklist();
}

// ── Theme ──

function applyTheme(theme) {
  if (theme === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.className = theme === "light" ? "light" : "";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  loadOptions();

  document.getElementById("saveBtn").addEventListener("click", saveOptions);
  document.getElementById("resetBtn").addEventListener("click", resetOptions);

  // Blacklist
  document.getElementById("addBlacklistBtn").addEventListener("click", addBlacklistEntry);
  document.getElementById("blacklistInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBlacklistEntry();
  });

  // Theme selector
  document.querySelectorAll(".theme-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      document.querySelectorAll(".theme-option").forEach((o) => o.classList.remove("active"));
      opt.classList.add("active");
      const theme = opt.dataset.theme;
      browser.storage.local.set({ theme });
      applyTheme(theme);
    });
  });
});
