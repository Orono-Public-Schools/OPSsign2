#!/bin/bash
# Set device ID for OPSsign2

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <device-id>"
    echo "Example: $0 lobby-display-1"
    exit 1
fi

DEVICE_ID="$1"

# Validate device ID (alphanumeric, hyphens, underscores only)
if [[ ! "$DEVICE_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "❌ Device ID can only contain letters, numbers, hyphens, and underscores"
    exit 1
fi

echo "🏷️ Setting device ID to: $DEVICE_ID"

# Update configuration file
echo "DEVICE_ID=$DEVICE_ID" | sudo tee /opt/opssign/config/device.conf
echo "SERVER_URL=http://sign.orono.k12.mn.us:3000" | sudo tee -a /opt/opssign/config/device.conf

sudo chown opssign:opssign /opt/opssign/config/device.conf

echo "✅ Device ID set successfully!"
echo "📋 Don't forget to add this device in the admin interface"
echo "🔄 Reboot to apply changes: sudo reboot"