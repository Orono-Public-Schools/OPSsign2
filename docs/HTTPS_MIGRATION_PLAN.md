# HTTPS Migration Plan for OPSsign2

This document outlines the complete plan to migrate the OPSsign2 application from its current state on `http://...:3000` to a secure, professional setup on `https://sign.orono.k12.mn.us`.

## 1. Objective

The goal is to make the application accessible on the standard HTTPS port (443) without requiring users or devices to specify a port number. This will be achieved using a publicly trusted SSL certificate from Let's Encrypt while keeping the application server itself private and inaccessible from the public internet.

## 2. Final Architecture

We will use a **Split-Horizon DNS** configuration with a reverse proxy.

- **Node.js Application**: Continues to run on its internal port `3000`.
- **Nginx**: Acts as a reverse proxy, listening on ports `80` (HTTP) and `443` (HTTPS).
- **Let's Encrypt (Certbot)**: Automatically provides and renews a trusted SSL certificate.
- **Firewall**: Controls access, allowing certificate validation while blocking public access to the application.

### Traffic Flow

*   **Internal User/Device**:
    1.  Accesses `https://sign.orono.k12.mn.us`.
    2.  Internal DNS resolves this to the server's **private IP**.
    3.  Connects to Nginx on port `443`.
    4.  Nginx handles SSL and proxies the request to the Node.js app on port `3000`.
    5.  The application works securely.

*   **Let's Encrypt Server (for validation/renewal)**:
    1.  Accesses `http://sign.orono.k12.mn.us`.
    2.  Public DNS resolves this to the server's **public IP**.
    3.  Connects to Nginx on port `80`.
    4.  Nginx serves a special verification file.
    5.  The certificate is issued/renewed successfully.

*   **External Public User**:
    1.  Accesses `http://sign.orono.k12.mn.us`.
    2.  Nginx on port `80` redirects them to `https://sign.orono.k12.mn.us`.
    3.  The user's browser tries to connect to the public IP on port `443`.
    4.  The firewall **blocks** this connection.
    5.  The user sees a "Connection Timed Out" error. The application remains private.

## 3. Step-by-Step Implementation Guide

### Step 1: Network & DNS Configuration (Prerequisites)

1.  **Public IP**: Assign a public IP address to the `opssign` server via NAT.
2.  **Public DNS**: In your public DNS provider, create an `A` record for `sign.orono.k12.mn.us` pointing to the new **public IP**.
3.  **Internal DNS**: In your internal DNS server (e.g., Active Directory), ensure the `A` record for `sign.orono.k12.mn.us` points to the server's **private IP**.
4.  **Firewall Rules**: Configure your network firewall with the following rules for the server's public IP:

| Port  | Direction | Source          | Action | Purpose                               |
| :---- | :-------- | :-------------- | :----- | :------------------------------------ |
| **80**  | Inbound   | Public Internet | **ALLOW**  | Required for Let's Encrypt validation |
| **443** | Inbound   | Public Internet | **BLOCK**  | Keeps the application private         |

### Step 2: Install and Configure Nginx

1.  **Install Nginx**:
    ```bash
    sudo apt update
    sudo apt install -y nginx
    ```
2.  **Create Initial Nginx Config**: Create a file at `/etc/nginx/sites-available/opssign` with a basic proxy configuration. This will be modified by Certbot later.
    ```nginx
    server {
        listen 80;
        server_name sign.orono.k12.mn.us;

        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_cache_bypass $http_upgrade;
        }
    }
    ```
3.  **Enable the Site**:
    ```bash
    sudo ln -s /etc/nginx/sites-available/opssign /etc/nginx/sites-enabled/
    sudo nginx -t # Test configuration
    sudo systemctl restart nginx
    ```

### Step 3: Obtain SSL Certificate with Certbot

1.  **Install Certbot**:
    ```bash
    sudo apt install -y certbot python3-certbot-nginx
    ```
2.  **Run Certbot**: This command will automatically obtain the certificate and update your Nginx configuration.
    ```bash
    sudo certbot --nginx -d sign.orono.k12.mn.us
    ```
    - When prompted, enter your email for renewal notices.
    - Agree to the terms of service.
    - **Choose the option to redirect HTTP traffic to HTTPS.**

### Step 4: Update Node.js Application (`server.js`)

Modify `server.js` to trust the Nginx proxy and enable secure cookies.

```diff
--- a/home/opssign/OPSsign2/server.js
++++ b/home/opssign/OPSsign2/server.js
@@ -69,12 +69,14 @@
 app.use(express.json());
 app.use(express.urlencoded({ extended: true }));
 
+// Trust the Nginx reverse proxy
+app.set('trust proxy', 1);
+
 // Session configuration
 app.use(session({
   secret: process.env.SESSION_SECRET,
   resave: false,
   saveUninitialized: true,
   cookie: {
-    secure: false, // Set to true in production with HTTPS
+    secure: true, // Use secure cookies in production with HTTPS
     maxAge: 24 * 60 * 60 * 1000, // 24 hours
     httpOnly: true
   }
@@ -2095,13 +2097,13 @@
 });
 
 app.listen(port, '0.0.0.0', async () => {
-  console.log(`🚀 OPSsign2 server running on port ${port}`);
-  console.log(`📱 Digital signage: http://sign.orono.k12.mn.us:${port}`);
-  console.log(`⚙️  Admin interface: http://sign.orono.k12.mn.us:${port}/admin`);
-  console.log(`🏠 Homepage: http://sign.orono.k12.mn.us:${port}`);
-  console.log(`🔐 Login URL: http://sign.orono.k12.mn.us:${port}/auth/google`);
-  console.log(`📡 SSE endpoint: http://sign.orono.k12.mn.us:${port}/api/device/{deviceId}/events`);
+  console.log(`🚀 OPSsign2 server running on port ${port}, accepting proxy connections from Nginx.`);
+  console.log(`✅ Application is now accessible via HTTPS at: https://sign.orono.k12.mn.us`);
+  console.log(`📱 Digital signage: https://sign.orono.k12.mn.us`);
+  console.log(`⚙️  Admin interface: https://sign.orono.k12.mn.us/admin`);
+  console.log(`🔐 Login URL: https://sign.orono.k12.mn.us/auth/google`);
+  console.log(`📡 SSE endpoint: https://sign.orono.k12.mn.us/api/device/{deviceId}/events`);
 
   
   // Initialize Google APIs
```

### Step 5: Update Device Scripts

Update the default `SERVER_URL` in all device scripts to the new, secure URL.

*(Diffs for `device/install.sh`, `device/scripts/chromium-kiosk.sh`, and `device/utils/set-device-id.sh` would be included here as shown in previous responses.)*

### Step 6: Update Google OAuth Client ID

1.  Go to the Google Cloud Console.
2.  Navigate to **APIs & Services -> Credentials**.
3.  Click on your **OAuth 2.0 Client ID**.
4.  Under **Authorized redirect URIs**, click **ADD URI**.
5.  Add the new URI: `https://sign.orono.k12.mn.us/auth/google/callback`
6.  Click **Save**.

### Step 7: Deploy and Verify

1.  Restart your Node.js application (e.g., `pm2 restart server`).
2.  From an internal network computer, browse to `https://sign.orono.k12.mn.us` and verify the application loads with a valid SSL certificate.
3.  From an external network (e.g., a mobile phone off Wi-Fi), browse to `http://sign.orono.k12.mn.us` and verify that the connection times out.

## 4. Migration Strategy for Existing Devices

This migration is non-disruptive.

- **Existing Devices**: Will continue to function perfectly by connecting directly to `http://sign.orono.k12.mn.us:3000`. They bypass the new Nginx proxy entirely.
- **New Devices**: Will be provisioned with the new `https://sign.orono.k12.mn.us` URL by default.

You can update existing devices to the new URL at your convenience.


