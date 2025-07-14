# OPSsign2 Project Updates Summary

This document summarizes the major improvements and additions made to the OPSsign2 digital signage system.

## 1. Template System Enhancements

### Understanding the Current Template System
- Templates are stored in `/templates/{templateName}/index.html.template`
- Uses placeholder replacement: `{LOCATION}`, `{PRESENTATION_ID}`, `{DEVICE_ID}`, `{THEME_PATH}`
- Current templates: `standard`, `sidebar`, `weather`
- Template loading handled by `loadTemplate()` function in `public/index.html`

### Template Logic Fix for No SlideID
**Problem**: Templates showed "No Google Slide ID configured" error even when they had default content.

**Solution**: Updated `applyConfiguration()` method in `public/index.html`:
```javascript
// Initialize Google Slide if available
if (this.config.slideId) {
    this.initializeSlide(this.config.slideId);
} else {
    // Let the template handle the no-slideId case
    console.log('No slideId configured - using template default content');
    
    // For standard template, we still want to show an error
    if (!this.config.template || this.config.template === 'standard') {
        this.showError('No Google Slide ID configured for this device');
    } else {
        // For custom templates, let them show their default content
        console.log(`Template "${this.config.template}" will show default content`);
    }
}
```

## 2. New Templates Created

### Announcement Template (`templates/announcement/index.html.template`)
- **Purpose**: Eye-catching announcements and important messages
- **Features**: 
  - Gradient background with school branding
  - Default announcement content when no slideId
  - Animated elements (pulse effect)
  - Real-time clock display
  - Responsive design
- **Fallback Logic**: Shows announcement content when no slideId, switches to slides when available

### Full-Screen Template (`templates/fullscreen/index.html.template`)
- **Purpose**: Slideshow-only display with no branding or UI elements
- **Features**:
  - 100% full-screen coverage
  - No banner, footer, or navigation
  - Minimal device overlay (hover to show)
  - Clean loading and error states
  - Force-fill CSS to eliminate black bars
- **CSS Scaling Solution**: `transform: scale(1.15)` or `object-fit: contain` based on preference

### Admin Interface Updates
Updated `admin/index.html` to include new templates:
```html
<select id="template" name="template">
    <option value="standard">Standard</option>
    <option value="sidebar">Sidebar</option>
    <option value="weather">Weather</option>
    <option value="announcement">Announcement</option>
    <option value="fullscreen">Full-Screen</option>
</select>
```

Updated template count: `<div class="stat-number" id="totalTemplates">5</div>`

## 3. Raspberry Pi Device Management System

### New Directory Structure
```
OPSsign2/
└── device/                     # New folder for Pi setup
    ├── README.md              # Setup instructions
    ├── install.sh             # One-time Pi setup script
    ├── scripts/               # Runtime scripts
    │   ├── chromium-kiosk.sh  # Chromium launcher
    │   ├── start-kiosk.sh     # X session starter
    │   └── update-device.sh   # Update scripts from repo
    ├── config/                # Configuration files
    │   ├── xinitrc.template   # .xinitrc template
    │   ├── bashrc.template    # .bashrc additions
    │   └── autologin.conf     # systemd autologin config
    └── utils/                 # Utility scripts
        ├── set-device-id.sh   # Set device ID
        ├── test-display.sh    # Test the display
        └── reset-kiosk.sh     # Reset if something breaks
```

### One-Command Pi Setup
**Remote Installation**:
```bash
curl -sSL https://raw.githubusercontent.com/Orono-Public-Schools/OPSsign2/main/device/install.sh | bash
```

**Key Features**:
- Works with custom `opstech` user (not default `pi` user)
- Creates dedicated `opssign` kiosk user
- Installs minimal X server environment (no desktop)
- Configures autologin and auto-start
- Sets up logging and log rotation
- Includes update mechanism

### Security Enhancements
- **Custom User**: Uses `opstech` user instead of default `pi`
- **Minimal Privileges**: `opssign` user has no sudo access
- **No Desktop Environment**: Runs only X server + Chromium
- **Disabled Shortcuts**: Eliminates Ctrl+Alt+T and similar shortcuts
- **Locked Down**: Prevents context menus and text selection
- **SSH Access Maintained**: Remote management via `opstech` user

### Device Management Scripts

#### install.sh
- Complete Pi setup from fresh Raspberry Pi OS
- Package installation and user creation
- System configuration and security setup
- Auto-reboot option

#### update-device.sh
- Pull latest scripts from git repository
- Automatic backup before updating
- Rollback capability
- Preserves device-specific configuration

#### set-device-id.sh
- Set unique device identifier
- Validates device ID format
- Updates configuration files
- Integration with admin interface

## 4. Chromium Kiosk Fixes

### Full-Screen Display Issue
**Problem**: Chromium only occupied left half of screen despite kiosk mode.

**Root Cause**: Chromium's saved preferences caused windowed behavior.

**Solution**: Force clean preferences with correct window placement:
```bash
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
```

### Optimized Chromium Launch
**Final Working Command**:
```bash
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
```

## 5. Template Development Best Practices

### Placeholder System
- Use `{LOCATION}` for device location
- Use `{PRESENTATION_ID}` for Google Slides ID
- Use `{DEVICE_ID}` for device identifier
- Use `{THEME_PATH}` for CSS theme path

### Template Structure
- Include loading states for good UX
- Handle both slideId and no-slideId scenarios
- Maintain responsive design for different screen sizes
- Include proper error handling
- Use consistent footer structure

### CSS for Full-Screen Content
```css
/* For templates that need to eliminate black bars */
#slideContainer iframe {
    width: 100vw !important;
    height: 100vh !important;
    transform: scale(1.15) !important; /* Eliminates black bars */
    transform-origin: center center !important;
    object-fit: contain !important; /* Alternative approach */
}
```

## 6. Deployment Workflow

### New Device Setup
1. Flash Raspberry Pi OS with custom `opstech` user
2. Run installation script
3. Set device ID
4. Add device in admin interface
5. Reboot - device starts automatically

### Updates and Maintenance
1. Make changes to scripts in git repository
2. Commit and push changes
3. Update devices: `sudo /opt/opssign/scripts/update-device.sh`
4. Rollback if needed: `sudo /opt/opssign/utils/rollback-update.sh`

### Benefits Achieved
- ✅ **Version Control**: All Pi setup tracked in git
- ✅ **Consistent Deployment**: Identical setup across all devices
- ✅ **Easy Updates**: Push to git, pull to devices
- ✅ **Centralized Management**: Single admin interface
- ✅ **Security**: Custom users, minimal privileges
- ✅ **Scalability**: Easy to add new devices
- ✅ **Maintainability**: Documented, scripted processes

## 7. Files Modified/Created

### New Files Created
- `device/install.sh` - Pi setup script
- `device/scripts/chromium-kiosk.sh` - Chromium launcher
- `device/scripts/start-kiosk.sh` - X session starter
- `device/scripts/update-device.sh` - Update mechanism
- `device/utils/set-device-id.sh` - Device ID management
- `device/utils/rollback-update.sh` - Rollback capability
- `device/config/xinitrc.template` - X session config
- `device/config/bashrc.template` - Auto-start config
- `device/config/autologin.conf` - System autologin
- `device/README.md` - Setup documentation
- `templates/announcement/index.html.template` - Announcement template
- `templates/fullscreen/index.html.template` - Full-screen template

### Files Modified
- `public/index.html` - Updated template loading logic
- `admin/index.html` - Added new template options, updated counts

## 8. Next Steps / Future Enhancements

### Potential Template Ideas
- **Emergency Template**: High-contrast, attention-grabbing design
- **Menu Template**: Food service menu display
- **Event Template**: Upcoming events and calendar
- **Directory Template**: Staff directory and locations
- **Sports Template**: Game schedules and scores

### System Enhancements
- **Health Monitoring**: Device status reporting
- **Remote Reboot**: Restart devices from admin interface
- **Screenshot Capture**: See what devices are displaying
- **Bandwidth Monitoring**: Track data usage
- **Scheduled Content**: Time-based template switching

This completes the major enhancements to the OPSsign2 digital signage system, providing a robust, scalable, and maintainable solution for Orono Public Schools.