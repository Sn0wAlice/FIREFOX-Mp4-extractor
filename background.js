// background.js — Media Extractor Pro v4.0
// Network interception, badge, downloads, HLS/DASH capture, quality grouping,
// smart rename, blacklist, duplicate detection, stream auto-detection,
// smart dedup, download queue, watch mode, source tracking

const MEDIA_EXTENSIONS = /\.(mp4|webm|mkv|m3u8|mpd|mp3|m4a|ogg|wav|flac|avi|mov)(\?|$)/i;
const MEDIA_CONTENT_TYPES = /^(video|audio)\//i;
const QUALITY_REGEX = /(\d{3,4})p|(\d{3,4})x(\d{3,4})|[_\-.](\d{3,4})[_\-.]/i;

// Patterns that indicate a segment (not a standalone file)
const SEGMENT_EXTENSIONS = /\.(ts|m4s|m4f|m4v|m4a|aac|fmp4|cmfv|cmfa)(\?|$)/i;
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
// Download queue
const downloadQueue = [];
let activeDownloads = 0;
let maxConcurrentDownloads = 2;

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

function isSegment(url, contentType) {
  if (SEGMENT_EXTENSIONS.test(url)) return true;
  if (SEGMENT_URL_PATTERNS.test(url)) return true;
  const filename = getFilenameFromUrl(url);
  if (/^\d+\.(aac|ts|m4s|mp4)$/i.test(filename)) return true;
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
  if (!tabMedia[tabId]) tabMedia[tabId] = new Map();

  browser.storage.local.get("options").then((result) => {
    const opts = result.options || {};
    const blacklist = opts.blacklist || [];
    if (isBlacklisted(mediaInfo.url, blacklist)) return;

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
  const text = count > 0 ? String(count) : "";
  browser.browserAction.setBadgeText({ text, tabId });
  browser.browserAction.setBadgeBackgroundColor({ color: count > 0 ? "#7c3aed" : "#666", tabId });
}

// ── HLS/DASH parsing ──

async function parseM3U8(url) {
  try {
    const resp = await fetch(url);
    const text = await resp.text();
    const lines = text.split("\n").map((l) => l.trim());
    const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
    const result = { masterUrl: url, variants: [], segments: [], audioGroups: [], totalDuration: 0 };

    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    if (isMaster) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-MEDIA") && lines[i].includes("TYPE=AUDIO")) {
          const uriMatch = lines[i].match(/URI="([^"]+)"/);
          const nameMatch = lines[i].match(/NAME="([^"]+)"/);
          const langMatch = lines[i].match(/LANGUAGE="([^"]+)"/);
          if (uriMatch) {
            const audioUrl = uriMatch[1].startsWith("http") ? uriMatch[1] : baseUrl + uriMatch[1];
            result.audioGroups.push({
              url: audioUrl,
              name: nameMatch ? nameMatch[1] : "audio",
              language: langMatch ? langMatch[1] : null
            });
          }
        }
      }

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
          const info = lines[i];
          const bwMatch = info.match(/BANDWIDTH=(\d+)/);
          const resMatch = info.match(/RESOLUTION=(\d+)x(\d+)/);
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.startsWith("#")) {
            const variantUrl = nextLine.startsWith("http") ? nextLine : baseUrl + nextLine;
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
      for (const line of lines) {
        if (line.startsWith("#EXTINF:")) {
          const dur = parseFloat(line.split(":")[1]);
          if (!isNaN(dur)) duration += dur;
        }
        if (line && !line.startsWith("#")) {
          const segUrl = line.startsWith("http") ? line : baseUrl + line;
          result.segments.push(segUrl);
        }
      }
      result.totalDuration = duration;
    }

    return result;
  } catch {
    return null;
  }
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

async function downloadStream(tabId, url, filename, qualityHeight) {
  const progressKey = url;

  const capturedSegments = collectCapturedSegments(tabId, url);

  let manifestSegments = null;
  if (/\.m3u8(\?|$)/i.test(url)) {
    manifestSegments = await getManifestSegments(url, qualityHeight);
  }

  let segmentUrls = [];
  let source = "";

  if (manifestSegments && manifestSegments.length > 0) {
    segmentUrls = manifestSegments;
    source = "manifest";
  } else if (capturedSegments.length > 0) {
    segmentUrls = capturedSegments;
    source = "captured";
  } else {
    const storedParsed = tabHLS[tabId] && tabHLS[tabId].get(url);
    if (storedParsed) {
      segmentUrls = await getSegmentsFromStoredManifest(storedParsed, qualityHeight);
      source = "stored";
    }
  }

  if (segmentUrls.length === 0) {
    return { error: "No segments found. Try playing the video fully first, then download." };
  }

  reportProgress(progressKey, 1, `Found ${segmentUrls.length} segments (${source})`);

  const chunks = await downloadSegmentsWithProgress(segmentUrls, progressKey, 0, segmentUrls.length);

  if (chunks.length === 0) {
    return { error: "All segment downloads failed" };
  }

  const tsBlob = mergeChunks(chunks);
  const tsData = new Uint8Array(await tsBlob.arrayBuffer());

  let mp4Filename = filename.replace(/\.(m3u8|mpd|ts|aac|ism).*$/i, ".mp4");
  if (!mp4Filename.endsWith(".mp4")) mp4Filename += ".mp4";

  try {
    reportProgress(progressKey, -1, "Remuxing to MP4...");
    const mp4Data = await transmuxTStoMP4(tsData);
    const mp4Blob = new Blob([mp4Data], { type: "video/mp4" });
    const mp4BlobUrl = URL.createObjectURL(mp4Blob);
    const dlId = await browser.downloads.download({ url: mp4BlobUrl, filename: mp4Filename });
    return { downloadId: dlId, segments: segmentUrls.length };
  } catch {
    const tsBlobUrl = URL.createObjectURL(new Blob([tsData], { type: "video/mp2t" }));
    const tsFilename = mp4Filename.replace(/\.mp4$/, ".ts");
    const dlId = await browser.downloads.download({ url: tsBlobUrl, filename: tsFilename });
    return { downloadId: dlId, segments: segmentUrls.length, fallback: true };
  }
}

function collectCapturedSegments(tabId, masterUrl) {
  if (!tabStreams[tabId]) return [];

  const masterDomain = getDomain(masterUrl);
  const allSegmentUrls = [];

  for (const [key, stream] of tabStreams[tabId]) {
    if (stream.domain === masterDomain || key.startsWith(masterDomain)) {
      stream.segments.forEach((s) => {
        if (!allSegmentUrls.includes(s.url)) {
          allSegmentUrls.push(s.url);
        }
      });
    }
  }

  return allSegmentUrls;
}

async function getManifestSegments(m3u8Url, qualityHeight) {
  try {
    const parsed = await parseM3U8(m3u8Url);
    if (!parsed) return [];
    return await getSegmentsFromStoredManifest(parsed, qualityHeight);
  } catch {
    return [];
  }
}

async function getSegmentsFromStoredManifest(parsed, qualityHeight) {
  let videoSegmentUrls = [];
  let audioSegmentUrls = [];

  if (parsed.variants && parsed.variants.length > 0) {
    let chosenVariant;
    if (qualityHeight) {
      chosenVariant = parsed.variants.find((v) => v.height === qualityHeight);
    }
    if (!chosenVariant) {
      chosenVariant = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    }

    try {
      const variantData = await parseM3U8(chosenVariant.url);
      if (variantData) videoSegmentUrls = variantData.segments;
    } catch {}

    if (parsed.audioGroups && parsed.audioGroups.length > 0) {
      try {
        const audioData = await parseM3U8(parsed.audioGroups[0].url);
        if (audioData) audioSegmentUrls = audioData.segments;
      } catch {}
    }
  } else if (parsed.segments) {
    videoSegmentUrls = parsed.segments;
  }

  return [...videoSegmentUrls, ...audioSegmentUrls];
}

async function downloadSegmentsWithProgress(segmentUrls, progressKey, startIndex, totalSegments) {
  const chunks = [];
  let downloaded = 0;
  let failed = 0;
  const BATCH_SIZE = 6;

  for (let i = 0; i < segmentUrls.length; i += BATCH_SIZE) {
    const batch = segmentUrls.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((segUrl) =>
        fetch(segUrl).then((resp) => {
          if (!resp.ok) throw new Error(resp.status);
          return resp.arrayBuffer();
        })
      )
    );

    results.forEach((result) => {
      if (result.status === "fulfilled") {
        chunks.push(result.value);
      } else {
        failed++;
      }
      downloaded++;
    });

    const globalProgress = ((startIndex + downloaded) / totalSegments) * 90;
    const failText = failed > 0 ? ` (${failed} failed)` : "";
    reportProgress(progressKey, globalProgress, `${startIndex + downloaded}/${totalSegments}${failText}`);
  }

  return chunks;
}

function reportProgress(url, progress, label) {
  browser.runtime.sendMessage({
    action: "hls_progress",
    url,
    progress,
    label
  }).catch(() => {});
}

function mergeChunks(chunks) {
  const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return new Blob([merged]);
}

// Download a consolidated auto-detected stream
async function downloadConsolidatedStream(tabId, streamKey, filename) {
  const streams = tabStreams[tabId];
  if (!streams || !streams.has(streamKey)) return { error: "Stream not found" };

  const stream = streams.get(streamKey);

  if (stream.manifestUrl) {
    return downloadStream(tabId, stream.manifestUrl, filename);
  }

  const segmentUrls = stream.segments.map((s) => s.url);
  if (segmentUrls.length === 0) {
    return { error: "No segments captured. Play the video first." };
  }

  const progressKey = "stream://" + streamKey;
  const chunks = await downloadSegmentsWithProgress(segmentUrls, progressKey, 0, segmentUrls.length);

  if (chunks.length === 0) {
    return { error: "All segment downloads failed" };
  }

  const tsBlob = mergeChunks(chunks);
  const tsData = new Uint8Array(await tsBlob.arrayBuffer());

  let mp4Filename = filename.replace(/\.(ts|m3u8|aac|ism).*$/i, ".mp4");
  if (!mp4Filename.endsWith(".mp4")) mp4Filename += ".mp4";

  try {
    reportProgress(progressKey, -1, "Remuxing to MP4...");
    const mp4Data = await transmuxTStoMP4(tsData);
    const mp4Blob = new Blob([mp4Data], { type: "video/mp4" });
    const mp4BlobUrl = URL.createObjectURL(mp4Blob);
    const dlId = await browser.downloads.download({ url: mp4BlobUrl, filename: mp4Filename });
    return { downloadId: dlId, segments: segmentUrls.length };
  } catch {
    const tsBlobUrl = URL.createObjectURL(new Blob([tsData], { type: "video/mp2t" }));
    const tsFilename = mp4Filename.replace(/\.mp4$/, ".ts");
    const dlId = await browser.downloads.download({ url: tsBlobUrl, filename: tsFilename });
    return { downloadId: dlId, segments: segmentUrls.length, fallback: true };
  }
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
      await executeDownload(item);
    } catch (err) {
      browser.runtime.sendMessage({
        action: "download_error",
        url: item.url,
        error: err.message
      }).catch(() => {});
    } finally {
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

async function executeDownload(item) {
  const { url, filename, tabId, quality, sendResponse: respond } = item;

  // Consolidated stream download
  if (url.startsWith("stream://")) {
    const streamKey = url.replace("stream://", "");
    const result = await downloadConsolidatedStream(tabId, streamKey, filename);
    if (respond) respond(result);
    return result;
  }

  // HLS stream download
  if (/\.m3u8(\?|$)/i.test(url)) {
    const result = await downloadStream(tabId, url, filename, quality);
    if (respond) respond(result);
    return result;
  }

  // Regular download
  const dlId = await browser.downloads.download({ url, filename });
  const fileHash = getDomain(url) + "/" + (getFilenameFromUrl(url));
  downloadedFiles.set(fileHash, { url, filename, timestamp: Date.now() });
  if (respond) respond({ downloadId: dlId });
  return { downloadId: dlId };
}

// ── Network Interception ──

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

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

    const segmentLike = isSegment(url, contentType);

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
      const isManifest = isM3U8 || isMPD;

      if (isManifest && fileSize && fileSize < 50000) {
        if (isM3U8) {
          parseM3U8(url).then((parsed) => {
            if (!parsed) return;
            linkManifestToStreams(details.tabId, url, parsed);
          });
        }
        return;
      }

      if (/auth|token|drm|license|widevine|playready/i.test(url)) return;

      if (isM3U8) {
        parseM3U8(url).then((parsed) => {
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
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    delete tabMedia[tabId];
    delete tabStreams[tabId];
    delete tabHLS[tabId];
    updateBadge(tabId);
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
    return;
  }

  // Popup requests media list
  if (message.action === "get_media") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        const tabId = tabs[0].id;
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
          watchMode: !!tabWatchMode[tabId],
          queueLength: downloadQueue.length,
          activeDownloads
        });
      } else {
        sendResponse({ media: [], pageTitle: "", streams: [], watchMode: false, queueLength: 0, activeDownloads: 0 });
      }
    });
    return true;
  }

  // Get all media across all tabs (for duplicate detection)
  if (message.action === "get_all_tabs_media") {
    const allTabsMedia = {};
    for (const [tabId, mediaMap] of Object.entries(tabMedia)) {
      allTabsMedia[tabId] = Array.from(mediaMap.values());
    }
    sendResponse({ allTabsMedia, downloadedFiles: Array.from(downloadedFiles.entries()) });
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
        quality: message.quality,
        sendResponse
      });
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

  // Get options
  if (message.action === "get_options") {
    browser.storage.local.get("options").then((result) => {
      sendResponse(result.options || {});
    });
    return true;
  }
});
