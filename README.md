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
- Download queue with retry and cancellation, quality grouping, batch rename,
  duplicate detection, ad filter, watch mode
- Private windows: downloads stay in the private session, requests are sent
  without the normal-session cookies

DRM-protected streams (Widevine, PlayReady, licence servers) are not supported.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json`

## Layout

| File | Role |
|------|------|
| `manifest.json` | Manifest V2 |
| `background.js` | Network detection, manifest parsing, download queue, remuxing |
| `content.js` | DOM scan of each page and frame |
| `popup.html/js` | Media list and download UI |
| `options.html/js` | Settings |
| `lib/mux-shim.js` | Unmodified [mux.js](https://github.com/videojs/mux.js) 7.0.3 plus a CommonJS shim |

## Licence

See `LICENSE`.
