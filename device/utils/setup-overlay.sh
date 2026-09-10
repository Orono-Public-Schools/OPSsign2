#!/bin/bash
# Read-only overlay filesystem control for OPSsign2 devices.
#
#   sudo /opt/opssign/utils/setup-overlay.sh install   # install resume service only
#   sudo /opt/opssign/utils/setup-overlay.sh enable    # turn the overlay on
#   sudo /opt/opssign/utils/setup-overlay.sh disable   # turn it off
#        /opt/opssign/utils/setup-overlay.sh status
#
# With the overlay enabled, all writes to / land in RAM and are discarded on
# reboot: the SD card is never written during normal operation. That is what
# makes the device survive being unplugged and stops Chromium's cache from
# wearing the card out.

set -uo pipefail

OPSSIGN_ROOT="/opt/opssign"
CONF="$OPSSIGN_ROOT/config/device.conf"
RESUME_UNIT="opssign-update-resume.service"
ACTION="${1:-status}"

if [[ $EUID -ne 0 ]] && [ "$ACTION" != "status" ]; then
    echo "Must be run as root (use sudo)"; exit 1
fi

boot_mount() { [ -d /boot/firmware ] && echo /boot/firmware || echo /boot; }
cmdline_file() { echo "$(boot_mount)/cmdline.txt"; }

# Detect by filesystem TYPE - "overlay" for both implementations. The mount
# SOURCE differs (overlay vs overlayroot) and must not be tested.
overlay_active() {
    [ "$(findmnt -n -o FSTYPE / 2>/dev/null)" = "overlay" ]
}

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
            sed -i -e "s/[[:space:]]*overlayroot=[^[:space:]]*//g" "$cl"
            sed -i -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//" "$cl"
            ! grep -q "overlayroot=" "$cl"
            ;;
        *)
            raspi-config nonint do_overlayfs 1 || return 1
            overlay_active || raspi-config nonint disable_bootro 2>/dev/null || true
            ;;
    esac
}

overlay_on() {
    local cl; cl=$(cmdline_file)
    case "$(overlay_mechanism)" in
        overlayroot)
            _boot_rw
            grep -q "overlayroot=tmpfs" "$cl" || sed -i -e "s/$/ overlayroot=tmpfs/" "$cl"
            sed -i -e "s/[[:space:]]\+/ /g" -e "s/^ //" -e "s/ $//" "$cl"
            grep -q "overlayroot=tmpfs" "$cl"
            ;;
        *)
            raspi-config nonint do_overlayfs 0
            ;;
    esac
}

set_conf() {
    local key="$1" value="$2"
    touch "$CONF"
    if grep -q "^${key}=" "$CONF"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$CONF"
    else
        echo "${key}=${value}" >> "$CONF"
    fi
}

install_resume_unit() {
    if [ -f "$OPSSIGN_ROOT/config/$RESUME_UNIT" ]; then
        cp "$OPSSIGN_ROOT/config/$RESUME_UNIT" "/etc/systemd/system/$RESUME_UNIT"
    else
        cat > "/etc/systemd/system/$RESUME_UNIT" <<'UNIT'
[Unit]
Description=OPSsign2 staged device update (runs with the overlay disabled)
After=network-online.target
Wants=network-online.target
Before=getty@tty1.service
ConditionPathExists=/opt/opssign/.update-stage

[Service]
Type=oneshot
RemainAfterExit=no
TimeoutStartSec=3600
StandardOutput=journal+console
StandardError=journal+console
ExecStart=/opt/opssign/scripts/update-device.sh --resume

[Install]
WantedBy=multi-user.target
UNIT
    fi
    systemctl daemon-reload
    echo "  Installed $RESUME_UNIT"
}

case "$ACTION" in
  status)
    echo "Overlay filesystem: $(overlay_active && echo ACTIVE || echo inactive)"
    echo "Mechanism:          $(overlay_mechanism)"
    echo "Root fstype/source: $(findmnt -n -o FSTYPE / 2>/dev/null) / $(findmnt -n -o SOURCE / 2>/dev/null)"
    if [ "$(overlay_mechanism)" = "overlayroot" ]; then
        echo "Kernel cmdline:     $(grep -o 'overlayroot=[^ ]*' "$(cmdline_file)" 2>/dev/null || echo '(no overlayroot= token)')"
        echo "  NOTE: the kernel cmdline overrides /etc/overlayroot.conf entirely."
        echo "        Editing that conf file has no effect while the token is set."
    fi
    echo "Boot partition:     $(boot_mount) [$(findmnt -n -o OPTIONS "$(boot_mount)" 2>/dev/null | cut -d, -f1)]"
    echo "Desired state:      $(grep '^OVERLAY_ENABLED=' "$CONF" 2>/dev/null || echo 'OVERLAY_ENABLED=(unset)')"
    echo "Resume unit:        $([ -f "/etc/systemd/system/$RESUME_UNIT" ] && echo installed || echo 'NOT INSTALLED')"
    echo "Pending stage:      $(cat "$OPSSIGN_ROOT/.update-stage" 2>/dev/null || echo none)"
    ;;

  install)
    install_resume_unit
    ;;

  enable)
    echo "Pre-flight checks before locking the filesystem..."

    [ -f "$CONF" ] || { echo "  FAIL: $CONF missing. Run set-device-id.sh first."; exit 1; }
    if grep -q "DEVICE_ID=change-me" "$CONF"; then
        echo "  FAIL: DEVICE_ID is still the placeholder."
        echo "        sudo $OPSSIGN_ROOT/utils/set-device-id.sh <device-name>"
        exit 1
    fi
    echo "  OK: DEVICE_ID = $(grep '^DEVICE_ID=' "$CONF" | cut -d= -f2)"

    if ! test -d "/lib/modules/$(uname -r)"; then
        echo "  FAIL: no modules for the running kernel ($(uname -r))."
        echo "        Reboot into the installed kernel first, then re-run."
        exit 1
    fi
    echo "  OK: kernel modules present for $(uname -r)"

    install_resume_unit
    set_conf OVERLAY_ENABLED true

    if overlay_active; then
        echo "Overlay is already active. Desired state recorded."
        exit 0
    fi

    echo "  Syncing pending disk writes..."
    sync

    echo "Enabling overlay filesystem ($(overlay_mechanism))..."
    overlay_on || { echo "FAILED"; exit 1; }

    cat <<'NOTE'

Overlay enabled. It takes effect on the next reboot.

From then on:
  - Nothing written to / survives a reboot. /var/log is ephemeral.
  - apt and git changes will not stick until the overlay is turned off.
  - To update:  sudo /opt/opssign/scripts/update-device.sh --full
    That handles disable -> update -> re-enable for you, unattended.
  - For a manual change: 'setup-overlay.sh disable', reboot, make the change,
    'setup-overlay.sh enable', reboot.

NOTE
    echo "Reboot to activate: sudo reboot"
    ;;

  disable)
    set_conf OVERLAY_ENABLED false
    echo "Disabling overlay filesystem ($(overlay_mechanism))..."
    overlay_off || { echo "FAILED"; exit 1; }
    echo "Overlay disabled. Reboot for a writable filesystem: sudo reboot"
    ;;

  *)
    echo "Usage: $0 {install|enable|disable|status}"; exit 1 ;;
esac
