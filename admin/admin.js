// Admin Interface JavaScript
class AdminInterface {
    constructor() {
        this.devices = [];
        this.editingDevice = null;
        this.init();
    }

    async init() {
        await this.loadUserInfo();
        await this.loadDevices();
        this.setupEventListeners();
        this.updateStats();
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

                <div class="device-details">
                    <div class="device-detail">
                        <span class="device-detail-label">Location:</span>
                        <span class="device-detail-value">${device.location || 'Not set'}</span>
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
                    <button class="btn btn-secondary btn-small" onclick="admin.editDevice('${device.deviceId}')">
                        ✏️ Edit
                    </button>
                    <button class="btn btn-danger btn-small" onclick="admin.deleteDevice('${device.deviceId}')">
                        🗑️ Delete
                    </button>
                </div>
            </div>
        `).join('');
    }

    // Update statistics
    updateStats() {
        const total = this.devices.length;
        const online = this.devices.filter(d => d.status === 'online').length;
        const offline = total - online;

        document.getElementById('totalDevices').textContent = total;
        document.getElementById('onlineDevices').textContent = online;
        document.getElementById('offlineDevices').textContent = offline;
    }

    // Setup event listeners
    setupEventListeners() {
        // Add device button
        document.getElementById('addDeviceBtn').addEventListener('click', () => {
            this.showAddDeviceModal();
        });

        // Modal close events
        document.querySelector('.modal-close').addEventListener('click', () => {
            this.hideAddDeviceModal();
        });

        document.getElementById('cancelAdd').addEventListener('click', () => {
            this.hideAddDeviceModal();
        });

        // Click outside modal to close
        document.getElementById('addDeviceModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('addDeviceModal')) {
                this.hideAddDeviceModal();
            }
        });

        // Add device form submission
        document.getElementById('addDeviceForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddDevice();
        });

        // Auto-refresh devices every 30 seconds
        setInterval(() => {
            this.loadDevices();
        }, 30000);
    }

    // Show add device modal
    showAddDeviceModal() {
        document.getElementById('addDeviceModal').style.display = 'block';
        document.getElementById('deviceId').focus();
    }

    // Hide add device modal
    hideAddDeviceModal() {
        document.getElementById('addDeviceModal').style.display = 'none';
        document.getElementById('addDeviceForm').reset();

        // Reset form for adding (not editing)
        document.querySelector('.modal-header h3').textContent = 'Add New Device';
        document.querySelector('button[type="submit"]').textContent = 'Add Device';
        document.getElementById('deviceId').disabled = false;
        this.editingDevice = null;
    }

    // Handle add device form submission
    async handleAddDevice() {
        const formData = new FormData(document.getElementById('addDeviceForm'));
        const deviceData = {
            deviceId: formData.get('deviceId'),
            location: formData.get('location'),
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
                    // Show manual instructions
                    this.showSuccess(`Device "${deviceData.deviceId}" configuration ready!

Please ${isEditing ? 'update' : 'add'} this device in your Google Sheet manually:
1. Open: https://docs.google.com/spreadsheets/d/1Zmzmg_QXsrPXvB6BR-j9lEExzTZ8sCHBneBJq90dlw0
2. ${isEditing ? 'Update the row for' : 'Add a new row with'} deviceId: ${deviceData.deviceId}
3. Set the following values:
   • location: ${deviceData.location}
   • template: ${deviceData.template}
   • theme: ${deviceData.theme}
   • slideId: ${deviceData.slideId}
   • refreshInterval: ${deviceData.refreshInterval}

The device will pick up the new configuration within a few minutes.`);
                } else {
                    // Success with automatic Google Sheets update
                    this.showSuccess(result.message);
                }

                // Refresh the devices list after a short delay
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

    // Preview device (open in new tab)
    previewDevice(deviceId) {
        const url = `/?deviceId=${deviceId}`;
        window.open(url, '_blank', 'width=1024,height=768');
    }

    // Edit device - now with a proper implementation
    editDevice(deviceId) {
        const device = this.devices.find(d => d.deviceId === deviceId);
        if (device) {
            // Pre-populate the add device form with current values
            document.getElementById('deviceId').value = device.deviceId;
            document.getElementById('location').value = device.location || '';
            document.getElementById('template').value = device.template || 'standard';
            document.getElementById('theme').value = device.theme || 'default';
            document.getElementById('slideId').value = device.slideId || '';
            document.getElementById('refreshInterval').value = device.refreshInterval || 15;

            // Change the form title and button text
            document.querySelector('.modal-header h3').textContent = `Edit Device: ${deviceId}`;
            document.querySelector('button[type="submit"]').textContent = 'Update Device';

            // Disable deviceId field since we're editing
            document.getElementById('deviceId').disabled = true;

            // Store the fact that we're editing
            this.editingDevice = deviceId;

            // Show the modal
            this.showAddDeviceModal();
        }
    }

    // Delete device
    async deleteDevice(deviceId) {
        if (!confirm(`Are you sure you want to delete device "${deviceId}"?\n\nThis will require manual removal from the Google Sheet.`)) {
            return;
        }

        try {
            const response = await fetch(`/api/admin/devices/${deviceId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                const result = await response.json();

                if (result.requiresManualUpdate) {
                    this.showSuccess(`Device "${deviceId}" marked for deletion!

Please remove this device from your Google Sheet manually:
1. Open: https://docs.google.com/spreadsheets/d/1Zmzmg_QXsrPXvB6BR-j9lEExzTZ8sCHBneBJq90dlw0
2. Find the row with deviceId: ${deviceId}
3. Delete that entire row

The device will stop receiving configuration once removed from the sheet.`);
                } else {
                    this.showSuccess(result.message);
                }

                // Don't refresh automatically since it's manual - just show instructions
                console.log('Device marked for deletion - manual removal required');
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete device');
            }
        } catch (error) {
            console.error('Error deleting device:', error);
            this.showError(`Failed to delete device: ${error.message}`);
        }
    }

    // Utility functions
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
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;

        // Handle multiline messages
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

        // Add styles for notification
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

        // Set background color based on type
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

        // Add to DOM
        document.body.appendChild(notification);

        // Animate in
        requestAnimationFrame(() => {
            notification.style.opacity = '1';
            notification.style.transform = 'translateX(0)';
        });

        // Remove after 8 seconds (longer for detailed messages)
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

// Initialize admin interface when page loads
let admin;
document.addEventListener('DOMContentLoaded', () => {
    admin = new AdminInterface();
});
