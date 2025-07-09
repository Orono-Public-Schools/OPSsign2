#!/bin/bash
# Update device scripts from OPSsign2 git repository
# Usage: sudo /opt/opssign/scripts/update-device.sh

set -e

REPO_URL="https://github.com/Orono-Public-Schools/OPSsign2.git"
TEMP_DIR="/tmp/opssign-update-$$"
BACKUP_DIR="/opt/opssign/backup/$(date +%Y%m%d-%H%M%S)"

echo "🔄 Starting OPSsign2 device update..."

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run as root (use sudo)" 
   exit 1
fi

# Create backup directory
echo "💾 Creating backup..."
mkdir -p "$BACKUP_DIR"
cp -r /opt/opssign/scripts "$BACKUP_DIR/"
cp -r /opt/opssign/utils "$BACKUP_DIR/"
echo "✅ Backup created at: $BACKUP_DIR"

# Clone the latest repository
echo "📥 Downloading latest version..."
cd /tmp
rm -rf "$TEMP_DIR" 2>/dev/null || true
git clone "$REPO_URL" "$TEMP_DIR"

if [ ! -d "$TEMP_DIR/device" ]; then
    echo "❌ Device scripts not found in repository"
    exit 1
fi

cd "$TEMP_DIR"

# Show what we're updating
echo "📋 Current version info:"
echo "  Repository: $(git remote get-url origin)"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Date: $(git log -1 --format=%cd --date=short)"
echo "  Message: $(git log -1 --format=%s)"

# Update scripts
echo "📄 Updating scripts..."
if [ -d "device/scripts" ]; then
    cp device/scripts/* /opt/opssign/scripts/
    chmod +x /opt/opssign/scripts/*
    echo "✅ Scripts updated"
fi

# Update utilities
echo "🔧 Updating utilities..."
if [ -d "device/utils" ]; then
    cp device/utils/* /opt/opssign/utils/
    chmod +x /opt/opssign/utils/*
    echo "✅ Utilities updated"
fi

# Update config templates (but don't overwrite existing config)
echo "⚙️ Updating config templates..."
if [ -d "device/config" ]; then
    # Copy templates, but preserve existing device.conf
    for file in device/config/*; do
        filename=$(basename "$file")
        if [ "$filename" != "device.conf" ] || [ ! -f "/opt/opssign/config/$filename" ]; then
            cp "$file" /opt/opssign/config/
            echo "  Updated: $filename"
        else
            echo "  Preserved: $filename (existing config kept)"
        fi
    done
    echo "✅ Config templates updated"
fi

# Set proper ownership
chown -R opssign:opssign /opt/opssign/scripts /opt/opssign/utils
chown -R opssign:opssign /opt/opssign/config

# Clean up
rm -rf "$TEMP_DIR"

# Check if kiosk is currently running
if pgrep -f "chromium.*kiosk" > /dev/null; then
    echo ""
    echo "🖥️ Kiosk is currently running."
    echo "   The updates will take effect on next restart."
    echo ""
    echo "Options:"
    echo "  • Reboot now: sudo reboot"
    echo "  • Restart kiosk: sudo pkill -f chromium && sudo systemctl restart getty@tty1"
    echo "  • Wait for next automatic restart"
else
    echo "✅ No kiosk currently running - updates ready for next start"
fi

echo ""
echo "✅ OPSsign2 device update completed successfully!"
echo ""
echo "📁 Backup location: $BACKUP_DIR"
echo "📝 To view logs: tail -f /var/log/opssign-kiosk.log"
echo "🔄 To rollback: sudo /opt/opssign/utils/rollback-update.sh $BACKUP_DIR"