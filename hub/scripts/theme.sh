#!/bin/sh
# Materialises the pinned default theme into target/theme/, where rust-embed
# picks it up. The hub embeds a built theme derived from web-theme.pin, placed
# outside any working tree so nothing can drift from the pin.
#
# Called by build.rs, and by CI before cargo runs so that any download happens
# on the runner rather than inside the cross container, which does not
# necessarily carry curl.
#
# Two sources, in order: vendor/theme/ committed to this repository, then the
# upstream GitHub release. The vendored copy makes this fork buildable with no
# network at all -- the whole point of forking -- and its stamp carries the same
# `<tag> <sha256>` the pin names, so a re-pin takes effect the same way.
set -eu

cd "$(dirname "$0")/.."
# read returns 1 at EOF, which is also what a pin file without a trailing
# newline produces; the fields are set either way. Unguarded, set -e would exit
# here silently and build.rs would report only the empty output.
read -r TAG SHA <web-theme.pin || true
[ -n "${TAG:-}" ] && [ -n "${SHA:-}" ] ||
  { echo "web-theme.pin must hold '<tag> <sha256>'" >&2; exit 1; }
DEST=target/theme
URL="https://github.com/wwx0wwx/monitor-theme-default/releases/download/$TAG/theme.tar.gz"

# Already unpacked at this pin. A theme placed here manually with a matching
# stamp is also left alone, which is how an unreleased theme is built against.
if [ -f "$DEST/.pin" ] && [ "$(cat "$DEST/.pin")" = "$TAG $SHA" ]; then
  exit 0
fi

install_from() {
  # The directory is an installable theme, the same layout frontend.rs reads
  # from disk. Without dist/index.html and theme.json the hub would embed
  # nothing.
  if [ ! -f "$1/dist/index.html" ] || [ ! -f "$1/theme.json" ]; then
    return 1
  fi
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -R "$1/." "$DEST/"
  printf '%s %s\n' "$TAG" "$SHA" >"$DEST/.pin"
  echo "default theme $TAG taken from $1"
}

# The vendored copy first: stamped with the same pin, so it answers only for
# the exact release web-theme.pin names.
if [ -f vendor/theme/.pin ] && [ "$(cat vendor/theme/.pin)" = "$TAG $SHA" ]; then
  install_from vendor/theme && exit 0
fi

mkdir -p target
curl -fsSL --retry 3 -o target/theme.tar.gz "$URL"

GOT=$(sha256sum target/theme.tar.gz | cut -d' ' -f1)
if [ "$GOT" != "$SHA" ]; then
  echo "theme $TAG hashes to $GOT, not the $SHA that web-theme.pin names" >&2
  echo "the release asset was replaced or the pin is wrong; neither is safe to build" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
tar xzf target/theme.tar.gz -C "$DEST"

# The archive is an installable theme directory, the same layout frontend.rs
# reads from disk. Without it the hub would embed nothing.
if [ ! -f "$DEST/dist/index.html" ] || [ ! -f "$DEST/theme.json" ]; then
  echo "theme $TAG unpacked without dist/index.html and theme.json" >&2
  exit 1
fi

printf '%s %s\n' "$TAG" "$SHA" >"$DEST/.pin"
echo "default theme $TAG unpacked into $DEST"
