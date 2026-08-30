#!/bin/sh
# Pull the website's imaging engine in, then prove nothing drifted.
#
# engine.js in this folder must be byte-identical to the one the site serves.
# It is not a copy of the maths, it IS the maths, and two copies that disagree
# means a customer gets one result on the website and another in Photoshop.
set -e

BASE="https://geordieprintco.co.uk/wp-content/plugins/boldprint-toolkit/assets/js/dtx-engine.js"
DIR="$(cd "$(dirname "$0")" && pwd)"

# The plain URL is behind Cloudflare with a four hour cache, and the site never
# requests it that way - it always appends ?v=BPT_VERSION, which is a separate
# cache entry. Asking for the bare URL returned a file 20 minutes out of date
# and would have silently installed a stale engine. The random parameter forces
# a fresh pull.
URL="$BASE?sync=$(date +%s)$$"

curl -fsS "$URL" -o "$DIR/engine.js.new"

if ! head -c 400 "$DIR/engine.js.new" | grep -q 'Prepress engine'; then
	echo "that is not the engine - refusing to install it" >&2
	rm -f "$DIR/engine.js.new"
	exit 1
fi

# A stale copy is still a valid engine file, so "is it the engine" cannot catch
# it. This can: the plugin calls run() directly and needs the exported entry
# points, which only the current file has.
if ! grep -q 'ENGINE_API' "$DIR/engine.js.new"; then
	echo "fetched an engine with no exported entry points - stale cache?" >&2
	rm -f "$DIR/engine.js.new"
	exit 1
fi

mv "$DIR/engine.js.new" "$DIR/engine.js"
echo "engine.js updated from the site ($(wc -c < "$DIR/engine.js") bytes)"

node "$DIR/test/run.js" > /dev/null && echo "tests pass"
