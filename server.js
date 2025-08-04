const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');
const ping = require('ping');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const deviceStatuses = new Map();
const deviceIPs = new Map();

// Building Groups Configuration
const BUILDING_GROUPS = {
  'SE': 'sign-se@orono.k12.mn.us',
  'IS': 'sign-is@orono.k12.mn.us', 
  'MS': 'sign-ms@orono.k12.mn.us',
  'HS': 'sign-hs@orono.k12.mn.us',
  'DC': 'sign-dc@orono.k12.mn.us',
  'DO': 'sign-do@orono.k12.mn.us'
};

const ADMIN_GROUP = 'sign-admin@orono.k12.mn.us';

// Cache for group memberships (15 minute TTL)
const groupMembershipCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  console.log('✅ Google Groups permissions integration loaded');
  console.log('📋 Building groups configured:', Object.keys(BUILDING_GROUPS).join(', '));
  console.log('👑 Admin group:', ADMIN_GROUP);

// SSE Connection Management
const connectedDevices = new Map(); // deviceId -> { response, connectedAt, lastPing }

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false, // Set to true in production with HTTPS
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true
  }
}));

// Passport configuration
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Check if user email is from Orono Public Schools domain
      const email = profile.emails[0].value;
      if (email.endsWith('@orono.k12.mn.us')) {
        console.log(`Authorized login: ${email}`);
        return done(null, profile);
      } else {
        console.log(`Unauthorized login attempt: ${email}`);
        return done(null, false, { message: 'Unauthorized domain' });
      }
    } catch (error) {
      return done(error, null);
    }
  }
));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Authentication middleware
/**
 * Enhanced authentication middleware with building permissions
 */
async function requireAuthWithPermissions(req, res, next) {
  console.log('Auth check with permissions - isAuthenticated:', req.isAuthenticated());
  
  if (!req.isAuthenticated()) {
    console.log('User not authenticated, showing login page');
    req.session.returnTo = req.originalUrl;
    
    return res.send(`
      <html>
        <head><title>OPSsign2 Login</title></head>
        <body style="font-family: Arial; text-align: center; margin-top: 100px;">
          <h1>OPSsign2 Admin Login</h1>
          <p>Please sign in with your Orono Public Schools account</p>
          <a href="/auth/google" style="background: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Sign in with Google
          </a>
          <br><br>
          <a href="/" style="color: #666;">← Back to Homepage</a>
        </body>
      </html>
    `);
  }

  try {
    // Get user's building permissions
    const userEmail = req.user.emails[0].value;
    req.userPermissions = await getUserBuildingPermissions(userEmail);
    
    // Check if user has any signage access
    if (req.userPermissions.level === 'none') {
      console.log(`❌ Access denied for ${userEmail} - not in any signage group`);
      return res.status(403).send(`
        <html>
          <head><title>Access Denied</title></head>
          <body style="font-family: Arial; text-align: center; margin-top: 100px;">
            <h1>Access Denied</h1>
            <p>You must be a member of a digital signage group to access this interface.</p>
            <p>Please contact your IT administrator to request access.</p>
            <p>Your email: <strong>${userEmail}</strong></p>
            <br>
            <a href="/auth/logout" style="color: #666;">← Logout</a>
          </body>
        </html>
      `);
    }

    console.log(`✅ Access granted: ${userEmail} (${req.userPermissions.level} level, buildings: ${req.userPermissions.buildings.join(', ')})`);
    next();
  } catch (error) {
    console.error('Permission check error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Filter devices based on user's building permissions
 */
function filterDevicesByPermissions(devices, userPermissions) {
  if (userPermissions.level === 'district') {
    return devices; // District admin sees all
  }
  
  return devices.filter(device => 
    userPermissions.buildings.includes(device.building)
  );
}

/**
 * Filter alerts based on user's building permissions
 */
function filterAlertsByPermissions(alerts, userPermissions) {
  if (userPermissions.level === 'district') {
    return alerts; // District admin sees all
  }
  
  // For building-level admins, show alerts that target any of their buildings
  // OR alerts that are for everyone (i.e., have no specific buildings assigned).
  return alerts.filter(alert => {
    const alertBuildings = Array.isArray(alert.buildings) ? alert.buildings : [];

    // If an alert has no buildings, it's considered global and should be seen by everyone.
    if (alertBuildings.length === 0) {
      return true;
    }

    // Otherwise, check if the user has access to at least one of the alert's target buildings.
    return alertBuildings.some(buildingCode =>
      userPermissions.buildings.includes(buildingCode)
    );
  });
}

/**
 * Check if user can access a specific building
 */
function canAccessBuilding(userPermissions, building) {
  return userPermissions.buildings.includes(building);
}

// Clear group membership cache periodically (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of groupMembershipCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      groupMembershipCache.delete(key);
    }
  }
}, 60 * 60 * 1000); // 1 hour


// Authentication routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/admin/login-failed.html',
    failureMessage: true
  }),
  (req, res) => {
    console.log('OAuth callback successful for:', req.user.emails[0].value);

    // Check if there's a 'returnTo' parameter to redirect back to where they came from
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;

    res.redirect(returnTo);
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    // Always redirect to homepage after logout
    res.redirect('/');
  });
});

// ==================== SSE IMPLEMENTATION ====================

// SSE endpoint for real-time device communication
app.get('/api/device/:deviceId/events', (req, res) => {
  const deviceId = req.params.deviceId;
  
  console.log(`🔌 SSE connection request from device: ${deviceId}`);
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*', // Adjust for your domain if needed
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    message: 'SSE connection established',
    deviceId: deviceId,
    timestamp: Date.now()
  })}\n\n`);
  
  // Store this connection
  connectedDevices.set(deviceId, {
    response: res,
    connectedAt: Date.now(),
    lastPing: Date.now()
  });
  
  console.log(`📡 Device ${deviceId} connected via SSE. Total connections: ${connectedDevices.size}`);
  
  // Clean up when connection closes
  req.on('close', () => {
    connectedDevices.delete(deviceId);
    console.log(`📴 Device ${deviceId} disconnected from SSE. Remaining connections: ${connectedDevices.size}`);
  });
  
  req.on('error', (err) => {
    console.log(`❌ SSE error for device ${deviceId}:`, err.message);
    connectedDevices.delete(deviceId);
  });
});

// Push function - send data to specific device
function pushToDevice(deviceId, data) {
  const connection = connectedDevices.get(deviceId);
  if (connection && connection.response) {
    try {
      const message = JSON.stringify({
        ...data,
        timestamp: Date.now(),
        deviceId: deviceId
      });
      
      connection.response.write(`data: ${message}\n\n`);
      connection.lastPing = Date.now();
      
      console.log(`📤 Pushed to device ${deviceId}:`, data.type);
      return true;
    } catch (err) {
      console.log(`❌ Failed to push to device ${deviceId}:`, err.message);
      connectedDevices.delete(deviceId);
      return false;
    }
  }
  console.log(`⚠️  Device ${deviceId} not connected for push`);
  return false;
}

// Push function - send data to multiple specific devices
function pushToDevices(deviceIds, data) {
  const results = deviceIds.map(deviceId => ({
    deviceId,
    success: pushToDevice(deviceId, data)
  }));
  
  const successful = results.filter(r => r.success).length;
  console.log(`📤 Pushed to ${successful}/${deviceIds.length} devices`);
  
  return results;
}

// Push function - send data to devices in specific buildings
function pushToBuilding(buildingCode, data) {
  // Get devices for this building from current sheet data
  fetchGoogleSheet()
    .then(rows => {
      const devices = parseSheetData(rows);
      const buildingDevices = devices
        .filter(device => device.building === buildingCode)
        .map(device => device.deviceId);
      
      if (buildingDevices.length > 0) {
        console.log(`🏢 Pushing to ${buildingDevices.length} devices in building ${buildingCode}`);
        return pushToDevices(buildingDevices, data);
      } else {
        console.log(`⚠️  No devices found for building ${buildingCode}`);
        return [];
      }
    })
    .catch(err => {
      console.error(`❌ Error getting devices for building ${buildingCode}:`, err.message);
      return [];
    });
}

// Push function - send data to all connected devices
function pushToAllDevices(data) {
  const deviceIds = Array.from(connectedDevices.keys());
  console.log(`📡 Pushing to all ${deviceIds.length} connected devices`);
  
  return pushToDevices(deviceIds, data);
}

// Helper function - get list of connected devices
function getConnectedDevices() {
  return Array.from(connectedDevices.keys());
}

// Helper function - get connection info
function getConnectionInfo() {
  const connections = {};
  connectedDevices.forEach((connection, deviceId) => {
    connections[deviceId] = {
      connectedAt: connection.connectedAt,
      lastPing: connection.lastPing,
      connectedFor: Date.now() - connection.connectedAt
    };
  });
  return connections;
}

// ==================== SSE ADMIN API ROUTES ====================

// SSE status endpoint for admin
app.get('/api/admin/sse/status', requireAuthWithPermissions, (req, res) => {
  res.json({
    connectedDevices: getConnectedDevices(),
    totalConnections: connectedDevices.size,
    connectionInfo: getConnectionInfo()
  });
});

// Test push to specific device
app.post('/api/admin/sse/test-push/:deviceId', requireAuthWithPermissions, (req, res) => {
  const deviceId = req.params.deviceId;
  const success = pushToDevice(deviceId, {
    type: 'test',
    message: 'This is a test push from the admin interface',
    testData: req.body
  });
  
  res.json({
    success,
    deviceId,
    message: success ? 'Push sent successfully' : 'Device not connected'
  });
});

// Test push to all devices
app.post('/api/admin/sse/test-push-all', requireAuthWithPermissions, (req, res) => {
  const results = pushToAllDevices({
    type: 'test',
    message: 'This is a test push to all devices from admin interface',
    testData: req.body
  });
  
  res.json({
    success: true,
    results,
    totalDevices: results.length,
    successfulPushes: results.filter(r => r.success).length
  });
});

// Push refresh to a single device
app.post('/api/admin/push/refresh-one/:deviceId', requireAuthWithPermissions, (req, res) => {
  try {
    const { deviceId } = req.params;
    const success = pushToDevice(deviceId, { type: 'refresh' });
    
    res.json({
      success,
      message: success 
        ? `Refresh signal sent to ${deviceId}` 
        : `Device ${deviceId} not connected via SSE.`
    });

  } catch (error) {
    console.error(`Error pushing refresh to ${req.params.deviceId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Push refresh to specific devices
app.post('/api/admin/push/refresh', requireAuthWithPermissions, (req, res) => {
  try {
    const { deviceIds } = req.body;
    const results = pushToDevices(deviceIds, { type: 'refresh' });
    
    res.json({
      success: true,
      results: results,
      pushed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Push refresh to all devices
app.post('/api/admin/push/refresh-all', requireAuthWithPermissions, (req, res) => {
  try {
    const results = pushToAllDevices({ type: 'refresh' });
    res.json({ 
      success: true, 
      devicesNotified: results.filter(r => r.success).length,
      totalDevices: results.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== END SSE IMPLEMENTATION ====================

// Periodic cleanup of stale SSE connections
setInterval(() => {
  const now = Date.now();
  const staleTimeout = 5 * 60 * 1000; // 5 minutes
  
  connectedDevices.forEach((connection, deviceId) => {
    if (now - connection.lastPing > staleTimeout) {
      console.log(`🧹 Removing stale SSE connection for device ${deviceId}`);
      connectedDevices.delete(deviceId);
    }
  });
}, 60000); // Check every minute

// Google Sheets helper functions
let auth = null;
let sheets = null;

// Initialize Google Sheets API
async function initializeGoogleSheets() {
  try {
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL;
    const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

    if (serviceAccountEmail && serviceAccountKey) {
      console.log('🔄 Attempting to initialize Google Sheets API with service account...');
      // Initialize service account - simplified approach
      try {
        const serviceAccountPath = './service-account-key.json';
        const auth = new google.auth.GoogleAuth({
          keyFile: serviceAccountPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Google Sheets API initialized successfully with service account');
      } catch (authError) {
        console.error('❌ Service account authentication failed:', authError.message);
        sheets = null;
      }
    } else {
      console.log('ℹ️  No service account configured, using manual mode');
      sheets = null;
    }
  } catch (error) {
    console.error('❌ Failed to initialize Google Sheets API:', error.message);
    console.log('ℹ️  Falling back to manual mode');
    sheets = null;
  }
}

async function fetchGoogleSheet() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Displays';  // Keep this for now

  // If service account is available, use it for an authenticated read to avoid caching delays.
  if (sheets) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: sheetName,
      });
      return response.data.values || [];
    } catch (error) {
      console.error(`Authenticated read for '${sheetName}' failed, falling back to public API. Error: ${error.message}`);
      // Fallback to public API key if authenticated read fails for some reason
    }
  }

  // Fallback to public API key
  console.log(`Falling back to public API key for reading '${sheetName}' sheet.`);
  const apiKey = process.env.GOOGLE_API_KEY;
  const response = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}?key=${apiKey}`
  );

  return response.data.values || [];
}

async function addDeviceToSheet(deviceData) {
  if (!sheets) {
    throw new Error('Google Sheets API not initialized with service account');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Displays';  // Keep this for now

  // First, get current data to determine the next row
  const currentData = await fetchGoogleSheet();
  const nextRow = currentData.length + 1;

  // Prepare the row data in the correct order - UPDATED to include building
  // IMPORTANT: This assumes a fixed column order in your Google Sheet.
  const rowData = [
    deviceData.deviceId,              // A: deviceId
    deviceData.ipAddress || '',       // B: ipAddress
    deviceData.location || '',        // C: location
    deviceData.template || 'standard', // D: template
    deviceData.theme || 'default',    // E: theme
    deviceData.slideId || '',         // F: slideId
    deviceData.refreshInterval || 15, // G: refreshInterval
    deviceData.coordinates || '',     // H: coordinates
    deviceData.notes || '',           // I: notes
    deviceData.building || '',        // J: building
    deviceData.name || ''             // K: displayname
  ];

  const request = {
    spreadsheetId: sheetId,
    range: `${sheetName}!A${nextRow}:K${nextRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [rowData]
    }
  };

  const response = await sheets.spreadsheets.values.update(request);
  return response;
}

async function updateDeviceInSheet(deviceId, deviceData) {
  if (!sheets) {
    throw new Error('Google Sheets API not initialized with service account');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Displays';  // Keep this for now

  // Get current data to find the row to update
  const currentData = await fetchGoogleSheet();
  const headers = currentData[0];
  const deviceIdCol = headers.indexOf('deviceId');

  if (deviceIdCol === -1) {
    throw new Error('deviceId column not found in sheet');
  }

  // Find the row with this deviceId
  let targetRow = -1;
  for (let i = 1; i < currentData.length; i++) {
    if (currentData[i][deviceIdCol] === deviceId) {
      targetRow = i + 1; // +1 because sheets are 1-indexed
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error(`Device ${deviceId} not found in sheet`);
  }

  // Prepare the updated row data - UPDATED to include building
  // IMPORTANT: This assumes a fixed column order in your Google Sheet.
  const rowData = [
    deviceData.deviceId,              // A: deviceId
    deviceData.ipAddress || '',       // B: ipAddress
    deviceData.location || '',        // C: location
    deviceData.template || 'standard', // D: template
    deviceData.theme || 'default',    // E: theme
    deviceData.slideId || '',         // F: slideId
    deviceData.refreshInterval || 15, // G: refreshInterval
    deviceData.coordinates || '',     // H: coordinates
    deviceData.notes || '',           // I: notes
    deviceData.building || '',        // J: building
    deviceData.name || ''             // K: displayname
  ];

  const request = {
    spreadsheetId: sheetId,
    range: `${sheetName}!A${targetRow}:K${targetRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [rowData]
    }
  };

  const response = await sheets.spreadsheets.values.update(request);
  return response;
}

async function deleteDeviceFromSheet(deviceId) {
  if (!sheets) {
    throw new Error('Google Sheets API not initialized with service account');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Displays';

  // Get current data to find the row to delete
  const currentData = await fetchGoogleSheet();
  const headers = currentData[0];
  const deviceIdCol = headers.indexOf('deviceId');

  if (deviceIdCol === -1) {
    throw new Error('deviceId column not found in sheet');
  }

  // Find the row with this deviceId
  let targetRow = -1;
  for (let i = 1; i < currentData.length; i++) {
    if (currentData[i][deviceIdCol] === deviceId) {
      targetRow = i; // 0-indexed for the delete operation
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error(`Device ${deviceId} not found in sheet`);
  }

  // Dynamically find the sheetId (gid) to make deletion robust
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) {
    throw new Error(`Sheet with name "${sheetName}" not found.`);
  }
  const gid = sheet.properties.sheetId;

  // Delete the row
  const request = {
    spreadsheetId: sheetId,
 	   resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: gid, // Use dynamic GID
            dimension: 'ROWS',
            startIndex: targetRow,
            endIndex: targetRow + 1
          }
        }
      }]
    }
  };

  const response = await sheets.spreadsheets.batchUpdate(request);
  return response;
}

// ==================== ALERT HELPER FUNCTIONS ====================

// Fetch alerts from Google Sheets
async function fetchAlertsSheet() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Alerts';

  // If service account is available, use it for an authenticated read to avoid caching delays.
  if (sheets) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: sheetName,
      });
      return response.data.values || [];
    } catch (error) {
      console.error(`Authenticated read for '${sheetName}' failed, falling back to public API. Error: ${error.message}`);
      // Fallback to public API key if authenticated read fails for some reason
    }
  }

  // If service account fails or isn't configured, fall back to public API key.
  // This will now throw an error if the sheet is not found or not public, which is
  // the desired behavior for the admin panel to report issues correctly.
  console.log(`Falling back to public API key for reading '${sheetName}' sheet.`);
  const apiKey = process.env.GOOGLE_API_KEY;
  const response = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}?key=${apiKey}`
  );
  return response.data.values || [];
}

// Parse alerts data and filter for active alerts
function parseAlertsData(rows) {
  if (rows.length === 0) return [];

  const headers = rows[0];
  const alerts = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const alert = {};

    headers.forEach((header, index) => {
      alert[header] = row[index] || '';
    });

    // Normalize alertId vs alertID from sheet to ensure consistency for client-side code.
    // This handles cases where the sheet header might be 'alertID'.
    if (alert.alertID && !alert.alertId) {
      alert.alertId = alert.alertID;
      delete alert.alertID;
    }

    // Only include active alerts that haven't expired
    if (alert.active === 'TRUE' || alert.active === true) {
      // Check expiration
      if (alert.expires && alert.expires !== '') {
        const expirationDate = new Date(alert.expires);
        if (expirationDate <= new Date()) {
          continue; // Skip expired alerts
        }
      }

      // Parse buildings into an array
      if (alert.buildings && typeof alert.buildings === 'string') {
        // Split and filter out any empty strings that result from trailing commas etc.
        alert.buildings = alert.buildings.split(',').map(b => b.trim()).filter(Boolean);
      } else {
        alert.buildings = [];
      }

      alerts.push(alert);
    }
  }

  return alerts;
}

// Parse all alerts for the admin interface (does not filter by active/expired)
function parseAllAlertsDataForAdmin(rows) {
  if (!rows || rows.length < 2) return [];

  const headers = rows[0];
  const alerts = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0) continue; // Skip empty rows

    const alert = {};
    headers.forEach((header, index) => {
      alert[header] = row[index] || '';
    });

    // Normalize alertId vs alertID from sheet to ensure consistency
    if (alert.alertID && !alert.alertId) {
      alert.alertId = alert.alertID;
      delete alert.alertID;
    }

    // A row is considered a potential alert if it has a name OR an ID.
    // This is very lenient to ensure all potentially valid data is shown in the admin UI.
    if (alert.name || alert.alertId) {
      // Convert 'TRUE'/'FALSE' strings to booleans
      alert.active = (alert.active === 'TRUE' || alert.active === true);

      // Parse buildings into an array
      if (alert.buildings && typeof alert.buildings === 'string') {
        alert.buildings = alert.buildings.split(',').map(b => b.trim()).filter(Boolean);
      } else if (!Array.isArray(alert.buildings)) {
        alert.buildings = [];
      }
      alerts.push(alert);
    }
  }
  return alerts;
}

// Get alerts for a specific building
function getAlertsForBuilding(alerts, building) {
  if (!building || !alerts || alerts.length === 0) return [];

  return alerts.filter(alert => {
    // An alert applies if its building list is empty (global alert for all buildings)
    // OR if its building list explicitly includes the device's building.
    const isGlobalAlert = !alert.buildings || alert.buildings.length === 0;
    const isTargeted = Array.isArray(alert.buildings) && alert.buildings.includes(building);
    return isGlobalAlert || isTargeted;
  }).sort((a, b) => {
      // Sort by priority: high > medium > low
      const priorityValues = { high: 3, medium: 2, low: 1 };
      const priorityA = a.priority ? a.priority.toLowerCase() : 'low';
      const priorityB = b.priority ? b.priority.toLowerCase() : 'low';
      return (priorityValues[priorityB] || 1) - (priorityValues[priorityA] || 1);
    });
}

// Add alert to Google Sheets
async function addAlertToSheet(alertData) {
  if (!sheets) {
    throw new Error('Google Sheets API not initialized with service account');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Alerts';

  // Get headers to build the row correctly
  const currentData = await fetchAlertsSheet();
  const headers = currentData[0] || [];

  // Find the actual header used for alert IDs, case-insensitively.
  // Default to 'alertId' if not found, though it should exist.
  const alertIdHeader = headers.find(h => h.toLowerCase() === 'alertid') || 'alertId';


  // Generate alert ID
  const alertId = `alert${Date.now()}`;

  const defaults = {
    priority: 'Medium',
    active: 'TRUE',
  };

  const fullAlertData = {
    ...defaults,
    ...alertData,
    alertId,
    buildings: Array.isArray(alertData.buildings) ? alertData.buildings.join(',') : '',
  };

  // Add the generated ID to the data object using the correct header key from the sheet.
  fullAlertData[alertIdHeader] = alertId;

  // Now, map the data to the row using the sheet's headers. This will correctly find the ID.

  const rowData = headers.map(header => fullAlertData[header] || '');

  const request = {
    spreadsheetId: sheetId,
    range: sheetName, // Append to the sheet
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: {
      values: [rowData]
    }
  };

  await sheets.spreadsheets.values.append(request);

  // Return the new alert data with the standardized 'alertId' key for the client.
  return { ...alertData, alertId };
}

// Update alert in Google Sheets
async function updateAlertInSheet(alertId, updates) {
  if (!sheets) {
    throw new Error('Google Sheets API not initialized with service account');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Alerts';

  // Get current data to find the row to update
  const currentData = await fetchAlertsSheet();
  const headers = currentData[0] || [];
  // Find the column index for 'alertId' case-insensitively
  const alertIdCol = headers.findIndex(h => h.toLowerCase() === 'alertid');

  if (alertIdCol === -1) {
    throw new Error('alertId column not found in alerts sheet');
  }

  // Find the row with this alertId
  let targetRow = -1;
  for (let i = 1; i < currentData.length; i++) {
    if (currentData[i][alertIdCol] === alertId) {
      targetRow = i + 1; // +1 because sheets are 1-indexed
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error(`Alert ${alertId} not found in sheet`);
  }

  // Get the existing row data as an object and merge with updates
  const existingRowObject = {};
  headers.forEach((header, index) => {
    existingRowObject[header] = currentData[targetRow - 1][index] || '';
  });

  // Prepare updates, ensuring correct types
  const processedUpdates = { ...updates };
  if (processedUpdates.buildings && Array.isArray(processedUpdates.buildings)) {
    processedUpdates.buildings = processedUpdates.buildings.join(',');
  }
  if (processedUpdates.active !== undefined) {
    processedUpdates.active = String(processedUpdates.active).toUpperCase();
  }

  const updatedData = { ...existingRowObject, ...processedUpdates };
  const rowData = headers.map(header => updatedData[header] || '');

  // Update the row
  const request = {
    spreadsheetId: sheetId,
    // Dynamically calculate the range based on number of headers
    range: `${sheetName}!A${targetRow}:${String.fromCharCode(65 + headers.length - 1)}${targetRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [rowData]
    }
  };

  const response = await sheets.spreadsheets.values.update(request);
  return response;
}

// Delete alert from Google Sheets
async function deleteAlertFromSheet(alertId) {
  if (!sheets) {
    throw new Error('Google Sheets API not initialized with service account');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Alerts';

  // Get current data to find the row to delete
  const currentData = await fetchAlertsSheet();
  const headers = currentData[0];
  // Find the column index for 'alertId' case-insensitively
  const alertIdCol = headers.findIndex(h => h.toLowerCase() === 'alertid');

  if (alertIdCol === -1) {
    throw new Error('alertId column not found in alerts sheet');
  }

  // Find the row with this alertId
  let targetRow = -1;
  for (let i = 1; i < currentData.length; i++) {
    if (currentData[i][alertIdCol] === alertId) {
      targetRow = i; // 0-indexed for the delete operation
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error(`Alert ${alertId} not found in sheet`);
  }

  // Dynamically find the sheetId (gid) to make deletion robust
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) {
    throw new Error(`Sheet with name "${sheetName}" not found.`);
  }
  const gid = sheet.properties.sheetId;

  // Delete the row
  const request = {
    spreadsheetId: sheetId,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: gid, // Use dynamic GID
            dimension: 'ROWS',
            startIndex: targetRow,
            endIndex: targetRow + 1
          }
        }
      }]
    }
  };

  const response = await sheets.spreadsheets.batchUpdate(request);
  return response;
}

// ==================== END ALERT FUNCTIONS ====================

/**
 * Get user's building permissions by checking Google Group memberships
 */
async function getUserBuildingPermissions(userEmail) {
  console.log(`🔍 Debug: Checking permissions for ${userEmail}`);
  const cacheKey = userEmail;
  const cached = groupMembershipCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`🔍 Debug: Using cached permissions for ${userEmail}`);
    return cached.permissions;
  }

  try {
  console.log(`🔍 Debug: Initializing JWT authentication for domain-wide delegation...`);
  
  // Use JWT authentication directly
  const { JWT } = require('google-auth-library');
  const serviceAccount = require('./service-account-key.json');

  const jwtClient = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: [
      'https://www.googleapis.com/auth/admin.directory.group.member.readonly'
    ],
    subject: 'jason.woyak@orono.k12.mn.us'
  });

  await jwtClient.authorize();
  console.log(`✅ Debug: JWT client authorized successfully`);

  const directory = google.admin({ version: 'directory_v1', auth: jwtClient });
  console.log(`🔍 Debug: Directory API initialized, checking admin group...`);

    // Check if user is district admin first
    try {
      console.log(`🔍 Debug: Checking if ${userEmail} is in admin group: ${ADMIN_GROUP}`);
      const adminResult = await directory.members.get({
        groupKey: ADMIN_GROUP,
        memberKey: userEmail
      });
      console.log(`✅ Debug: User IS in admin group!`, adminResult.data);
      
      // User is district admin - has access to all buildings
      const permissions = {
        level: 'district',
        buildings: ['SE', 'IS', 'MS', 'HS', 'DC', 'DO'],
        isAdmin: true
      };
      
      groupMembershipCache.set(cacheKey, {
        permissions,
        timestamp: Date.now()
      });
      
      console.log(`✅ District admin access granted for: ${userEmail}`);
      return permissions;
    } catch (adminCheckError) {
      console.log(`🔍 Debug: User NOT in admin group. Error:`, adminCheckError.message);
      // User is not in admin group, check building-specific groups
    }

    const userBuildings = []

    // Check building-specific group memberships
    for (const [buildingCode, groupEmail] of Object.entries(BUILDING_GROUPS)) {
      try {
        console.log(`🔍 Debug: Checking if ${userEmail} is in ${buildingCode} group: ${groupEmail}`);
        const memberResult = await directory.members.get({
          groupKey: groupEmail,
          memberKey: userEmail
        });
        console.log(`✅ Debug: User IS in ${buildingCode} group!`);
        userBuildings.push(buildingCode);
      } catch (memberCheckError) {
        console.log(`🔍 Debug: User NOT in ${buildingCode} group. Error:`, memberCheckError.message);
      }
    }

    const permissions = userBuildings.length > 0 
      ? {
          level: 'building',
          buildings: userBuildings,
          isAdmin: false
        }
      : {
          level: 'none',
          buildings: [],
          isAdmin: false
        };

    // Cache the result
    groupMembershipCache.set(cacheKey, {
      permissions,
      timestamp: Date.now()
    });

    if (permissions.level === 'building') {
      console.log(`✅ Building admin access granted: ${userEmail} -> ${userBuildings.join(', ')}`);
    } else {
      console.log(`❌ No signage group access for: ${userEmail}`);
    }

    return permissions;

  } catch (error) {
    console.error('Error checking group memberships:', error);
    
    // Return no access on error, but log for debugging
    console.log(`⚠️  Falling back to no access for ${userEmail} due to error`);
    return {
      level: 'none',
      buildings: [],
      isAdmin: false
    };
  }
}

/**
 * Extract Google Slides presentation ID from various URL formats
 */
function extractSlideIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;
  
  // Handle different Google Slides URL formats
  const patterns = [
    /\/presentation\/d\/([a-zA-Z0-9-_]+)/,
    /\/presentation\/d\/([a-zA-Z0-9-_]+)\/edit/,
    /\/presentation\/d\/([a-zA-Z0-9-_]+)\/preview/,
    /\/presentation\/d\/([a-zA-Z0-9-_]+)\/embed/
  ];
  
  for (const pattern of patterns) {
    const match = trimmedUrl.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // If it looks like it's already just a presentation ID, return as-is
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmedUrl)) {
    return trimmedUrl;
  }
  
  return null;
}

/**
 * Process device configuration, converting presentation links to slide IDs
 */
function processDeviceConfig(rawConfig) {
    const config = { ...rawConfig };

    // 1. Prioritize a directly provided slideId.
    //    Clean it up in case it's a full URL pasted into the slideId field.
    if (config.slideId && config.slideId.includes('docs.google.com')) {
        const extractedId = extractSlideIdFromUrl(config.slideId);
        if (extractedId) {
            config.slideId = extractedId;
        }
    }

    // 2. If no slideId, try to derive it from presentationLink.
    if (!config.slideId && config.presentationLink) {
        const extractedId = extractSlideIdFromUrl(config.presentationLink);
        if (extractedId) {
            config.slideId = extractedId;
        }
    }

    return config;
}

// Ping monitoring functions
async function checkDeviceStatus(deviceId, ipAddress) {
  try {
    const result = await ping.promise.probe(ipAddress, {
      timeout: 3,
      extra: ['-c', '1'] // Send only 1 packet
    });

    return {
      deviceId,
      status: result.alive ? 'online' : 'offline',
      responseTime: result.time,
      lastChecked: new Date().toISOString(),
      ipAddress
    };
  } catch (error) {
    return {
      deviceId,
      status: 'offline',
      error: error.message,
      lastChecked: new Date().toISOString(),
      ipAddress
    };
  }
}

async function pingAllDevices() {
  console.log(`🏓 Pinging ${deviceIPs.size} devices...`);

  for (const [deviceId, ipAddress] of deviceIPs) {
    if (ipAddress && ipAddress !== '') {
      const status = await checkDeviceStatus(deviceId, ipAddress);
      deviceStatuses.set(deviceId, status);
      console.log(`📡 ${deviceId} (${ipAddress}): ${status.status}`);
    }
  }
}

// Function to update device IP mapping from Google Sheets
async function updateDeviceIPs() {
  try {
    const rows = await fetchGoogleSheet();
    const devices = parseSheetData(rows);

    // Clear and rebuild IP mapping
    deviceIPs.clear();

    devices.forEach(device => {
      if (device.deviceId && device.ipAddress) {
        deviceIPs.set(device.deviceId, device.ipAddress);
      }
    });

    console.log(`📋 Updated IP mapping for ${deviceIPs.size} devices`);
  } catch (error) {
    console.error('Error updating device IPs:', error);
  }
}

// UPDATED: Modify existing parseSheetData function to include alerts
function parseSheetData(rows) {
  if (rows.length === 0) return [];

  const headers = rows[0];
  const data = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const device = {};

    headers.forEach((header, index) => {
      device[header] = row[index] || '';
    });

    // Normalize the display name. Prefer 'displayname', fall back to 'deviceId'.
    device.name = device.displayname || device.name || device.deviceId;

    // Get status from ping monitoring
    const pingStatus = deviceStatuses.get(device.deviceId);
    device.status = pingStatus ? pingStatus.status : 'unknown';
    device.lastSeen = pingStatus ? pingStatus.lastChecked : 'Never';
    device.responseTime = pingStatus ? pingStatus.responseTime : null;

    data.push(device);
  }

  return data;
}

// Test route to see if Express routing is working
app.get('/homepage-test', (req, res) => {
  console.log('Homepage test route hit!');
  res.sendFile(path.join(__dirname, 'homepage.html'));
});

// Digital signage display route (main application)
app.get('/', (req, res) => {
  console.log('=== ROOT ROUTE HIT ===');
  console.log('Query params:', req.query);
  console.log('URL:', req.url);

  const deviceId = req.query.deviceId;
  console.log('Device ID:', deviceId);

  // If deviceId is provided, show the digital signage display
  if (deviceId) {
    console.log(`Serving digital signage for device: ${deviceId}`);
        
    // Set cache-control headers to ensure the browser always loads the latest
    // version of the application's HTML and JavaScript logic.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    return;
  }

  // Otherwise show the homepage
  console.log('Serving homepage - no deviceId provided');
  console.log('Homepage path:', path.join(__dirname, 'homepage.html'));

  // Check if homepage file exists
  const fs = require('fs');
  const homepagePath = path.join(__dirname, 'homepage.html');

  if (fs.existsSync(homepagePath)) {
    console.log('Homepage file exists, serving it');
    res.sendFile(homepagePath);
  } else {
    console.log('Homepage file NOT found!');
    res.send('<h1>Homepage file missing</h1><p>Expected at: ' + homepagePath + '</p>');
  }
});

// Device configuration API (UPDATED to include alerts)
app.get('/api/device-config/:deviceId', async (req, res) => {
  // Set cache-control headers to ensure the client always gets the latest config.
  // This prevents the browser from using a stale, cached version of the data.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const deviceId = req.params.deviceId;

    // Don't process requests for 'unknown' devices
    if (deviceId === 'unknown' || !deviceId) {
      return res.status(400).json({
        error: 'Invalid device ID',
        message: 'Please provide a valid device ID parameter'
      });
    }

    console.log(`Configuration request for device: ${deviceId}`);

    // Fetch data from both Google Sheets
    const [displayRows, alertRows] = await Promise.all([
      fetchGoogleSheet(),    // Displays sheet
      fetchAlertsSheet()     // Alerts sheet
    ]);

    const devices = parseSheetData(displayRows);
    const alerts = parseAlertsData(alertRows);

    // Find device configuration
    const rawDeviceConfig = devices.find(device => device.deviceId === deviceId);
    
    if (rawDeviceConfig) {
      console.log(`Raw configuration found for device: ${deviceId}`);
      
      // Process the configuration to handle slide IDs from URLs
      const deviceConfig = processDeviceConfig(rawDeviceConfig);
      
      // Get alerts for this device's building
      const deviceAlerts = getAlertsForBuilding(alerts, deviceConfig.building);
      
      // Add alerts to the device configuration
      deviceConfig.alerts = deviceAlerts;
      
      console.log(`Found ${deviceAlerts.length} alerts for building: ${deviceConfig.building}, slideId: ${deviceConfig.slideId}`);
      
      res.json(deviceConfig);
    } else {
      console.log(`No configuration found for device: ${deviceId}, using defaults`);

      // Return default configuration with alerts (no building filter for defaults)
      const defaultConfig = {
        deviceId: deviceId,
        template: 'standard',
        theme: 'default',
        slideId: '1E7v2rVGN8TabxalUlXSHE2zEhJxv0tEXiCxE3FD99Ic',
        refreshInterval: 15,
        location: 'Orono Public Schools',
        building: '',
        alerts: [], // No alerts for unconfigured devices
        lastUpdated: new Date().toISOString()
      };

      res.json(defaultConfig);
    }
  } catch (error) {
    console.error('Error fetching device configuration:', error);

    // Return default configuration on error
    const defaultConfig = {
      deviceId: req.params.deviceId,
      template: 'standard',
      theme: 'default',
      slideId: '1E7v2rVGN8TabxalUlXSHE2zEhJxv0tEXiCxE3FD99Ic',
      refreshInterval: 15,
      location: 'Orono Public Schools',
      building: '',
      alerts: [],
      lastUpdated: new Date().toISOString(),
      error: 'Failed to load from Google Sheets'
    };

    res.json(defaultConfig);
  }
});

// API route to get current user info
app.get('/api/user', requireAuthWithPermissions, (req, res) => {
  res.json({
    name: req.user.displayName,
    email: req.user.emails[0].value,
    photo: req.user.photos[0].value,
    permissions: req.userPermissions
  });
});

// Test admin authentication
app.get('/api/admin/test', requireAuthWithPermissions, (req, res) => {
  res.json({
    message: 'Admin authentication working',
    user: req.user.emails[0].value,
    timestamp: new Date().toISOString()
  });
});

// Debug session info
app.get('/debug/session', (req, res) => {
  res.json({
    isAuthenticated: req.isAuthenticated(),
    user: req.user ? req.user.emails[0].value : 'No user',
    session: req.session ? 'Session exists' : 'No session',
    sessionID: req.sessionID || 'No session ID'
  });
});

// Admin routes
app.get('/admin', requireAuthWithPermissions, (req, res) => {
  console.log('Admin route accessed by:', req.user.emails[0].value);
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Admin API routes
app.get('/api/admin/devices', requireAuthWithPermissions, async (req, res) => {
  try {
    console.log('Admin devices request from:', req.user.emails[0].value);

    const rows = await fetchGoogleSheet();
    const allDevices = parseSheetData(rows);
    
    // Filter devices based on user's permissions
    const filteredDevices = filterDevicesByPermissions(allDevices, req.userPermissions);
    
    console.log(`Returning ${filteredDevices.length} of ${allDevices.length} devices for user's buildings: ${req.userPermissions.buildings.join(', ')}`);
    res.json(filteredDevices);
  } catch (error) {
    console.error('Error loading devices:', error);
    res.status(500).json({
      error: 'Failed to load devices from Google Sheets',
      details: error.message
    });
  }
});

app.post('/api/admin/devices', requireAuthWithPermissions, async (req, res) => {
  try {
    const newDevice = req.body;
    console.log('Device add requested by:', req.user.emails[0].value, newDevice);

    // Validate user can access the specified building
    if (newDevice.building && !canAccessBuilding(req.userPermissions, newDevice.building)) {
      return res.status(403).json({
        error: 'Access denied',
        message: `You don't have permission to manage devices in building: ${newDevice.building}`
      });
    }

    // Process the device config (convert URLs to IDs if needed)
    const processedDevice = processDeviceConfig(newDevice);

    if (sheets) {
      await addDeviceToSheet(processedDevice);
      console.log(`✅ Device ${processedDevice.deviceId} added to Google Sheets by ${req.user.emails[0].value}`);

      res.json({
        success: true,
        message: `Device "${processedDevice.deviceId}" added successfully to Google Sheets!`,
        device: processedDevice
      });
    } else {
      res.json({
        success: true,
        message: 'Device configuration saved. Please add this device manually to your Google Sheet for now.',
        device: processedDevice,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error adding device:', error);
    res.status(500).json({
      error: 'Failed to add device',
      details: error.message
    });
  }
});

// Update device editing to include building validation:
app.put('/api/admin/devices/:deviceId', requireAuthWithPermissions, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const updates = req.body;

    console.log(`Device update requested for ${deviceId} by:`, req.user.emails[0].value);

    // Get existing device to check current building
    const rows = await fetchGoogleSheet();
    const allDevices = parseSheetData(rows);
    const existingDevice = allDevices.find(d => d.deviceId === deviceId);
    
    if (!existingDevice) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Check if user can access the current building
    if (!canAccessBuilding(req.userPermissions, existingDevice.building)) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You don\'t have permission to modify this device'
      });
    }

    // If changing building, check access to new building too
    if (updates.building && updates.building !== existingDevice.building) {
      if (!canAccessBuilding(req.userPermissions, updates.building)) {
        return res.status(403).json({
          error: 'Access denied',
          message: `You don't have permission to move devices to building: ${updates.building}`
        });
      }
    }

    // Process the updates (convert URLs to IDs if needed)
    const processedUpdates = processDeviceConfig(updates);

    if (sheets) {
      await updateDeviceInSheet(deviceId, processedUpdates);
      console.log(`✅ Device ${deviceId} updated in Google Sheets by ${req.user.emails[0].value}`);

      res.json({
        success: true,
        message: `Device "${deviceId}" updated successfully in Google Sheets!`,
        deviceId: deviceId,
        updates: processedUpdates
      });
    } else {
      res.json({
        success: true,
        message: 'Device configuration updated. Please update this device manually in your Google Sheet for now.',
        deviceId: deviceId,
        updates: processedUpdates,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error updating device:', error);
    res.status(500).json({
      error: 'Failed to update device',
      details: error.message
    });
  }
});

app.delete('/api/admin/devices/:deviceId', requireAuthWithPermissions, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    console.log(`Device delete requested for: ${deviceId} by:`, req.user.emails[0].value);

    // Get existing device to check building permission
    const rows = await fetchGoogleSheet();
    const allDevices = parseSheetData(rows);
    const existingDevice = allDevices.find(d => d.deviceId === deviceId);
    
    if (!existingDevice) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Check if user can access this device's building
    if (!canAccessBuilding(req.userPermissions, existingDevice.building)) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You don\'t have permission to delete this device'
      });
    }

    if (sheets) {
      await deleteDeviceFromSheet(deviceId);
      console.log(`✅ Device ${deviceId} deleted from Google Sheets by ${req.user.emails[0].value}`);

      res.json({
        success: true,
        message: `Device "${deviceId}" deleted successfully from Google Sheets!`,
        deviceId: deviceId
      });
    } else {
      res.json({
        success: true,
        message: 'Device marked for deletion. Please remove this device manually from your Google Sheet for now.',
        deviceId: deviceId,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({
      error: 'Failed to delete device',
      details: error.message
    });
  }
});

app.get('/api/admin/user-info', requireAuthWithPermissions, (req, res) => {
  res.json({
    user: {
      name: req.user.displayName,
      email: req.user.emails[0].value,
      photo: req.user.photos[0].value
    },
    permissions: req.userPermissions
  });
});

// ==================== ALERT API ROUTES ====================

// Get all alerts (admin only)
app.get('/api/admin/alerts', requireAuthWithPermissions, async (req, res) => {
  try {
    console.log('Admin alerts request from:', req.user.emails[0].value);

    const alertRows = await fetchAlertsSheet();
    const allAlerts = parseAllAlertsDataForAdmin(alertRows);
    
    // Filter alerts based on user's permissions
    const filteredAlerts = filterAlertsByPermissions(allAlerts, req.userPermissions);

    console.log(`Returning ${filteredAlerts.length} of ${allAlerts.length} alerts for user's buildings`);
    res.json(filteredAlerts);
  } catch (error) {
    console.error('Error loading alerts:', error);
    res.status(500).json({
      error: 'Failed to load alerts from Google Sheets',
      details: error.message
    });
  }
});

// Add new alert (admin only)
app.post('/api/admin/alerts', requireAuthWithPermissions, async (req, res) => {
  try {
    const newAlert = req.body;
    console.log('Alert add requested by:', req.user.emails[0].value, newAlert);

    // --- Enhanced Validation ---
    if (!newAlert.name || !newAlert.buildings || newAlert.buildings.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Alert name and at least one building are required.'
      });
    }

    switch (newAlert.type) {
      case 'slide':
        if (!newAlert.slideId) {
          return res.status(400).json({ error: 'Missing required fields', message: 'Google Slide ID is required for this alert type.' });
        }
        break;
      case 'custom':
        if (!newAlert.title || !newAlert.text) {
          return res.status(400).json({ error: 'Missing required fields', message: 'Title and Message Body are required for a custom alert.' });
        }
        break;
      case 'srp':
        if (!newAlert.srpAction) {
          return res.status(400).json({ error: 'Missing required fields', message: 'A Standard Response Protocol action is required.' });
        }
        break;
      default:
        return res.status(400).json({ error: 'Invalid alert type', message: `Unknown alert type: ${newAlert.type}` });
    }
    // Validate user can access all specified buildings
    const invalidBuildings = newAlert.buildings.filter(building => 
      !canAccessBuilding(req.userPermissions, building)
    );

    if (invalidBuildings.length > 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: `You don't have permission to create alerts for buildings: ${invalidBuildings.join(', ')}`
      });
    }

    // Process the alert config (convert URLs to IDs if needed)
    const processedAlert = processDeviceConfig(newAlert);

    if (sheets) {
      const alertWithId = await addAlertToSheet(processedAlert);
      console.log(`✅ Alert ${alertWithId.alertId} added to Google Sheets by ${req.user.emails[0].value}`);

      res.json({
        success: true,
        message: `Alert "${processedAlert.name}" added successfully!`,
        alert: alertWithId
      });

      // Push a refresh to affected devices
      const displayRows = await fetchGoogleSheet();
      const devices = parseSheetData(displayRows);
      const targetDeviceIds = devices
          .filter(d => processedAlert.buildings.includes(d.building))
          .map(d => d.deviceId);

      if (targetDeviceIds.length > 0) {
          pushToDevices(targetDeviceIds, { type: 'refresh' });
      }
    } else {
      res.json({
        success: true,
        message: 'Alert configuration saved. Please add this alert manually to your Google Sheet for now.',
        alert: processedAlert,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error adding alert:', error);
    res.status(500).json({
      error: 'Failed to add alert',
      details: error.message
    });
  }
});

// Update alert (admin only)
app.put('/api/admin/alerts/:alertId', requireAuthWithPermissions, async (req, res) => {
  try {
    const alertId = req.params.alertId;
    const updates = req.body;

    console.log(`Alert update requested for ${alertId} by:`, req.user.emails[0].value);

    // Validate required fields
    if (updates.buildings && updates.buildings.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'At least one building is required'
      });
    }

    // --- Enhanced Validation for updates ---
    if (updates.type) {
      switch (updates.type) {
        case 'slide':
          if (!updates.slideId) return res.status(400).json({ error: 'Missing required fields', message: 'Google Slide ID is required.' });
          break;
        case 'custom':
          if (!updates.title || !updates.text) return res.status(400).json({ error: 'Missing required fields', message: 'Title and Text are required.' });
          break;
        case 'srp':
          if (!updates.srpAction) return res.status(400).json({ error: 'Missing required fields', message: 'SRP Action is required.' });
          break;
      }
    }
    // Get existing alert to check current buildings
    const alertRows = await fetchAlertsSheet();
    const allAlerts = parseAllAlertsDataForAdmin(alertRows);
    const existingAlert = allAlerts.find(a => a.alertId === alertId);
    
    if (!existingAlert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    // Check if user can access the current alert's buildings
    const currentBuildings = existingAlert.buildings || [];
    // A district admin can always access. A building admin can access if the alert is global
    // or if it targets one of their buildings.
    const hasAccessToCurrent = req.userPermissions.level === 'district' ||
                               currentBuildings.length === 0 ||
                               currentBuildings.some(building => 
                                 canAccessBuilding(req.userPermissions, building)
                               );

    if (!hasAccessToCurrent) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You don\'t have permission to modify this alert'
      });
    }

    // If changing buildings, validate user can access all new buildings
    if (updates.buildings) {
      const invalidBuildings = updates.buildings.filter(building => 
        !canAccessBuilding(req.userPermissions, building)
      );

      if (invalidBuildings.length > 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: `You don't have permission to target buildings: ${invalidBuildings.join(', ')}`
        });
      }
    }

    // Process the updates (convert URLs to IDs if needed)
    const processedUpdates = processDeviceConfig(updates);

    if (sheets) {
      await updateAlertInSheet(alertId, processedUpdates);
      console.log(`✅ Alert ${alertId} updated in Google Sheets by ${req.user.emails[0].value}`);

      res.json({
        success: true,
        message: `Alert "${alertId}" updated successfully!`,
        alertId: alertId,
        updates: processedUpdates
      });

      // Push a refresh to affected devices (both old and new buildings)
      const affectedBuildings = new Set([...(existingAlert.buildings || []), ...(processedUpdates.buildings || [])]);
      const displayRows = await fetchGoogleSheet();
      const devices = parseSheetData(displayRows);
      const targetDeviceIds = devices
          .filter(d => affectedBuildings.has(d.building))
          .map(d => d.deviceId);
      if (targetDeviceIds.length > 0) {
          pushToDevices(targetDeviceIds, { type: 'refresh' });
      }
    } else {
      res.json({
        success: true,
        message: 'Alert configuration updated. Please update this alert manually in your Google Sheet for now.',
        alertId: alertId,
        updates: processedUpdates,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error updating alert:', error);
    res.status(500).json({
      error: 'Failed to update alert',
      details: error.message
    });
  }
});

// Delete alert (admin only)
app.delete('/api/admin/alerts/:alertId', requireAuthWithPermissions, async (req, res) => {
  try {
    const alertId = req.params.alertId;
    console.log(`Alert delete requested for: ${alertId} by:`, req.user.emails[0].value);

    // Get existing alert to check building permission
    const alertRows = await fetchAlertsSheet();
    const allAlerts = parseAllAlertsDataForAdmin(alertRows);
    const existingAlert = allAlerts.find(a => a.alertId === alertId);
    
    if (!existingAlert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    // Check if user can access this alert's buildings
    const alertBuildings = existingAlert.buildings || [];
    // A district admin can always access. A building admin can access if the alert is global
    // or if it targets one of their buildings.
    const hasAccess = req.userPermissions.level === 'district' ||
                      alertBuildings.length === 0 ||
                      alertBuildings.some(building => 
                        canAccessBuilding(req.userPermissions, building)
                      );

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You don\'t have permission to delete this alert'
      });
    }

    if (sheets) {
      await deleteAlertFromSheet(alertId);
      console.log(`✅ Alert ${alertId} deleted from Google Sheets by ${req.user.emails[0].value}`);

      res.json({
        success: true,
        message: `Alert "${alertId}" deleted successfully from Google Sheets!`,
        alertId: alertId
      });

      // Push a refresh to affected devices
      if (existingAlert.buildings && existingAlert.buildings.length > 0) {
          const displayRows = await fetchGoogleSheet();
          const devices = parseSheetData(displayRows);
          const targetDeviceIds = devices
              .filter(d => existingAlert.buildings.includes(d.building))
              .map(d => d.deviceId);
          if (targetDeviceIds.length > 0) {
              pushToDevices(targetDeviceIds, { type: 'refresh' });
          }
      }
    } else {
      res.json({
        success: true,
        message: 'Alert marked for deletion. Please remove this alert manually from your Google Sheet for now.',
        alertId: alertId,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error deleting alert:', error);
    res.status(500).json({
      error: 'Failed to delete alert',
      details: error.message
    });
  }
});

// Toggle alert active status (quick action for admin)
app.patch('/api/admin/alerts/:alertId/toggle', requireAuthWithPermissions, async (req, res) => {
  try {
    const alertId = req.params.alertId;

    // Get current alert status
    const alertRows = await fetchAlertsSheet();
    const allAlerts = parseAllAlertsDataForAdmin(alertRows);
    const currentAlert = allAlerts.find(alert => alert.alertId === alertId);

    if (!currentAlert) {
      return res.status(404).json({
        error: 'Alert not found',
        alertId: alertId
      });
    }

    // Toggle the active status
    const newActiveStatus = !currentAlert.active;

    if (sheets) {
      await updateAlertInSheet(alertId, { active: newActiveStatus });
      console.log(`✅ Alert ${alertId} toggled to ${newActiveStatus ? 'active' : 'inactive'}`);

      res.json({
        success: true,
        message: `Alert "${alertId}" ${newActiveStatus ? 'activated' : 'deactivated'}!`,
        alertId: alertId,
        active: newActiveStatus
      });

      // Push a refresh to affected devices
      if (currentAlert.buildings && currentAlert.buildings.length > 0) {
          const displayRows = await fetchGoogleSheet();
          const devices = parseSheetData(displayRows);
          const targetDeviceIds = devices
              .filter(d => currentAlert.buildings.includes(d.building))
              .map(d => d.deviceId);
          if (targetDeviceIds.length > 0) {
              pushToDevices(targetDeviceIds, { type: 'refresh' });
          }
      }
    } else {
      res.json({
        success: true,
        message: 'Alert status toggled. Please update this alert manually in your Google Sheet for now.',
        alertId: alertId,
        active: newActiveStatus,
        requiresManualUpdate: true
      });
    }
  } catch (error) {
    console.error('Error toggling alert:', error);
    res.status(500).json({
      error: 'Failed to toggle alert',
      details: error.message
    });
  }
});

// Deploy alert immediately to all targeted devices
app.post('/api/admin/alerts/:alertId/deploy', requireAuthWithPermissions, async (req, res) => {
  try {
    const alertId = req.params.alertId;
    
    // Get alert details from sheet
    const alertRows = await fetchAlertsSheet();
    const alerts = parseAlertsData(alertRows);
    const alert = alerts.find(a => a.alertId === alertId);
    
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    
    // Push to devices in targeted buildings
    const buildings = alert.buildings || [];
    let totalPushed = 0;

    // Fetch device data once to avoid multiple API calls in the loop
    const displayRows = await fetchGoogleSheet();
    const devices = parseSheetData(displayRows);
    
    
    for (const building of buildings) {
      // Get devices for this building
      const buildingDevices = devices
        .filter(device => device.building === building)
        .map(device => device.deviceId);
      
      if (buildingDevices.length > 0) {
        const results = pushToDevices(buildingDevices, {
          type: 'alert',
          alertId: alertId,
          slideId: alert.slideId,
          priority: alert.priority
        });
        totalPushed += results.filter(r => r.success).length;
      }
    }
    
    res.json({ 
      success: true, 
      devicesNotified: totalPushed,
      buildings: buildings,
      alertId: alertId
    });
  } catch (error) {
    console.error('Error deploying alert:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== END ALERT API ROUTES ====================

// Simple test route
app.get('/simple-test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Simple Test</title>
        <style>
            body { font-family: Arial; margin: 40px; }
            .test { background: lightblue; padding: 20px; }
        </style>
    </head>
    <body>
        <div class="test">
            <h1>Simple Test Page</h1>
            <p>If you can see this, the server is working!</p>
            <div id="output">Testing JavaScript...</div>
        </div>
        <script>
            console.log('JavaScript is working!');
            document.getElementById('output').innerHTML = 'JavaScript is working!';
        </script>
    </body>
    </html>
  `);
});

// Test route for debugging
app.get('/test', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>OPSsign2 Server Test</h1>
        <p>Server is running successfully!</p>
        <p>Time: ${new Date().toISOString()}</p>
        <p>Environment: ${process.env.NODE_ENV || 'development'}</p>
        <p><a href="/api/health">Health Check</a></p>
        <p><a href="/api/device-config/test-device">Test Device Config</a></p>
        <p><a href="/?deviceId=test-device">Digital Display</a></p>
        <p><a href="/admin">Admin Interface</a></p>
        <p><a href="/api/admin/sse/status">SSE Status</a></p>
      </body>
    </html>
  `);
});

// Simple test route to verify auth middleware
app.get('/test-auth', (req, res) => {
  if (req.isAuthenticated()) {
    res.send(`<h1>You are logged in as: ${req.user.emails[0].value}</h1><a href="/auth/logout">Logout</a>`);
  } else {
    res.send(`<h1>You are NOT logged in</h1><a href="/auth/google">Login with Google</a>`);
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    sseConnections: connectedDevices.size,
    connectedDevices: getConnectedDevices()
  });
});

// Serve static files AFTER all routes to prevent conflicts
app.use(express.static(path.join(__dirname, 'public')));
app.use('/themes', express.static('themes'));
app.use('/templates', express.static('templates'));

// Protect admin directory but allow static files after authentication
app.use('/admin', (req, res, next) => {
  // If requesting the main admin page, require auth and handle specially
  if (req.path === '/' || req.path === '') {
    return requireAuthWithPermissions(req, res, next);
  }

  // For static files (CSS, JS, etc.), check auth but serve files
  if (req.isAuthenticated()) {
    express.static('admin')(req, res, next);
  } else {
    res.status(401).send('Authentication required');
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, '0.0.0.0', async () => {
  console.log(`🚀 OPSsign2 server running on port ${port}`);
  console.log(`📱 Digital signage: http://sign.orono.k12.mn.us:${port}`);
  console.log(`⚙️  Admin interface: http://sign.orono.k12.mn.us:${port}/admin`);
  console.log(`🏠 Homepage: http://sign.orono.k12.mn.us:${port}`);
  console.log(`🔐 Login URL: http://sign.orono.k12.mn.us:${port}/auth/google`);
  console.log(`📡 SSE endpoint: http://sign.orono.k12.mn.us:${port}/api/device/{deviceId}/events`);

  // Initialize Google Sheets API
  await initializeGoogleSheets();

  // Initialize ping monitoring
  console.log(`🏓 Starting ping monitoring...`);
  await updateDeviceIPs();
  await pingAllDevices();

  // Check devices every 2 minutes
  setInterval(async () => {
    await updateDeviceIPs(); // Refresh IP list from Google Sheets
    await pingAllDevices();  // Ping all devices
  }, 120000); // 2 minutes

});

module.exports = app;