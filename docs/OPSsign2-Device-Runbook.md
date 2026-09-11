# OPSsign2 Device Runbook

Golden-image workflow for OPSsign2 Raspberry Pi displays: committing device
scripts, preparing the template card, capturing the image, and deploying a new
device.

Last updated: September 2026

---

## 0. Architecture notes

| Thing | Where |
|---|---|
| Server (Node app + git checkout) | `sign.orono.k12.mn.us`, `~/OPSsign2` |
| Device scripts (machine-invoked) | `/opt/opssign/scripts/` |
| Device utilities (operator-invoked) | `/opt/opssign/utils/` |
| Device config | `/opt/opssign/config/device.conf` |
| Kiosk log | `/var/log/opssign-kiosk.log` |
| Update logs | `/opt/opssign/logs/` |
| Staging marker | `/boot/firmware/opssign-update-stage` |
| Repo | `github.com/Orono-Public-Schools/OPSsign2` |

**`scripts/` vs `utils/`** — `scripts/` is run by the machine (autologin,
xinit, systemd). `utils/` is run by you. Breaking something in `scripts/` means
the display doesn't come up.

Devices have **no git checkout**. They receive files either from
`update-device.sh` (which clones the repo) or from a bootstrap paste.

---

## 1. Commit device scripts to git (run on the SERVER)

The Pi has no repo, so pull the tested files across and commit from the server.

```bash
ssh opssign@sign.orono.k12.mn.us
cd ~/OPSsign2

scp opstech@<device-hostname>:/opt/opssign/scripts/{chromium-kiosk,update-device}.sh device/scripts/
scp opstech@<device-hostname>:/opt/opssign/utils/{setup-overlay,test-display,reset-kiosk,set-device-id}.sh device/utils/
scp opstech@<device-hostname>:/opt/opssign/config/opssign-update-resume.service device/config/
scp opstech@<device-hostname>:/etc/logrotate.d/opssign device/config/opssign-logrotate

chmod +x device/scripts/*.sh device/utils/*.sh
git status --short          # expect ONLY files under device/
```

If the server can't resolve the device hostname, add it to `/etc/hosts` or use
the IP.

```bash
git add device/
git commit -m "device: <what changed>"
git push
```

**Verify the executable bit survived** — `git diff --cached --stat` should show
`100755` on `.sh` files. A script committed without it won't run after a fresh
clone.

### Git auth on the server

The server uses `gh` with an HTTPS credential helper, not an SSH key:

```bash
gh auth status
gh config set git_protocol https
gh auth setup-git
```

---

## 2. Prepare the template card

Run these on the device that will become the golden image. **The overlay must
be OFF.**

### 2a. Confirm the filesystem is writable

```bash
findmnt -n -o FSTYPE /          # must be ext4, NOT overlay
```

If it says `overlay`:

```bash
sudo /opt/opssign/utils/setup-overlay.sh disable
sudo reboot
```

> Anything installed while the overlay is active goes to RAM and disappears at
> the next reboot. This silently wasted a whole afternoon once.

### 2b. Update to the latest committed scripts

```bash
sudo /opt/opssign/scripts/update-device.sh --full
ls -la /opt/opssign/scripts/ /opt/opssign/utils/   # dates should be NOW
```

### 2c. Verify the display

```bash
/opt/opssign/utils/test-display.sh
```

Check: device ID, scale factor present and matching, server responding,
correct template and slideId.

### 2d. Blank the identity

Every card cloned from this image inherits these. Two displays with the same
device ID will fight over the server's SSE connection.

```bash
sudo sed -i 's/^DEVICE_ID=.*/DEVICE_ID=change-me/' /opt/opssign/config/device.conf
sudo hostnamectl set-hostname opssign-template
sudo sed -i -E 's/^(127\.0\.1\.1[[:space:]]+).*/\1opssign-template/' /etc/hosts
```

### 2e. Clear machine-specific identifiers

Cloned SSH host keys mean every sign presents the same identity. A cloned
`machine-id` means NetworkManager derives the same DHCP client identifier on
every device, causing lease collisions.

```bash
sudo truncate -s 0 /etc/machine-id          # truncate, NOT rm - systemd needs the file to exist
sudo rm -f /etc/ssh/ssh_host_*
sudo systemctl enable regenerate_ssh_host_keys.service
```

### 2f. Clear logs and backups

```bash
sudo truncate -s 0 /var/log/opssign-kiosk.log
sudo rm -rf /opt/opssign/backup/*
sudo rm -f /boot/firmware/opssign-update-stage
```

> Truncate, don't delete, the kiosk log: Chromium holds an open fd on it for the
> life of the session. Unlinking it means writes go to a nameless inode and the
> space isn't reclaimed until the process exits.

### 2g. Shut down cleanly

```bash
sudo shutdown -h now
```

Wait for the green LED to stop before pulling the card.

---

## 3. Capture the image (Windows)

**Raspberry Pi Imager cannot read cards — it only writes.** Use Win32 Disk
Imager for the capture.

### 3a. Read the card

1. Insert the card. Windows will offer to format the unrecognised ext4
   partition — **decline**.
2. Open **Win32 Disk Imager as Administrator**.
3. Set Image File to e.g. `D:\opssign-images\opssign-template-2026-09-11.img`
4. Device: pick the **boot drive letter** of the card. Win32 Disk Imager reads
   the whole physical device, not just that partition.
5. Tick **Read Only Allocated Partitions** if available.
6. Click **Read**. Expect 20-40 minutes for a 128 GB card.

Result is a full-size `.img` (~119 GB) regardless of used space.

### 3b. Shrink it with PiShrink (via WSL)

PiShrink shrinks the last partition and flags it to auto-expand on first boot.
With ~5 GB used you should land around 6 GB.

One-time WSL setup:

```bash
wsl --install                 # PowerShell, if WSL isn't present yet
```

Inside WSL:

```bash
sudo apt update && sudo apt install -y parted e2fsprogs
wget https://raw.githubusercontent.com/Drewsif/PiShrink/master/pishrink.sh
chmod +x pishrink.sh
sudo mv pishrink.sh /usr/local/bin/
```

Shrink (Windows drives appear under `/mnt/`):

```bash
cd /mnt/d/opssign-images
sudo pishrink.sh -z opssign-template-2026-09-11.img opssign-template-shrunk.img
```

- `-z` gzips afterwards. Drop it if you'd rather flash directly.
- Giving a second filename preserves the original, but needs space for a full
  copy.

**Auto-expand caveat:** PiShrink's resize-on-first-boot needs `/etc/rc.local`
compatibility on systemd distros. If a newly flashed card comes up with a small
root partition, just run:

```bash
sudo raspi-config nonint do_expand_rootfs && sudo reboot
```

Confirm with `df -h /` — should show the full card size.

**Do not shrink an image captured with the overlay enabled.** PiShrink's
auto-expand edits `cmdline.txt`, the same file the overlay token lives in.

### 3c. Write to a new card

Raspberry Pi Imager, balenaEtcher or Win32 Disk Imager all work. In Raspberry
Pi Imager choose **Use custom** and select the `.img` (or `.img.gz`).

**Do not apply Imager's OS customisation settings** (hostname, user, SSH, wifi).
They're for stock Pi OS images and will fight the template's configuration.

---

## 4. Deploy a newly imaged card

```bash
# 1. Boot the Pi on the network. Find it by MAC in DHCP.
#    Hostname will be: opssign-template

ssh opstech@<ip>

# 2. Confirm the root filesystem expanded
df -h /                       # should show the full card size
                              # if not: sudo raspi-config nonint do_expand_rootfs && sudo reboot

# 3. Set device ID (also sets hostname and /etc/hosts)
sudo /opt/opssign/utils/set-device-id.sh sign-hs-cafeteria-1
sudo reboot

# 4. Add the row in the Displays sheet:
#    deviceId | ipAddress | location | template | theme | slideId | building | displayname | active

# 5. Verify
ssh opstech@sign-hs-cafeteria-1
/opt/opssign/utils/test-display.sh

# 6. Optional: pull anything committed since the image was made
sudo /opt/opssign/scripts/update-device.sh --full

# 7. Lock the filesystem LAST
sudo /opt/opssign/utils/setup-overlay.sh enable
sudo reboot

# 8. Confirm
/opt/opssign/utils/setup-overlay.sh status    # Overlay filesystem: ACTIVE
```

**Enable the overlay last.** Once it's on, any change needs
`sudo overlayroot-chroot`.

Your SSH client will warn about changed host keys — that's the regeneration
working. Clear the stale entry with `ssh-keygen -R <hostname>`.

### Naming convention

`sign-{owner}-{location}` — include a site segment only when the owner differs
from the physical building.

| Name | Meaning |
|---|---|
| `sign-hs-main-entry` | HS-owned, in the HS |
| `sign-at-hs-lobby` | Athletics-owned, in the HS |
| `sign-at-stadium-concessions` | Athletics-owned, at the stadium |

All lowercase, so the device ID and hostname are identical rather than derived.

> The `building` column is **content ownership**, not physical location — it
> controls who can push alerts to a display. See "Known gaps" below.

---

## 5. Day-to-day operations

### Diagnose a display

```bash
/opt/opssign/utils/test-display.sh
```

### Fix a stuck or wrongly scaled display

```bash
sudo /opt/opssign/utils/reset-kiosk.sh          # bounce the session, ~10s
sudo /opt/opssign/utils/reset-kiosk.sh --hard   # full reboot
```

Needed after moving a Pi between panels, or when a TV was powered on after the
Pi booted — the scale factor is computed once at Chromium launch.

### Update one device

```bash
sudo /opt/opssign/scripts/update-device.sh              # scripts only
sudo /opt/opssign/scripts/update-device.sh --full       # apt + scripts
```

### Update the whole fleet

```bash
for h in sign-hs-main-entry sign-ms-commons sign-do-front; do
  ssh opstech@$h "sudo /opt/opssign/scripts/update-device.sh --full" &
done; wait
```

### Make a persistent change on a locked device

```bash
sudo overlayroot-chroot
# ...you are now in the real filesystem, writes persist...
exit
sudo reboot
```

---

## 6. How the display scaling works

The launcher does **not** force a resolution. It reads whatever mode the panel
negotiated and scales the page content:

```
scale factor = panel height / 1080
```

4K → `2.0`, 1080p → `1.0`. The page always sees a 1920x1080 CSS viewport, so
templates lay out identically everywhere and 4K simply renders sharper.

This is why panels advertising only 4K in their EDID (Samsung QBN with Input
Signal Plus, many ViewSonic ViewBoards) no longer cause problems: there is no
mode to force, so nothing fails.

Override per device in `device.conf`:

```
DISPLAY_SCALE=1.5        # default is "auto"
```

> `--window-size` is in DIPs, not device pixels. The launcher divides native
> resolution by the scale factor. Passing raw pixels makes the window N times
> larger than the screen.

---

## 7. How the read-only overlay works

Root writes land in RAM and are discarded at reboot, so the card is never
written during normal operation. This is what makes displays survive being
unplugged.

**Two implementations exist and are not interchangeable:**

| | Token in `cmdline.txt` | Control |
|---|---|---|
| overlayroot (Debian pkg) | `overlayroot=tmpfs` | edit `cmdline.txt` |
| raspi-config | `boot=overlay` | `raspi-config nonint do_overlayfs` |

`setup-overlay.sh` detects which is in use and dispatches accordingly.

**Detect by filesystem TYPE, never mount source:**

```bash
findmnt -n -o FSTYPE /     # "overlay" for BOTH implementations
findmnt -n -o SOURCE /     # "overlay" OR "overlayroot" - unreliable
```

### Gotchas

- **The kernel cmdline overrides `/etc/overlayroot.conf` entirely.** The conf
  file can read `overlayroot=""` while the overlay is plainly running.
- **`overlayroot` rewrites `/etc/fstab` at every boot.** Entries it can't
  overlay (vfat `/boot/firmware`) are rewritten to `defaults` and tagged
  `# overlayroot:fs-unsupported`. You cannot make `/boot/firmware` read-only
  through fstab — the edit persists on disk but is regenerated away at boot.
- **`raspi-config nonint enable_bootro` refuses to run while an overlay is
  active**, including inside `overlayroot-chroot`, because it checks the running
  `/proc/cmdline`.
- `systemctl enable` writes to the root filesystem, so it doesn't persist under
  an overlay. The resume unit is enabled at install time instead.

### Updating a locked device

`update-device.sh --full` stages itself across reboots:

1. Strip the overlay token, write the marker to `/boot/firmware`, reboot
2. `opssign-update-resume.service` runs apt + git pull
3. Reboot again if the kernel changed (the overlay initramfs must be built
   against the kernel that will run)
4. Re-enable the overlay, reboot

Two to four reboots, unattended. Watch with:

```bash
sudo journalctl -u opssign-update-resume.service -f
```

> **Not yet tested end to end.** Verify on a bench device before relying on it
> across the fleet.

---

## 8. Troubleshooting

### X session crash-loops (startup text, black, repeat)

Chromium is exiting immediately and `.bashrc`'s `exec xinit` respawns it.

```bash
sudo systemctl stop getty@tty1.service     # stop the loop
sudo tail -40 /var/log/opssign-kiosk.log   # read why
```

Most common cause is a root-owned profile directory:

```bash
sudo rm -rf /home/opssign/.config/chromium
sudo systemctl start getty@tty1.service
```

Chromium aborts rather than risk profile corruption when it can't create
`SingletonLock`. Running the launcher under `sudo` used to cause this.

### An update reported success but nothing changed

The overlay was active. Check with `findmnt -n -o FSTYPE /`; if it says
`overlay`, everything went to RAM.

### Update dies with a syntax error partway through

The updater was overwriting itself while bash was still reading it. Fixed by
re-execing from a `/tmp` copy — if you see this, the device is running a
pre-September-2026 version. Re-bootstrap it.

### `cmdline.txt` edits silently do nothing

`/boot/firmware` is mounted read-only.

```bash
sudo mount -o remount,rw /boot/firmware
```

### fstab changes don't take effect

systemd caches the generated mount unit.

```bash
sudo systemctl daemon-reload
sudo umount /boot/firmware && sudo mount /boot/firmware
```

### Slides show a Google sign-in page

The `slideId` is a Drive **file ID** whose sharing was tightened, not a
published ID. Published IDs start with `2PACX-` and come from
File → Share → Publish to web. Take the segment between `/d/e/` and `/pub`.

File IDs work only while the deck is link-shared, and break silently.

---

## 9. Known gaps

Deliberately deferred. None block normal operation.

**SSE connection eviction.** `connectedDevices` is keyed on `deviceId` and holds
one connection each. Two clients with the same ID means the newer evicts the
older — relevant to duplicate device IDs and to the planned "virtual displays"
(one browser-openable display per building, linked from ClassLink).

**Alert routing by ownership, not location.** `getAlertsForBuilding()` matches
the `building` column exactly. Since `building` means *who manages the content*,
an athletics-owned display inside the high school will **not** receive an
HS-targeted lockdown alert. A district-wide alert (empty buildings list) does
reach everything. Fix would be a separate `site` column for physical location.

**`install.sh` fixes not yet applied.** Still writes to `/boot/config.txt`
instead of `/boot/firmware/config.txt` on Bookworm; still ships the old
logrotate stanza using `create` rather than `copytruncate`.

**No `PATH` symlinks.** Worth adding to `install.sh`:

```bash
sudo ln -sf /opt/opssign/utils/*.sh /usr/local/bin/
```

**`fullscreen` template builds its own embed URL** (line ~225) rather than
calling `initializeSlide`, so it may not carry the published-ID fix.
`templates/rotation/` line 73 has the same pattern but is retired.

**Admin "update device" button.** Would need a small root agent on each Pi
holding its own SSE connection, keyed separately from `connectedDevices`, with a
shared token. SSH covers this meanwhile.

**unattended-upgrades.** Still enabled. Under the overlay it downloads and
installs into RAM every boot, discards it, and repeats. Worth disabling given
the deliberate update path.
