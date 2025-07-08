### device/install.sh
```bash
#!/bin/bash
# OPSsign2 Raspberry Pi Installation Script

set -e

echo "🚀 Starting OPSsign2 device setup..."

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "❌ Don't run this script as root. Run as pi user." 
   exit 1
fi

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install required packages
echo "📦 Installing required packages..."
sudo apt install -y \
    git \
    chromium-browser \
    xorg \
    unclutter \
    xinit \
    xserver-xorg-legacy

# Create opssign user if it doesn't exist
if ! id "opssign" &>/dev/null; then
    echo "👤 Creating opssign user..."
    sudo adduser --disabled-password --gecos "OPS Digital Signage" opssign
    sudo usermod -a -G audio,video opssign
fi

# Create directories
echo "📁 Creating directories..."
sudo mkdir -p /opt/opssign/{scripts,config,utils,logs}
sudo chown -R opssign:opssign /opt/opssign

# Copy scripts to system location
echo "📄 Installing scripts..."
sudo cp scripts/* /opt/opssign/scripts/
sudo cp utils/* /opt/opssign/utils/
sudo cp config/* /opt/opssign/config/
sudo chmod +x /opt/opssign/scripts/*
sudo chmod +x /opt/opssign/utils/*

# Set up opssign user environment
echo "⚙️ Configuring opssign user..."
sudo cp /opt/opssign/config/xinitrc.template /home/opssign/.xinitrc
sudo cp /opt/opssign/config/bashrc.template /tmp/bashrc_addon
sudo cat /tmp/bashrc_addon >> /home/opssign/.bashrc
sudo chown opssign:opssign /home/opssign/.xinitrc /home/opssign/.bashrc
sudo chmod +x /home/opssign/.xinitrc

# Set up autologin
echo "🔧 Configuring autologin..."
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d/
sudo cp /opt/opssign/config/autologin.conf /etc/systemd/system/getty@tty1.service.d/

# Allow X server to be started by any user
echo "🖥️ Configuring X server permissions..."
echo 'allowed_users=anybody' | sudo tee /etc/X11/Xwrapper.config

# Create device ID placeholder
echo "🏷️ Creating device ID configuration..."
echo "DEVICE_ID=change-me" | sudo tee /opt/opssign/config/device.conf
sudo chown opssign:opssign /opt/opssign/config/device.conf

# Enable services
echo "🔄 Enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable getty@tty1.service

# Create update mechanism
echo "📥 Setting up update mechanism..."
echo '#!/bin/bash' | sudo tee /opt/opssign/utils/update-device.sh
echo 'cd /tmp && git clone https://github.com/Orono-Public-Schools/OPSsign2.git' | sudo tee -a /opt/opssign/utils/update-device.sh
echo 'cp -r OPSsign2/device/scripts/* /opt/opssign/scripts/' | sudo tee -a /opt/opssign/utils/update-device.sh
echo 'cp -r OPSsign2/device/utils/* /opt/opssign/utils/' | sudo tee -a /opt/opssign/utils/update-device.sh
echo 'chmod +x /opt/opssign/scripts/* /opt/opssign/utils/*' | sudo tee -a /opt/opssign/utils/update-device.sh
echo 'rm -rf /tmp/OPSsign2' | sudo tee -a /opt/opssign/utils/update-device.sh
echo 'echo "✅ Device scripts updated!"' | sudo tee -a /opt/opssign/utils/update-device.sh
sudo chmod +x /opt/opssign/utils/update-device.sh

echo ""
echo "✅ OPSsign2 device setup complete!"
echo ""
echo "Next steps:"
echo "1. Set your device ID: sudo /opt/opssign/utils/set-device-id.sh your-device-name"
echo "2. Reboot: sudo reboot"
echo "3. The display should start automatically on boot"
echo ""
echo "For troubleshooting: tail -f /var/log/opssign-kiosk.log"