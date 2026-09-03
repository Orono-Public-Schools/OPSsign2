#!/bin/bash
# Set the device ID for an OPSsign2 display, and match the hostname to it.
#
#   sudo /opt/opssign/utils/set-device-id.sh OPSsign-HSCafeteria1
#   sudo /opt/opssign/utils/set-device-id.sh OPSsign-HSCafeteria1 --no-hostname
#
# The device ID is what the server keys on. The hostname is derived from it
# (lowercased, underscores converted to hyphens) so SSH, logs and DHCP leases
# all line up with the name in the admin interface.

set -uo pipefail

OPSSIGN_ROOT="/opt/opssign"
CONF="$OPSSIGN_ROOT/config/device.conf"
DEFAULT_SERVER="http://sign.orono.k12.mn.us:3000"
SET_HOSTNAME=true
DEVICE_ID=""

for arg in "$@"; do
    case "$arg" in
        --no-hostname) SET_HOSTNAME=false ;;
        -h|--help)     sed -n '2,10p' "$0"; exit 0 ;;
        -*)            echo "Unknown option: $arg"; exit 1 ;;
        *)
            [ -n "$DEVICE_ID" ] && { echo "Only one device ID may be given."; exit 1; }
            DEVICE_ID="$arg" ;;
    esac
done

[ -n "$DEVICE_ID" ] || { echo "Usage: $0 <device-id> [--no-hostname]"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Must be run as root (use sudo)"; exit 1; }

# --- Validate --------------------------------------------------------------
if [[ ! "$DEVICE_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Device ID may only contain letters, numbers, hyphens and underscores."
    exit 1
fi
if [ ${#DEVICE_ID} -gt 63 ]; then
    echo "Device ID is ${#DEVICE_ID} characters; 63 is the hostname limit."
    exit 1
fi

# --- Refuse to write into a filesystem that will discard it ----------------
if grep -qw "boot=overlay" /proc/cmdline 2>/dev/null || \
   [ "$(findmnt -n -o SOURCE / 2>/dev/null)" = "overlay" ]; then
    echo "The read-only overlay is active. Any change made now is discarded at"
    echo "the next reboot. Turn it off first:"
    echo "  sudo $OPSSIGN_ROOT/utils/setup-overlay.sh disable && sudo reboot"
    exit 1
fi

# --- Update device.conf in place, preserving every other key ---------------
set_conf() {
    local key="$1" value="$2"
    touch "$CONF"
    if grep -q "^${key}=" "$CONF"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$CONF"
    else
        echo "${key}=${value}" >> "$CONF"
    fi
}

if [ ! -f "$CONF" ]; then
    install -d "$(dirname "$CONF")"
    echo "# OPSsign2 Device Configuration" > "$CONF"
fi

OLD_ID=$(grep '^DEVICE_ID=' "$CONF" 2>/dev/null | cut -d= -f2-)
set_conf DEVICE_ID "$DEVICE_ID"
grep -q '^SERVER_URL=' "$CONF" || set_conf SERVER_URL "$DEFAULT_SERVER"
chown opssign:opssign "$CONF" 2>/dev/null || true

echo "Device ID: ${OLD_ID:-none} -> $DEVICE_ID"

# --- Hostname --------------------------------------------------------------
if [ "$SET_HOSTNAME" = true ]; then
    # Hostnames are case-insensitive and disallow underscores.
    NEW_HOST=$(echo "$DEVICE_ID" | tr '[:upper:]' '[:lower:]' | tr '_' '-')
    NEW_HOST=$(echo "$NEW_HOST" | sed -e 's/^-*//' -e 's/-*$//')

    if [[ ! "$NEW_HOST" =~ ^[a-z0-9-]+$ ]]; then
        echo "WARNING: could not derive a valid hostname from $DEVICE_ID - skipping."
    else
        OLD_HOST=$(hostname)
        if [ "$OLD_HOST" = "$NEW_HOST" ]; then
            echo "Hostname: already $NEW_HOST"
        else
            hostnamectl set-hostname "$NEW_HOST" 2>/dev/null || echo "$NEW_HOST" > /etc/hostname

            # hostnamectl does not touch /etc/hosts. Without this, sudo and
            # anything else resolving the local name stalls on every call.
            if grep -qE "^127\.0\.1\.1" /etc/hosts; then
                sed -i -E "s/^(127\.0\.1\.1[[:space:]]+).*/\1${NEW_HOST}/" /etc/hosts
            else
                echo "127.0.1.1	${NEW_HOST}" >> /etc/hosts
            fi
            echo "Hostname: $OLD_HOST -> $NEW_HOST (/etc/hosts updated)"
            HOSTNAME_CHANGED=true
        fi
    fi
else
    echo "Hostname: unchanged (--no-hostname)"
fi

# --- Next steps ------------------------------------------------------------
echo
echo "Register this device in the admin interface if you have not already:"
echo "  ${SERVER_URL:-$DEFAULT_SERVER}/admin"
echo
if [ "${HOSTNAME_CHANGED:-false}" = true ]; then
    echo "Reboot to apply the hostname cleanly: sudo reboot"
    echo "Your next SSH session will be: opstech@${NEW_HOST}"
else
    echo "Restart the kiosk to pick up the new ID:"
    echo "  sudo $OPSSIGN_ROOT/utils/reset-kiosk.sh"
fi
