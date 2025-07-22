// Admin Interface JavaScript
class AdminInterface {
    constructor() {
        this.devices = [];
        this.alerts = [];
        this.editingDevice = null;
        this.editingAlert = null;
        this.init();
    }

    async init() {
        await this.loadUserInfo();
        await this.loadDevices();
        await this.loadAlerts();
        this.setupEventListeners();
        this.updateStats();
        this.updateAlertStats();
    }

    // Load current user information
    async loadUserInfo() {
        try {
            const response = await fetch('/api/user');
            if (response.ok) {
                const user = await response.json();
                document.getElementById('userName').textContent = user.name;
                document.getElementById('userEmail').textContent = user.email;
                document.getElementById('userPhoto').src = user.photo;
            }
        } catch (error) {
            console.error('Error loading user info:', error);
        }
    }

    // Load devices from the server
    async loadDevices() {
        try {
            const response = await fetch('/api/admin/devices');
            if (response.ok) {
                this.devices = await response.json();
                this.renderDevices();
            } else {
                throw new Error('Failed to load devices');
            }
        } catch (error) {
            console.error('Error loading devices:', error);
            this.showError('Failed to load devices');
        }
    }

    // Load alerts from the server
    async loadAlerts() {
        try {
            const response = await fetch('/api/admin/alerts');
            if (response.ok) {
                this.alerts = await response.json();
                this.renderAlerts();
            } else {
                // Alerts might not exist yet, that's okay
                console.log('No alerts found or alerts sheet not created yet');
                this.alerts = [];
                this.renderAlerts();
            }
        } catch (error) {
            console.error('Error loading alerts:', error);
            this.alerts = [];
            this.renderAlerts();
        }
    }

    // Render devices in the grid
    renderDevices() {
        const grid = document.getElementById('devicesGrid');

        if (this.devices.length === 0) {
            grid.innerHTML = '<div class="loading">No devices configured yet.</div>';
            return;
        }

        grid.innerHTML = this.devices.map(device => `
            <div class="device-card" data-device-id="${device.deviceId}">
                <div class="device-header">
                    <h3 class="device-title">${device.deviceId}</h3>
                    <span class="device-status ${device.status}">
                        ${device.status === 'online' ? '🟢' : '🔴'} ${device.status}
                    </span>
                </div>
                <div class="device-detail">
                    <span class="device-detail-label">IP Address:</span>
                    <span class="device-detail-value">${device.ipAddress || 'Not set'}</span>
                </div>
                <div class="device-details">
                    <div class="device-detail">
                        <span class="device-detail-label">Location:</span>
                        <span class="device-detail-value">${device.location || 'Not set'}</span>
                    </div>
                    <div class="device-detail">
                        <span class="device-detail-label">Building:</span>
                        <span class="device-detail-value">${device.building || 'Not set'}</span>
                    </div>
                    <div class="device-detail">
                        <span class="device-detail-label">Template:</span>
                        <span class="device-detail-value">${device.template || 'standard'}</span>
                    </div>
                    <div class="device-detail">
                        <span class="device-detail-label">Theme:</span>
                        <span class="device-detail-value">${device.theme || 'default'}</span>
                    </div>
                    <div class="device-detail">
                        <span class="device-detail-label">Refresh:</span>
                        <span class="device-detail-value">${device.refreshInterval || 15} min</span>
                    </div>
                    <div class="device-detail">
                        <span class="device-detail-label">Last Seen:</span>
                        <span class="device-detail-value">${this.formatDate(device.lastSeen)}</span>
                    </div>
                </div>

                <div class="device-actions">
                        <button class="btn btn-secondary btn-small" onclick="admin.previewDevice('${device.deviceId}')">
                            👁️ Preview
                        </button>
                        <button class="btn btn-info btn-small" onclick="admin.pushRefreshToDevice('${device.deviceId}')">
                            📡 Push Refresh
                        </button>
                        <button class="btn btn-secondary btn-small" onclick="editDeviceClick('${device.deviceId}')">
                            ✏️ Edit
                        </button>
                        <button class="btn btn-danger btn-small" onclick="admin.deleteDevice('${device.deviceId}')">
                            🗑️ Delete
                        </button>
                </div>
            </div>
        `).join('');
    }

    // Render alerts in the grid
    renderAlerts() {
        const grid = document.getElementById('alertsGrid');

        if (this.alerts.length === 0) {
            grid.innerHTML = '<div class="loading">No alerts configured yet.</div>';
            return;
        }

        grid.innerHTML = this.alerts.map(alert => `
            <div class="alert-card priority-${alert.priority}" data-alert-id="${alert.alertId}">
                <div class="alert-header">
                    <h3 class="alert-title">${alert.name}</h3>
                    <div class="alert-status-row">
                        <span class="priority-badge ${alert.priority}">${alert.priority.toUpperCase()}</span>
                        <span class="alert-status ${alert.active === 'TRUE' ? 'active' : 'inactive'}">
                            ${alert.active === 'TRUE' ? '🟢 Active' : '⚪ Inactive'}
                        </span>
                    </div>
                </div>
                
                <div class="alert-details">
                    <div class="alert-detail">
                        <span class="alert-detail-label">Buildings:</span>
                        <span class="alert-detail-value">${this.formatBuildingNames(alert.buildings)}</span>
                    </div>
                    <div class="alert-detail">
                        <span class="alert-detail-label">Slide ID:</span>
                        <span class="alert-detail-value">${alert.slideId}</span>
                    </div>
                    <div class="alert-detail">
                        <span class="alert-detail-label">Expires:</span>
                        <span class="alert-detail-value">${alert.expires ? this.formatDate(alert.expires) : 'Never'}</span>
                    </div>
                </div>

                <div class="alert-actions">
                    <button class="btn btn-secondary btn-small" onclick="admin.toggleAlert('${alert.alertId}')">
                        ${alert.active === 'TRUE' ? '⏸️ Deactivate' : '▶️ Activate'}
                    </button>
                    <button class="btn btn-urgent btn-small" onclick="admin.deployAlertNow('${alert.alertId}')">
                        ⚡ Deploy Now
                    </button>
                    <button class="btn btn-secondary btn-small" onclick="admin.editAlert('${alert.alertId}')">
                        ✏️ Edit
                    </button>
                    <button class="btn btn-danger btn-small" onclick="admin.deleteAlert('${alert.alertId}')">
                        🗑️ Delete
                    </button>
                </div>
            </div>
        `).join('');
    }

    // Update device statistics
    updateStats() {
        const total = this.devices.length;
        const online = this.devices.filter(d => d.status === 'online').length;

        document.getElementById('totalDevices').textContent = total;
        document.getElementById('onlineDevices').textContent = online;
    }

    // Update alert statistics
    updateAlertStats() {
        const total = this.alerts.length;
        const active = this.alerts.filter(a => a.active === 'TRUE').length;
        const highPriority = this.alerts.filter(a => a.priority === 'high' && a.active === 'TRUE').length;

        document.getElementById('totalAlerts').textContent = total;
        document.getElementById('activeAlerts').textContent = active;
        document.getElementById('highPriorityAlerts').textContent = highPriority;
    }

    // Setup event listeners
    setupEventListeners() {
        // Device modal listeners
        document.getElementById('addDeviceBtn').addEventListener('click', () => {
            openAddDeviceModal();
        });

        document.querySelector('.modal-close').addEventListener('click', () => {
            this.hideAddDeviceModal();
        });

        document.getElementById('cancelAdd').addEventListener('click', () => {
            this.hideAddDeviceModal();
        });

        document.getElementById('addDeviceModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('addDeviceModal')) {
                this.hideAddDeviceModal();
            }
        });

        document.getElementById('addDeviceForm').addEventListener('submit', (e) => {
            e.preventDefault();
    
            const editDeviceId = document.getElementById('editDeviceId').value;
            if (editDeviceId) {
                // Edit mode
                const formData = new FormData(e.target);
                const deviceData = Object.fromEntries(formData);
                updateDevice(editDeviceId, deviceData);
            } else {
                // Add mode
                this.handleAddDevice();
            }
        });

        // Alert form listener
        document.getElementById('alertForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddAlert();
        });

        // Auto-refresh both devices and alerts every 30 seconds
        setInterval(() => {
            this.loadDevices();
            this.loadAlerts();
        }, 30000);
    }

    // === DEVICE MODAL METHODS ===

    showAddDeviceModal() {
        document.getElementById('addDeviceModal').classList.add('show');
        document.getElementById('deviceId').focus();
    }

    hideAddDeviceModal() {
        document.getElementById('addDeviceModal').classList.remove('show');
        document.getElementById('addDeviceForm').reset();

        // Reset form for adding (not editing)
        const modalTitle = document.querySelector('.modal-header h3');
        const submitBtn = document.querySelector('button[type="submit"]');
        if (modalTitle) modalTitle.textContent = 'Add New Device';
        if (submitBtn) submitBtn.textContent = 'Add Device';
        document.getElementById('deviceId').disabled = false;
        this.editingDevice = null;
    }

    async handleAddDevice() {
        const formData = new FormData(document.getElementById('addDeviceForm'));
        const deviceData = {
            deviceId: formData.get('deviceId'),
            ipAddress: formData.get('ipAddress'),
            location: formData.get('location'),
            building: formData.get('building'),
            template: formData.get('template'),
            theme: formData.get('theme'),
            slideId: formData.get('slideId'),
            refreshInterval: parseInt(formData.get('refreshInterval'))
        };

        const isEditing = this.editingDevice !== null;
        const action = isEditing ? 'updated' : 'added';
        const method = isEditing ? 'PUT' : 'POST';
        const url = isEditing ? `/api/admin/devices/${this.editingDevice}` : '/api/admin/devices';

        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(deviceData)
            });

            if (response.ok) {
                const result = await response.json();
                this.hideAddDeviceModal();

                if (result.requiresManualUpdate) {
                    this.showSuccess(`Device "${deviceData.deviceId}" configuration ready!

Please ${isEditing ? 'update' : 'add'} this device in your Google Sheet manually:
1. Open your Displays sheet
2. ${isEditing ? 'Update the row for' : 'Add a new row with'} deviceId: ${deviceData.deviceId}
3. Set building: ${deviceData.building}
4. Set other values as needed

The device will pick up the new configuration within a few minutes.`);
                } else {
                    this.showSuccess(result.message);
                }

                setTimeout(() => {
                    this.loadDevices();
                }, 3000);
            } else {
                const error = await response.json();
                throw new Error(error.message || `Failed to ${action.slice(0, -1)} device`);
            }
        } catch (error) {
            console.error(`Error ${action.slice(0, -1)}ing device:`, error);
            this.showError(`Failed to ${action.slice(0, -1)} device: ${error.message}`);
        }
    }

    previewDevice(deviceId) {
        const url = `/?deviceId=${deviceId}`;
        window.open(url, '_blank', 'width=1024,height=768');
    }

    editDevice(deviceId) {
        const device = this.devices.find(d => d.deviceId === deviceId);
        if (device) {
            document.getElementById('deviceId').value = device.deviceId;
            document.getElementById('ipAddress').value = device.ipAddress || '';
            document.getElementById('location').value = device.location || '';
            document.getElementById('building').value = device.building || '';
            document.getElementById('template').value = device.template || 'standard';
            document.getElementById('theme').value = device.theme || 'default';
            document.getElementById('slideId').value = device.slideId || '';
            document.getElementById('refreshInterval').value = device.refreshInterval || 15;

            const modalTitle = document.querySelector('.modal-header h3');
            const submitBtn = document.querySelector('button[type="submit"]');
            if (modalTitle) modalTitle.textContent = `Edit Device: ${deviceId}`;
            if (submitBtn) submitBtn.textContent = 'Update Device';
            document.getElementById('deviceId').disabled = true;

            this.editingDevice = deviceId;
            this.showAddDeviceModal();
        }
    }

    async deleteDevice(deviceId) {
        if (!confirm(`Are you sure you want to delete device "${deviceId}"?`)) {
            return;
        }

        try {
            const response = await fetch(`/api/admin/devices/${deviceId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(result.message);
                setTimeout(() => this.loadDevices(), 2000);
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete device');
            }
        } catch (error) {
            console.error('Error deleting device:', error);
            this.showError(`Failed to delete device: ${error.message}`);
        }
    }

    // === ALERT METHODS ===

    async handleAddAlert() {
        const selectedBuildings = this.getSelectedBuildings();

        if (selectedBuildings.length === 0) {
            this.showError('Please select at least one building for this alert.');
            return;
        }

        const formData = new FormData(document.getElementById('alertForm'));
        const alertData = {
            name: formData.get('alertName'),
            slideId: formData.get('alertSlideId'),
            buildings: selectedBuildings,
            priority: formData.get('alertPriority'),
            expires: formData.get('alertExpires') || null
        };

        try {
            const response = await fetch('/api/admin/alerts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(alertData)
            });

            if (response.ok) {
                const result = await response.json();

                if (result.requiresManualUpdate) {
                    this.showSuccess(`Alert "${alertData.name}" configuration ready!

Please add this alert to your Alerts sheet manually:
1. Open your Google Sheets and go to the Alerts sheet
2. Add a new row with these values:
   • Name: ${alertData.name}
   • Slide ID: ${alertData.slideId}
   • Buildings: ${alertData.buildings.join(',')}
   • Priority: ${alertData.priority}
   • Active: TRUE
   • Expires: ${alertData.expires || '(leave empty)'}

The alert will be active once added to the sheet.`);
                } else {
                    this.showSuccess(result.message);
                }

                // Reset form and refresh
                document.getElementById('alertForm').reset();
                clearAllBuildings();
                setTimeout(() => {
                    this.loadAlerts();
                }, 3000);
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to add alert');
            }
        } catch (error) {
            console.error('Error adding alert:', error);
            this.showError(`Failed to add alert: ${error.message}`);
        }
    }

    async toggleAlert(alertId) {
        try {
            const response = await fetch(`/api/admin/alerts/${alertId}/toggle`, {
                method: 'PATCH'
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(result.message);
                setTimeout(() => this.loadAlerts(), 1000);
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to toggle alert');
            }
        } catch (error) {
            console.error('Error toggling alert:', error);
            this.showError(`Failed to toggle alert: ${error.message}`);
        }
    }

    editAlert(alertId) {
        const alert = this.alerts.find(a => a.alertId === alertId);
        if (alert) {
            // Populate edit form
            document.getElementById('editAlertId').value = alert.alertId;
            document.getElementById('editAlertName').value = alert.name;
            document.getElementById('editAlertSlideId').value = alert.slideId;
            document.getElementById('editAlertPriority').value = alert.priority;
            document.getElementById('editAlertExpires').value = alert.expires || '';

            // Set building checkboxes
            const checkboxes = document.querySelectorAll('#editBuildingCheckboxes input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = alert.buildings.includes(cb.value);
            });

            this.showAlertEditModal();
        }
    }

    async deleteAlert(alertId) {
        const alert = this.alerts.find(a => a.alertId === alertId);
        if (!confirm(`Are you sure you want to delete alert "${alert?.name}"?`)) {
            return;
        }

        try {
            const response = await fetch(`/api/admin/alerts/${alertId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(result.message);
                setTimeout(() => this.loadAlerts(), 2000);
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete alert');
            }
        } catch (error) {
            console.error('Error deleting alert:', error);
            this.showError(`Failed to delete alert: ${error.message}`);
        }
    }

    showAlertEditModal() {
        document.getElementById('alertEditModal').classList.add('show');
    }

    closeAlertEditModal() {
        document.getElementById('alertEditModal').classList.remove('show');
    }

    async saveAlertEdit() {
        const alertId = document.getElementById('editAlertId').value;
        const selectedBuildings = this.getEditSelectedBuildings();
        
        if (selectedBuildings.length === 0) {
            this.showError('Please select at least one building for this alert.');
            return;
        }

        const alertData = {
            name: document.getElementById('editAlertName').value,
            slideId: document.getElementById('editAlertSlideId').value,
            buildings: selectedBuildings,
            priority: document.getElementById('editAlertPriority').value,
            expires: document.getElementById('editAlertExpires').value || null
        };

        try {
            const response = await fetch(`/api/admin/alerts/${alertId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(alertData)
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(result.message);
                this.closeAlertEditModal();
                setTimeout(() => this.loadAlerts(), 2000);
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to update alert');
            }
        } catch (error) {
            console.error('Error updating alert:', error);
            this.showError(`Failed to update alert: ${error.message}`);
        }
    }

    // === SSE PUSH METHODS ===

    async pushRefreshToDevice(deviceId) {
        try {
            const response = await fetch(`/api/admin/push/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceIds: [deviceId] })
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(`Refresh pushed to device ${deviceId} (${result.pushed}/${result.results.length} successful)`);
            } else {
                throw new Error('Failed to push refresh');
            }
        } catch (error) {
            console.error('Error pushing refresh:', error);
            this.showError('Failed to push refresh to device');
        }
    }

    async pushRefreshToAll() {
        try {
            const response = await fetch(`/api/admin/push/refresh-all`, {
                method: 'POST'
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(`Refresh pushed to all devices (${result.devicesNotified}/${result.totalDevices} connected)`);
            } else {
                throw new Error('Failed to push refresh to all');
            }
        } catch (error) {
            console.error('Error pushing refresh to all:', error);
            this.showError('Failed to push refresh to all devices');
        }
    }

    async deployAlertNow(alertId) {
        try {
            const response = await fetch(`/api/admin/alerts/${alertId}/deploy`, {
                method: 'POST'
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccess(`Alert deployed immediately to ${result.devicesNotified} devices in buildings: ${result.buildings.join(', ')}`);
            } else {
                throw new Error('Failed to deploy alert');
            }
        } catch (error) {
            console.error('Error deploying alert:', error);
            this.showError('Failed to deploy alert immediately');
        }
    }

    async checkSSEStatus() {
        try {
            const response = await fetch('/api/admin/sse/status');
            if (response.ok) {
                const status = await response.json();
                this.showSuccess(`SSE Status: ${status.totalConnections} devices connected\nConnected devices: ${status.connectedDevices.join(', ') || 'None'}`);
            } else {
                throw new Error('Failed to get SSE status');
            }
        } catch (error) {
            console.error('Error checking SSE status:', error);
            this.showError('Failed to check SSE status');
        }
    }

    // === BUILDING SELECTION HELPERS ===

    getSelectedBuildings() {
        const checkboxes = document.querySelectorAll('input[name="buildings"]:checked');
        return Array.from(checkboxes).map(cb => cb.value);
    }

    getEditSelectedBuildings() {
        const checkboxes = document.querySelectorAll('input[name="editBuildings"]:checked');
        return Array.from(checkboxes).map(cb => cb.value);
    }

    selectBuildings(codes) {
        // Clear all checkboxes first
        document.querySelectorAll('input[name="buildings"]').forEach(cb => {
            cb.checked = false;
        });
        
        // Check the specified building codes
        codes.forEach(code => {
            const checkbox = document.querySelector(`input[name="buildings"][value="${code}"]`);
            if (checkbox) {
                checkbox.checked = true;
            }
        });
    }

    // === HELPER FUNCTIONS ===

    formatBuildingNames(buildingCodes) {
        const buildingNames = {
            'SE': 'Schumann Elementary',
            'IS': 'Intermediate School', 
            'MS': 'Middle School',
            'HS': 'High School',
            'DC': 'Discovery Center',
            'DO': 'District Office'
        };

        if (!buildingCodes || buildingCodes.length === 0) return 'None';
        
        return buildingCodes.map(code => {
            const name = buildingNames[code];
            return name ? `${code}` : code;
        }).join(', ');
    }

    formatDate(dateString) {
        if (!dateString || dateString === 'Never') return 'Never';

        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;

        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;

        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString();
    }

    showSuccess(message) {
        this.showNotification(message, 'success');
    }

    showError(message) {
        this.showNotification(message, 'error');
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;

        if (message.includes('\n')) {
            const lines = message.split('\n');
            const title = lines[0];
            const body = lines.slice(1).join('\n');

            notification.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 0.5rem;">${title}</div>
                <div style="white-space: pre-line; font-size: 0.9rem; line-height: 1.4;">${body}</div>
            `;
        } else {
            notification.textContent = message;
        }

        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 1.5rem;
            border-radius: 6px;
            color: white;
            font-weight: 500;
            z-index: 1001;
            max-width: 500px;
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        `;

        switch (type) {
            case 'success':
                notification.style.backgroundColor = '#38a169';
                break;
            case 'error':
                notification.style.backgroundColor = '#e53e3e';
                break;
            default:
                notification.style.backgroundColor = '#667eea';
        }

        document.body.appendChild(notification);

        requestAnimationFrame(() => {
            notification.style.opacity = '1';
            notification.style.transform = 'translateX(0)';
        });

        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 8000);
    }
}

// === GLOBAL BUILDING SELECTION FUNCTIONS ===

function selectAllSchools() {
    admin.selectBuildings(['SE', 'IS', 'MS', 'HS']);
}

function selectElementaryLevel() {
    admin.selectBuildings(['SE', 'IS']);
}

function selectSecondaryLevel() {
    admin.selectBuildings(['MS', 'HS']);
}

function selectAllBuildings() {
    admin.selectBuildings(['SE', 'IS', 'MS', 'HS', 'DC', 'DO']);
}

function clearAllBuildings() {
    admin.selectBuildings([]);
}

function refreshAlerts() {
    const refreshText = document.getElementById('refreshAlertsText');
    refreshText.textContent = 'Refreshing...';
    
    admin.loadAlerts().then(() => {
        refreshText.textContent = 'Refresh';
    });
}

function filterAlerts() {
    const filter = document.getElementById('alertFilter').value;
    console.log('Filter alerts by:', filter);
}

function closeAlertEditModal() {
    admin.closeAlertEditModal();
}

function saveAlertEdit() {
    admin.saveAlertEdit();
}

// === GLOBAL MODAL FUNCTIONS ===

// Function to open modal in "Add" mode
function openAddDeviceModal() {
    const form = document.getElementById('addDeviceForm');
    const editDeviceId = document.getElementById('editDeviceId');
    const modalTitle = document.getElementById('modalTitle');
    const submitBtn = document.getElementById('submitDeviceBtn');
    const modal = document.getElementById('addDeviceModal');
    
    if (!form || !modalTitle || !submitBtn || !modal) {
        console.error('Missing modal elements');
        return;
    }
    
    form.reset();
    if (editDeviceId) editDeviceId.value = '';
    
    // Set modal to "Add" mode
    modalTitle.textContent = 'Add New Device';
    submitBtn.textContent = 'Add Device';
    
    // Show modal
    modal.classList.add('show');
}

// Store device data globally for edit mode
let currentEditDevice = null;

// Function to open modal in "Edit" mode
function openEditDeviceModal(deviceData) {
    // Store device data
    currentEditDevice = deviceData;
    
    // Get all elements first
    const elements = {
        editDeviceId: document.getElementById('editDeviceId'),
        deviceId: document.getElementById('deviceId'),
        ipAddress: document.getElementById('ipAddress'),
        location: document.getElementById('location'),
        building: document.getElementById('building'),
        template: document.getElementById('template'),
        theme: document.getElementById('theme'),
        slideId: document.getElementById('slideId'),
        refreshInterval: document.getElementById('refreshInterval'),
        modalTitle: document.getElementById('modalTitle'),
        submitBtn: document.getElementById('submitDeviceBtn'),
        modal: document.getElementById('addDeviceModal')
    };
    
    // Check if all required elements exist
    const missingElements = Object.entries(elements).filter(([key, el]) => !el).map(([key]) => key);
    if (missingElements.length > 0) {
        console.error('Missing elements:', missingElements);
        return;
    }
    
    // Populate form with device data
    elements.editDeviceId.value = deviceData.deviceId;
    elements.deviceId.value = deviceData.deviceId;
    elements.ipAddress.value = deviceData.ipAddress || '';
    elements.location.value = deviceData.location || '';
    elements.building.value = deviceData.building || '';
    elements.template.value = deviceData.template || 'standard';
    elements.theme.value = deviceData.theme || 'default';
    elements.slideId.value = deviceData.slideId || '';
    elements.refreshInterval.value = deviceData.refreshInterval || 15;
    
    // Set modal to "Edit" mode
    elements.modalTitle.textContent = 'Edit Device: ' + deviceData.deviceId;
    elements.submitBtn.textContent = 'Save Changes';
    
    // Show modal
    elements.modal.classList.add('show');
}

// Helper function to handle edit clicks
function editDeviceClick(deviceId) {
    // Find the device data from the admin's device list
    if (!admin || !admin.devices) {
        console.error('Admin or devices list not available');
        return;
    }
    
    const device = admin.devices.find(d => d.deviceId === deviceId);
    if (device) {
        openEditDeviceModal(device);
    } else {
        console.error('Device not found:', deviceId);
        console.log('Available devices:', admin.devices.map(d => d.deviceId));
    }
}

// Update device function
async function updateDevice(deviceId, deviceData) {
    try {
        const response = await fetch(`/api/admin/devices/${deviceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(deviceData)
        });
        
        if (response.ok) {
            // Close modal
            const modal = document.getElementById('addDeviceModal');
            if (modal) modal.classList.remove('show');
            currentEditDevice = null;
            
            // Refresh the device list
            admin.loadDevices();
            
            alert('Device updated successfully!');
        } else {
            const errorText = await response.text();
            throw new Error(`Failed to update device: ${errorText}`);
        }
    } catch (error) {
        console.error('Error updating device:', error);
        alert('Error updating device: ' + error.message);
    }
}

// Initialize admin interface when page loads
let admin;
document.addEventListener('DOMContentLoaded', () => {
    admin = new AdminInterface();
});