#!/bin/bash
# Chromium kiosk launcher for OPSsign2

# Load device configuration
source /opt/opssign/config/device.conf

# Default values
SERVER_URL=${SERVER_URL:-"http://sign.orono.k12.mn.us:3000"}
DEVICE_ID=${DEVICE_ID:-"unknown-device"}

# Log startup
echo "$(date): Starting Chromium kiosk for device: $DEVICE_ID" >> /var/log/opssign-kiosk.log

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Hide cursor after 5 seconds
unclutter -idle 5 &

# Clean chromium config to remove any windowed preferences
rm -rf /home/opssign/.config/chromium 2>/dev/null || true

# Create a fresh chromium config directory
mkdir -p /home/opssign/.config/chromium/Default

# Create preferences file that forces fullscreen
cat > /home/opssign/.config/chromium/Default/Preferences << 'EOF'
{
   "browser": {
      "window_placement": {
         "bottom": 1080,
         "left": 0,
         "maximized": true,
         "right": 1920,
         "top": 0,
         "work_area_bottom": 1080,
         "work_area_left": 0,
         "work_area_right": 1920,
         "work_area_top": 0
      }
   }
}
EOF

# Launch chromium with simplified but effective flags
exec chromium-browser \
    --kiosk \
    --no-sandbox \
    --disable-infobars \
    --disable-dev-tools \
    --disable-extensions \
    --no-first-run \
    --disable-translate \
    --disable-features=TranslateUI \
    --user-data-dir=/home/opssign/.config/chromium \
    "${SERVER_URL}/?deviceId=${DEVICE_ID}" \
    2>&1 | tee -a /var/log/opssign-kiosk.log