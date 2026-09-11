#!/bin/bash
# OPSsign2 device updater
#
#   sudo /opt/opssign/scripts/update-device.sh             # opssign scripts only
#   sudo /opt/opssign/scripts/update-device.sh --full      # apt + opssign scripts
#   sudo /opt/opssign/scripts/update-device.sh --full --reboot
#   sudo /opt/opssign/scripts/update-device.sh --resume    # internal, systemd only
#
# Overlay-aware. When the read-only overlay is active a --full run stages itself
# across reboots: disable overlay -> reboot -> apt+git -> (reboot if the kernel
# changed) -> re-enable overlay -> reboot. The overlay initramfs is built for
# the *running* kernel, so it must be rebuilt only once the new kernel is live.

set -uo pipefail

# --- Self-overwrite guard ---------------------------------------------------
# This script copies device/scripts/* over /opt/opssign/scripts/, which
# includes THIS FILE. Bash reads a script incrementally by byte offset, so
# rewriting it mid-run makes execution resume at that offset inside the NEW
# file - producing a syntax error somewhere unrelated, after some of the work
# has already happened. Re-exec from a private copy in /tmp so the file on
# disk can be replaced safely underneath us.
if [ "${OPSSIGN_REEXEC:-}" != "1" ]; then
    _self=$(mktemp /tmp/opssign-update-XXXXXX.sh) || exit 1
    cat "$0" > "$_self" || exit 1
    chmod +x "$_self"
    OPSSIGN_REEXEC=1 export OPSSIGN_REEXEC
    exec "$_self" "$@"
fi
trap 'rm -f "$0"' EXIT

REPO_URL="https://github.com/Orono-Public-Schools/OPSsign2.git"
OPSSIGN_ROOT="/opt/opssign"
CONF="$OPSSIGN_ROOT/config/device.conf"
LOG_DIR="$OPSSIGN_ROOT/logs"
# The staging marker MUST live outside the overlay. /opt is on the root
# filesystem, so a marker written there during staging goes to RAM and is gone
# at the very reboot it exists to survive. /boot/firmware is vfat, outside the
# overlay, and already writable.
MARKER_DIR_PRIMARY="/boot/firmware"
MARKER_DIR_FALLBACK="/boot"
[ -d "$MARKER_DIR_PRIMARY" ] && MARKER="$MARKER_DIR_PRIMARY/opssign-update-stage" \
                            || MARKER="$MARKER_DIR_FALLBACK/opssign-update-stage"
RESUME_UNIT="opssign-update-resume.service"
TEMP_DIR="/tmp/opssign-update-$$"
BACKUP_DIR="$OPSSIGN_ROOT/backup/$(date +%Y%m%d-%H%M%S)"

DO_APT=false
DO_REBOOT=false
IS_RESUME=false

for arg in "$@"; do
    case "$arg" in
        --full)         DO_APT=true ;;
        --scripts-only) DO_APT=false ;;
        --reboot)       DO_REBOOT=true ;;
        --resume)       IS_RESUME=true ;;
        -h|--help)      sed -n '2,14p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "Must be run as root (use sudo)"; exit 1; }

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/update-$(date +%Y%m%d).log") 2>&1

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "[$(date '+%H:%M:%S')] ERROR: $*"; exit 1; }

# shellcheck source=/dev/null
[ -f "$CONF" ] && source "$CONF"
OVERLAY_DESIRED=${OVERLAY_ENABLED:-false}

# --- Overlay mechanism ------------------------------------------------------
# Two implementations exist and they are not interchangeable:
#   overlayroot (Debian pkg) : "overlayroot=tmpfs" on the kernel cmdline
#   raspi-config             : "boot=overlay" on the kernel cmdline + initramfs
# The kernel cmdline always wins over /etc/overlayroot.conf, so editing that
# conf file does nothing when overlayroot=tmpfs is set at boot.
# Detection is by filesystem TYPE, which is "overlay" for both; the mount
# SOURCE differs ("overlay" vs "overlayroot") and must not be tested.

overlay_active() {
    [ "$(findmnt -n -o FSTYPE / 2>/dev/null)" = "overlay" ]
}

boot_mount() { [ -d /boot/firmware ] && echo /boot/firmware || echo /boot; }
cmdline_file() { echo "$(boot_mount)/cmdline.txt"; }

overlay_mechanism() {
    if grep -q "overlayroot=" "$(cmdline_file)" 2>/dev/null \
       || dpkg -l overlayroot 2>/dev/null | grep -q "^ii"; then
        echo "overlayroot"
    else
        echo "raspi-config"
    fi
}

_boot_rw() { mount -o remount,rw "$(boot_mount)" 2>/dev/null || true; }

overlay_off() {
    local cl; cl=$(cmdline_file)
    case "$(overlay_mechanism)" in
        overlayroot)
            _boot_rw
            # cmdline.txt must stay a single line.
            sed -i -e "s/[[:space:]]*overlayroot=[^[:space:]]*//g" "$cl"
            sed -i -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//" "$cl"
            grep -q "overlayroot=" "$cl" && return 1
            ;;
        *)
            raspi-config nonint do_overlayfs 1 || return 1
            overlay_active || raspi-config nonint disable_bootro 2>/dev/null || true
            ;;
    esac
    return 0
}

overlay_on() {
    local cl; cl=$(cmdline_file)
    case "$(overlay_mechanism)" in
        overlayroot)
            _boot_rw
            grep -q "overlayroot=tmpfs" "$cl" || \
                sed -i -e "s/$/ overlayroot=tmpfs/" "$cl"
            sed -i -e "s/[[:space:]]\+/ /g" -e "s/^ //" -e "s/ $//" "$cl"
            grep -q "overlayroot=tmpfs" "$cl" || return 1
            ;;
        *)
            raspi-config nonint do_overlayfs 0 || return 1
            ;;
    esac
    return 0
}

unlock_boot() {
    raspi-config nonint disable_bootro 2>/dev/null || true
    _boot_rw
}

set_stage() {
    _boot_rw
    echo "$1" > "$MARKER" || fail "could not write the staging marker to $MARKER"
    sync
}
get_stage() { cat "$MARKER" 2>/dev/null || echo ""; }

clear_staging() {
    _boot_rw
    rm -f "$MARKER"
    sync
    # The unit stays enabled: it is gated by ConditionPathExists on the marker,
    # and "systemctl enable" writes to the root filesystem, which under the
    # overlay would not persist either.
}

# ===========================================================================
# Resume path: called by opssign-update-resume.service on the next boot
# ===========================================================================
if [ "$IS_RESUME" = true ]; then
    STAGE=$(get_stage)
    log "=== Resuming staged update (stage: ${STAGE:-none}) ==="

    if overlay_active; then
        clear_staging
        fail "overlay is still active on resume - aborting rather than looping"
    fi

    if [ "$STAGE" = "overlay" ]; then
        log "Kernel is current. Re-enabling read-only overlay..."
        overlay_on || { clear_staging; fail "could not re-enable the overlay"; }
        clear_staging
        log "Overlay restored. Rebooting into normal operation."
        sleep 3; reboot; exit 0
    fi

    # stage = "apt": fall through and do the real work below
    DO_APT=true
    unlock_boot
fi

# ===========================================================================
# Staging: a --full run cannot proceed under a live overlay
# ===========================================================================
if [ "$IS_RESUME" = false ] && [ "$DO_APT" = true ] && overlay_active; then
    log "Read-only overlay is active - apt cannot write to the root filesystem."
    [ -f "/etc/systemd/system/$RESUME_UNIT" ] \
        || fail "$RESUME_UNIT not installed. Run: sudo $OPSSIGN_ROOT/utils/setup-overlay.sh install"
    log "Staging the update to run on the next boot."
    overlay_off || fail "could not disable the overlay"
    set_stage "apt"
    systemctl is-enabled "$RESUME_UNIT" >/dev/null 2>&1 \
        || fail "$RESUME_UNIT is not enabled. Run: sudo $OPSSIGN_ROOT/utils/setup-overlay.sh install"
    log "Rebooting into a writable filesystem. The update continues automatically."
    sleep 3; reboot; exit 0
fi

# ===========================================================================
# Main update
# ===========================================================================
log "=== OPSsign2 device update ==="
log "Device: ${DEVICE_ID:-unknown}   Mode: $([ "$DO_APT" = true ] && echo 'full (apt + opssign)' || echo 'opssign scripts only')"

log "Stopping kiosk session..."
systemctl stop getty@tty1.service 2>/dev/null || true
pkill -f chromium 2>/dev/null || true
sleep 2

KERNEL_BEFORE=$(uname -r)

# --- System packages -------------------------------------------------------
if [ "$DO_APT" = true ]; then
    unlock_boot
    export DEBIAN_FRONTEND=noninteractive
    APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

    log "Refreshing package lists..."
    apt-get update || log "WARNING: apt-get update reported errors"

    log "Upgrading packages (this can take several minutes)..."
    apt-get "${APT_OPTS[@]}" full-upgrade || fail "apt-get full-upgrade failed"

    log "Cleaning up..."
    apt-get "${APT_OPTS[@]}" autoremove || true
    apt-get clean || true
    log "System packages up to date."
fi

# --- OPSsign device software ----------------------------------------------
log "Backing up current scripts to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
cp -r "$OPSSIGN_ROOT/scripts" "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$OPSSIGN_ROOT/utils"   "$BACKUP_DIR/" 2>/dev/null || true

log "Fetching latest OPSsign2 device files..."
rm -rf "$TEMP_DIR"
git clone --depth 1 "$REPO_URL" "$TEMP_DIR" >/dev/null 2>&1 \
    || fail "git clone failed - check network connectivity"
[ -d "$TEMP_DIR/device" ] || fail "device/ not found in repository"

cd "$TEMP_DIR" || fail "cannot enter $TEMP_DIR"
log "Repository commit: $(git rev-parse --short HEAD) - $(git log -1 --format=%s)"

install -d "$OPSSIGN_ROOT/scripts" "$OPSSIGN_ROOT/utils" "$OPSSIGN_ROOT/config"
cp device/scripts/* "$OPSSIGN_ROOT/scripts/"
cp device/utils/*   "$OPSSIGN_ROOT/utils/"
chmod +x "$OPSSIGN_ROOT/scripts/"* "$OPSSIGN_ROOT/utils/"*
log "Scripts and utilities updated."

# Config templates: never clobber device.conf, it holds the device identity.
for file in device/config/*; do
    filename=$(basename "$file")
    [ "$filename" = "device.conf" ] && continue
    case "$filename" in
        *.service)
            cp "$file" "/etc/systemd/system/$filename"
            log "  systemd unit: $filename"
            ;;
        opssign-logrotate)
            cp "$file" /etc/logrotate.d/opssign
            log "  logrotate: /etc/logrotate.d/opssign"
            ;;
        *)
            cp "$file" "$OPSSIGN_ROOT/config/"
            log "  config: $filename"
            ;;
    esac
done
systemctl daemon-reload

chown -R opssign:opssign "$OPSSIGN_ROOT/scripts" "$OPSSIGN_ROOT/utils" "$OPSSIGN_ROOT/config"
cd /; rm -rf "$TEMP_DIR"

# --- Finish ----------------------------------------------------------------
KERNEL_CHANGED=false
if [ -f /var/run/reboot-required ] || [ "$(uname -r)" != "$KERNEL_BEFORE" ]; then
    KERNEL_CHANGED=true
fi

if [ "$IS_RESUME" = true ]; then
    if [ "$OVERLAY_DESIRED" != "true" ]; then
        clear_staging
        log "Overlay not requested for this device. Update complete, rebooting."
        sleep 3; reboot; exit 0
    fi

    if [ "$KERNEL_CHANGED" = true ]; then
        log "Kernel or firmware was updated. Deferring overlay rebuild to the next boot"
        log "so the overlay initramfs is built against the kernel that will run."
        set_stage "overlay"
        sleep 3; reboot; exit 0
    fi

    log "Re-enabling read-only overlay..."
    overlay_on || { clear_staging; fail "could not re-enable the overlay"; }
    clear_staging
    log "Update complete. Rebooting into normal operation."
    sleep 3; reboot; exit 0
fi

log "=== Update complete ==="
log "Backup:   $BACKUP_DIR"
log "Rollback: sudo $OPSSIGN_ROOT/utils/rollback-update.sh $BACKUP_DIR"
[ "$KERNEL_CHANGED" = true ] && log "NOTE: a reboot is required to finish (kernel/firmware changed)."

if [ "$DO_REBOOT" = true ] || [ "$KERNEL_CHANGED" = true ]; then
    log "Rebooting..."
    sleep 3; reboot
else
    log "Restarting kiosk session..."
    systemctl start getty@tty1.service 2>/dev/null || true
fi
