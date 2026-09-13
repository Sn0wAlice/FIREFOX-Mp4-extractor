// background.js — Media Extractor Pro v4.0
// Network interception, badge, downloads, HLS/DASH capture, quality grouping,
// smart rename, blacklist, duplicate detection, stream auto-detection,
// smart dedup, download queue, watch mode, source tracking

const MEDIA_EXTENSIONS = /\.(mp4|webm|mkv|m3u8|mpd|mp3|m4a|ogg|wav|flac|avi|mov)(\?|$)/i;
const MEDIA_CONTENT_TYPES = /^(video|audio)\//i;
const QUALITY_REGEX = /(\d{3,4})p|(\d{3,4})x(\d{3,4})|[_\-.](\d{3,4})[_\-.]/i;

// Patterns that indicate a segment (not a standalone file)
const SEGMENT_EXTENSIONS = /\.(ts|m4s|m4f|aac|fmp4|cmfv|cmfa)(\?|$)/i;
// .m4a and .m4v are standalone media formats that some packagers also emit as
// segments — only treat them as segments when the URL or the size says so
const AMBIGUOUS_SEGMENT_EXTENSIONS = /\.(m4v|m4a)(\?|$)/i;
const AMBIGUOUS_SEGMENT_MAX_SIZE = 2 * 1024 * 1024;
const SEGMENT_URL_PATTERNS = /segment|chunk|frag|seq\d|seg\d|part\d|media=|range=|sq=|\d{4,}\.aac|\d{4,}\.ts/i;

// Store detected media per tab
const tabMedia = {};
// Auto-detected streams per tab: { tabId: Map<streamKey, streamInfo> }
const tabStreams = {};
// HLS manifest data per tab
const tabHLS = {};
// Global download log for duplicate detection
const downloadedFiles = new Map();
// Page titles per tab
const tabTitles = {};
// Watch mode per tab
const tabWatchMode = {};
// Which tabs belong to a private browsing window
const tabPrivate = {};
// Page URL per tab, used as the Referer of our own media requests
const tabPageUrl = {};
// Download queue
const downloadQueue = [];
// Downloads the user asked to stop, keyed by the URL the popup shows
const cancelled = new Set();

function isCancelled(key) { return cancelled.has(key); }

class DownloadCancelled extends Error {
  constructor() { super("Cancelled"); this.cancelled = true; }
}
// How many advertising items were hidden, per tab
const adsHidden = {};
// Tabs whose player streams through Media Source Extensions
const tabUsesMediaSource = {};
let activeDownloads = 0;
let maxConcurrentDownloads = 2;

// ── Options ──
// The badge and the format filter are decided on the hot path of every
// request, so the stored options are mirrored here rather than read each time.

let currentOptions = {};

function refreshOptions() {
  return browser.storage.local.get("options").then((result) => {
    currentOptions = result.options || {};
    return currentOptions;
  });
}

refreshOptions();
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.options) currentOptions = changes.options.newValue || {};
});

// ── What counts as downloadable media ──

// A page that streams through Media Source Extensions gives its <video> a
// blob: URL. It is a handle on a buffer the page filled itself, not something
// that can be fetched or downloaded, so it never belongs in the list — the
// real stream is the one passing through the network layer.
function isFetchableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// Advertising is served by a handful of well-known networks and through a few
// unmistakable path markers. Anything matched here is counted and hidden
// rather than dropped silently, so a false positive stays visible.
const AD_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|2mdn\.net|imasdk\.googleapis\.com|adservice\.google\.[a-z.]+|smartadserver\.com|sascdn\.com|freewheel\.tv|fwmrm\.net|innovid\.com|teads\.tv|spotxchange\.com|spotx\.tv|adsafeprotected\.com|moatads\.com|serving-sys\.com|adnxs\.com|casalemedia\.com|criteo\.(com|net)|taboola\.com|outbrain\.com)$/i;
const AD_PATHS = /\/(ads?|advert\w*|preroll|midroll|postroll|adbreak|ad_break|vast|vmap|creatives?)\//i;

// The format list in the options page decides what is worth listing at all.
function isEnabledFormat(url, formats) {
  if (!formats || formats.length === 0) return true;
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  if (!ext || ext.length > 5) return true; // no extension to judge by
  const known = ["mp4", "webm", "mkv", "avi", "mov", "ts", "m3u8", "mpd", "mp3", "m4a", "ogg", "wav", "flac"];
  if (!known.includes(ext)) return true;
  return formats.includes(ext);
}

function isAdvertising(url) {
  try {
    const u = new URL(url);
    if (AD_HOSTS.test(u.hostname)) return true;
    if (AD_PATHS.test(u.pathname)) return true;
    return /[?&](ad_?type|adtag|slotid|vast|vmap)=/i.test(u.search);
  } catch {
    return false;
  }
}

// ── Utility ──

function getFilenameFromUrl(url) {
  try {
    let path = new URL(url).pathname.split("?")[0].split("/").filter(Boolean);
    return path.length ? decodeURIComponent(path[path.length - 1]) : "media_file";
  } catch {
    return "media_file";
  }
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return "unknown"; }
}

function getMediaType(url) {
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  const videoExts = ["mp4", "webm", "mkv", "avi", "mov"];
  const audioExts = ["mp3", "m4a", "ogg", "wav", "flac"];
  const streamExts = ["m3u8", "mpd"];
  if (videoExts.includes(ext)) return "video";
  if (audioExts.includes(ext)) return "audio";
  if (streamExts.includes(ext)) return "stream";
  return "video";
}

function extractQuality(url) {
  const match = url.match(QUALITY_REGEX);
  if (!match) return null;
  const val = match[1] || match[3] || match[4];
  return val ? parseInt(val) : null;
}

function generateFileHash(url) {
  try {
    const u = new URL(url);
    const clean = u.hostname + u.pathname.replace(/\d{3,4}p/gi, "").replace(/[_\-]\d{3,4}[_\-]/g, "");
    return clean;
  } catch {
    return url;
  }
}

// Smart content fingerprint — groups same content from different sources/CDNs
function getContentFingerprint(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    // Strip common CDN hash paths
    path = path.replace(/\/[a-f0-9]{32,}\//gi, "/H/");
    path = path.replace(/\/v\d+\//g, "/");
    // Get filename
    const filename = path.split("/").filter(Boolean).pop() || "";
    // Normalize: remove quality indicators for grouping
    const normalized = filename
      .replace(/[\._\-]?\d{3,4}p/gi, "")
      .replace(/[\._\-]?\d{3,4}x\d{3,4}/gi, "")
      .replace(/\?.*$/, "");
    // Strip CDN subdomain prefixes
    const domain = u.hostname.replace(/^(cdn|media|video|static|stream|vod|edge|dl)\d*\./, "");
    return domain + "/" + normalized;
  } catch {
    return url;
  }
}

// ── Private browsing ──
// Media found in a private window must stay in the private session: its
// downloads belong to the private download manager, its network requests must
// not carry normal-session cookies, and it must leave nothing in shared state.

function markTabPrivacy(tabId, isPrivate) {
  if (typeof tabId !== "number" || tabId < 0) return;
  if (isPrivate) tabPrivate[tabId] = true;
  else delete tabPrivate[tabId];
}

function isPrivateTab(tabId) {
  return !!tabPrivate[tabId];
}

// Downloads started for a private tab are attached to the private session, so
// they show up in the private download manager and not in normal history.
function startDownload(options, tabId) {
  return browser.downloads.download(
    isPrivateTab(tabId) ? { ...options, incognito: true } : options
  );
}

// Most CDNs reject a segment request that does not carry the Referer of the
// page playing the stream. fetch() refuses to set Referer or Origin, so they
// are injected with a blocking listener scoped to our own background requests.
const pendingRequestHeaders = new Map();

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId !== -1) return;
    const wanted = pendingRequestHeaders.get(details.url);
    if (!wanted) return;

    const headers = (details.requestHeaders || []).filter(
      (h) => !/^(referer|origin)$/i.test(h.name)
    );
    headers.push({ name: "Referer", value: wanted.referer });
    if (wanted.origin) headers.push({ name: "Origin", value: wanted.origin });
    return { requestHeaders: headers };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

// Everything the background page needs to reproduce a tab's request context.
function tabContext(tabId) {
  return { isPrivate: isPrivateTab(tabId), referer: tabPageUrl[tabId] || null };
}

// Requests made on behalf of a private tab are sent without credentials so the
// normal-session cookie jar of the background page is never exposed to the CDN.
async function mediaFetch(url, ctx, range) {
  const referer = ctx && ctx.referer;
  if (referer) {
    const existing = pendingRequestHeaders.get(url);
    if (existing) {
      existing.count++;
    } else {
      let origin = null;
      try { origin = new URL(referer).origin; } catch {}
      pendingRequestHeaders.set(url, { referer, origin, count: 1 });
    }
  }

  const init = {};
  if (ctx && ctx.isPrivate) init.credentials = "omit";
  if (range) init.headers = { Range: `bytes=${range.start}-${range.start + range.length - 1}` };

  try {
    return await fetch(url, init);
  } finally {
    if (referer) {
      const entry = pendingRequestHeaders.get(url);
      if (entry && --entry.count <= 0) pendingRequestHeaders.delete(url);
    }
  }
}

// ── Segments ──
// A segment is { url, start?, length? }. #EXT-X-BYTERANGE playlists point every
// segment at the same URL and distinguish them only by the slice they cover, so
// a segment can never be reduced to its URL.

// #EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x...
// A key served in the clear alongside the playlist is transport encryption,
// part of the HLS specification, and every conforming player decrypts it.
// Anything that needs a licence server is a different matter and is left alone.
function parseKeyLine(value, baseUrl) {
  const method = (value.match(/METHOD=([A-Z0-9-]+)/i) || [])[1] || "NONE";
  if (method === "NONE") return null;

  const uri = (value.match(/URI="([^"]+)"/) || [])[1];
  if (!uri) return null;

  const ivHex = (value.match(/IV=0x([0-9a-f]+)/i) || [])[1] || null;
  return { method: method.toUpperCase(), url: resolveUrl(uri, baseUrl), ivHex };
}

// #EXT-X-MAP:URI="init.mp4",BYTERANGE="719@0"
function parseMapLine(value, baseUrl) {
  const uri = (value.match(/URI="([^"]+)"/) || [])[1];
  if (!uri) return null;

  const segment = { url: resolveUrl(uri, baseUrl) };
  if (!segment.url) return null;

  const rangeText = (value.match(/BYTERANGE="([^"]+)"/) || [])[1];
  if (rangeText) {
    const range = parseByteRange(rangeText);
    if (range) {
      segment.start = range.offset === null ? 0 : range.offset;
      segment.length = range.length;
    }
  }
  return segment;
}

function parseByteRange(value) {
  const [lenPart, offsetPart] = value.trim().split("@");
  const length = parseInt(lenPart, 10);
  if (!Number.isFinite(length) || length <= 0) return null;
  const offset = offsetPart === undefined ? null : parseInt(offsetPart, 10);
  return { length, offset: Number.isFinite(offset) ? offset : null };
}

function segmentRange(segment) {
  return typeof segment.start === "number" ? { start: segment.start, length: segment.length } : null;
}

// A server may ignore Range and answer 200 with the whole resource; slicing
// here keeps that case from concatenating the full file once per segment.
function sliceRangeResponse(buffer, status, range) {
  if (!range || status === 206) return buffer;
  if (buffer.byteLength <= range.start) return new ArrayBuffer(0);
  return buffer.slice(range.start, range.start + range.length);
}

function resolveUrl(raw, baseUrl) {
  try { return new URL(raw, baseUrl).href; } catch { return null; }
}

function isBlacklisted(url, blacklist) {
  if (!blacklist || !blacklist.length) return false;
  const lower = url.toLowerCase();
  return blacklist.some((pattern) => {
    if (pattern.startsWith("/") && pattern.endsWith("/")) {
      try { return new RegExp(pattern.slice(1, -1), "i").test(lower); } catch { return false; }
    }
    return lower.includes(pattern.toLowerCase());
  });
}

function buildSmartFilename(media, pageTitle, pattern) {
  const original = media.filename || getFilenameFromUrl(media.url);
  const domain = media.domain || getDomain(media.url);
  const date = new Date().toISOString().slice(0, 10);
  const ext = original.includes(".") ? "." + original.split(".").pop() : "";
  const base = original.includes(".") ? original.slice(0, original.lastIndexOf(".")) : original;
  const cleanTitle = (pageTitle || "").replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

  switch (pattern) {
    case "title": return cleanTitle ? cleanTitle + ext : original;
    case "title-original": return cleanTitle ? cleanTitle + " - " + base + ext : original;
    case "domain-original": return domain + "_" + original;
    case "date-original": return date + "_" + original;
    case "date-domain-original": return date + "_" + domain + "_" + original;
    case "date-title": return cleanTitle ? date + "_" + cleanTitle + ext : date + "_" + original;
    default: return original;
  }
}

// Batch rename: apply pattern with variables
function applyBatchRename(media, pageTitle, pattern, index, total) {
  const original = media.filename || getFilenameFromUrl(media.url);
  const ext = original.includes(".") ? "." + original.split(".").pop() : "";
  const base = original.includes(".") ? original.slice(0, original.lastIndexOf(".")) : original;
  const domain = media.domain || getDomain(media.url);
  const date = new Date().toISOString().slice(0, 10);
  const cleanTitle = (pageTitle || "").replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const quality = media.quality ? media.quality + "p" : "";
  const padded = String(index + 1).padStart(String(total).length, "0");

  return pattern
    .replace(/\{title\}/gi, cleanTitle || "untitled")
    .replace(/\{filename\}/gi, base)
    .replace(/\{domain\}/gi, domain)
    .replace(/\{date\}/gi, date)
    .replace(/\{quality\}/gi, quality)
    .replace(/\{index\}/gi, padded)
    .replace(/\{ext\}/gi, ext)
    + ext;
}

// ── Segment detection & stream grouping ──

function isSegment(url, contentType, size) {
  if (SEGMENT_EXTENSIONS.test(url)) return true;
  if (SEGMENT_URL_PATTERNS.test(url)) return true;
  const filename = getFilenameFromUrl(url);
  if (/^\d+\.(aac|ts|m4s|m4a|m4v|mp4)$/i.test(filename)) return true;
  if (AMBIGUOUS_SEGMENT_EXTENSIONS.test(url)) {
    return typeof size === "number" && size > 0 && size < AMBIGUOUS_SEGMENT_MAX_SIZE;
  }
  return false;
}

function getStreamKey(url) {
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split("/").filter(Boolean);
    pathParts.pop();
    return u.hostname + "/" + pathParts.join("/");
  } catch {
    return null;
  }
}

function detectStreamType(segments) {
  let hasVideo = false;
  let hasAudio = false;
  for (const seg of segments) {
    const ext = seg.url.split("?")[0].split(".").pop().toLowerCase();
    if (["ts", "m4v", "cmfv", "fmp4"].includes(ext)) hasVideo = true;
    if (["aac", "m4a", "cmfa"].includes(ext)) hasAudio = true;
    const ct = seg.contentType || "";
    if (ct.startsWith("video/")) hasVideo = true;
    if (ct.startsWith("audio/")) hasAudio = true;
  }
  if (hasVideo && hasAudio) return "video+audio";
  if (hasVideo) return "video";
  if (hasAudio) return "audio";
  return "video";
}

function addSegmentToStream(tabId, segmentInfo) {
  // An ad break is its own little stream; letting its segments through would
  // create a phantom entry next to the real one.
  if (isAdvertising(segmentInfo.url)) {
    adsHidden[tabId] = (adsHidden[tabId] || 0) + 1;
    return;
  }
  if (!tabStreams[tabId]) tabStreams[tabId] = new Map();

  const key = getStreamKey(segmentInfo.url);
  if (!key) return;

  if (!tabStreams[tabId].has(key)) {
    tabStreams[tabId].set(key, {
      key,
      domain: getDomain(segmentInfo.url),
      segments: [],
      totalSize: 0,
      firstSeen: Date.now(),
      contentTypes: new Set(),
      manifestUrl: null
    });
  }

  const stream = tabStreams[tabId].get(key);
  stream.segments.push({
    url: segmentInfo.url,
    size: segmentInfo.size || 0,
    contentType: segmentInfo.contentType || "",
    timestamp: Date.now()
  });
  stream.totalSize += segmentInfo.size || 0;
  if (segmentInfo.contentType) stream.contentTypes.add(segmentInfo.contentType);

  if (stream.segments.length >= 3) {
    updateStreamEntry(tabId, key, stream);
  }
}

function updateStreamEntry(tabId, key, stream) {
  if (!tabMedia[tabId]) tabMedia[tabId] = new Map();

  const streamType = detectStreamType(stream.segments);
  const quality = extractQuality(stream.segments[0]?.url || "");
  const streamId = "stream://" + key;

  const pathParts = key.split("/").filter(Boolean);
  const displayName = pathParts.length > 1
    ? pathParts.slice(-2).join("/")
    : pathParts[pathParts.length - 1] || "stream";

  const mediaEntry = {
    url: streamId,
    realUrls: stream.segments.map((s) => s.url),
    domain: stream.domain,
    filename: displayName + (streamType.includes("audio") && !streamType.includes("video") ? ".aac" : ".ts"),
    type: "stream",
    streamType,
    size: stream.totalSize,
    segmentCount: stream.segments.length,
    quality,
    source: "auto-detected",
    isConsolidatedStream: true,
    streamKey: key,
    manifestUrl: stream.manifestUrl,
    fingerprint: "stream:" + key
  };

  tabMedia[tabId].set(streamId, mediaEntry);
  updateBadge(tabId);

  // Watch mode: auto-queue new streams
  if (tabWatchMode[tabId] && !mediaEntry._watchQueued) {
    mediaEntry._watchQueued = true;
    notifyWatchMode(tabId, mediaEntry);
  }
}

// ── Regular media (non-segment) ──

function addMediaToTab(tabId, mediaInfo) {
  if (!isFetchableUrl(mediaInfo.url)) return;
  if (!tabMedia[tabId]) tabMedia[tabId] = new Map();

  browser.storage.local.get("options").then((result) => {
    const opts = result.options || {};
    const blacklist = opts.blacklist || [];
    if (isBlacklisted(mediaInfo.url, blacklist)) return;

    if (opts.hideAds !== false && isAdvertising(mediaInfo.url)) {
      adsHidden[tabId] = (adsHidden[tabId] || 0) + 1;
      return;
    }

    if (!isEnabledFormat(mediaInfo.url, opts.formats)) return;

    if (mediaInfo.size) {
      if (opts.minSize && mediaInfo.size < opts.minSize * 1024) return;
      if (opts.maxSize && mediaInfo.size > opts.maxSize * 1024 * 1024) return;
    }

    if (!mediaInfo.quality) mediaInfo.quality = extractQuality(mediaInfo.url);
    mediaInfo.groupHash = generateFileHash(mediaInfo.url);
    mediaInfo.fingerprint = getContentFingerprint(mediaInfo.url);

    const fileHash = mediaInfo.domain + "/" + mediaInfo.filename;
    if (downloadedFiles.has(fileHash)) mediaInfo.duplicate = downloadedFiles.get(fileHash);

    if (!tabMedia[tabId].has(mediaInfo.url)) {
      // Check if we already have a dupe by fingerprint — merge if so
      let dominated = false;
      for (const [existingUrl, existing] of tabMedia[tabId]) {
        if (existing.fingerprint === mediaInfo.fingerprint && existingUrl !== mediaInfo.url) {
          // Merge: keep the one with more info
          if (!existing.size && mediaInfo.size) {
            existing.size = mediaInfo.size;
          }
          if (!existing.quality && mediaInfo.quality) {
            existing.quality = mediaInfo.quality;
          }
          if (!existing.altSources) existing.altSources = [];
          existing.altSources.push(mediaInfo.source);
          if (mediaInfo.source === "network" && existing.source === "dom") {
            // Upgrade source
            existing.size = mediaInfo.size || existing.size;
            existing.contentType = mediaInfo.contentType || existing.contentType;
          }
          dominated = true;
          break;
        }
      }

      if (!dominated) {
        tabMedia[tabId].set(mediaInfo.url, mediaInfo);
        updateBadge(tabId);

        // Watch mode: auto-queue new media
        if (tabWatchMode[tabId] && !mediaInfo._watchQueued) {
          mediaInfo._watchQueued = true;
          notifyWatchMode(tabId, mediaInfo);
        }
      }
    }
  });
}

function notifyWatchMode(tabId, media) {
  browser.runtime.sendMessage({
    action: "watch_new_media",
    tabId,
    media
  }).catch(() => {});
}

function updateBadge(tabId) {
  const count = tabMedia[tabId] ? tabMedia[tabId].size : 0;
  const text = currentOptions.showBadge === false ? "" : (count > 0 ? String(count) : "");
  browser.browserAction.setBadgeText({ text, tabId });
  browser.browserAction.setBadgeBackgroundColor({ color: count > 0 ? "#7c3aed" : "#666", tabId });
}

// ── HLS/DASH parsing ──

async function parseM3U8(url, ctx) {
  try {
    const resp = await mediaFetch(url, ctx);
    const text = await resp.text();
    const lines = text.split("\n").map((l) => l.trim());
    const result = {
      masterUrl: url, variants: [], segments: [],
      audioGroups: [], subtitleGroups: [], totalDuration: 0
    };

    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    if (isMaster) {
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-MEDIA")) continue;

        const isAudio = lines[i].includes("TYPE=AUDIO");
        const isSubtitles = lines[i].includes("TYPE=SUBTITLES");
        if (!isAudio && !isSubtitles) continue;

        const uriMatch = lines[i].match(/URI="([^"]+)"/);
        if (!uriMatch) continue;
        const mediaUrl = resolveUrl(uriMatch[1], url);
        if (!mediaUrl) continue;

        const nameMatch = lines[i].match(/NAME="([^"]+)"/);
        const langMatch = lines[i].match(/LANGUAGE="([^"]+)"/);
        const rendition = {
          url: mediaUrl,
          name: nameMatch ? nameMatch[1] : (isAudio ? "audio" : "subtitles"),
          language: langMatch ? langMatch[1] : null
        };

        if (isAudio) result.audioGroups.push(rendition);
        else result.subtitleGroups.push(rendition);
      }

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
          const info = lines[i];
          const bwMatch = info.match(/BANDWIDTH=(\d+)/);
          const resMatch = info.match(/RESOLUTION=(\d+)x(\d+)/);
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.startsWith("#")) {
            const variantUrl = resolveUrl(nextLine, url);
            if (!variantUrl) continue;
            result.variants.push({
              url: variantUrl,
              bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
              width: resMatch ? parseInt(resMatch[1]) : 0,
              height: resMatch ? parseInt(resMatch[2]) : 0,
              quality: resMatch ? parseInt(resMatch[2]) : null
            });
          }
        }
      }
    } else {
      // Media playlist — also sum duration
      let duration = 0;
      let pendingRange = null;
      // #EXT-X-BYTERANGE may omit the offset, which then means "straight after
      // the previous sub-range of the same resource".
      const nextOffset = new Map();
      // The key in force applies to every segment until another one is declared.
      let currentKey = null;
      let sequence = 0;

      for (const line of lines) {
        if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
          sequence = parseInt(line.split(":")[1], 10) || 0;
          continue;
        }
        if (line.startsWith("#EXTINF:")) {
          const dur = parseFloat(line.split(":")[1]);
          if (!isNaN(dur)) duration += dur;
          continue;
        }
        if (line.startsWith("#EXT-X-BYTERANGE:")) {
          pendingRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length));
          continue;
        }
        if (line.startsWith("#EXT-X-KEY:")) {
          currentKey = parseKeyLine(line.slice("#EXT-X-KEY:".length), url);
          continue;
        }
        // The initialisation segment of a fragmented MP4 stream: it carries
        // ftyp and moov, without which the media segments mean nothing.
        if (line.startsWith("#EXT-X-MAP:")) {
          result.initSegment = parseMapLine(line.slice("#EXT-X-MAP:".length), url);
          continue;
        }
        if (!line || line.startsWith("#")) continue;

        const segUrl = resolveUrl(line, url);
        const range = pendingRange;
        pendingRange = null;
        if (!segUrl) continue;

        const segment = { url: segUrl };
        if (currentKey) {
          segment.key = currentKey;
          // AES-128 defaults the initialisation vector to the media sequence
          // number of the segment when the playlist does not give one.
          segment.mediaSequence = sequence + result.segments.length;
        }
        if (range) {
          const start = range.offset === null ? (nextOffset.get(segUrl) || 0) : range.offset;
          segment.start = start;
          segment.length = range.length;
          nextOffset.set(segUrl, start + range.length);
        }
        result.segments.push(segment);
      }
      result.totalDuration = duration;
    }

    return result;
  } catch {
    return null;
  }
}

// ── MPEG-DASH ──
// An MPD describes each track as a template to expand rather than a list of
// URLs. Two shapes cover nearly every stream in the wild: a fixed segment
// duration with a numbered template, and an explicit SegmentTimeline. Both are
// handled here; the segments themselves are fragmented MP4, which the rest of
// the pipeline already knows how to assemble.

function parseIsoDuration(value) {
  if (!value) return 0;
  const m = value.match(/^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m.map((x) => (x === undefined ? 0 : parseFloat(x)));
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600 + mi * 60 + sec;
}

// BaseURL may appear at every level and each one resolves against the one above.
function resolveBaseUrl(element, documentUrl) {
  const chain = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentNode) {
    const own = Array.from(node.children || []).find((c) => c.nodeName === "BaseURL");
    if (own && own.textContent.trim()) chain.unshift(own.textContent.trim());
  }
  return chain.reduce((base, part) => resolveUrl(part, base) || base, documentUrl);
}

function expandTemplate(template, values) {
  return template.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (whole, name, width) => {
    const value = values[name];
    if (value === undefined || value === null) return whole;
    const text = String(value);
    return width ? text.padStart(parseInt(width, 10), "0") : text;
  }).replace(/\$\$/g, "$");
}

function firstChild(element, name) {
  return Array.from(element.children || []).find((c) => c.nodeName === name) || null;
}

// Expands one SegmentTemplate into the ordered list of segments of a track.
function segmentsFromTemplate(template, representation, baseUrl, totalDuration) {
  const media = template.getAttribute("media");
  if (!media) return [];

  const values = {
    RepresentationID: representation.getAttribute("id"),
    Bandwidth: representation.getAttribute("bandwidth")
  };
  const segments = [];

  const initTemplate = template.getAttribute("initialization");
  if (initTemplate) {
    const initUrl = resolveUrl(expandTemplate(initTemplate, values), baseUrl);
    if (initUrl) segments.push({ url: initUrl });
  }

  const timescale = parseFloat(template.getAttribute("timescale")) || 1;
  const startNumber = parseInt(template.getAttribute("startNumber"), 10);
  let number = Number.isFinite(startNumber) ? startNumber : 1;

  const timeline = firstChild(template, "SegmentTimeline");
  if (timeline) {
    let time = 0;
    for (const entry of Array.from(timeline.children)) {
      if (entry.nodeName !== "S") continue;
      const t = parseFloat(entry.getAttribute("t"));
      if (Number.isFinite(t)) time = t;
      const d = parseFloat(entry.getAttribute("d")) || 0;
      const repeat = parseInt(entry.getAttribute("r"), 10) || 0;

      for (let i = 0; i <= repeat; i++) {
        const url = resolveUrl(expandTemplate(media, { ...values, Number: number, Time: time }), baseUrl);
        if (url) segments.push({ url });
        time += d;
        number++;
      }
    }
    return segments;
  }

  const segmentDuration = parseFloat(template.getAttribute("duration"));
  if (!segmentDuration || !totalDuration) return segments;

  const count = Math.ceil(totalDuration / (segmentDuration / timescale));
  for (let i = 0; i < count; i++) {
    const url = resolveUrl(expandTemplate(media, { ...values, Number: number + i, Time: i * segmentDuration }), baseUrl);
    if (url) segments.push({ url });
  }
  return segments;
}

// A SegmentList spells every segment out instead of templating them.
function segmentsFromList(list, baseUrl) {
  const segments = [];
  const init = firstChild(list, "Initialization");
  if (init && init.getAttribute("sourceURL")) {
    const url = resolveUrl(init.getAttribute("sourceURL"), baseUrl);
    if (url) segments.push({ url });
  }
  for (const entry of Array.from(list.children)) {
    if (entry.nodeName !== "SegmentURL") continue;
    const url = resolveUrl(entry.getAttribute("media") || "", baseUrl);
    if (url) segments.push({ url });
  }
  return segments;
}

function representationTrack(representation, adaptationSet, documentUrl, totalDuration) {
  const baseUrl = resolveBaseUrl(representation, documentUrl);
  const template = firstChild(representation, "SegmentTemplate") || firstChild(adaptationSet, "SegmentTemplate");
  const list = firstChild(representation, "SegmentList") || firstChild(adaptationSet, "SegmentList");

  let segments = [];
  if (template) segments = segmentsFromTemplate(template, representation, baseUrl, totalDuration);
  else if (list) segments = segmentsFromList(list, baseUrl);
  else {
    // No template and no list: the representation is one plain file.
    const own = firstChild(representation, "BaseURL");
    if (own) segments = [{ url: baseUrl }];
  }

  return {
    id: representation.getAttribute("id"),
    bandwidth: parseInt(representation.getAttribute("bandwidth"), 10) || 0,
    width: parseInt(representation.getAttribute("width"), 10) || 0,
    height: parseInt(representation.getAttribute("height"), 10) || 0,
    segments
  };
}

async function parseMPD(url, ctx) {
  try {
    const resp = await mediaFetch(url, ctx);
    if (!resp.ok) return null;

    const doc = new DOMParser().parseFromString(await resp.text(), "application/xml");
    const mpd = doc.documentElement;
    if (!mpd || mpd.nodeName === "parsererror" || mpd.nodeName !== "MPD") return null;

    const totalDuration = parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));
    const period = doc.getElementsByTagName("Period")[0];
    if (!period) return null;

    const result = { manifestUrl: url, video: [], audio: [], totalDuration, isDash: true };

    for (const set of Array.from(period.children)) {
      if (set.nodeName !== "AdaptationSet") continue;

      const mime = set.getAttribute("mimeType") || "";
      const kind = set.getAttribute("contentType") || mime.split("/")[0];
      if (kind !== "video" && kind !== "audio") continue;

      for (const representation of Array.from(set.children)) {
        if (representation.nodeName !== "Representation") continue;
        const track = representationTrack(representation, set, url, totalDuration);
        if (track.segments.length > 0) result[kind].push(track);
      }
    }

    if (result.video.length === 0 && result.audio.length === 0) return null;
    return result;
  } catch {
    return null;
  }
}

// Picks the requested height, or the richest track otherwise, and returns the
// same shape the HLS side produces.
function dashSegments(parsed, qualityHeight) {
  const byQuality = (tracks) => {
    if (tracks.length === 0) return null;
    const wanted = qualityHeight && tracks.find((t) => t.height === qualityHeight);
    return wanted || tracks.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
  };

  const video = byQuality(parsed.video);
  const audio = byQuality(parsed.audio);

  return {
    video: video ? video.segments : [],
    // DASH always keeps audio in its own track, so it is written as its own file.
    audio: video && audio ? audio.segments : (audio ? audio.segments : []),
    subtitles: [],
    duration: parsed.totalDuration || 0,
    fragmentedMp4: true
  };
}

// ── TS → MP4 Transmuxing via mux.js ──

function transmuxTStoMP4(tsData) {
  return new Promise((resolve, reject) => {
    try {
      const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
      const mp4Segments = [];

      transmuxer.on("data", (segment) => {
        const combined = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
        combined.set(segment.initSegment, 0);
        combined.set(segment.data, segment.initSegment.byteLength);
        mp4Segments.push(combined);
      });

      transmuxer.on("done", () => {
        if (mp4Segments.length === 0) {
          reject(new Error("Transmux produced no output"));
          return;
        }
        const totalSize = mp4Segments.reduce((s, c) => s + c.byteLength, 0);
        const merged = new Uint8Array(totalSize);
        let offset = 0;
        for (const seg of mp4Segments) {
          merged.set(seg, offset);
          offset += seg.byteLength;
        }
        resolve(merged);
      });

      transmuxer.push(tsData);
      transmuxer.flush();
    } catch (err) {
      reject(err);
    }
  });
}

// ── Unified download: uses captured segments first, manifest re-fetch as fallback ──

// progressKey is the URL the popup shows for this item. It differs from the
// manifest URL whenever a consolidated stream is downloaded through its
// manifest, and reporting on the wrong key leaves the popup without a bar.
async function downloadStream(tabId, url, filename, qualityHeight, progressKey = url) {
  const ctx = tabContext(tabId);

  const capturedSegments = collectCapturedSegments(tabId, url);

  let manifest = null;
  if (/\.m3u8(\?|$)/i.test(url)) {
    manifest = await getManifestSegments(url, qualityHeight, ctx);
  } else if (/\.mpd(\?|$)/i.test(url)) {
    const mpd = await parseMPD(url, ctx);
    if (mpd) manifest = dashSegments(mpd, qualityHeight);
  }

  let segmentUrls = [];
  let audioSegmentUrls = [];
  let playlistDuration = 0;
  let fragmentedMp4 = false;
  let subtitleTracks = [];
  let source = "";

  if (manifest && manifest.video.length > 0) {
    segmentUrls = manifest.video;
    audioSegmentUrls = manifest.audio;
    playlistDuration = manifest.duration || 0;
    fragmentedMp4 = !!manifest.fragmentedMp4;
    subtitleTracks = manifest.subtitles || [];
    source = "manifest";
  } else if (capturedSegments.length > 0) {
    segmentUrls = capturedSegments;
    source = "captured";
  } else {
    const storedParsed = tabHLS[tabId] && tabHLS[tabId].get(url);
    if (storedParsed) {
      const stored = await getSegmentsFromStoredManifest(storedParsed, qualityHeight, ctx);
      segmentUrls = stored.video;
      audioSegmentUrls = stored.audio;
      playlistDuration = stored.duration || 0;
      fragmentedMp4 = !!stored.fragmentedMp4;
      subtitleTracks = stored.subtitles || [];
      source = "stored";
    }
  }

  if (segmentUrls.length === 0) {
    return { error: "No segments found. Try playing the video fully first, then download." };
  }

  reportProgress(progressKey, 1, `Found ${segmentUrls.length} segments (${source})`);

  const video = await downloadSegmentsWithProgress(
    segmentUrls, progressKey, 0, segmentUrls.length, ctx
  );

  const incomplete = segmentFailureError(video, segmentUrls.length, ctx);
  if (incomplete) return incomplete;

  const result = await writeSegmentsAsVideo(
    video.chunks, filename, progressKey, tabId, playlistDuration, fragmentedMp4
  );
  result.segments = segmentUrls.length;

  // A separate audio rendition cannot be muxed into the video stream here, so
  // it is written as its own file instead of being appended to the video.
  if (audioSegmentUrls.length > 0) {
    const audio = await downloadAudioRendition(audioSegmentUrls, filename, progressKey, tabId, ctx);
    if (audio) {
      result.separateAudio = true;
      result.audioFilename = audio.filename;
    }
  }

  if (subtitleTracks.length > 0) {
    reportProgress(progressKey, -1, "Downloading subtitles...");
    const written = [];
    for (let i = 0; i < subtitleTracks.length; i++) {
      try {
        const name = await downloadSubtitleTrack(subtitleTracks[i], filename, tabId, ctx, i);
        if (name) written.push(name);
      } catch {}
    }
    if (written.length > 0) result.subtitles = written;
  }

  return result;
}

// A stream stitched from a partial segment list plays back broken, so a run
// that lost segments fails loudly instead of writing a corrupt file.
function segmentFailureError(result, total, ctx) {
  if (result.chunks.length === 0) {
    return {
      error: ctx.referer
        ? "Every segment request failed — the server refused them."
        : "Every segment request failed. Reload the page so the extension sees it, then retry."
    };
  }
  if (result.failed / total > 0.02) {
    return { error: `${result.failed} of ${total} segments failed — output would be broken.` };
  }
  return null;
}

// ── Fragmented MP4 header repair ──
// mux.js stamps 0xFFFFFFFF, the "unknown duration" value, into every duration
// field of the init segment. Media Source Extensions does not care, which is
// why the file plays in a browser, but desktop players read those fields and
// show 13 or 24 hours and refuse to seek. Once every fragment has been
// downloaded the real duration is known, so it is written back into the header.

const UNKNOWN_DURATION = 0xffffffff;

function readBoxes(view, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    const size = view.getUint32(off);
    if (size < 8 || off + size > end) break;
    const type = String.fromCharCode(
      view.getUint8(off + 4), view.getUint8(off + 5),
      view.getUint8(off + 6), view.getUint8(off + 7)
    );
    boxes.push({ type, body: off + 8, end: off + size });
    off += size;
  }
  return boxes;
}

function findBox(view, parent, type) {
  return readBoxes(view, parent.body, parent.end).find((b) => b.type === type) || null;
}

// mvhd and mdhd share the layout of the two fields we care about.
function headerFields(view, box) {
  return view.getUint8(box.body) === 1
    ? { timescaleAt: box.body + 20, durationAt: box.body + 24, wide: true }
    : { timescaleAt: box.body + 12, durationAt: box.body + 16, wide: false };
}

function trackHeaderFields(view, box) {
  return view.getUint8(box.body) === 1
    ? { trackIdAt: box.body + 20, durationAt: box.body + 28, wide: true }
    : { trackIdAt: box.body + 12, durationAt: box.body + 20, wide: false };
}

function writeDuration(view, at, wide, value) {
  const v = Math.max(0, Math.round(value));
  if (wide) {
    view.setUint32(at, Math.floor(v / 4294967296));
    view.setUint32(at + 4, v >>> 0);
  } else {
    view.setUint32(at, Math.min(v, UNKNOWN_DURATION - 1));
  }
}

function sumTrunDurations(view, trun, defaultSampleDuration) {
  const flags = view.getUint32(trun.body) & 0xffffff;
  const count = view.getUint32(trun.body + 4);
  if (!(flags & 0x000100)) return count * (defaultSampleDuration || 0);

  let off = trun.body + 8;
  if (flags & 0x000001) off += 4;
  if (flags & 0x000004) off += 4;

  const stride =
    4 +
    ((flags & 0x000200) ? 4 : 0) +
    ((flags & 0x000400) ? 4 : 0) +
    ((flags & 0x000800) ? 4 : 0);

  let total = 0;
  for (let i = 0; i < count && off + stride <= trun.end; i++) {
    total += view.getUint32(off);
    off += stride;
  }
  return total;
}

// Falls back to the fragments themselves when no playlist duration is known:
// the last fragment's decode time plus the samples it carries is the exact end.
function measureFragmentDuration(view, topBoxes, tracks) {
  const defaults = new Map();
  for (const t of tracks) defaults.set(t.id, t.defaultSampleDuration);

  const endByTrack = new Map();
  for (const box of topBoxes) {
    if (box.type !== "moof") continue;
    for (const traf of readBoxes(view, box.body, box.end)) {
      if (traf.type !== "traf") continue;

      const tfhd = findBox(view, traf, "tfhd");
      const tfdt = findBox(view, traf, "tfdt");
      if (!tfhd || !tfdt) continue;

      const trackId = view.getUint32(tfhd.body + 4);
      const base = view.getUint8(tfdt.body) === 1
        ? view.getUint32(tfdt.body + 4) * 4294967296 + view.getUint32(tfdt.body + 8)
        : view.getUint32(tfdt.body + 4);

      let samples = 0;
      for (const trun of readBoxes(view, traf.body, traf.end)) {
        if (trun.type === "trun") samples += sumTrunDurations(view, trun, defaults.get(trackId));
      }
      endByTrack.set(trackId, Math.max(endByTrack.get(trackId) || 0, base + samples));
    }
  }

  let seconds = 0;
  for (const t of tracks) {
    const end = endByTrack.get(t.id);
    if (end && t.timescale) seconds = Math.max(seconds, end / t.timescale);
  }
  return seconds;
}

function repairFragmentedMp4Duration(bytes, knownDuration) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = readBoxes(view, 0, bytes.byteLength);

  const moov = top.find((b) => b.type === "moov");
  if (!moov) return 0;

  const mvhd = findBox(view, moov, "mvhd");
  if (!mvhd) return 0;

  const movie = headerFields(view, mvhd);
  const movieTimescale = view.getUint32(movie.timescaleAt);
  if (!movieTimescale) return 0;

  const mvex = findBox(view, moov, "mvex");
  const trexDefaults = new Map();
  if (mvex) {
    for (const trex of readBoxes(view, mvex.body, mvex.end)) {
      if (trex.type === "trex") trexDefaults.set(view.getUint32(trex.body + 4), view.getUint32(trex.body + 12));
    }
  }

  const tracks = [];
  for (const trak of readBoxes(view, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = findBox(view, trak, "tkhd");
    const mdia = findBox(view, trak, "mdia");
    const mdhd = mdia && findBox(view, mdia, "mdhd");
    if (!tkhd || !mdhd) continue;

    const th = trackHeaderFields(view, tkhd);
    const mh = headerFields(view, mdhd);
    const id = view.getUint32(th.trackIdAt);
    tracks.push({
      id, tkhd, mdhd, th, mh,
      timescale: view.getUint32(mh.timescaleAt),
      defaultSampleDuration: trexDefaults.get(id) || 0
    });
  }

  const seconds = knownDuration > 0 ? knownDuration : measureFragmentDuration(view, top, tracks);
  if (!(seconds > 0)) return 0;

  writeDuration(view, movie.durationAt, movie.wide, seconds * movieTimescale);
  for (const t of tracks) {
    writeDuration(view, t.th.durationAt, t.th.wide, seconds * movieTimescale);
    if (t.timescale) writeDuration(view, t.mh.durationAt, t.mh.wide, seconds * t.timescale);
  }
  return seconds;
}

// ── Fragmented MP4 → progressive MP4 ──
// mux.js can only emit a fragmented MP4, the shape Media Source Extensions
// consumes: the sample tables in `moov` are left empty and every sample is
// described inside the `moof` boxes instead. A browser reads that happily,
// which is why the file previews in VS Code, but VLC and QuickTime read the
// tables in `moov`, find nothing, and open an empty movie. This rebuilds the
// file the way a player on disk expects it: real sample tables, one `mdat`,
// no fragments.

function box(type, ...parts) {
  let length = 8;
  for (const part of parts) length += part.length;

  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);

  let off = 8;
  for (const part of parts) { out.set(part, off); off += part.length; }
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v >>> 0));
  return out;
}

function u32From(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v >>> 0));
  return out;
}

function parseTrun(view, trun, defaults) {
  const version = view.getUint8(trun.body);
  const flags = view.getUint32(trun.body) & 0xffffff;
  const count = view.getUint32(trun.body + 4);

  let off = trun.body + 8;
  let dataOffset = 0;
  if (flags & 0x000001) { dataOffset = view.getInt32(off); off += 4; }
  let firstFlags = null;
  if (flags & 0x000004) { firstFlags = view.getUint32(off); off += 4; }

  const samples = [];
  for (let i = 0; i < count; i++) {
    const sample = {
      duration: defaults.duration,
      size: defaults.size,
      flags: i === 0 && firstFlags !== null ? firstFlags : defaults.flags,
      cto: 0
    };
    if (flags & 0x000100) { sample.duration = view.getUint32(off); off += 4; }
    if (flags & 0x000200) { sample.size = view.getUint32(off); off += 4; }
    if (flags & 0x000400) { sample.flags = view.getUint32(off); off += 4; }
    if (flags & 0x000800) {
      sample.cto = version === 0 ? view.getUint32(off) : view.getInt32(off);
      off += 4;
    }
    samples.push(sample);
  }
  return { samples, dataOffset };
}

// Walks every fragment and returns, per track, the flat list of samples with
// their absolute position in the file.
function collectFragmentSamples(view, length) {
  const tracks = new Map();

  for (const moof of readBoxes(view, 0, length)) {
    if (moof.type !== "moof") continue;
    const moofStart = moof.body - 8;

    for (const traf of readBoxes(view, moof.body, moof.end)) {
      if (traf.type !== "traf") continue;

      const tfhd = findBox(view, traf, "tfhd");
      if (!tfhd) continue;

      const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
      const trackId = view.getUint32(tfhd.body + 4);

      let off = tfhd.body + 8;
      // Absent an explicit base, the spec anchors sample data to the moof.
      let base = moofStart;
      if (tfhdFlags & 0x000001) {
        base = view.getUint32(off) * 4294967296 + view.getUint32(off + 4);
        off += 8;
      }
      if (tfhdFlags & 0x000002) off += 4;

      const defaults = { duration: 0, size: 0, flags: 0 };
      if (tfhdFlags & 0x000008) { defaults.duration = view.getUint32(off); off += 4; }
      if (tfhdFlags & 0x000010) { defaults.size = view.getUint32(off); off += 4; }
      if (tfhdFlags & 0x000020) { defaults.flags = view.getUint32(off); off += 4; }

      if (!tracks.has(trackId)) tracks.set(trackId, { id: trackId, samples: [], startTime: null });
      const track = tracks.get(trackId);

      // A track whose first fragment does not start at zero is offset against
      // the others. A sample table always starts at zero, so that offset has
      // to be carried over as an edit list or the tracks drift apart.
      if (track.startTime === null) {
        const tfdt = findBox(view, traf, "tfdt");
        if (tfdt) {
          track.startTime = view.getUint8(tfdt.body) === 1
            ? view.getUint32(tfdt.body + 4) * 4294967296 + view.getUint32(tfdt.body + 8)
            : view.getUint32(tfdt.body + 4);
        }
      }

      for (const trun of readBoxes(view, traf.body, traf.end)) {
        if (trun.type !== "trun") continue;
        const { samples, dataOffset } = parseTrun(view, trun, defaults);
        let at = base + dataOffset;
        for (const sample of samples) {
          sample.offset = at;
          at += sample.size;
          track.samples.push(sample);
        }
      }
    }
  }
  return tracks;
}

function buildStts(samples) {
  const entries = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last[1] === sample.duration) last[0]++;
    else entries.push([1, sample.duration]);
  }
  return box("stts", u32(0, entries.length), u32From(entries.flat()));
}

function buildCtts(samples) {
  if (!samples.some((s) => s.cto !== 0)) return null;
  const signed = samples.some((s) => s.cto < 0);

  const entries = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last[1] === sample.cto) last[0]++;
    else entries.push([1, sample.cto]);
  }

  const payload = new Uint8Array(entries.length * 8);
  const view = new DataView(payload.buffer);
  entries.forEach(([count, offset], i) => {
    view.setUint32(i * 8, count);
    if (signed) view.setInt32(i * 8 + 4, offset);
    else view.setUint32(i * 8 + 4, offset);
  });

  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, signed ? 0x01000000 : 0);
  new DataView(header.buffer).setUint32(4, entries.length);
  return box("ctts", header, payload);
}

function buildStsz(samples) {
  const uniform = samples.length > 0 && samples.every((s) => s.size === samples[0].size);
  if (uniform) return box("stsz", u32(0, samples[0].size, samples.length));
  return box("stsz", u32(0, 0, samples.length), u32From(samples.map((s) => s.size)));
}

// Sync samples are the ones a player can seek to; without stss it assumes all
// of them are, which makes seeking land on broken frames.
function buildStss(samples) {
  const sync = [];
  samples.forEach((s, i) => { if (!(s.flags & 0x00010000)) sync.push(i + 1); });
  if (sync.length === 0 || sync.length === samples.length) return null;
  return box("stss", u32(0, sync.length), u32From(sync));
}

// An empty edit at the head of the track delays it by exactly the decode time
// its first fragment declared.
function buildDelayEdit(startTicks, mediaTimescale, movieTimescale, trackTicks) {
  if (!startTicks || !mediaTimescale) return null;

  const delay = Math.round((startTicks / mediaTimescale) * movieTimescale);
  if (delay <= 0) return null;

  const payload = new Uint8Array(4 + 4 + 24);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0);          // version 0, no flags
  view.setUint32(4, 2);          // two edits
  view.setUint32(8, delay);      // empty edit: duration ...
  view.setInt32(12, -1);         // ... with no media behind it
  view.setUint32(16, 0x00010000);
  view.setUint32(20, Math.round((trackTicks / mediaTimescale) * movieTimescale));
  view.setInt32(24, 0);          // then the track from its start
  view.setUint32(28, 0x00010000);

  return box("edts", box("elst", payload));
}

function buildStbl(view, originalStbl, samples, useCo64) {
  const stsd = findBox(view, originalStbl, "stsd");
  if (!stsd) return null;

  const stsdBytes = new Uint8Array(view.buffer, view.byteOffset + stsd.body - 8, stsd.end - stsd.body + 8);

  const parts = [
    stsdBytes.slice(),
    buildStts(samples),
    // One chunk per track: every sample of the track sits in it.
    box("stsc", u32(0, 1), u32(1, samples.length, 1)),
    buildStsz(samples),
    useCo64
      ? box("co64", u32(0, 1), new Uint8Array(8))
      : box("stco", u32(0, 1), u32(0))
  ];

  const ctts = buildCtts(samples);
  if (ctts) parts.splice(2, 0, ctts);
  const stss = buildStss(samples);
  if (stss) parts.push(stss);

  return box("stbl", ...parts);
}

// Rebuilds moov, dropping mvex and swapping each track's empty sample table
// for the real one. Everything else, stsd in particular, is copied verbatim.
function rebuildMoov(view, moov, tracks, useCo64, movieTimescale) {
  const children = [];
  let trackIndex = 0;

  for (const child of readBoxes(view, moov.body, moov.end)) {
    if (child.type === "mvex") continue; // no fragments in the output

    if (child.type !== "trak") {
      children.push(new Uint8Array(view.buffer, view.byteOffset + child.body - 8, child.end - child.body + 8).slice());
      continue;
    }

    const tkhd = findBox(view, child, "tkhd");
    const mdia = tkhd && findBox(view, child, "mdia");
    const minf = mdia && findBox(view, mdia, "minf");
    const stbl = minf && findBox(view, minf, "stbl");
    const trackId = tkhd ? view.getUint32(trackHeaderFields(view, tkhd).trackIdAt) : null;
    const track = trackId !== null ? tracks.get(trackId) : null;

    if (!stbl || !track || track.samples.length === 0) {
      children.push(new Uint8Array(view.buffer, view.byteOffset + child.body - 8, child.end - child.body + 8).slice());
      trackIndex++;
      continue;
    }

    const newStbl = buildStbl(view, stbl, track.samples, useCo64);
    if (!newStbl) return null;

    const newMinf = rebuildContainer(view, minf, "stbl", newStbl);
    const newMdia = rebuildContainer(view, mdia, "minf", newMinf);

    const mdhd = findBox(view, mdia, "mdhd");
    const mediaTimescale = mdhd ? view.getUint32(headerFields(view, mdhd).timescaleAt) : 0;
    const trackTicks = track.samples.reduce((total, sample) => total + sample.duration, 0);
    const edts = buildDelayEdit(track.startTime, mediaTimescale, movieTimescale, trackTicks);

    children.push(rebuildTrak(view, child, newMdia, edts));
    trackIndex++;
  }

  const rebuilt = box("moov", ...children);
  applyProgressiveDurations(rebuilt, tracks, movieTimescale);
  return rebuilt;
}

// Rebuilds a trak with the new mdia, and with the edit list swapped in or
// dropped depending on whether the track needs one.
function rebuildTrak(view, trak, newMdia, edts) {
  const parts = [];
  for (const child of readBoxes(view, trak.body, trak.end)) {
    if (child.type === "edts") continue;
    if (child.type === "mdia") {
      if (edts) parts.push(edts);
      parts.push(newMdia);
      continue;
    }
    parts.push(new Uint8Array(view.buffer, view.byteOffset + child.body - 8, child.end - child.body + 8).slice());
  }
  return box("trak", ...parts);
}

// Copies a container box, replacing exactly one of its children.
function rebuildContainer(view, container, childType, replacement) {
  const parts = [];
  for (const child of readBoxes(view, container.body, container.end)) {
    if (child.type === childType) parts.push(replacement);
    else parts.push(new Uint8Array(view.buffer, view.byteOffset + child.body - 8, child.end - child.body + 8).slice());
  }
  const name = String.fromCharCode(
    view.getUint8(container.body - 4), view.getUint8(container.body - 3),
    view.getUint8(container.body - 2), view.getUint8(container.body - 1)
  );
  return box(name, ...parts);
}

// The durations come from the samples themselves, so they are exact and need
// no help from the playlist.
function applyProgressiveDurations(moovBytes, tracks, movieTimescale) {
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const moov = { body: 8, end: moovBytes.byteLength };

  const mvhd = findBox(view, moov, "mvhd");
  if (!mvhd) return;
  const movie = headerFields(view, mvhd);

  let longest = 0;
  for (const child of readBoxes(view, moov.body, moov.end)) {
    if (child.type !== "trak") continue;

    const tkhd = findBox(view, child, "tkhd");
    const mdia = findBox(view, child, "mdia");
    const mdhd = mdia && findBox(view, mdia, "mdhd");
    if (!tkhd || !mdhd) continue;

    const th = trackHeaderFields(view, tkhd);
    const mh = headerFields(view, mdhd);
    const track = tracks.get(view.getUint32(th.trackIdAt));
    const timescale = view.getUint32(mh.timescaleAt);
    if (!track || !timescale) continue;

    const ticks = track.samples.reduce((total, s) => total + s.duration, 0);
    const seconds = ticks / timescale;
    longest = Math.max(longest, seconds);

    writeDuration(view, mh.durationAt, mh.wide, ticks);
    writeDuration(view, th.durationAt, th.wide, seconds * movieTimescale);
  }

  writeDuration(view, movie.durationAt, movie.wide, longest * movieTimescale);
}

function concatBytes(parts, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) { out.set(part, off); off += part.length; }
  return out;
}

// Writes the chunk offset of each track once the final layout is known, and
// returns the track order it used so the mdat is written to match.
function patchChunkOffsets(moovBytes, tracks, mdatDataStart) {
  const ordered = [];
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const moov = { body: 8, end: moovBytes.byteLength };

  let cursor = mdatDataStart;
  for (const child of readBoxes(view, moov.body, moov.end)) {
    if (child.type !== "trak") continue;

    const tkhd = findBox(view, child, "tkhd");
    const mdia = findBox(view, child, "mdia");
    const minf = mdia && findBox(view, mdia, "minf");
    const stbl = minf && findBox(view, minf, "stbl");
    if (!tkhd || !stbl) continue;

    const track = tracks.get(view.getUint32(trackHeaderFields(view, tkhd).trackIdAt));
    if (!track || track.samples.length === 0) continue;

    const stco = findBox(view, stbl, "stco");
    const co64 = findBox(view, stbl, "co64");
    if (co64) {
      view.setUint32(co64.body + 8, Math.floor(cursor / 4294967296));
      view.setUint32(co64.body + 12, cursor % 4294967296);
    } else if (stco) {
      view.setUint32(stco.body + 8, cursor);
    }
    ordered.push(track);
    cursor += track.samples.reduce((total, s) => total + s.size, 0);
  }
  return ordered;
}

function fragmentedToProgressiveMp4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = readBoxes(view, 0, bytes.byteLength);

  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  if (!ftyp || !moov) return null;

  const mvhd = findBox(view, moov, "mvhd");
  if (!mvhd) return null;
  const movieTimescale = view.getUint32(headerFields(view, mvhd).timescaleAt);
  if (!movieTimescale) return null;

  const tracks = collectFragmentSamples(view, bytes.byteLength);
  if (tracks.size === 0) return null;

  let payload = 0;
  for (const track of tracks.values()) {
    for (const sample of track.samples) {
      if (sample.offset + sample.size > bytes.byteLength) return null;
      payload += sample.size;
    }
  }
  if (payload === 0) return null;

  const useCo64 = payload > 0xf0000000;
  const newMoov = rebuildMoov(view, moov, tracks, useCo64, movieTimescale);
  if (!newMoov) return null;

  const ftypBytes = new Uint8Array(view.buffer, view.byteOffset + ftyp.body - 8, ftyp.end - ftyp.body + 8).slice();
  const wideMdat = payload + 8 > 0xfffffff0;
  const mdatHeader = new Uint8Array(wideMdat ? 16 : 8);
  const headerView = new DataView(mdatHeader.buffer);
  if (wideMdat) {
    headerView.setUint32(0, 1);
    for (let i = 0; i < 4; i++) mdatHeader[4 + i] = "mdat".charCodeAt(i);
    headerView.setUint32(8, Math.floor((payload + 16) / 4294967296));
    headerView.setUint32(12, (payload + 16) % 4294967296);
  } else {
    headerView.setUint32(0, payload + 8);
    for (let i = 0; i < 4; i++) mdatHeader[4 + i] = "mdat".charCodeAt(i);
  }

  const mdatDataStart = ftypBytes.length + newMoov.length + mdatHeader.length;
  const ordered = patchChunkOffsets(newMoov, tracks, mdatDataStart);
  if (ordered.length === 0) return null;

  const out = new Uint8Array(mdatDataStart + payload);
  out.set(ftypBytes, 0);
  out.set(newMoov, ftypBytes.length);
  out.set(mdatHeader, ftypBytes.length + newMoov.length);

  let cursor = mdatDataStart;
  for (const track of ordered) {
    for (const sample of track.samples) {
      out.set(bytes.subarray(sample.offset, sample.offset + sample.size), cursor);
      cursor += sample.size;
    }
  }
  return out;
}

// Merge downloaded segments, remux to MP4, and hand the result to the browser.
// Falls back to writing the raw transport stream when remuxing fails.
async function writeSegmentsAsVideo(chunks, filename, progressKey, tabId, knownDuration, fragmentedMp4) {
  let source = mergeChunks(chunks);
  chunks.length = 0; // the merged copy is the only one needed from here

  let mp4Filename = filename.replace(/\.(m3u8|mpd|ts|aac|m4s|ism).*$/i, ".mp4");
  if (!mp4Filename.endsWith(".mp4")) mp4Filename += ".mp4";

  try {
    let fragmented;
    if (fragmentedMp4) {
      // Already a fragmented MP4: the segments only need the sample tables.
      reportProgress(progressKey, -1, "Rebuilding MP4 index...");
      fragmented = source;
    } else {
      reportProgress(progressKey, -1, "Remuxing to MP4...");
      fragmented = await transmuxTStoMP4(source);
    }

    // A fragmented MP4 opens as an empty movie in VLC and QuickTime, so the
    // file is rewritten with real sample tables before it is handed over.
    let mp4Data = fragmentedToProgressiveMp4(fragmented);
    if (!mp4Data) {
      mp4Data = fragmented;
      repairFragmentedMp4Duration(mp4Data, knownDuration);
    } else if (fragmented !== source) {
      fragmented = null;
    }
    source = null;

    const mp4BlobUrl = URL.createObjectURL(new Blob([mp4Data], { type: "video/mp4" }));
    const dlId = await startDownload({ url: mp4BlobUrl, filename: mp4Filename }, tabId);
    return { downloadId: dlId, filename: mp4Filename };
  } catch (err) {
    if (err && err.cancelled) throw err;
    if (!source) throw err;

    const rawFilename = mp4Filename.replace(/\.mp4$/, fragmentedMp4 ? ".m4s" : ".ts");
    const rawUrl = URL.createObjectURL(new Blob([source], { type: fragmentedMp4 ? "video/mp4" : "video/mp2t" }));
    const dlId = await startDownload({ url: rawUrl, filename: rawFilename }, tabId);
    return { downloadId: dlId, filename: rawFilename, fallback: true };
  }
}

async function downloadAudioRendition(audioSegmentUrls, filename, progressKey, tabId, ctx) {
  reportProgress(progressKey, -1, "Downloading separate audio track...");

  const { chunks } = await downloadSegmentsWithProgress(
    audioSegmentUrls, progressKey, 0, audioSegmentUrls.length, ctx
  );
  if (chunks.length === 0) return null;

  const ext = /\.aac(\?|$)/i.test(audioSegmentUrls[0].url) ? ".aac" : ".m4a";
  const base = filename.replace(/\.(m3u8|mpd|ts|aac|m4a|mp4|ism).*$/i, "") || "audio";
  const audioFilename = base + ".audio" + ext;

  const blobUrl = URL.createObjectURL(new Blob([mergeChunks(chunks)]));
  await startDownload({ url: blobUrl, filename: audioFilename }, tabId);
  return { filename: audioFilename };
}

// Picks the single captured stream that belongs to this manifest. Merging
// every stream of the domain used to interleave unrelated renditions — a
// 720p segment after a 1080p one, or audio inside the video track — which is
// what made downloads play back as garbage.
function collectCapturedSegments(tabId, masterUrl) {
  if (!tabStreams[tabId]) return [];

  const masterKey = getStreamKey(masterUrl);
  const masterDomain = getDomain(masterUrl);

  let best = null;
  let bestScore = -1;

  for (const [key, stream] of tabStreams[tabId]) {
    let score = -1;
    if (stream.manifestUrl === masterUrl) score = 3;
    else if (masterKey && (key.startsWith(masterKey) || masterKey.startsWith(key))) score = 2;
    else if (stream.domain === masterDomain) score = 1;
    if (score < 0) continue;

    // Same relevance: keep the stream we captured the most of.
    if (score > bestScore || (score === bestScore && stream.segments.length > best.segments.length)) {
      best = stream;
      bestScore = score;
    }
  }

  // A bare domain match is too weak to trust when several streams compete.
  if (!best || bestScore < 1) return [];
  if (bestScore === 1) {
    const sameDomain = Array.from(tabStreams[tabId].values()).filter((s) => s.domain === masterDomain);
    if (sameDomain.length > 1) return [];
  }

  const seen = new Set();
  const segments = [];
  for (const seg of best.segments) {
    if (seen.has(seg.url)) continue;
    seen.add(seg.url);
    segments.push({ url: seg.url });
  }
  return segments;
}

// Returns { video: [...], audio: [...] } — the audio list is only populated
// when the manifest carries the audio as a rendition of its own.
async function getManifestSegments(m3u8Url, qualityHeight, ctx) {
  try {
    const parsed = await parseM3U8(m3u8Url, ctx);
    if (!parsed) return { video: [], audio: [], duration: 0 };
    return await getSegmentsFromStoredManifest(parsed, qualityHeight, ctx);
  } catch {
    return { video: [], audio: [], duration: 0 };
  }
}

async function getSegmentsFromStoredManifest(parsed, qualityHeight, ctx) {
  let videoSegmentUrls = [];
  let audioSegmentUrls = [];
  let duration = 0;

  if (parsed.variants && parsed.variants.length > 0) {
    let chosenVariant;
    if (qualityHeight) {
      chosenVariant = parsed.variants.find((v) => v.height === qualityHeight);
    }
    if (!chosenVariant) {
      chosenVariant = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    }

    try {
      const variantData = await parseM3U8(chosenVariant.url, ctx);
      if (variantData) {
        videoSegmentUrls = withInitSegment(variantData);
        duration = variantData.totalDuration || 0;
      }
    } catch {}

    if (parsed.audioGroups && parsed.audioGroups.length > 0) {
      try {
        const audioData = await parseM3U8(parsed.audioGroups[0].url, ctx);
        if (audioData) audioSegmentUrls = withInitSegment(audioData);
      } catch {}
    }
  } else if (parsed.segments) {
    videoSegmentUrls = withInitSegment(parsed);
    duration = parsed.totalDuration || 0;
  }

  return {
    video: videoSegmentUrls,
    audio: audioSegmentUrls,
    subtitles: parsed.subtitleGroups || [],
    duration,
    fragmentedMp4: isFragmentedMp4Playlist(videoSegmentUrls)
  };
}

// ── Subtitles ──
// Each rendition is a playlist of WebVTT segments. They carry timestamps on
// the media timeline already, so the segments only need their repeated headers
// stripped before being joined into one file.

function mergeWebVtt(parts) {
  const cues = [];
  for (const part of parts) {
    const body = part
      .replace(/^\uFEFF/, "")
      .replace(/^WEBVTT[^\n]*\n/, "")
      .replace(/^X-TIMESTAMP-MAP[^\n]*\n/m, "")
      .trim();
    if (body) cues.push(body);
  }
  return "WEBVTT\n\n" + cues.join("\n\n") + "\n";
}

async function downloadSubtitleTrack(rendition, filename, tabId, ctx, index) {
  const playlist = await parseM3U8(rendition.url, ctx);
  if (!playlist || playlist.segments.length === 0) return null;

  const parts = [];
  for (const segment of playlist.segments) {
    try {
      const resp = await mediaFetch(segment.url, ctx, segmentRange(segment));
      if (resp.ok) parts.push(await resp.text());
    } catch {}
  }
  if (parts.length === 0) return null;

  const tag = (rendition.language || rendition.name || String(index + 1))
    .replace(/[^\w-]/g, "").slice(0, 16) || String(index + 1);
  const base = filename.replace(/\.(m3u8|mpd|ts|m4s|aac|m4a|mp4|ism).*$/i, "") || "subtitles";
  const subFilename = `${base}.${tag}.vtt`;

  const blobUrl = URL.createObjectURL(new Blob([mergeWebVtt(parts)], { type: "text/vtt" }));
  await startDownload({ url: blobUrl, filename: subFilename }, tabId);
  return subFilename;
}

// The initialisation segment carries ftyp and moov. Put in front of the media
// segments it forms a valid fragmented MP4 on its own, which is exactly what
// the progressive rewriter already knows how to handle.
function withInitSegment(parsed) {
  if (!parsed.initSegment) return parsed.segments;
  return [parsed.initSegment, ...parsed.segments];
}

// mux.js only demultiplexes MPEG-2 transport streams. A CMAF playlist has to
// skip it entirely, otherwise it produces nothing and the download silently
// falls back to an unplayable .ts.
function isFragmentedMp4Playlist(segments) {
  if (segments.length === 0) return false;
  return segments.some((s) => /\.(m4s|m4f|mp4|cmfv|cmfa|fmp4)(\?|$)/i.test(s.url));
}

// ── AES-128 ──
// Keys are small and shared by every segment of a playlist, so each one is
// fetched once and kept for the duration of the download.
const keyCache = new Map();

async function importAesKey(key, ctx) {
  if (keyCache.has(key.url)) return keyCache.get(key.url);

  const pending = (async () => {
    const resp = await mediaFetch(key.url, ctx);
    if (!resp.ok) throw new Error("Key fetch failed: HTTP " + resp.status);
    const raw = await resp.arrayBuffer();
    if (raw.byteLength !== 16) throw new Error("Unexpected AES-128 key length");
    return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
  })();

  keyCache.set(key.url, pending);
  return pending;
}

// Absent an explicit IV, the HLS specification uses the segment's media
// sequence number as a big-endian 128-bit integer.
function initialisationVector(key, mediaSequence) {
  const iv = new Uint8Array(16);
  if (key.ivHex) {
    const hex = key.ivHex.padStart(32, "0").slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    return iv;
  }
  const view = new DataView(iv.buffer);
  view.setUint32(12, mediaSequence >>> 0);
  return iv;
}

async function decryptSegment(buffer, segment, ctx) {
  if (segment.key.method !== "AES-128") {
    throw new Error(`${segment.key.method} needs a licence server — not supported`);
  }
  const key = await importAesKey(segment.key, ctx);
  const iv = initialisationVector(segment.key, segment.mediaSequence || 0);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, buffer);
}

const SEGMENT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A CDN under load drops the odd segment, and refusing to write an incomplete
// file means one such drop used to throw away the whole download. Each segment
// gets a few spaced-out attempts before it counts as lost.
async function fetchSegment(segment, ctx, progressKey) {
  const range = segmentRange(segment);
  let lastError = null;

  for (let attempt = 1; attempt <= SEGMENT_ATTEMPTS; attempt++) {
    if (isCancelled(progressKey)) throw new DownloadCancelled();
    try {
      const resp = await mediaFetch(segment.url, ctx, range);
      if (!resp.ok) throw new Error("HTTP " + resp.status);

      const body = sliceRangeResponse(await resp.arrayBuffer(), resp.status, range);
      return segment.key ? decryptSegment(body, segment, ctx) : body;
    } catch (err) {
      if (err.cancelled) throw err;
      lastError = err;
      if (attempt < SEGMENT_ATTEMPTS) await wait(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function downloadSegmentsWithProgress(segments, progressKey, startIndex, totalSegments, ctx) {
  const chunks = [];
  let downloaded = 0;
  let failed = 0;
  let retried = 0;
  const BATCH_SIZE = 6;

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    if (isCancelled(progressKey)) throw new DownloadCancelled();

    const batch = segments.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((segment) => fetchSegment(segment, ctx, progressKey))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        chunks.push(result.value);
      } else if (result.reason && result.reason.cancelled) {
        throw new DownloadCancelled();
      } else {
        failed++;
      }
      downloaded++;
    }

    const globalProgress = ((startIndex + downloaded) / totalSegments) * 90;
    const failText = failed > 0 ? ` (${failed} lost)` : "";
    reportProgress(progressKey, globalProgress, `${startIndex + downloaded}/${totalSegments}${failText}`);
  }

  return { chunks, failed, retried };
}

function reportProgress(url, progress, label) {
  browser.runtime.sendMessage({
    action: "hls_progress",
    url,
    progress,
    label
  }).catch(() => {});
}

// Returns the bytes, not a Blob: wrapping them and reading them back doubled
// the peak memory of every download for nothing.
function mergeChunks(chunks) {
  const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return merged;
}

// Download a consolidated auto-detected stream
async function downloadConsolidatedStream(tabId, streamKey, filename) {
  const streams = tabStreams[tabId];
  if (!streams || !streams.has(streamKey)) return { error: "Stream not found" };

  const stream = streams.get(streamKey);

  const progressKey = "stream://" + streamKey;

  if (stream.manifestUrl) {
    return downloadStream(tabId, stream.manifestUrl, filename, null, progressKey);
  }

  const segmentUrls = stream.segments.map((s) => ({ url: s.url }));
  if (segmentUrls.length === 0) {
    return { error: "No segments captured. Play the video first." };
  }

  const ctx = tabContext(tabId);
  const video = await downloadSegmentsWithProgress(
    segmentUrls, progressKey, 0, segmentUrls.length, ctx
  );

  const incomplete = segmentFailureError(video, segmentUrls.length, ctx);
  if (incomplete) return incomplete;

  const result = await writeSegmentsAsVideo(
    video.chunks, filename, progressKey, tabId, 0, isFragmentedMp4Playlist(segmentUrls)
  );
  result.segments = segmentUrls.length;
  return result;
}

function linkManifestToStreams(tabId, manifestUrl, parsed) {
  if (!tabStreams[tabId]) return;
  const domain = getDomain(manifestUrl);
  for (const [key, stream] of tabStreams[tabId]) {
    if (key.startsWith(domain)) {
      stream.manifestUrl = manifestUrl;
      stream.parsedManifest = parsed;
    }
  }
}

// ── Clearing ──
// A single page application never reloads, so a tab keeps accumulating the
// media of every video watched in it. Clearing has to be something the user
// can ask for.

function clearTabMedia(tabId) {
  delete tabMedia[tabId];
  delete tabStreams[tabId];
  delete tabHLS[tabId];
  delete adsHidden[tabId];
  delete tabUsesMediaSource[tabId];
  updateBadge(tabId);
}

// ── Download queue management ──

function enqueueDownload(downloadInfo) {
  downloadQueue.push(downloadInfo);
  processDownloadQueue();
}

async function processDownloadQueue() {
  while (activeDownloads < maxConcurrentDownloads && downloadQueue.length > 0) {
    const item = downloadQueue.shift();
    activeDownloads++;

    // Notify popup of queue state
    browser.runtime.sendMessage({
      action: "queue_update",
      queueLength: downloadQueue.length,
      activeDownloads
    }).catch(() => {});

    try {
      if (isCancelled(item.url)) {
        notifyDownload(item.url, { state: "cancelled" });
      } else {
        await executeDownload(item);
      }
    } catch (err) {
      if (err && err.cancelled) notifyDownload(item.url, { state: "cancelled" });
      else notifyDownload(item.url, { state: "error", error: err.message });
    } finally {
      cancelled.delete(item.url);
      activeDownloads--;
      browser.runtime.sendMessage({
        action: "queue_update",
        queueLength: downloadQueue.length,
        activeDownloads
      }).catch(() => {});
      processDownloadQueue();
    }
  }
}

// The popup is told how a download ends through a message rather than through
// the original sendResponse, which would otherwise stay open for minutes and
// be dropped as soon as the popup is closed.
function notifyDownload(url, payload) {
  browser.runtime.sendMessage({ action: "dl_update", url, ...payload }).catch(() => {});
}

function reportDownloadResult(url, result) {
  if (!result || result.error) {
    notifyDownload(url, { state: "error", error: (result && result.error) || "Download failed" });
    return;
  }
  notifyDownload(url, {
    state: "done",
    segments: result.segments || 0,
    fallback: !!result.fallback,
    separateAudio: !!result.separateAudio,
    audioFilename: result.audioFilename || null,
    subtitles: result.subtitles || null
  });
}

async function executeDownload(item) {
  const { url, filename, tabId, quality } = item;

  // Consolidated stream download
  if (url.startsWith("stream://")) {
    const streamKey = url.replace("stream://", "");
    const result = await downloadConsolidatedStream(tabId, streamKey, filename);
    reportDownloadResult(url, result);
    return result;
  }

  // HLS or DASH stream download
  if (/\.(m3u8|mpd)(\?|$)/i.test(url)) {
    const result = await downloadStream(tabId, url, filename, quality);
    reportDownloadResult(url, result);
    return result;
  }

  // Regular download — the browser owns the transfer from here, so the popup
  // follows it by download id instead of waiting on us.
  const dlId = await startDownload({ url, filename }, tabId);
  // The duplicate log is shared across tabs and outlives the private window,
  // so private downloads are deliberately left out of it.
  if (!isPrivateTab(tabId)) {
    const fileHash = getDomain(url) + "/" + (getFilenameFromUrl(url));
    downloadedFiles.set(fileHash, { url, filename, timestamp: Date.now() });
  }
  notifyDownload(url, { state: "started", downloadId: dlId });
  return { downloadId: dlId };
}

// ── Network Interception ──

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    markTabPrivacy(details.tabId, details.incognito);
    const pageUrl = details.documentUrl || details.originUrl;
    if (pageUrl && !pageUrl.startsWith("moz-extension:")) tabPageUrl[details.tabId] = pageUrl;

    const url = details.url;
    let fileSize = null;
    let contentType = null;

    if (details.responseHeaders) {
      for (const header of details.responseHeaders) {
        const name = header.name.toLowerCase();
        if (name === "content-type") contentType = header.value;
        if (name === "content-length") fileSize = parseInt(header.value, 10);
      }
    }

    const segmentLike = isSegment(url, contentType, fileSize);

    if (segmentLike) {
      addSegmentToStream(details.tabId, { url, size: fileSize, contentType });
      return;
    }

    let isMedia = false;
    if (MEDIA_EXTENSIONS.test(url)) isMedia = true;
    if (contentType && MEDIA_CONTENT_TYPES.test(contentType)) {
      if (fileSize && fileSize < 500000 && !MEDIA_EXTENSIONS.test(url)) {
        addSegmentToStream(details.tabId, { url, size: fileSize, contentType });
        return;
      }
      isMedia = true;
    }

    if (isMedia) {
      const isM3U8 = /\.m3u8(\?|$)/i.test(url);
      const isMPD = /\.mpd(\?|$)/i.test(url);

      // A small m3u8 is usually a variant playlist rather than the master, so
      // it only serves to link captured segments to their manifest. An MPD has
      // no such distinction: it is always the whole description, and a few
      // kilobytes is its normal size.
      if (isM3U8 && fileSize && fileSize < 50000) {
        parseM3U8(url, tabContext(details.tabId)).then((parsed) => {
          if (!parsed) return;
          linkManifestToStreams(details.tabId, url, parsed);
        });
        return;
      }

      if (/auth|token|drm|license|widevine|playready/i.test(url)) return;

      if (isMPD) {
        parseMPD(url, tabContext(details.tabId)).then((parsed) => {
          if (!parsed) return;

          const qualities = parsed.video.map((t) => t.height).filter(Boolean).sort((a, b) => b - a);
          addMediaToTab(details.tabId, {
            url,
            domain: getDomain(url),
            filename: getFilenameFromUrl(url),
            type: "stream",
            quality: qualities[0] || null,
            source: "dash",
            isDashManifest: true,
            availableQualities: qualities,
            audioGroups: parsed.audio.length,
            size: fileSize,
            duration: parsed.totalDuration || null
          });
        });
        return;
      }

      if (isM3U8) {
        parseM3U8(url, tabContext(details.tabId)).then((parsed) => {
          if (!parsed) return;

          linkManifestToStreams(details.tabId, url, parsed);

          if (parsed.variants.length > 0) {
            if (!tabHLS[details.tabId]) tabHLS[details.tabId] = new Map();
            tabHLS[details.tabId].set(url, parsed);

            const best = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
            const qualities = parsed.variants.map((v) => v.height).filter(Boolean).sort((a, b) => b - a);

            addMediaToTab(details.tabId, {
              url,
              domain: getDomain(url),
              filename: getFilenameFromUrl(url),
              type: "stream",
              quality: best.height,
              bandwidth: best.bandwidth,
              source: "hls-master",
              isHLSMaster: true,
              availableQualities: qualities,
              audioGroups: parsed.audioGroups.length,
              size: fileSize,
              duration: null // Will be resolved when media playlist is parsed
            });
          } else if (parsed.segments.length > 0) {
            addMediaToTab(details.tabId, {
              url,
              domain: getDomain(url),
              filename: getFilenameFromUrl(url),
              type: "stream",
              source: "hls-media",
              segmentCount: parsed.segments.length,
              size: fileSize,
              duration: parsed.totalDuration || null
            });
          }
        });
      } else {
        addMediaToTab(details.tabId, {
          url,
          domain: getDomain(url),
          filename: getFilenameFromUrl(url),
          type: getMediaType(url),
          size: fileSize,
          contentType,
          source: "network"
        });
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ── Tab management ──

browser.tabs.onRemoved.addListener((tabId) => {
  delete tabMedia[tabId];
  delete tabStreams[tabId];
  delete tabHLS[tabId];
  delete tabTitles[tabId];
  delete tabWatchMode[tabId];
  delete tabPrivate[tabId];
  delete tabPageUrl[tabId];
  delete adsHidden[tabId];
  delete tabUsesMediaSource[tabId];
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    clearTabMedia(tabId);
  }
  if (changeInfo.title || (tab && tab.title)) {
    tabTitles[tabId] = changeInfo.title || tab.title;
  }
});

// ── Message handling ──

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script found media
  if (message.action === "media_links") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (sender.tab) markTabPrivacy(sender.tab.id, sender.tab.incognito);
    if (tabId && message.links) {
      message.links.forEach((link) => {
        const mediaInfo = { ...link, source: link.source || "dom" };
        // Attach resolution/duration from content script if available
        if (link.resolution) mediaInfo.resolution = link.resolution;
        if (link.duration) mediaInfo.duration = link.duration;
        addMediaToTab(tabId, mediaInfo);
      });
      if (message.pageTitle) tabTitles[tabId] = message.pageTitle;
    }
    if (tabId && message.usesMediaSource) {
      tabUsesMediaSource[tabId] = true;
    }
    return;
  }

  // Popup requests media list
  if (message.action === "get_media") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        const tabId = tabs[0].id;
        markTabPrivacy(tabId, tabs[0].incognito);
        let media = tabMedia[tabId] ? Array.from(tabMedia[tabId].values()) : [];
        const pageTitle = tabTitles[tabId] || tabs[0].title || "";

        const hasConsolidatedStreams = media.some((m) => m.isConsolidatedStream);
        const hasHLSMaster = media.some((m) => m.isHLSMaster);

        media = media.filter((m) => {
          if (m.source === "hls-variant") return false;
          if (m.source === "hls-media" && hasConsolidatedStreams) return false;
          if (m.type === "stream" && !m.isHLSMaster && !m.isConsolidatedStream && (hasHLSMaster || hasConsolidatedStreams)) return false;
          if (m.size && m.size < 5000 && !m.isConsolidatedStream) return false;
          return true;
        });

        const hlsMasterDomains = new Set(media.filter((m) => m.isHLSMaster).map((m) => m.domain));
        if (hlsMasterDomains.size > 0) {
          media = media.filter((m) => {
            if (m.isConsolidatedStream && hlsMasterDomains.has(m.domain)) return false;
            return true;
          });
        }

        // Final dedup by fingerprint — keep best entry per fingerprint
        const dedupMap = new Map();
        media.forEach((m) => {
          const fp = m.fingerprint || m.url;
          if (!dedupMap.has(fp)) {
            dedupMap.set(fp, m);
          } else {
            const existing = dedupMap.get(fp);
            // Merge alt sources
            if (!existing.altSources) existing.altSources = [existing.source];
            existing.altSources.push(m.source);
            // Keep better data
            if (!existing.size && m.size) existing.size = m.size;
            if (!existing.quality && m.quality) existing.quality = m.quality;
            if (!existing.duration && m.duration) existing.duration = m.duration;
            if (!existing.resolution && m.resolution) existing.resolution = m.resolution;
            if (m.source === "network" && existing.source === "dom") {
              existing.url = m.url; // network URL is more reliable
              existing.source = "network";
            }
          }
        });
        media = Array.from(dedupMap.values());

        const streams = tabStreams[tabId]
          ? Array.from(tabStreams[tabId].entries()).map(([key, s]) => ({
              key,
              segmentCount: s.segments.length,
              totalSize: s.totalSize,
              domain: s.domain,
              hasManifest: !!s.manifestUrl
            }))
          : [];

        sendResponse({
          media,
          pageTitle,
          streams,
          isPrivate: isPrivateTab(tabId),
          adsHidden: adsHidden[tabId] || 0,
          usesMediaSource: !!tabUsesMediaSource[tabId],
          watchMode: !!tabWatchMode[tabId],
          queueLength: downloadQueue.length,
          activeDownloads
        });
      } else {
        sendResponse({ media: [], pageTitle: "", streams: [], isPrivate: false, adsHidden: 0, usesMediaSource: false, watchMode: false, queueLength: 0, activeDownloads: 0 });
      }
    });
    return true;
  }

  // Clear everything detected in this tab
  if (message.action === "clear_media") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (!tabs[0]) { sendResponse({ cleared: false }); return; }
      clearTabMedia(tabs[0].id);
      browser.tabs.sendMessage(tabs[0].id, { action: "forget" }).catch(() => {});
      sendResponse({ cleared: true });
    });
    return true;
  }

  // Cancel a queued or running download
  if (message.action === "cancel_download") {
    cancelled.add(message.url);
    const waiting = downloadQueue.findIndex((item) => item.url === message.url);
    if (waiting >= 0) {
      downloadQueue.splice(waiting, 1);
      cancelled.delete(message.url);
      notifyDownload(message.url, { state: "cancelled" });
    }
    sendResponse({ cancelled: true });
    return true;
  }

  // Rescan
  if (message.action === "rescan") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { action: "rescan" });
    });
    return;
  }

  // Toggle watch mode
  if (message.action === "toggle_watch") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        const tabId = tabs[0].id;
        tabWatchMode[tabId] = !tabWatchMode[tabId];
        sendResponse({ watchMode: tabWatchMode[tabId] });
      }
    });
    return true;
  }

  // Download request (now uses queue)
  if (message.action === "download") {
    browser.storage.local.get("options").then(async (result) => {
      const options = result.options || {};

      let filename = message.filename || getFilenameFromUrl(message.url);
      if (options.filenamePattern && options.filenamePattern !== "original") {
        const pageTitle = tabTitles[message.tabId] || message.pageTitle || "";
        filename = buildSmartFilename(
          { filename, domain: getDomain(message.url), url: message.url },
          pageTitle,
          options.filenamePattern
        );
      }

      if (options.downloadFolder) {
        filename = options.downloadFolder + "/" + filename;
      }

      // Update max concurrent from options
      maxConcurrentDownloads = options.maxConcurrent || 2;

      const tabId = message.tabId || (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;

      enqueueDownload({
        url: message.url,
        filename,
        tabId,
        quality: message.quality
      });

      sendResponse({ queued: true, queueLength: downloadQueue.length });
    });
    return true;
  }

  // Batch download with custom rename
  if (message.action === "batch_download") {
    browser.storage.local.get("options").then(async (result) => {
      const options = result.options || {};
      const tabId = message.tabId || (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      const ptitle = tabTitles[tabId] || message.pageTitle || "";
      maxConcurrentDownloads = options.maxConcurrent || 2;

      message.items.forEach((item, index) => {
        let filename;
        if (message.renamePattern) {
          filename = applyBatchRename(item, ptitle, message.renamePattern, index, message.items.length);
        } else {
          filename = item.filename || getFilenameFromUrl(item.url);
        }

        if (options.downloadFolder) {
          filename = options.downloadFolder + "/" + filename;
        }

        enqueueDownload({ url: item.url, filename, tabId, quality: item.quality });
      });

      sendResponse({ queued: message.items.length });
    });
    return true;
  }

  // Download progress
  if (message.action === "download_progress") {
    browser.downloads.search({ id: message.downloadId }).then((items) => {
      if (items.length) {
        sendResponse({
          state: items[0].state,
          bytesReceived: items[0].bytesReceived,
          totalBytes: items[0].totalBytes
        });
      }
    });
    return true;
  }

});
