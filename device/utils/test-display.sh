#!/bin/bash
# OPSsign2 display diagnostic - answers "is this sign actually working?"
# Safe to run over SSH as opstech; no root required.
#
#   /opt/opssign/utils/test-display.sh

OPSSIGN_ROOT="/opt/opssign"
CONF="$OPSSIGN_ROOT/config/device.conf"
LOG="/var/log/opssign-kiosk.log"

# Reach into the opssign user's X session when invoked over SSH.
export DISPLAY="${DISPLAY:-:0}"
if [ -z "${XAUTHORITY:-}" ] && [ -f /home/opssign/.Xauthority ]; then
    export XAUTHORITY=/home/opssign/.Xauthority
fi

ok()   { echo "  [ OK ] $*"; }
warn() { echo "  [WARN] $*"; }
bad()  { echo "  [FAIL] $*"; }

hr() { echo; echo "--- $* ------------------------------------------"; }

echo "OPSsign2 display check - $(hostname) - $(date '+%Y-%m-%d %H:%M:%S')"

# --- Identity --------------------------------------------------------------
hr "Device identity"
if [ -f "$CONF" ]; then
    # shellcheck source=/dev/null
    source "$CONF"
    if [ -z "${DEVICE_ID:-}" ] || [[ "${DEVICE_ID}" == change-me* ]]; then
        bad "DEVICE_ID is unset or still the placeholder: ${DEVICE_ID:-none}"
        echo "         sudo $OPSSIGN_ROOT/utils/set-device-id.sh <name>"
    else
        ok "DEVICE_ID = $DEVICE_ID"
    fi
    ok "SERVER_URL = ${SERVER_URL:-unset}"
    [ -n "${DISPLAY_SCALE:-}" ] && ok "DISPLAY_SCALE override = $DISPLAY_SCALE"
else
    bad "$CONF not found"
fi

echo "  Model:  $(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
echo "  Kernel: $(uname -r)  |  Uptime:$(uptime -p | sed 's/^up//')"

# --- X session -------------------------------------------------------------
hr "X session and panel"
if ! xset q >/dev/null 2>&1; then
    bad "cannot talk to X on $DISPLAY (is the kiosk session running?)"
else
    ok "X server reachable on $DISPLAY"

    CONNECTED=$(xrandr --current 2>/dev/null | grep " connected" | head -3)
    if [ -n "$CONNECTED" ]; then
        echo "$CONNECTED" | while read -r line; do ok "output: $line"; done
    else
        warn "no connected outputs reported by xrandr"
    fi

    RES=$(xrandr --current 2>/dev/null | awk '/[0-9]+x[0-9]+/ && /\*/ {print $1; exit}')
    RES=${RES:-$(xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $2; exit}')}

    if [ -n "$RES" ]; then
        SCREEN_W=${RES%x*}; SCREEN_H=${RES#*x}
        ok "active mode: ${SCREEN_W}x${SCREEN_H}"

        EXPECTED=$(awk -v h="$SCREEN_H" 'BEGIN {
            s = h / 1080
            if (s < 0.5) s = 0.5
            if (s > 4)   s = 4
            printf "%.4f", s
        }')
        CSS_W=$(awk -v w="$SCREEN_W" -v s="$EXPECTED" 'BEGIN { printf "%d", (w/s)+0.5 }')
        CSS_H=$(awk -v h="$SCREEN_H" -v s="$EXPECTED" 'BEGIN { printf "%d", (h/s)+0.5 }')
        ok "expected scale factor: $EXPECTED  ->  CSS viewport ${CSS_W}x${CSS_H}"
        [ "$CSS_H" != "1080" ] && warn "CSS height is not 1080 - templates may lay out oddly"
    else
        bad "could not determine the active mode"
    fi

    # Available modes tell you whether the panel is hiding 1080p from us.
    MODE_COUNT=$(xrandr --current 2>/dev/null | grep -cE '^\s+[0-9]+x[0-9]+')
    echo "  Panel advertises $MODE_COUNT mode(s) in its EDID."
    if [ "$MODE_COUNT" -gt 0 ] && ! xrandr --current 2>/dev/null | grep -qE '^\s+1920x1080'; then
        warn "1920x1080 is NOT offered by this panel."
        echo "         Normal for Samsung QBN with Input Signal Plus / HDMI UHD Color on."
        echo "         Harmless now - the launcher scales instead of forcing a mode."
    fi
fi

# --- Kiosk process ---------------------------------------------------------
hr "Kiosk process"
CHROME_PID=$(pgrep -f "chromium.*--kiosk" | head -1)
if [ -n "$CHROME_PID" ]; then
    ok "Chromium running (pid $CHROME_PID)"
    # cmdline is null-separated, but the chromium-browser wrapper packs several
    # flags into one argv element, so split on spaces too and cut at the first =.
    ACTUAL_SCALE=$(tr '\0' '\n' < "/proc/$CHROME_PID/cmdline" 2>/dev/null \
        | tr ' ' '\n' | grep -m1 -- '--force-device-scale-factor=' \
        | sed 's/^[^=]*=//')
    if [ -n "$ACTUAL_SCALE" ]; then
        ok "running with scale factor: $ACTUAL_SCALE"
        if [ -n "${EXPECTED:-}" ] && [ "$ACTUAL_SCALE" != "$EXPECTED" ]; then
            warn "differs from expected ($EXPECTED) - panel may have changed mode since launch"
            echo "         sudo $OPSSIGN_ROOT/utils/reset-kiosk.sh"
        fi
    else
        warn "no --force-device-scale-factor flag - this Pi is on the OLD launcher"
        echo "         sudo $OPSSIGN_ROOT/scripts/update-device.sh"
    fi
    RSS=$(awk '/VmRSS/ {print $2/1024 " MB"}' "/proc/$CHROME_PID/status" 2>/dev/null)
    [ -n "$RSS" ] && echo "  Memory: $RSS"
else
    bad "no Chromium kiosk process found"
fi

# --- Server ----------------------------------------------------------------
hr "Server and configuration"
if [ -n "${SERVER_URL:-}" ] && [ -n "${DEVICE_ID:-}" ]; then
    URL="${SERVER_URL}/api/device-config/${DEVICE_ID}"
    BODY=$(curl -fsS --max-time 10 "$URL" 2>/dev/null)
    if [ -n "$BODY" ]; then
        ok "server responded to $URL"
        if command -v python3 >/dev/null 2>&1; then
            echo "$BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('  [WARN] response was not valid JSON')
    sys.exit()
for key in ('location', 'template', 'slideId', 'building', 'theme'):
    if key in d and d[key] not in (None, ''):
        print('  %-12s%s' % (key + ':', d[key]))
alerts = d.get('alerts') or []
if alerts:
    print('  ACTIVE ALERTS: %d' % len(alerts))
    for a in alerts[:3]:
        print('    - [%s] %s' % (a.get('priority', '?'), a.get('name', 'unnamed')))
else:
    print('  no active alerts')
"
        else
            echo "  ${BODY:0:300}"
        fi
    else
        bad "no response from $URL"
        echo "         Check networking, DNS, and that the device exists in the admin interface."
    fi
else
    warn "skipped - DEVICE_ID or SERVER_URL missing"
fi

# --- Filesystem ------------------------------------------------------------
hr "Filesystem and storage"
if grep -qw "boot=overlay" /proc/cmdline 2>/dev/null || \
   [ "$(findmnt -n -o SOURCE / 2>/dev/null)" = "overlay" ]; then
    ok "read-only overlay ACTIVE (changes will not survive reboot)"
else
    warn "overlay inactive - card is being written to during normal operation"
    echo "         sudo $OPSSIGN_ROOT/utils/setup-overlay.sh enable"
fi
echo "  Root usage: $(df -h / | awk 'NR==2 {print $3 " of " $2 " (" $5 ")"}')"
echo "  RAM:        $(free -h | awk '/^Mem:/ {print $3 " of " $2 " used"}')"

TEMP=$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2)
[ -n "$TEMP" ] && echo "  SoC temp:   $TEMP"
THROTTLE=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)
if [ -n "$THROTTLE" ] && [ "$THROTTLE" != "0x0" ]; then
    warn "throttling flags set: $THROTTLE (check the power supply)"
fi

# --- Recent log ------------------------------------------------------------
hr "Last 12 kiosk log lines"
if [ -r "$LOG" ]; then
    tail -12 "$LOG" | sed 's/^/  /'
else
    warn "$LOG not readable"
fi

echo
echo "Done."
