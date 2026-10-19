# Media Extractor Pro (Firefox)

Firefox extension that detects the video and audio on a page and downloads it.
HLS and DASH streams are fetched segment by segment and remuxed into a single
progressive MP4 that plays in VLC and QuickTime.

## Features

- Detection from the DOM (`<video>`, `<audio>`, `<source>`, links, `data-*`,
  inline scripts, JSON-LD, `og:video`) and from network traffic
- HLS: master/variant playlists, AES-128 (clear key only), byte ranges,
  fragmented MP4, subtitles
- DASH (MPD) manifests
- A separate audio rendition (DASH, or HLS with fragmented MP4) is merged
  with the video into a single MP4; other combinations (TS video, ADTS audio)
  are saved as two files
- MSE capture: for players that stream through Media Source Extensions
  (`blob:` video), the bytes the player appends are captured and saved as one
  MP4 (video + audio merged). Only what has been played is captured, so the
  video has to be played to the end. Captured bytes are kept in the
  extension's IndexedDB rather than the page's memory (in memory only in
  private windows). WebM captures get a seek index and duration, and are
  saved as separate video and audio files
- Images: the pictures of the page, with the full-size version listed instead
  of its thumbnail (link around the thumbnail, lightbox `data-*` attributes,
  largest `srcset` candidate, Twitter / Wikimedia / Reddit / Imgur /
  WordPress thumbnail URLs), plus CSS backgrounds, the page's `og:image` and
  large pictures seen on the network (galleries that load the full image on
  click). Icons below a minimum size are skipped, banner-sized pictures go
  through the ad filter
- Batch actions (selected, all, best, rename) fetch everything in the
  background and save one zip, so the browser asks for a location once.
  Progress bar with cancel; zip64 above 4 GB; rate-limited hosts (HTTP 429)
  are retried
- Download queue with retry and cancellation, quality grouping, batch rename,
  duplicate detection, ad filter, watch mode
- Playlist mode (☰ in the popup, on demand only): the same-site links of the
  page (up to 40, logout/delete links and files skipped) are opened three at a
  time in muted background tabs, and the videos detected in each are added to
  the list with the title of their page. MSE captures are not collected
- Private windows: downloads stay in the private session, requests are sent
  without the normal-session cookies

Requires Firefox 128 or later (Manifest V3). The background page may be
unloaded when idle: detected media are kept in `storage.session` and
restored, and it stays alive while downloads run.

DRM-protected streams (Widevine, PlayReady, licence servers) are not supported.

## Install (development)

`./build.sh dev` builds `dist/dev/`: same code under another name, id and an
orange DEV icon, so it can be loaded next to the store version.

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `dist/dev/manifest.json`

`./build.sh prod` writes `dist/media-extractor-pro-<version>.zip` for AMO.

## Layout

| File | Role |
|------|------|
| `manifest.json` | Manifest V3 |
| `background.js` | Network detection, manifest parsing, download queue, remuxing |
| `content.js` | DOM scan of each page and frame |
| `mse-capture.js` | Hooks `SourceBuffer.appendBuffer` at `document_start` to capture MSE playback |
| `popup.html/js` | Media list and download UI |
| `options.html/js` | Settings |
| `lib/mux-shim.js` | Unmodified [mux.js](https://github.com/videojs/mux.js) 7.0.3 plus a CommonJS shim |

## Licence

See `LICENSE`.
