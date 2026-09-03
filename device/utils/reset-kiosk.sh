#!/bin/bash
# Restart the OPSsign2 kiosk session without rebooting the Pi.
#
#   sudo /opt/opssign/utils/reset-kiosk.sh          # restart the session
#   sudo /opt/opssign/utils/reset-kiosk.sh --hard   # full reboot instead
#
# Use this when the display is stuck, blank, wrongly scaled, or showing stale
# content. It kills Chromium, discards the browser profile and restarts the X
# session, which re-runs chromium-kiosk.sh and re-detects the panel resolution.

set -uo pipefail

OPSSIGN_ROOT="/opt/opssign"
CONF="$OPSSIGN_ROOT/config/device.conf"
CHROME_PROFILE="/home/opssign/.config/chromium"
HARD=false

for arg in "$@"; do
    case "$arg" in
        --hard)    HARD=true ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "Must be run as root (use sudo)"; exit 1; }

overlay_active() {
    grep -qw "boot=overlay" /proc/cmdline 2>/dev/null || \
    [ "$(findmnt -n -o SOURCE / 2>/dev/null)" = "overlay" ]
}

echo "Resetting OPSsign2 kiosk on $(hostname)..."

# --- Sanity check the identity before bouncing the session -----------------
if [ -f "$CONF" ]; then
    # shellcheck source=/dev/null
    source "$CONF"
    if [ -z "${DEVICE_ID:-}" ] || [[ "${DEVICE_ID}" == change-me* ]]; then
        echo "WARNING: DEVICE_ID is unset or still the placeholder (${DEVICE_ID:-none})."
        echo "         The kiosk will restart but the server will not recognise it."
    else
        echo "  Device: $DEVICE_ID"
    fi
else
    echo "WARNING: $CONF is missing. The kiosk will fall back to defaults."
fi

if overlay_active; then
    echo "  Note: the read-only overlay is active. This reset clears RAM state only;"
    echo "        nothing here needs to persist, so that is fine. But if you are"
    echo "        resetting to apply a config change you edited by hand, that change"
    echo "        was discarded at the last reboot and is not coming back."
fi

if [ "$HARD" = true ]; then
    echo "  Rebooting..."
    sleep 2
    reboot
    exit 0
fi

# --- Stop the session ------------------------------------------------------
echo "  Stopping the kiosk session..."
systemctl stop getty@tty1.service 2>/dev/null || true

pkill -f chromium 2>/dev/null || true
sleep 2
pkill -9 -f chromium 2>/dev/null || true

pkill -u opssign xinit 2>/dev/null || true
pkill -u opssign Xorg  2>/dev/null || true
pkill -x unclutter     2>/dev/null || true
sleep 1

# --- Clear browser state ---------------------------------------------------
echo "  Discarding the Chromium profile..."
rm -rf "$CHROME_PROFILE" 2>/dev/null || true
# Leave it absent. The launcher recreates it with the right ownership.
# Pre-creating it here is what poisoned the directory when run under sudo.

# --- Start it back up ------------------------------------------------------
echo "  Starting the kiosk session..."
systemctl start getty@tty1.service 2>/dev/null \
    || { echo "FAILED to start getty@tty1. Falling back to a reboot."; sleep 2; reboot; }

echo "  Waiting for Chromium..."
FIRST_PID=""
for i in $(seq 1 30); do
    PID=$(pgrep -f "chromium.*--kiosk" | head -1)
    if [ -n "$PID" ]; then
        if [ -z "$FIRST_PID" ]; then
            FIRST_PID="$PID"
            echo "  Chromium appeared (pid $PID) - confirming it stays up..."
            sleep 8
            continue
        fi
        # A crash-loop keeps producing new PIDs. A healthy start does not.
        if [ "$PID" = "$FIRST_PID" ]; then
            echo "  Kiosk is up and stable (pid $PID, ${i}s)."
            echo
            echo "Verify with: $OPSSIGN_ROOT/utils/test-display.sh"
            exit 0
        fi
        echo
        echo "  PROBLEM: Chromium is restarting in a loop (pid $FIRST_PID -> $PID)."
        echo "  It launches and exits immediately. The display will flicker between"
        echo "  the X startup text and a black screen."
        echo
        echo "  Stop the loop:  sudo systemctl stop getty@tty1.service"
        echo "  Then read why:  sudo tail -40 /var/log/opssign-kiosk.log"
        echo
        echo "  Most common cause is a profile directory owned by root:"
        echo "    sudo rm -rf $CHROME_PROFILE"
        echo "    sudo systemctl start getty@tty1.service"
        exit 1
    fi
    sleep 1
done

echo "  Chromium has not appeared after 30s."
echo "  Check: tail -30 /var/log/opssign-kiosk.log"
echo "  If it stays down, try: sudo $0 --hard"
exit 1
