// Enhanced AdminInterface class with building-level permissions

class AdminInterface {
    constructor() {
        this.devices = [];
        this.alerts = [];
        this.userInfo = null;
        this.userPermissions = null;
        this.currentBuildingFilter = '';
        this.editingDevice = null;
        this.editingAlert = null;
        
        this.buildingInfo = {
            'SE': { name: 'Schumann Elementary', level: 'elementary' },
            'IS': { name: 'Intermediate School', level: 'elementary' }, 
            'MS': { name: 'Middle School', level: 'secondary' },
            'HS': { name: 'High School', level: 'secondary' },
            'DC': { name: 'Discovery Center', level: 'other' },
            'DO': { name: 'District Office', level: 'other' }
        };
        
    }

    async init() {
        console.log('Initializing AdminInterface...');
        
        try {
            // First, get user info and permissions
            await this.loadUserInfo();
            
            if (!this.userPermissions || this.userPermissions.level === 'none') {
                this.showError('Access denied. You must be a member of a signage group.');
                return;
            }

            // Set up the interface based on permissions
            this.setupUserInterface();
            
            // Load data
            await Promise.all([
                this.loadDevices(),
                this.loadAlerts()
            ]);
            
            this.updateStats();
            this.hideLoading();
            
        } catch (error) {
            console.error('Initialization error:', error);
            this.showError('Failed to load admin interface. Please try again.');
        }
    }

    async loadUserInfo() {
        try {
            const response = await fetch('/api/user');
            if (response.ok) {
                this.userInfo = await response.json();
                const data = this.userInfo;
                document.getElementById('userEmail').textContent = data.email;
                document.getElementById('userPhoto').src = data.photo;
                
                // Store permissions for future use
                this.userPermissions = data.permissions;
                console.log('User permissions:', this.userPermissions);
            } else {
                throw new Error('Failed to load user info');
            }
        } catch (error) {
            console.error('Error loading user info:', error);
            throw error;
        }
    }
    
    setupUserInterface() {
        const userPhoto = document.getElementById('userPhoto');
        const userName = document.getElementById('userName');
        const userPermission = document.getElementById('userPermission');

        // Populate user info in header
        if (this.userInfo) {
            if (userPhoto) userPhoto.src = this.userInfo.photo;
            if (userName) userName.textContent = this.userInfo.name;
            
            if (this.userPermissions.level === 'district') {
                if (userPermission) {
                    userPermission.textContent = 'District Administrator';
                    userPermission.className = 'user-permission admin';
                }
            } else {
                const buildingNames = this.userPermissions.buildings.map(code => 
                    this.buildingInfo[code]?.name || code
                ).join(', ');
                if (userPermission) {
                    userPermission.textContent = `Building Admin: ${buildingNames}`;
                    userPermission.className = 'user-permission building';
                }
            }
        }

        // Set up building filter for district admins
        if (this.userPermissions.level === 'district' && this.userPermissions.buildings.length > 1) {
            this.setupBuildingFilter();
        }
        
        // Hide templates section for building admins
        if (this.userPermissions.level === 'building') {
            const templatesSection = document.querySelector('.templates-section');
            if (templatesSection) {
                templatesSection.style.display = 'none';
            }
        }

        // Set up form building options
        this.setupBuildingOptions();
    }

    setupBuildingFilter() {
        // Check if building filter elements exist in the HTML
        const buildingFilter = document.getElementById('buildingFilter');
        const buildingSelect = document.getElementById('buildingSelect');
        
        if (!buildingFilter || !buildingSelect) {
            console.warn('Building filter elements not found in HTML, skipping building filter setup');
            return;
        }
        
        // Only show filter if user has multiple buildings
        if (this.userPermissions.buildings.length <= 1) {
            console.log('User only has access to one building, no filter needed');
            return;
        }
        
        // Add options for each building the user can access
        this.userPermissions.buildings.forEach(code => {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = this.buildingInfo[code]?.name || code;
            buildingSelect.appendChild(option);
        });
    
        buildingSelect.addEventListener('change', (e) => {
            this.currentBuildingFilter = e.target.value;
            this.filterDisplays();
            this.filterAlerts();
        });
    
        buildingFilter.style.display = 'flex';
    }
    
    setupBuildingOptions() {
        // Update device form building dropdown
        const buildingSelect = document.getElementById('building');
        if (buildingSelect) {
            buildingSelect.innerHTML = '';
    
            // Add options only for buildings user can access
            this.userPermissions.buildings.forEach(code => {
                const option = document.createElement('option');
                option.value = code;
                option.textContent = `${code} - ${this.buildingInfo[code]?.name || code}`;
                buildingSelect.appendChild(option);
            });
        } else {
            console.warn('Building select dropdown not found');
        }
    
        // Set up building selection checkboxes for alerts (if element exists)
        const buildingSelection = document.getElementById('buildingSelection');
        if (buildingSelection) {
            buildingSelection.innerHTML = '';
    
            this.userPermissions.buildings.forEach(code => {
                const label = document.createElement('label');
                label.className = 'checkbox-label building-checkbox';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.name = 'buildings';
                checkbox.value = code;
                
                const span = document.createElement('span');
                span.className = 'checkmark';
                
                const text = document.createTextNode(`${code} - ${this.buildingInfo[code]?.name || code}`);
                
                label.appendChild(checkbox);
                label.appendChild(span);
                label.appendChild(text);
                buildingSelection.appendChild(label);
            });
    
            // Hide/show quick select buttons based on available buildings
            this.updateQuickSelectButtons();
        } else {
            console.warn('Building selection checkboxes not found, skipping alert building setup');
        }
    }

    updateQuickSelectButtons() {
        const elementaryBuildings = ['SE', 'IS'];
        const secondaryBuildings = ['MS', 'HS'];
        
        const hasElementary = elementaryBuildings.some(code => 
            this.userPermissions.buildings.includes(code)
        );
        const hasSecondary = secondaryBuildings.some(code => 
            this.userPermissions.buildings.includes(code)
        );

        const selectElementaryBtn = document.getElementById('selectElementaryBtn');
        if (selectElementaryBtn) selectElementaryBtn.style.display = hasElementary ? 'inline-block' : 'none';
        
        const selectSecondaryBtn = document.getElementById('selectSecondaryBtn');
        if (selectSecondaryBtn) selectSecondaryBtn.style.display = hasSecondary ? 'inline-block' : 'none';
        
        // Hide "Select All" if user only has one building
        const selectAllBtn = document.getElementById('selectAllBtn');
        if (selectAllBtn) {
            selectAllBtn.style.display = 
                this.userPermissions.buildings.length > 1 ? 'inline-block' : 'none';
        }
    }
    
    async loadDevices() {
        try {
            const response = await fetch('/api/admin/devices');
            if (!response.ok) throw new Error('Failed to load devices');
            
            this.devices = await response.json();
            this.renderDevices();
        } catch (error) {
            console.error('Error loading devices:', error);
            this.showError('Failed to load devices');
        }
    }

    async loadAlerts() {
        try {
            const response = await fetch('/api/admin/alerts');
            if (!response.ok) throw new Error('Failed to load alerts');
            
            this.alerts = await response.json();
            this.renderAlerts();
        } catch (error) {
            console.error('Error loading alerts:', error);
            this.showError('Failed to load alerts');
        }
    }

    filterDisplays() {
        this.renderDevices();
    }

    filterAlerts() {
        this.renderAlerts();
    }

    getFilteredDevices() {
        let filtered = this.devices;
        
        // Apply building filter if set
        if (this.currentBuildingFilter) {
            filtered = filtered.filter(device => device.building === this.currentBuildingFilter);
        }
        
        return filtered;
    }

    getFilteredAlerts() {
        let filtered = this.alerts;
        
        // Apply building filter if set
        if (this.currentBuildingFilter) {
            filtered = filtered.filter(alert => {
                // The server now sends `buildings` as an array, so we just need to check for inclusion.
                return Array.isArray(alert.buildings) && alert.buildings.includes(this.currentBuildingFilter);
            });
        }
        
        return filtered;
    }

    renderDevices() {
        const devicesGrid = document.getElementById('devicesGrid');
        devicesGrid.innerHTML = ''; // Clear existing content
        const filteredDevices = this.getFilteredDevices();
        
        if (filteredDevices.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.innerHTML = `
                <div class="empty-icon">📺</div>
                <h3>No displays found</h3>
                <p>Get started by adding your first display</p>
                <button id="addEmptyDeviceBtn" class="add-btn">Add Display</button>
            `;
            devicesGrid.appendChild(emptyState);
            return;
        }

        filteredDevices.forEach(device => {
            const card = document.createElement('div');
            card.className = 'device-card';

            // Helper function to create info rows
            const createInfo = (label, value, valueClass = '') => {
                const info = document.createElement('div');
                info.className = 'device-info';
                info.innerHTML = `
                    <span class="info-label">${label}:</span>
                    <span class="info-value ${valueClass}">${value}</span>
                `;
                return info;
            };

            card.innerHTML = `
                <div class="device-header">
                    <div class="device-title">
                        <h3></h3>
                        <div class="device-building"></div>
                    </div>
                    <div class="device-status ${device.active ? 'active' : 'inactive'}">${device.active ? '●' : '○'}</div>
                </div>
                <div class="device-details"></div>
                <div class="device-actions">
                    <button class="edit-btn" data-action="edit" data-id="${device.deviceId}">Edit</button>
                    <button class="delete-btn" data-action="delete" data-id="${device.deviceId}">Delete</button>
                    <button class="refresh-btn" data-action="push-refresh" data-id="${device.deviceId}" title="Push Refresh via SSE">📡</button>
                    <button class="view-btn" data-action="view" data-id="${device.deviceId}">View</button>
                </div>
            `;

            // Safely set text content
            card.querySelector('h3').textContent = device.name;
            card.querySelector('.device-building').textContent = `${device.deviceId} • ${device.building} - ${this.buildingInfo[device.building]?.name || device.building}`;

            const details = card.querySelector('.device-details');
            details.appendChild(createInfo('ID', device.deviceId));
            details.appendChild(createInfo('Location', device.location || 'Not specified'));
            details.appendChild(createInfo('Template', device.template, `template-${device.template}`));
            details.appendChild(createInfo('Slides', device.slideId ? '✅ Configured' : '⚪ None'));

            devicesGrid.appendChild(card);
        });
    }

    renderAlerts() {
        const alertsGrid = document.getElementById('alertsGrid');
        alertsGrid.innerHTML = ''; // Clear existing content
        const filteredAlerts = this.getFilteredAlerts();
        
        if (filteredAlerts.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.innerHTML = `
                <div class="empty-icon">🚨</div>
                <h3>No alerts found</h3>
                <p>Create alerts to broadcast important information</p>
                <button id="addEmptyAlertBtn" class="add-btn">Create Alert</button>
            `;
            alertsGrid.appendChild(emptyState);
            return;
        }

        filteredAlerts.forEach(alert => {
            // Safely handle priority, defaulting to 'Low' if missing or empty.
            // This prevents rendering errors if an alert has no priority set.
            const priority = alert.priority || 'Low';
            const priorityLower = priority.toLowerCase();

            // New: Determine alert type for display
            let alertTypeDisplay = 'Google Slide';
            if (alert.type === 'custom') {
                alertTypeDisplay = `Custom: ${alert.title || ''}`;
            } else if (alert.type === 'srp') {
                alertTypeDisplay = `SRP: ${alert.srpAction || 'Alert'}`;
            }

            const card = document.createElement('div');
            card.className = `alert-card priority-${priorityLower}`;

            const priorityIcon = priority === 'High' ? '🔴' : priority === 'Medium' ? '🟡' : '🔵';

            let expiresHTML = '';
            if (alert.expires) {
                expiresHTML = `
                    <div class="alert-expires">
                        <span class="info-label">Expires:</span>
                        <span class="info-value">${new Date(alert.expires).toLocaleString()}</span>
                    </div>
                `;
            }

            card.innerHTML = `
                <div class="alert-header">
                    <div class="alert-title">
                        <h3></h3>
                        <div class="alert-priority priority-${priorityLower}">
                            ${priorityIcon} ${priority}
                        </div>
                        <div class="alert-type">${alertTypeDisplay}</div>
                    </div>
                    <div class="alert-status ${alert.active ? 'active' : 'inactive'}">${alert.active ? '●' : '○'}</div>
                </div>
                
                <div class="alert-details">
                    <div class="alert-buildings">
                        <span class="info-label">Buildings:</span>
                        <span class="buildings-list"></span>
                    </div>
                    ${expiresHTML}
                </div>
                
                <div class="alert-actions">
                    <button class="edit-btn" data-action="edit" data-id="${alert.alertId}">Edit</button>
                    <button class="toggle-btn ${alert.active ? 'deactivate' : 'activate'}" data-action="toggle" data-id="${alert.alertId}" data-active="${!alert.active}">
                        ${alert.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button class="delete-btn" data-action="delete" data-id="${alert.alertId}">Delete</button>
                </div>
            `;

            card.querySelector('h3').textContent = alert.name || '[No Name]';
            
            const buildingsText = Array.isArray(alert.buildings) ? alert.buildings.join(', ') : (alert.buildings || 'None');
            card.querySelector('.buildings-list').textContent = buildingsText;

            alertsGrid.appendChild(card);
        });
    }

    async updateSSEStats() {
        try {
            const response = await fetch('/api/admin/sse/status');
            if (response.ok) {
                const status = await response.json();
                const sseConnectedEl = document.getElementById('sseConnected');
                if (sseConnectedEl) {
                    sseConnectedEl.textContent = status.totalConnections;
                }
            }
        } catch (error) {
            console.error('Error updating SSE stats:', error);
            // Don't show user error for SSE stats - just log it
        }
    }

    // Stub for a function called in the HTML but not defined
    async pushRefreshToAll() {
        try {
            const response = await fetch('/api/admin/push/refresh-all', { method: 'POST' });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.details || err.error);
            }
            const result = await response.json();
            this.showSuccessMessage(`Refresh signal sent to ${result.devicesNotified} connected devices.`);
        } catch (error) {
            console.error('Error pushing refresh to all:', error);
            this.showError(`Failed to push refresh: ${error.message}`);
        }
    }
    async pushRefreshToDevice(deviceId) {
        try {
            const response = await fetch(`/api/admin/push/refresh-one/${deviceId}`, { method: 'POST' });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.message || 'Failed to send refresh signal.');
            }
            this.showSuccessMessage(result.message);
        } catch (error) {
            console.error(`Error pushing refresh to ${deviceId}:`, error);
            this.showError(`Could not push refresh: ${error.message}`);
        }
    }
    checkSSEStatus() {
        console.log("checkSSEStatus called. Implement functionality.");
        this.updateSSEStats();
    }

    updateStats() {
        const filteredDevices = this.getFilteredDevices();
        const total = filteredDevices.length;
        const online = filteredDevices.filter(d => d.status === 'online').length;

        // Safely update stats only if elements exist
        const totalDevicesEl = document.getElementById('totalDevices');
        if (totalDevicesEl) totalDevicesEl.textContent = total;

        const onlineDevicesEl = document.getElementById('onlineDevices');
        if (onlineDevicesEl) onlineDevicesEl.textContent = online;

        const totalBuildingsEl = document.getElementById('totalBuildings');
        if (totalBuildingsEl) totalBuildingsEl.textContent = this.userPermissions.buildings.length;

        // Update SSE connected count
        this.updateSSEStats();

        // Update Alert Stats
        const totalAlertsEl = document.getElementById('totalAlerts');
        if (totalAlertsEl) totalAlertsEl.textContent = this.alerts.length;

        const activeAlerts = this.alerts.filter(a => a.active);
        const activeAlertsEl = document.getElementById('activeAlerts');
        if (activeAlertsEl) activeAlertsEl.textContent = activeAlerts.length;

        const highPriorityAlerts = activeAlerts.filter(a => a.priority === 'High').length;
        const highPriorityAlertsEl = document.getElementById('highPriorityAlerts');
        if (highPriorityAlertsEl) {
            highPriorityAlertsEl.textContent = highPriorityAlerts;
        }
    }

    // Device Management Methods
    async showAddDeviceModal() {
        this.editingDevice = null;
        document.getElementById('deviceModalTitle').textContent = 'Add New Display';
        document.getElementById('saveDeviceBtn').textContent = 'Save Display';
        
        // Reset form
        document.getElementById('deviceForm').reset();
        document.getElementById('active').checked = true;
        
        // Pre-fill building if only one option
        const buildingSelect = document.getElementById('building');
        if (this.userPermissions.buildings.length === 1) {
            buildingSelect.value = this.userPermissions.buildings[0];
            this.updateDeviceIdPrefix(this.userPermissions.buildings[0]);
        }
        
        document.getElementById('deviceModal').classList.add('show');
    }

    updateDeviceIdPrefix(building) {
        const deviceIdInput = document.getElementById('deviceId');
        const currentValue = deviceIdInput.value;
        
        // If empty or doesn't have correct prefix, set it
        if (!currentValue || !currentValue.startsWith(building + '-')) {
            deviceIdInput.value = building + '-';
            deviceIdInput.focus();
            // Move cursor to end
            deviceIdInput.setSelectionRange(deviceIdInput.value.length, deviceIdInput.value.length);
        }
    }

    extractSlideIdFromUrl(url) {
        if (!url || typeof url !== 'string') return null;
        
        const trimmedUrl = url.trim();
        if (!trimmedUrl) return null;
        
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
        
        if (/^[a-zA-Z0-9-_]{40,}$/.test(trimmedUrl)) {
            return trimmedUrl;
        }
        
        return null;
    }

    updateSlideIdFromUrl() {
        const urlInput = document.getElementById('presentationLink');
        const slideIdInput = document.getElementById('slideId');
        const validation = document.getElementById('urlValidation');
        const url = urlInput.value.trim();
        
        if (!url) {
            validation.style.display = 'none';
            return;
        }

        const extractedId = this.extractSlideIdFromUrl(url);
        
        if (extractedId) {
            slideIdInput.value = extractedId;
            validation.innerHTML = `<div class="validation-success">✅ ID extracted successfully.</div>`;
        } else {
            validation.innerHTML = `<div class="validation-error">❌ Could not extract a valid ID from the URL.</div>`;
        }
        validation.style.display = 'block';
    }

    async saveDevice(formData) {
        try {
            const url = this.editingDevice 
                ? `/api/admin/devices/${this.editingDevice.deviceId}`
                : '/api/admin/devices';
            
            const method = this.editingDevice ? 'PUT' : 'POST';
            
            const response = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.details ? error.details.join(', ') : error.error);
            }

            await this.loadDevices();
            this.updateStats();
            this.closeDeviceModal();
            
            this.showSuccessMessage(this.editingDevice ? 'Display updated successfully' : 'Display created successfully');
            
        } catch (error) {
            console.error('Error saving device:', error);
            this.showError(`Failed to save display: ${error.message}`);
        }
    }

    editDevice(deviceId) {
        const device = this.devices.find(d => d.deviceId === deviceId);
        if (!device) return;
        
        this.editingDevice = device;
        document.getElementById('deviceModalTitle').textContent = 'Edit Display';
        document.getElementById('saveDeviceBtn').textContent = 'Update Display';
        
        // Populate form
        document.getElementById('deviceId').value = device.deviceId;
        document.getElementById('name').value = device.name;
        document.getElementById('location').value = device.location || '';
        document.getElementById('ipAddress').value = device.ipAddress || '';
        document.getElementById('coordinates').value = device.coordinates || '';
        document.getElementById('notes').value = device.notes || '';
        document.getElementById('building').value = device.building;
        document.getElementById('template').value = device.template;
        document.getElementById('presentationLink').value = device.presentationLink || '';
        document.getElementById('slideId').value = device.slideId || '';
        document.getElementById('active').checked = device.active;
        
        document.getElementById('deviceModal').classList.add('show');
    }

    async deleteDevice(deviceId) {
        if (!confirm(`Are you sure you want to delete display "${deviceId}"?`)) return;

        try {
            const response = await fetch(`/api/admin/devices/${deviceId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error);
            }

            await this.loadDevices();
            this.updateStats();
            
            this.showSuccessMessage('Display deleted successfully');
            
        } catch (error) {
            console.error('Error deleting device:', error);
            this.showError(`Failed to delete display: ${error.message}`);
        }
    }

    viewDevice(deviceId) {
        // Open device view in new tab
        window.open(`/?deviceId=${deviceId}`, '_blank');
    }

    // Alert Management Methods
    async showAddAlertModal() {
        this.editingAlert = null;
        document.getElementById('alertModalTitle').textContent = 'Create New Alert';
        document.getElementById('saveAlertBtn').textContent = 'Create Alert';
        
        // Reset form
        document.getElementById('alertForm').reset();
        document.getElementById('alertActive').checked = true;
        
        // Uncheck all building checkboxes
        const checkboxes = document.querySelectorAll('input[name="buildings"]');
        checkboxes.forEach(cb => cb.checked = false);

        // New: Set default alert type and show correct fields
        document.getElementById('alertType').value = 'srp';
        this.toggleAlertFields('srp');
        
        document.getElementById('alertModal').classList.add('show');
    }
    

    toggleAlertFields(type) {
        const fieldsets = ['custom', 'srp', 'slide'];
        const slideIdInput = document.getElementById('alertSlideId');
        const alertTitleInput = document.getElementById('alertTitle');
        const alertTextInput = document.getElementById('alertText');
        const srpActionInput = document.getElementById('srpAction');

        // Hide all fieldsets
        fieldsets.forEach(id => {
            const el = document.getElementById(`alert-fields-${id}`);
            if (el) el.style.display = 'none';
        });

        // Show the selected one
        const selectedEl = document.getElementById(`alert-fields-${type}`);
        if (selectedEl) selectedEl.style.display = 'block';

        // Toggle required attributes for validation.
        // The server does the final validation, but this helps the user.
        if (slideIdInput) slideIdInput.required = (type === 'slide');
        if (alertTitleInput) alertTitleInput.required = (type === 'custom');
        if (alertTextInput) alertTextInput.required = (type === 'custom');
        if (srpActionInput) srpActionInput.required = (type === 'srp');
    }

    editAlert(alertId) {
        const alert = this.alerts.find(a => a.alertId === alertId);
        if (!alert) {
            console.error(`Alert with ID ${alertId} not found.`);
            this.showError(`Could not find alert ${alertId} to edit.`);
            return;
        }
        
        this.editingAlert = alert;
        document.getElementById('alertModalTitle').textContent = 'Edit Alert';
        document.getElementById('saveAlertBtn').textContent = 'Update Alert';
        
        // Populate common fields
        document.getElementById('alertName').value = alert.name;
        document.getElementById('priority').value = alert.priority;
        document.getElementById('expires').value = alert.expires || '';
        document.getElementById('alertActive').checked = alert.active;


        // New: handle alert type
        const alertType = alert.type || 'slide'; // Default to slide for old alerts
        document.getElementById('alertType').value = alertType;
        this.toggleAlertFields(alertType);

        // Populate type-specific fields
        if (alertType === 'slide') {
            document.getElementById('alertSlideId').value = alert.slideId || '';
        } else if (alertType === 'custom') {
            document.getElementById('alertTitle').value = alert.title || '';
            document.getElementById('alertText').value = alert.text || '';
            document.getElementById('alertIcon').value = alert.icon || 'none';
        } else if (alertType === 'srp') {
            document.getElementById('srpAction').value = alert.srpAction || 'Hold';
            document.getElementById('srpText').value = alert.text || '';
        }
        
        // Set building checkboxes
        // The 'buildings' property should already be an array from the server
        const alertBuildings = Array.isArray(alert.buildings) ? alert.buildings : [];
        document.querySelectorAll('input[name="buildings"]').forEach(cb => {
            cb.checked = alertBuildings.includes(cb.value);
        });
        
        document.getElementById('alertModal').classList.add('show');
    }

    selectAllBuildings() {
        const checkboxes = document.querySelectorAll('input[name="buildings"]');
        checkboxes.forEach(cb => cb.checked = true);
    }

    selectElementaryBuildings() {
        const elementaryBuildings = ['SE', 'IS'];
        const checkboxes = document.querySelectorAll('input[name="buildings"]');
        checkboxes.forEach(cb => {
            cb.checked = elementaryBuildings.includes(cb.value);
        });
    }

    selectSecondaryBuildings() {
        const secondaryBuildings = ['MS', 'HS'];
        const checkboxes = document.querySelectorAll('input[name="buildings"]');
        checkboxes.forEach(cb => {
            cb.checked = secondaryBuildings.includes(cb.value);
        });
    }

    async saveAlert(alertData) {
        try {
            const url = this.editingAlert 
                ? `/api/admin/alerts/${this.editingAlert.alertId}`
                : '/api/admin/alerts';
            
            const method = this.editingAlert ? 'PUT' : 'POST';

            // Client-side validation for buildings
            if (!alertData.buildings || alertData.buildings.length === 0) {
                throw new Error('Please select at least one building');
            }

            const response = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(alertData)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.details || error.error || 'An unknown server error occurred.');
            }

            await this.loadAlerts();
            this.updateStats();
            this.closeAlertModal();

            this.showSuccessMessage(this.editingAlert ? 'Alert updated successfully' : 'Alert created successfully');

        } catch (error) {
            console.error('Error saving alert:', error);
            this.showError(`Failed to save alert: ${error.message}`);
        }
    }

    async toggleAlert(alertId, active) {
        try {
            const response = await fetch(`/api/admin/alerts/${alertId}/toggle`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: active })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error);
            }

            await this.loadAlerts();
            this.updateStats();
            
            this.showSuccessMessage(`Alert ${active ? 'activated' : 'deactivated'} successfully`);
            
        } catch (error) {
            console.error('Error toggling alert:', error);
            this.showError(`Failed to ${active ? 'activate' : 'deactivate'} alert: ${error.message}`);
        }
    }

    async deleteAlert(alertId) {
        if (!confirm('Are you sure you want to delete this alert?')) return;

        try {
            const response = await fetch(`/api/admin/alerts/${alertId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error);
            }

            await this.loadAlerts();
            this.updateStats();
            this.showSuccessMessage('Alert deleted successfully');
        } catch (error) {
            console.error('Error deleting alert:', error);
            this.showError(`Failed to delete alert: ${error.message}`);
        }
    }

    // Utility Methods
    closeDeviceModal() {
        document.getElementById('deviceModal').classList.remove('show');
    }

    closeAlertModal() {
        document.getElementById('alertModal').classList.remove('show');
    }

    hideLoading() {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.style.display = 'none';
        }
    }

    showError(message) {
        console.error('Error:', message);
        
        // Try to hide loading if it exists
        const loading = document.getElementById('loading');
        if (loading) {
            loading.style.display = 'none';
        }
        
        // Try to show error message if elements exist
        const errorText = document.getElementById('errorText');
        const errorMessage = document.getElementById('errorMessage');
        
        if (errorText && errorMessage) {
            errorText.textContent = message;
            errorMessage.style.display = 'block';
        } else {
            // Fallback to alert if error elements don't exist
            alert('Error: ' + message);
        }
    }

    showSuccessMessage(message) {
        // You can implement a toast notification here
        console.log('Success:', message);
        // For now, just log to console, but you could show a toast/snackbar
    }
}

// Form handling
document.addEventListener('DOMContentLoaded', function() {
    const adminInterface = new AdminInterface();
    // Initialize the interface
    adminInterface.init();
    
    // Device form submission
    document.getElementById('deviceForm').addEventListener('submit', function(e) {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        const data = {
            deviceId: formData.get('deviceId'),
            name: formData.get('name'),
            location: formData.get('location'),
            ipAddress: formData.get('ipAddress'),
            coordinates: formData.get('coordinates'),
            notes: formData.get('notes'),
            building: formData.get('building'),
            template: formData.get('template'),
            presentationLink: formData.get('presentationLink'),
            slideId: formData.get('slideId'),
            active: formData.has('active')
        };
        
        adminInterface.saveDevice(data);
    });
    
    // Alert form submission
    document.getElementById('alertForm').addEventListener('submit', function(e) {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        const type = formData.get('type');

        const data = {
            type: type,
            name: formData.get('name'),
            priority: formData.get('priority'),
            expires: formData.get('expires'),
            active: formData.has('active'),
            buildings: Array.from(document.querySelectorAll('input[name="buildings"]:checked')).map(cb => cb.value)
        };

        // Add type-specific data
        if (type === 'slide') {
            data.slideId = formData.get('slideId');
        } else if (type === 'custom') {
            data.title = formData.get('title');
            data.text = formData.get('text');
            data.icon = formData.get('icon');
        } else if (type === 'srp') {
            data.srpAction = formData.get('srpAction');
            data.text = document.getElementById('srpText').value; // Get from the correct textarea
        }

        adminInterface.saveAlert(data);
    });
    
    // Building change handler for device ID prefix
    const buildingSelect = document.getElementById('building');
    if (buildingSelect) {
        buildingSelect.addEventListener('change', function(e) {
            if (e.target.value) {
                adminInterface.updateDeviceIdPrefix(e.target.value);
            }
        });
    }
    
    // Presentation link validation
    let validationTimeout;
    const presentationLinkInput = document.getElementById('presentationLink');
    if (presentationLinkInput) {
        presentationLinkInput.addEventListener('input', function() {
            clearTimeout(validationTimeout);
            validationTimeout = setTimeout(() => {
                adminInterface.updateSlideIdFromUrl();
            }, 500); // Validate after 500ms of no typing
        });
    }

    // Add event listener for alert type change
    const alertTypeSelect = document.getElementById('alertType');
    if (alertTypeSelect) {
        alertTypeSelect.addEventListener('change', (e) => {
            adminInterface.toggleAlertFields(e.target.value);
        });
    }

    // --- Event Listeners for Buttons ---
    document.getElementById('addDeviceBtn').addEventListener('click', () => adminInterface.showAddDeviceModal());
    document.getElementById('addAlertBtn').addEventListener('click', () => adminInterface.showAddAlertModal());

    document.getElementById('closeDeviceModalBtn').addEventListener('click', () => adminInterface.closeDeviceModal());
    document.getElementById('cancelDeviceBtn').addEventListener('click', () => adminInterface.closeDeviceModal());
    document.getElementById('closeAlertModalBtn').addEventListener('click', () => adminInterface.closeAlertModal());
    document.getElementById('cancelAlertBtn').addEventListener('click', () => adminInterface.closeAlertModal());

    document.getElementById('selectAllBtn').addEventListener('click', () => adminInterface.selectAllBuildings());
    document.getElementById('selectElementaryBtn').addEventListener('click', () => adminInterface.selectElementaryBuildings());
    document.getElementById('selectSecondaryBtn').addEventListener('click', () => adminInterface.selectSecondaryBuildings());

    document.getElementById('pushRefreshBtn').addEventListener('click', () => adminInterface.pushRefreshToAll());
    document.getElementById('checkSseBtn').addEventListener('click', () => adminInterface.checkSSEStatus());

    // Listen for clicks on the empty state buttons
    document.getElementById('devicesGrid').addEventListener('click', (e) => {
        if (e.target.id === 'addEmptyDeviceBtn') {
            adminInterface.showAddDeviceModal();
        }
    });
    document.getElementById('alertsGrid').addEventListener('click', (e) => {
        if (e.target.id === 'addEmptyAlertBtn') {
            adminInterface.showAddAlertModal();
        }
    });

    // Event Delegation for Device Actions
    document.getElementById('devicesGrid').addEventListener('click', (e) => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;

        const { action, id } = button.dataset;

        if (action === 'edit') {
            adminInterface.editDevice(id);
        } else if (action === 'delete') {
            adminInterface.deleteDevice(id);
        } else if (action === 'push-refresh') {
            adminInterface.pushRefreshToDevice(id);
        } else if (action === 'view') {
            adminInterface.viewDevice(id);
        }
    });

    // Event Delegation for Alert Actions
    document.getElementById('alertsGrid').addEventListener('click', (e) => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;

        const { action, id } = button.dataset;

        if (action === 'edit') {
            adminInterface.editAlert(id);
        } else if (action === 'delete') {
            adminInterface.deleteAlert(id);
        } else if (action === 'toggle') {
            const active = button.dataset.active === 'true';
            adminInterface.toggleAlert(id, active);
        }
    });
});
