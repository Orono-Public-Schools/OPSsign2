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

REPO_URL="https://github.com/Orono-Public-Schools/OPSsign2.git"
OPSSIGN_ROOT="/opt/opssign"
CONF="$OPSSIGN_ROOT/config/device.conf"
LOG_DIR="$OPSSIGN_ROOT/logs"
MARKER="$OPSSIGN_ROOT/.update-stage"
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

# --- Overlay helpers -------------------------------------------------------
# raspi-config has no do_bootro. do_overlayfs takes ONE argument and applies it
# to both the overlay question and the boot-write-protect question:
#   do_overlayfs 0  -> overlay ON,  /boot read-only
#   do_overlayfs 1  -> overlay OFF, /boot writable
# The boot-partition half is skipped when an overlay is live at runtime, so
# /boot has to be unlocked separately on the reboot after disabling.

overlay_active() {
    grep -qw "boot=overlay" /proc/cmdline 2>/dev/null || \
    [ "$(findmnt -n -o SOURCE / 2>/dev/null)" = "overlay" ]
}

boot_mount() { [ -d /boot/firmware ] && echo /boot/firmware || echo /boot; }

unlock_boot() {
    raspi-config nonint disable_bootro 2>/dev/null || true
    findmnt -n -o OPTIONS "$(boot_mount)" | grep -qw ro && \
        mount -o remount,rw "$(boot_mount)" 2>/dev/null || true
}

set_stage() { echo "$1" > "$MARKER"; }
get_stage() { cat "$MARKER" 2>/dev/null || echo ""; }

clear_staging() {
    rm -f "$MARKER"
    systemctl disable "$RESUME_UNIT" >/dev/null 2>&1 || true
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
        raspi-config nonint do_overlayfs 0 || { clear_staging; fail "could not enable overlayfs"; }
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
    raspi-config nonint do_overlayfs 1 || fail "could not disable overlayfs"
    set_stage "apt"
    systemctl enable "$RESUME_UNIT" >/dev/null 2>&1 || fail "could not enable $RESUME_UNIT"
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
    raspi-config nonint do_overlayfs 0 || { clear_staging; fail "could not enable overlayfs"; }
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
