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

# Launch chromium in kiosk mode
exec chromium-browser \
    --kiosk \
    --start-fullscreen \
    --force-device-scale-factor=1 \
    --disable-features=VizDisplayCompositor \
    --no-sandbox \
    --disable-infobars \
    --disable-dev-tools \
    --disable-extensions \
    --disable-plugins \
    --disable-java \
    --disable-translate \
    --disable-web-security \
    --disable-features=TranslateUI \
    --disable-sync \
    --disable-default-apps \
    --no-first-run \
    --hide-scrollbars \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --autoplay-policy=no-user-gesture-required \
    --user-data-dir=/home/opssign/.config/chromium \
    --app="${SERVER_URL}/?deviceId=${DEVICE_ID}" \
    2>&1 | tee -a /var/log/opssign-kiosk.log