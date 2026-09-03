#!/bin/bash
# Chromium kiosk launcher for OPSsign2
#
# Resolution-adaptive: accepts whatever mode the panel negotiates (1080p, 4K,
# 1440p...) and scales page content so templates authored against a 1920x1080
# CSS viewport render identically on every display, just sharper on 4K.
#
# No xrandr mode forcing. Panels that only advertise 4K in their EDID
# (e.g. Samsung QBN with "Input Signal Plus" enabled) are handled natively.

set -u

CONF="/opt/opssign/config/device.conf"
LOG="/var/log/opssign-kiosk.log"
CHROME_PROFILE="/home/opssign/.config/chromium"

# shellcheck source=/dev/null
[ -f "$CONF" ] && source "$CONF"

SERVER_URL=${SERVER_URL:-"http://sign.orono.k12.mn.us:3000"}
DEVICE_ID=${DEVICE_ID:-"unknown-device"}

# Design viewport the templates are authored against.
DESIGN_WIDTH=${DESIGN_WIDTH:-1920}
DESIGN_HEIGHT=${DESIGN_HEIGHT:-1080}

# auto = derive from panel height. Set a number in device.conf to override.
DISPLAY_SCALE=${DISPLAY_SCALE:-auto}

# Log to file AND console. Using a bare "exec >> $LOG" hides all output,
# including bash -x traces, at exactly the moment something is going wrong.
if [ -t 1 ] || [ -n "${OPSSIGN_VERBOSE:-}" ]; then
    exec > >(tee -a "$LOG") 2>&1
else
    exec >>"$LOG" 2>&1
fi
echo "=== $(date '+%Y-%m-%d %H:%M:%S') kiosk start | device=$DEVICE_ID ==="

# --- Locate Chromium -------------------------------------------------------
CHROMIUM_BIN=$(command -v chromium-browser || command -v chromium || true)
if [ -z "$CHROMIUM_BIN" ]; then
    echo "FATAL: no chromium binary found (tried chromium-browser, chromium)"
    exit 1
fi

# --- Detect the actual panel resolution ------------------------------------
detect_resolution() {
    local dims=""
    dims=$(xrandr --current 2>/dev/null | awk '/[0-9]+x[0-9]+/ && /\*/ {print $1; exit}')
    if [ -z "$dims" ]; then
        dims=$(xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $2; exit}')
    fi
    echo "${dims:-${DESIGN_WIDTH}x${DESIGN_HEIGHT}}"
}

RES=$(detect_resolution)
SCREEN_W=${RES%x*}
SCREEN_H=${RES#*x}
echo "Detected panel resolution: ${SCREEN_W}x${SCREEN_H}"

# --- Work out the device scale factor --------------------------------------
# Scale by height: signage panels are 16:9, and height is what the day-fitting
# logic in athletics-wide / schedule-bound measures against.
if [ "$DISPLAY_SCALE" = "auto" ]; then
    SCALE=$(awk -v h="$SCREEN_H" -v d="$DESIGN_HEIGHT" 'BEGIN {
        s = h / d
        if (s < 0.5) s = 0.5
        if (s > 4)   s = 4
        printf "%.4f", s
    }')
else
    SCALE="$DISPLAY_SCALE"
fi

# --window-size is in DIPs, not device pixels. Divide native by the scale
# factor or the window ends up SCALE times larger than the screen.
WIN_W=$(awk -v w="$SCREEN_W" -v s="$SCALE" 'BEGIN { printf "%d", (w / s) + 0.5 }')
WIN_H=$(awk -v h="$SCREEN_H" -v s="$SCALE" 'BEGIN { printf "%d", (h / s) + 0.5 }')

echo "Device scale factor: $SCALE  |  CSS viewport: ${WIN_W}x${WIN_H}"

# --- Display power management ----------------------------------------------
xset s off
xset -dpms
xset s noblank

# Hide the cursor
pgrep -x unclutter >/dev/null || unclutter -idle 5 &

# --- Fresh Chromium profile every boot -------------------------------------
# Guarantees no stale window_placement, no crash-restore bubble, no session
# state. Under the read-only overlay this costs nothing anyway.
rm -rf "$CHROME_PROFILE" 2>/dev/null || true
# Create the profile owned by whoever will actually run Chromium. If this
# script is ever invoked via sudo, a plain mkdir leaves the directory owned by
# root, Chromium cannot create its SingletonLock, and it aborts on every launch
# - which looks like an X session crash-loop rather than a permissions problem.
KIOSK_USER=${KIOSK_USER:-opssign}
if [ "$(id -u)" -eq 0 ] && id "$KIOSK_USER" >/dev/null 2>&1; then
    install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$CHROME_PROFILE/Default"
else
    mkdir -p "$CHROME_PROFILE/Default"
fi

# Chromium and Mesa also write to ~/.cache. A root-owned .cache silently
# disables the disk cache and the shader cache on every launch.
if [ "$(id -u)" -eq 0 ] && id "$KIOSK_USER" >/dev/null 2>&1; then
    install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "/home/$KIOSK_USER/.cache"
fi

# Refuse to launch into a profile we cannot write, rather than crash-looping.
if [ ! -w "$CHROME_PROFILE" ]; then
    echo "FATAL: $CHROME_PROFILE is not writable by $(id -un)."
    echo "       Fix with: sudo rm -rf $CHROME_PROFILE"
    exit 1
fi

# --- Launch ----------------------------------------------------------------
echo "Launching: $CHROMIUM_BIN -> ${SERVER_URL}/?deviceId=${DEVICE_ID}"

exec "$CHROMIUM_BIN" \
    --kiosk \
    --start-fullscreen \
    --window-position=0,0 \
    --window-size="${WIN_W},${WIN_H}" \
    --force-device-scale-factor="${SCALE}" \
    --user-data-dir="$CHROME_PROFILE" \
    --disk-cache-dir="$CHROME_PROFILE/Cache" \
    --disk-cache-size=52428800 \
    --disable-background-networking \
    --no-sandbox \
    --noerrdialogs \
    --disable-infobars \
    --disable-dev-tools \
    --disable-extensions \
    --disable-translate \
    --disable-features=TranslateUI \
    --disable-session-crashed-bubble \
    --disable-component-update \
    --hide-scrollbars \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --password-store=basic \
    --no-first-run \
    "${SERVER_URL}/?deviceId=${DEVICE_ID}"
