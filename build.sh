#!/bin/sh
# ./build.sh dev   -> dist/dev/: separate add-on (own name, id and orange icon)
#                     that installs next to the store version.
#                     Load dist/dev/manifest.json in about:debugging.
# ./build.sh prod  -> dist/media-extractor-pro-<version>.zip for AMO.
set -e
cd "$(dirname "$0")"

FILES="manifest.json background.js content.js mse-capture.js popup.html popup.js options.html options.js lib icons LICENSE"

case "$1" in
  dev)
    rm -rf dist/dev && mkdir -p dist/dev
    cp -R $FILES dist/dev/
    cp icon-dev.svg dist/dev/icons/icon-dev.svg
    node -e '
      const fs = require("fs"), p = "dist/dev/manifest.json";
      const m = JSON.parse(fs.readFileSync(p));
      m.name += " DEV";
      m.browser_specific_settings.gecko.id = "media-extractor-pro-dev@sn0walice";
      const icons = (o) => Object.fromEntries(Object.keys(o).map((k) => [k, "icons/icon-dev.svg"]));
      m.icons = icons(m.icons);
      m.action.default_icon = icons(m.action.default_icon);
      m.action.default_title = m.name;
      fs.writeFileSync(p, JSON.stringify(m, null, 2));
    '
    # The popup header says DEV too, so the two popups are not confused.
    sed -i '' 's|Media Extractor Pro$|Media Extractor Pro <b style="color:#ea580c">DEV</b>|' dist/dev/popup.html
    echo "dist/dev ready: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> dist/dev/manifest.json"
    ;;
  prod)
    version=$(node -p 'require("./manifest.json").version')
    out="dist/media-extractor-pro-$version.zip"
    mkdir -p dist && rm -f "$out"
    zip -qr "$out" $FILES -x '.*'
    echo "$out"
    ;;
  *)
    echo "usage: $0 dev|prod" >&2
    exit 1
    ;;
esac
