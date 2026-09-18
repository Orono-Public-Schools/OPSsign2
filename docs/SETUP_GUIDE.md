# Raspberry Pi Setup Guide for OPSsign2

This guide provides instructions for setting up a Raspberry Pi device to run the OPSsign2 digital signage system.

## Prerequisites

*   A Raspberry Pi (Model 3B+ or later recommended)
*   A microSD card (16GB or larger)
*   A monitor with HDMI input
*   A network connection (Ethernet or Wi-Fi)
*   Familiarity with basic Linux commands

## Installation

1.  **Flash Raspberry Pi OS:** Download the latest Raspberry Pi OS Lite image from the official Raspberry Pi website and flash it onto the microSD card.  It is recommended to use the "opstech" user for initial setup.

2.  **Enable SSH:** After flashing the OS, enable SSH by creating an empty file named `ssh` in the root directory of the microSD card. This allows you to remotely access the Pi.

3.  **Boot the Raspberry Pi:** Insert the microSD card into the Raspberry Pi and power it on.

4.  **Connect to the Raspberry Pi:** Use SSH to connect to the Raspberry Pi. The default username is `opstech` and you will need to configure the password.

5.  **Run the Installation Script:** Execute the following command to download and run the installation script:

    ```bash
    curl -sSL https://raw.githubusercontent.com/Orono-Public-Schools/OPSsign2/main/device/install.sh | bash
    ```

6.  **Set the Device ID:**  After the installation script completes, you need to set the unique device identifier.

    ```bash
    sudo /opt/opssign/utils/set-device-id.sh
    ```

7.  **Add the device in the admin interface**: After the script is complete, add the device to the admin interface.

8.  **(Optional) Reboot:** After configuring the device ID, reboot the Raspberry Pi. The device should automatically start the digital signage application.

## Security Enhancements

*   **Custom User:** Uses `opstech` user instead of default `pi`
*   **Minimal Privileges**: `opssign` user has no sudo access
*   **No Desktop Environment**: Runs only X server + Chromium
*   **Disabled Shortcuts**: Eliminates Ctrl+Alt+T and similar shortcuts
*   **Locked Down**: Prevents context menus and text selection
*   **SSH Access Maintained**: Remote management via `opstech` user

## Device Management Scripts

The following scripts are included for managing the Raspberry Pi device:

*   `install.sh`: Complete Pi setup from fresh Raspberry Pi OS
*   `update-device.sh`: Pull latest scripts from git repository
*   `set-device-id.sh`: Set unique device identifier

Refer to the `device/README.md` file for more information about these scripts.

## Troubleshooting

*   **Display Issues:** If Chromium only occupies the left half of the screen, force clean preferences:

    ```bash
    rm -rf /home/opssign/.config/chromium 2>/dev/null || true
    ```

*   **Reset Kiosk:** If something breaks, reset the kiosk:

    ```bash
    sudo /opt/opssign/utils/reset-kiosk.sh
    ```

## Additional Information

*   See `device/README.md` for more information on directory structure and scripts.
*   See `PROJECT_UPDATES.md` for information on Chromium Kiosk fixes.
