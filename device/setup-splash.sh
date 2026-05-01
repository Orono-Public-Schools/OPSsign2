#!/bin/bash
# OPSsign2 Boot Splash Screen Setup
# Configures the district logo as the Plymouth boot splash screen
# Usage: curl -sSL https://raw.githubusercontent.com/Orono-Public-Schools/OPSsign2/main/device/setup-splash.sh | bash
# Or: chmod +x setup-splash.sh && ./setup-splash.sh

set -e

SPLASH_URL="https://raw.githubusercontent.com/Orono-Public-Schools/OPSsign2/main/device/splash.png"
PLYMOUTH_PIX_DIR="/usr/share/plymouth/themes/pix"
TEMP_SPLASH="/tmp/ops-splash-$$.png"

echo "🖼️ OPSsign2 Boot Splash Setup"
echo ""

# Check if running as root
if [[ $EUID -eq 0 ]]; then
    echo "❌ Don't run this script as root. Run as a regular user with sudo access."
    exit 1
fi

# Check sudo access
if ! sudo -n true 2>/dev/null; then
    echo "❌ This script requires sudo access."
    exit 1
fi

# Install plymouth if not present
if ! dpkg -s plymouth &>/dev/null; then
    echo "📦 Installing Plymouth..."
    sudo apt update
    sudo apt install -y plymouth
    echo "✅ Plymouth installed"
else
    echo "✅ Plymouth already installed"
fi

# Download splash.png from repo
echo "📥 Downloading splash.png from repository..."
if ! curl -sSL "$SPLASH_URL" -o "$TEMP_SPLASH"; then
    echo "❌ Failed to download splash.png from repository"
    echo "   URL: $SPLASH_URL"
    exit 1
fi
echo "✅ Downloaded splash.png"

# Back up existing splash
if [ -f "$PLYMOUTH_PIX_DIR/splash.png" ]; then
    sudo cp "$PLYMOUTH_PIX_DIR/splash.png" "$PLYMOUTH_PIX_DIR/splash.png.bak"
    echo "✅ Backed up existing splash.png to splash.png.bak"
fi

# Copy new splash image
sudo cp "$TEMP_SPLASH" "$PLYMOUTH_PIX_DIR/splash.png"
rm -f "$TEMP_SPLASH"
echo "✅ Splash image installed"

# Configure Plymouth to use pix theme
echo "⚙️ Configuring Plymouth theme..."
sudo tee /etc/plymouth/plymouthd.conf > /dev/null <<EOF
# Administrator customizations go in this file
[Daemon]
Theme=pix
EOF
echo "✅ Plymouth theme set to pix"

# Rebuild initramfs
echo "🔄 Updating initramfs (this may take a minute)..."
sudo update-initramfs -u
echo "✅ Initramfs updated"

echo ""
echo "✅ Boot splash setup complete!"
echo "   The district logo will appear on next reboot."
echo ""
echo "Ready to reboot? (y/N)"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    echo "🔄 Rebooting now..."
    sudo reboot
else
    echo "👍 Manual reboot when ready: sudo reboot"
fi
