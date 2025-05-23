# OPSsign2 - Digital Signage System

A centralized digital signage system for Orono Public Schools, built with Node.js and Google Sheets integration.

## Features

- 🖥️ **Centralized Management** - Manage all digital displays from one server
- 📊 **Google Sheets Integration** - Device configurations stored in Google Sheets
- 🔐 **Google OAuth Authentication** - Secure admin access with school accounts
- 📱 **Web Admin Interface** - Easy-to-use dashboard for device management
- 🥧 **Raspberry Pi Support** - Simple setup scripts for Pi deployment
- 🎨 **Template System** - Multiple display layouts and themes
- 🔄 **Auto-refresh** - Displays automatically update with new content

## Architecture

- **Server**: Node.js/Express application with Google OAuth
- **Frontend**: Responsive web interfaces for both admin and displays
- **Configuration**: Google Sheets as the configuration backend
- **Displays**: Raspberry Pi devices running Chromium in kiosk mode

## Prerequisites

- Node.js 16+ (Node.js 18 has OpenSSL compatibility issues with Google APIs)
- Google Cloud Project with Sheets API enabled
- Google OAuth credentials
- Google Sheets for device configuration

## Configuration
Device configurations are stored in a Google Sheet with these columns:

* deviceId - Unique identifier for each display
* location - Human-readable location name
* template - Display template (standard, sidebar, weather)
* theme - Visual theme (default, dark)
* slideId - Google Slides presentation ID
* refreshInterval - How often to refresh (minutes)
* coordinates - GPS coordinates (optional)
* notes - Additional notes (optional)

## Development
Project Structure
OPSsign2/
├── server.js              # Main server application
├── public/                # Digital signage display files
│   ├── index.html         # Display interface
│   ├── style.css          # Display styling
│   └── assets/            # Images and static files
├── admin/                 # Admin interface files
│   ├── index.html         # Admin dashboard
│   ├── admin.css          # Admin styling
│   └── admin.js           # Admin JavaScript
├── templates/             # Display templates
├── themes/                # Visual themes
└── homepage.html          # System homepage

## API Endpoints

GET / - Homepage or digital display (based on deviceId parameter)
GET /admin - Admin interface (requires authentication)
GET /api/device-config/:deviceId - Get device configuration
GET /api/admin/devices - List all devices (admin only)
POST /api/admin/devices - Add new device (admin only)
PUT /api/admin/devices/:deviceId - Update device (admin only)
DELETE /api/admin/devices/:deviceId - Delete device (admin only)

### License
This project is developed for Orono Public Schools.

### Support
For issues or questions, please open a GitHub issue or contact the IT department.
