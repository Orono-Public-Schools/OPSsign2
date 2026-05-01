#!/bin/bash
# OPSsign2 Raspberry Pi Installation Script
# Usage: curl -sSL https://raw.githubusercontent.com/Orono-Public-Schools/OPSsign2/main/device/install.sh | bash
# Or: git clone repo && cd OPSsign2/device && chmod +x install.sh && ./install.sh

set -e

REPO_URL="https://github.com/Orono-Public-Schools/OPSsign2.git"
TEMP_DIR="/tmp/opssign-install-$$"

echo "🚀 Starting OPSsign2 device setup..."
echo "   This will configure this Raspberry Pi as a digital signage device"
echo ""

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "❌ Don't run this script as root. Run as a regular user with sudo access." 
   echo "   Example: ./install.sh"
   exit 1
fi

# Check if we have sudo access
if ! sudo -n true 2>/dev/null; then
    echo "❌ This script requires sudo access. Please ensure the current user can run sudo commands."
    exit 1
fi

# Detect if we're already in the git repo
if [ -f "scripts/chromium-kiosk.sh" ] && [ -f "config/autologin.conf" ]; then
    echo "📁 Running from local git repository"
    DEVICE_DIR="$(pwd)"
    CLEANUP_TEMP=false
else
    echo "📥 Downloading OPSsign2 repository..."
    cd /tmp
    rm -rf "$TEMP_DIR" 2>/dev/null || true
    git clone "$REPO_URL" "$TEMP_DIR"
    DEVICE_DIR="$TEMP_DIR/device"
    CLEANUP_TEMP=true
    
    if [ ! -d "$DEVICE_DIR" ]; then
        echo "❌ Device setup files not found in repository"
        exit 1
    fi
fi

cd "$DEVICE_DIR"

# Show system info
echo "🔍 System Information:"
echo "   OS: $(lsb_release -d -s 2>/dev/null || echo 'Unknown')"
echo "   Architecture: $(uname -m)"
echo "   Kernel: $(uname -r)"
echo ""

# Update system
echo "📦 Updating system packages..."
sudo apt update
sudo apt upgrade -y

# Install required packages
echo "📦 Installing required packages..."
sudo apt install -y \
    git \
    chromium-browser \
    xorg \
    unclutter \
    xinit \
    xserver-xorg-legacy \
    curl \
    wget \
    plymouth

echo "✅ Packages installed successfully"

# Create opssign user if it doesn't exist
if ! id "opssign" &>/dev/null; then
    echo "👤 Creating opssign user..."
    sudo adduser --disabled-password --gecos "OPS Digital Signage" opssign
    sudo usermod -a -G audio,video opssign
    echo "✅ User 'opssign' created"
else
    echo "👤 User 'opssign' already exists"
    sudo usermod -a -G audio,video opssign
fi

# Create directories
echo "📁 Creating directories..."
sudo mkdir -p /opt/opssign/{scripts,config,utils,logs,backup}
sudo chown -R opssign:opssign /opt/opssign

# Copy scripts to system location
echo "📄 Installing scripts..."
if [ -d "scripts" ]; then
    sudo cp scripts/* /opt/opssign/scripts/
    sudo chmod +x /opt/opssign/scripts/*
    echo "✅ Scripts installed"
fi

if [ -d "utils" ]; then
    sudo cp utils/* /opt/opssign/utils/
    sudo chmod +x /opt/opssign/utils/*
    echo "✅ Utilities installed"
fi

if [ -d "config" ]; then
    sudo cp config/* /opt/opssign/config/
    echo "✅ Config templates installed"
fi

# Set up opssign user environment
echo "⚙️ Configuring opssign user..."

# Set up .xinitrc
if [ -f "/opt/opssign/config/xinitrc.template" ]; then
    sudo cp /opt/opssign/config/xinitrc.template /home/opssign/.xinitrc
    sudo chown opssign:opssign /home/opssign/.xinitrc
    sudo chmod +x /home/opssign/.xinitrc
fi

# Set up .bashrc additions
if [ -f "/opt/opssign/config/bashrc.template" ]; then
    # Check if our additions are already in .bashrc
    if ! grep -q "OPSsign2 auto-start" /home/opssign/.bashrc 2>/dev/null; then
        echo "" | sudo tee -a /home/opssign/.bashrc
        sudo cat /opt/opssign/config/bashrc.template | sudo tee -a /home/opssign/.bashrc
        echo "✅ Auto-start configured in .bashrc"
    else
        echo "✅ Auto-start already configured in .bashrc"
    fi
fi

sudo chown opssign:opssign /home/opssign/.bashrc

# Set up autologin
echo "🔧 Configuring autologin..."
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d/
if [ -f "/opt/opssign/config/autologin.conf" ]; then
    sudo cp /opt/opssign/config/autologin.conf /etc/systemd/system/getty@tty1.service.d/
    echo "✅ Autologin configured"
fi

# Allow X server to be started by any user
echo "🖥️ Configuring X server permissions..."
echo 'allowed_users=anybody' | sudo tee /etc/X11/Xwrapper.config
echo 'needs_root_rights=yes' | sudo tee -a /etc/X11/Xwrapper.config

# Create device ID configuration with placeholder
echo "🏷️ Creating device ID configuration..."
if [ ! -f "/opt/opssign/config/device.conf" ]; then
    echo "# OPSsign2 Device Configuration" | sudo tee /opt/opssign/config/device.conf
    echo "DEVICE_ID=change-me-$(hostname)" | sudo tee -a /opt/opssign/config/device.conf
    echo "SERVER_URL=http://sign.orono.k12.mn.us:3000" | sudo tee -a /opt/opssign/config/device.conf
    sudo chown opssign:opssign /opt/opssign/config/device.conf
    echo "✅ Device configuration created"
else
    echo "✅ Device configuration already exists"
fi

# Set proper ownership for all opssign files
sudo chown -R opssign:opssign /opt/opssign

# Enable services
echo "🔄 Enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable getty@tty1.service

# Create log file with proper permissions
sudo touch /var/log/opssign-kiosk.log
sudo chown opssign:opssign /var/log/opssign-kiosk.log

# Setup log rotation
echo "📝 Setting up log rotation..."
sudo tee /etc/logrotate.d/opssign > /dev/null <<EOF
/var/log/opssign-kiosk.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 644 opssign opssign
}
EOF

# Clean up temporary files if we downloaded the repo
if [ "$CLEANUP_TEMP" = true ]; then
    rm -rf "$TEMP_DIR"
fi

# Final system configuration
echo "🔧 Final system configuration..."

# Disable unnecessary services to improve boot time
sudo systemctl disable bluetooth 2>/dev/null || true
sudo systemctl disable hciuart 2>/dev/null || true

# Configure GPU memory split for better graphics performance
if ! grep -q "gpu_mem" /boot/config.txt; then
    echo "gpu_mem=128" | sudo tee -a /boot/config.txt
fi

# Disable overscan if not already done
if ! grep -q "disable_overscan" /boot/config.txt; then
    echo "disable_overscan=1" | sudo tee -a /boot/config.txt
fi

# Configure Plymouth boot splash
echo "🖼️ Configuring boot splash screen..."
if [ -f "$DEVICE_DIR/splash.png" ]; then
    sudo cp /usr/share/plymouth/themes/pix/splash.png \
            /usr/share/plymouth/themes/pix/splash.png.bak 2>/dev/null || true
    sudo cp "$DEVICE_DIR/splash.png" /usr/share/plymouth/themes/pix/splash.png
    sudo tee /etc/plymouth/plymouthd.conf > /dev/null <<EOF
# Administrator customizations go in this file
[Daemon]
Theme=pix
EOF
    echo "🔄 Updating initramfs (this may take a minute)..."
    sudo update-initramfs -u
    echo "✅ Boot splash configured"
else
    echo "⚠️  splash.png not found in device directory - skipping boot splash setup"
fi

echo ""
echo "✅ OPSsign2 device setup completed successfully!"
echo ""
echo "📋 Next steps:"
echo "1. Set your device ID:"
echo "   sudo /opt/opssign/utils/set-device-id.sh your-device-name"
echo ""
echo "2. Add this device in the admin interface at:"
echo "   http://sign.orono.k12.mn.us:3000/admin"
echo ""
echo "3. Reboot to start the kiosk:"
echo "   sudo reboot"
echo ""
echo "📚 Useful commands:"
echo "• View logs: tail -f /var/log/opssign-kiosk.log"
echo "• Update device: sudo /opt/opssign/scripts/update-device.sh"
echo "• Test display: /opt/opssign/utils/test-display.sh"
echo "• Change device ID: sudo /opt/opssign/utils/set-device-id.sh new-name"
echo ""
echo "🆘 If something goes wrong:"
echo "• SSH in and run: sudo pkill chromium"
echo "• Check logs: tail -f /var/log/opssign-kiosk.log"
echo "• Reset: sudo /opt/opssign/utils/reset-kiosk.sh"
echo ""
echo "Ready to reboot? (y/N)"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    echo "🔄 Rebooting now..."
    sudo reboot
else
    echo "👍 Manual reboot required when ready: sudo reboot"
fi
