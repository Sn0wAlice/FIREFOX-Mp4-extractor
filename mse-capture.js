// mse-capture.js — Media Extractor Pro
// A Media Source Extensions player fetches its segments itself and hands them
// to SourceBuffer.appendBuffer(). Hooking that call captures exactly the bytes
// being played, whatever the site's manifest or URL scheme. Runs at
// document_start so the hook is in place before the player builds its
// MediaSource. Only what the player has appended is captured: the user has to
// play the video through.

(() => {
  const page = window.wrappedJSObject;
  if (!page || !page.MediaSource || !page.SourceBuffer) return;

  // Captured bytes are handed to the background page as they arrive and
  // stored in its IndexedDB (on disk), so a long film does not sit in this
  // page's memory. In a private window nothing may reach the disk: there
  // they stay here, in memory, until downloaded or cleared.
  const spill = !browser.extension.inIncognitoContext;
  const captures = []; // { id, tracks: [track], mediaSource }
  // Keyed by the unwrapped page object: Firefox hands the same SourceBuffer
  // over through different Xray wrappers, which never compare equal.
  const trackOf = new WeakMap(); // SourceBuffer -> track
  const keyOf = (obj) => XPCNativeWrapper.unwrap(obj);
  let drm = false;
  let bufferedEnd = 0;
  let duration = 0;

  // A track keeps one group per initialisation segment. A quality switch
  // appends a new init segment, so each rendition lands in its own group and
  // the biggest one is what gets saved — mixing them corrupts the file.
  function newTrack(mime, capture) {
    return { mime: String(mime || ""), groups: [], current: null, seen: new Set(), capture, index: capture.tracks.length };
  }

  // Bytes of a group: kept here, or sent to the background's store with
  // their position so the file can be rebuilt in order.
  function keep(track, group, bytes) {
    if (!spill) { group.fragments.push(bytes); return; }
    browser.runtime.sendMessage({
      action: "mse_chunk", capture: track.capture.id, track: track.index,
      group: group.index, seq: group.seq++, bytes
    }).catch(() => {});
  }

  function newGroup(track, init) {
    const group = { init, fragments: [], size: init.length, seq: 0, index: track.groups.length };
    track.groups.push(group);
    keep(track, group, init);
    return group;
  }

  function isInitSegment(bytes, mime) {
    if (bytes.length < 8) return false;
    if (/webm/i.test(mime)) {
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    }
    const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    return type === "ftyp" || type === "moov";
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Fragments start with their sequence number and decode time (moof/mfhd/tfdt,
  // or the WebM cluster timecode), so length plus the leading bytes tells a
  // re-appended fragment (after a seek) from a new one.
  function fingerprint(bytes) {
    return bytes.length + ":" + bytes.subarray(0, 128).join(",");
  }

  function record(track, bytes) {
    if (isInitSegment(bytes, track.mime)) {
      track.current = track.groups.find((g) => sameBytes(g.init, bytes)) || newGroup(track, bytes);
      return;
    }
    if (!track.current) return; // no init segment seen: nothing usable
    const key = fingerprint(bytes);
    if (track.seen.has(key)) return;
    track.seen.add(key);
    keep(track, track.current, bytes);
    track.current.size += bytes.length;
    scheduleReport();
  }

  // Copies the page's bytes into this compartment; the player may reuse its
  // buffer as soon as appendBuffer returns.
  // structuredClone moves them out of the page compartment; a typed array
  // built directly over a page buffer is refused by Firefox.
  function copyBytes(data) {
    const c = structuredClone(data);
    if (c instanceof ArrayBuffer) return new Uint8Array(c);
    const view = new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
    return view.byteLength === c.buffer.byteLength ? view : view.slice();
  }

  const msProto = page.MediaSource.prototype;
  const sbProto = page.SourceBuffer.prototype;
  const originalAdd = msProto.addSourceBuffer;
  const originalAppend = sbProto.appendBuffer;
  const originalChangeType = sbProto.changeType;

  exportFunction(function (mime) {
    const sb = originalAdd.call(this, mime);
    try {
      let capture = captures.find((c) => c.mediaSource === keyOf(this));
      if (!capture) {
        capture = { id: captures.length + 1, tracks: [], mediaSource: keyOf(this) };
        captures.push(capture);
      }
      const track = newTrack(mime, capture);
      capture.tracks.push(track);
      trackOf.set(keyOf(sb), track);
    } catch {}
    return sb;
  }, msProto, { defineAs: "addSourceBuffer" });

  // The original runs first: a rejected append (quota exceeded) must reach the
  // player untouched and must not be captured.
  exportFunction(function (data) {
    const result = originalAppend.call(this, data);
    try {
      const track = trackOf.get(keyOf(this));
      if (track) record(track, copyBytes(data));
    } catch {}
    return result;
  }, sbProto, { defineAs: "appendBuffer" });

  if (originalChangeType) {
    exportFunction(function (mime) {
      const result = originalChangeType.call(this, mime);
      try {
        const track = trackOf.get(keyOf(this));
        if (track) { track.mime = String(mime); track.current = null; }
      } catch {}
      return result;
    }, sbProto, { defineAs: "changeType" });
  }

  // EME: the appended bytes are encrypted and useless without the licence.
  document.addEventListener("encrypted", () => { drm = true; scheduleReport(); }, true);

  function readPlayback() {
    for (const v of document.querySelectorAll("video")) {
      if (!v.src.startsWith("blob:")) continue;
      if (v.mediaKeys) drm = true;
      if (isFinite(v.duration)) duration = Math.max(duration, v.duration);
      for (let i = 0; i < v.buffered.length; i++) bufferedEnd = Math.max(bufferedEnd, v.buffered.end(i));
    }
  }

  function bestGroup(track) {
    return track.groups.reduce((best, g) => (!best || g.size > best.size ? g : best), null);
  }

  function summary(capture) {
    const tracks = capture.tracks
      .map((t) => ({ mime: t.mime, size: bestGroup(t)?.size || 0 }))
      .filter((t) => t.size > 0);
    return {
      id: capture.id,
      tracks,
      size: tracks.reduce((s, t) => s + t.size, 0)
    };
  }

  let reportTimer = null;
  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      readPlayback();
      for (const capture of captures) {
        const s = summary(capture);
        if (s.size === 0) continue;
        browser.runtime.sendMessage({
          action: "mse_update", ...s, drm, bufferedEnd, duration,
          pageTitle: document.title
        }).catch(() => {});
      }
    }, 2000);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "forget") {
      // The player will not re-append its init segment, so it is kept (and
      // stored again: the background dropped everything of this tab).
      for (const c of captures) {
        for (const t of c.tracks) {
          t.seen.clear();
          const init = t.current && t.current.init;
          t.groups = [];
          t.current = init ? newGroup(t, init) : null;
        }
      }
      bufferedEnd = 0;
      return;
    }
    if (message.action !== "mse_dump") return;
    const capture = captures.find((c) => c.id === message.id);
    if (!capture) return Promise.resolve({ error: "Capture no longer in memory — reload and play again" });
    if (drm) return Promise.resolve({ error: "DRM protected — not supported" });
    // Stored groups are read back by the background from its own store.
    const tracks = capture.tracks
      .map((t) => ({ mime: t.mime, track: t.index, group: bestGroup(t) }))
      .filter((t) => t.group)
      .map((t) => spill
        ? { mime: t.mime, track: t.track, group: t.group.index }
        : { mime: t.mime, chunks: [t.group.init, ...t.group.fragments] });
    return Promise.resolve({ tracks, capture: capture.id });
  });
})();
