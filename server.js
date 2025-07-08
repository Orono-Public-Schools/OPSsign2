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
function requireAuth(req, res, next) {
  console.log('Auth check - isAuthenticated:', req.isAuthenticated());
  if (req.user) {
    console.log('User:', req.user.emails[0].value);
  }

  if (req.isAuthenticated()) {
    return next();
  }

  console.log('User not authenticated, showing login page');

  // Remember where they were trying to go
  req.session.returnTo = req.originalUrl;

  // Instead of direct redirect, show a login page
  res.send(`
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
      // Skip service account initialization for now due to OpenSSL issues
      console.log('⚠️  Service account temporarily disabled due to Node.js 18 OpenSSL compatibility');
      sheets = null;
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
  const apiKey = process.env.GOOGLE_API_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = 'Sheet1';

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
  const sheetName = 'Sheet1';

  // First, get current data to determine the next row
  const currentData = await fetchGoogleSheet();
  const nextRow = currentData.length + 1;

  // Prepare the row data in the correct order
  const rowData = [
    deviceData.deviceId,              // Column A
    deviceData.ipAddress || '',       // Column B
    deviceData.location || '',        // Column C
    deviceData.template || 'standard', // Column D
    deviceData.theme || 'default',    // Column E
    deviceData.slideId || '',         // Column F 
    deviceData.refreshInterval || 15, // Column G 
    deviceData.coordinates || '',     // Column H
    deviceData.notes || ''           // Column I
  ];

  // Add the new row
  const request = {
    spreadsheetId: sheetId,
    range: `${sheetName}!A${nextRow}:I${nextRow}`,
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
  const sheetName = 'Sheet1';

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

  // Prepare the updated row data

  const rowData = [
    deviceData.deviceId,              // Column A
    deviceData.ipAddress || '',       // Column B
    deviceData.location || '',        // Column C
    deviceData.template || 'standard', // Column D
    deviceData.theme || 'default',    // Column E
    deviceData.slideId || '',         // Column F
    deviceData.refreshInterval || 15, // Column G
    deviceData.coordinates || '',     // Column H
    deviceData.notes || ''           // Column I
  ];

  // Update the row
  const request = {
    spreadsheetId: sheetId,
    range: `${sheetName}!A${targetRow}:I${targetRow}`,
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
  const sheetName = 'Sheet1';

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

  // Delete the row
  const request = {
    spreadsheetId: sheetId,
 	   resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: 0, // Assuming first sheet
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

// Device configuration API
app.get('/api/device-config/:deviceId', async (req, res) => {
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

    // Fetch data from Google Sheets
    const rows = await fetchGoogleSheet();
    const devices = parseSheetData(rows);

    // Find device configuration
    const deviceConfig = devices.find(device => device.deviceId === deviceId);

    if (deviceConfig) {
      console.log(`Configuration found for device: ${deviceId}`);
      res.json(deviceConfig);
    } else {
      console.log(`No configuration found for device: ${deviceId}, using defaults`);

      // Return default configuration
      const defaultConfig = {
        deviceId: deviceId,
        template: 'standard',
        theme: 'default',
        slideId: '1E7v2rVGN8TabxalUlXSHE2zEhJxv0tEXiCxE3FD99Ic',
        refreshInterval: 15,
        location: 'Orono Public Schools',
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
      lastUpdated: new Date().toISOString(),
      error: 'Failed to load from Google Sheets'
    };

    res.json(defaultConfig);
  }
});

// API route to get current user info
app.get('/api/user', requireAuth, (req, res) => {
  res.json({
    name: req.user.displayName,
    email: req.user.emails[0].value,
    photo: req.user.photos[0].value
  });
});

// Test admin authentication
app.get('/api/admin/test', requireAuth, (req, res) => {
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
app.get('/admin', requireAuth, (req, res) => {
  console.log('Admin route accessed by:', req.user.emails[0].value);
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Admin API routes
app.get('/api/admin/devices', requireAuth, async (req, res) => {
  try {
    console.log('Admin devices request received');

    // Fetch real data from Google Sheets
    const rows = await fetchGoogleSheet();
    console.log('Google Sheets rows fetched:', rows.length);

    const devices = parseSheetData(rows);
    console.log(`Parsed ${devices.length} devices from Google Sheets`);

    res.json(devices);
  } catch (error) {
    console.error('Error loading devices from Google Sheets:', error);

    // Return error details for debugging
    res.status(500).json({
      error: 'Failed to load devices from Google Sheets',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/admin/devices', requireAuth, async (req, res) => {
  try {
    const newDevice = req.body;
    console.log('Device add requested:', newDevice);

    if (sheets) {
      // Use service account to write to Google Sheets
      await addDeviceToSheet(newDevice);
      console.log(`✅ Device ${newDevice.deviceId} added to Google Sheets`);

      res.json({
        success: true,
        message: `Device "${newDevice.deviceId}" added successfully to Google Sheets!`,
        device: newDevice
      });
    } else {
      // Fallback to manual instructions
      res.json({
        success: true,
        message: 'Device configuration saved. Please add this device manually to your Google Sheet for now.',
        device: newDevice,
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

app.put('/api/admin/devices/:deviceId', requireAuth, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const updates = req.body;

    console.log(`Device update requested for ${deviceId}:`, updates);

    if (sheets) {
      // Use service account to update Google Sheets
      await updateDeviceInSheet(deviceId, updates);
      console.log(`✅ Device ${deviceId} updated in Google Sheets`);

      res.json({
        success: true,
        message: `Device "${deviceId}" updated successfully in Google Sheets!`,
        deviceId: deviceId,
        updates: updates
      });
    } else {
      // Fallback to manual instructions
      res.json({
        success: true,
        message: 'Device configuration updated. Please update this device manually in your Google Sheet for now.',
        deviceId: deviceId,
        updates: updates,
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

app.delete('/api/admin/devices/:deviceId', requireAuth, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;

    console.log(`Device delete requested for: ${deviceId}`);

    if (sheets) {
      // Use service account to delete from Google Sheets
      await deleteDeviceFromSheet(deviceId);
      console.log(`✅ Device ${deviceId} deleted from Google Sheets`);

      res.json({
        success: true,
        message: `Device "${deviceId}" deleted successfully from Google Sheets!`,
        deviceId: deviceId
      });
    } else {
      // Fallback to manual instructions
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
    uptime: process.uptime()
  });
});

// Serve static files AFTER all routes to prevent conflicts
app.use('/style.css', express.static('public/style.css'));
app.use('/assets', express.static('public/assets'));
app.use('/themes', express.static('themes'));
app.use('/templates', express.static('templates'));

// Protect admin directory but allow static files after authentication
app.use('/admin', (req, res, next) => {
  // If requesting the main admin page, require auth and handle specially
  if (req.path === '/' || req.path === '') {
    return requireAuth(req, res, next);
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
