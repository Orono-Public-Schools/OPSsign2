#!/bin/bash
# X session starter for OPSsign2

# Wait for X server to be ready
sleep 3

# Log session start
echo "$(date): Starting kiosk session" >> /var/log/opssign-kiosk.log

# Start the chromium kiosk
/opt/opssign/scripts/chromium-kiosk.sh