# Car Rider Pro on OPSsign — setup

Lets dismissal displays come up already signed in, instead of showing a
CarRiderPro login screen after every reboot and every 14-day token expiry.

## How it works

1. `crp-token.js` on the OPSsign server mints a bearer token with CarRiderPro's
   standard `/Token` password grant and caches it in memory.
2. The `car-rider` template fetches that token from `/api/crp/token` — same
   origin, so no CORS — and appends it to the iframe URL as `?opssign_token=...`.
3. The `opssign-crp` browser extension has a content script on
   `carriderpro.com` with `all_frames: true`, so it runs **inside** the iframe's
   origin. It writes `accessToken`, `lineManagerZoneId` and
   `lineManagerSchoolId`, then strips the parameters from the URL.
4. CRP's `getSecurityHeaders()` finds the token, `init()` reads the stored
   zone, and the display comes up on the right queue.

The extension is the only piece that can do step 3. Same-origin policy is
enforced by the browser, not by CarRiderPro, so the OPSsign page could never
write into that frame's storage no matter how the app is written. A content
script is not a bypass — it runs in the origin it has permission for.

## Two things that look like they should work, and don't

**Don't use the `#queuemanager/<id>` route.** `queuemanager.js` branches on it:

```js
function activate(zoneId) {
    if (zoneId) { selectedZoneId(parseInt(zoneId)); return Q.resolve(); }
    else        { return datacontextQueue.initialize().then(init); }
}
```

The route path assumes you navigated from the Home screen with data already
loaded, so it **skips `datacontextQueue.initialize()`**. A display boots cold,
`zones()` is empty, and the app throws
`Cannot read properties of undefined (reading 'zoneId')`. Load the bare portal
and let the zone come from localStorage.

**Set the school as well as the zone.** `init()` only honours a stored zone
when all three hold:

```js
localStorage["lineManagerSchoolId"]
  && localStorage["lineManagerSchoolId"] == datacontextQueue.schoolId()
  && localStorage["lineManagerZoneId"]
```

Otherwise it falls through to `zones()[0]` and overwrites the stored zone — so
seeding the zone alone silently shows the wrong queue.

## Server

Save `crp-token.js` to the repo root, alongside `server.js` and `hls-proxy.js`.

Add to `.env`:

```
CRP_USERNAME=<dismissal account>
CRP_PASSWORD=<password>
# optional:
# CRP_BASE_URL=https://www.carriderpro.com
# CRP_ALLOWED_CIDRS=10.17.0.0/16,127.0.0.1/32      ('' disables the check)
```

Wire it into `server.js` the same way as `hls-proxy`:

```js
// with the other requires, near the top
const crpTokenRouter = require('./crp-token');

// with the other route registrations
app.use('/api/crp', crpTokenRouter);
```

Restart, then verify:

```bash
curl -s http://localhost:3000/api/crp/token | python3 -m json.tool
```

Expect `access_token`, `expires` about 14 days out, and `cached: false` the
first time / `true` after.

## Template

Goes in `templates/car-rider/index.html.template`.

Displays sheet row:

| column | value |
|---|---|
| template | `car-rider` |
| slideId | `https://www.carriderpro.com/schoolportal#queuemanager/1164` |

### Picking the queue per device

One template, one CRP account, one `.env` credential. Each display's queue is
set by its own `slideId` — nothing else differs between the three rows.

| device | slideId |
|---|---|
| Schumann | `https://www.carriderpro.com/schoolportal?zone=1164` |
| Intermediate Back Loop | `https://www.carriderpro.com/schoolportal?zone=1165` |
| Intermediate Front Loop | `https://www.carriderpro.com/schoolportal?zone=1357` |

The template reads `?zone=<id>`, strips it from the URL it hands to CRP, and
passes it to the extension, which writes `lineManagerZoneId` — the same key the
in-app **Settings → Zone** dropdown writes.

`school` defaults to 125 (the district account) and only needs setting with
`&school=<id>` if that ever changes.

Zone IDs come from `zoneLookups` in localStorage on a logged-in session, or
from the Settings → Zone dropdown.

`lineManagerSchoolId` is the district account (125) and is the same for every
zone, so `?school=` is not normally needed. It remains available if a future
configuration needs it.

Leave `slideId` empty to use `/schoolportal` with no deep link and no zone.

## Extension (on each CRP display)

```bash
sudo install -d -o opssign -g opssign /opt/opssign/extensions/opssign-crp
sudo install -m 644 -o opssign -g opssign manifest.json content.js \
    /opt/opssign/extensions/opssign-crp/
```

Then add to the Chromium launch flags in
`/opt/opssign/scripts/chromium-kiosk.sh`:

```
    --load-extension=/opt/opssign/extensions/opssign-crp \
```

> `--load-extension` was removed from **Chrome-branded** builds in Chrome 137
> and the workaround removed in 142. It still works in unbranded Chromium,
> which is what Raspberry Pi OS ships as `chromium-browser`. If a future Pi OS
> release switches to a branded build, move to an enterprise policy in
> `/etc/chromium/policies/managed/` instead.

Confirm it loaded:

```bash
tr '\0' '\n' < /proc/$(pgrep -f "chromium.*--kiosk" | head -1)/cmdline | grep load-extension
```

## Verifying end to end

On the display, or in WSL with the extension loaded via `chrome://extensions`
(Developer mode → Load unpacked):

1. Open `http://sign.orono.k12.mn.us:3000/?deviceId=<crp-device>`
2. The queue should render without a login screen.
3. Dev tools → Application → Local storage → `carriderpro.com` should show
   `accessToken` and `lineManagerZoneId` matching the device's row.
4. Console should show `[opssign-crp] seeded token zone=<id> school=125`,
   then `Retrieved [Initial Client Data] from remote data source` and
   `Binding views/queuemanager` with no `zoneId` error.
5. Point a second device row at a different zone and confirm each shows its own
   queue — that proves the zone is coming from the sheet rather than from
   whatever was last selected in the app.

## Expiry and self-healing

- Server re-mints when under 24 hours remain, and refreshes every 6 hours.
- The template re-fetches a token on every load, including its 30-minute
  refresh cycle. So an expired session recovers within half an hour without
  anyone touching the display.
- If the token endpoint is unreachable, the frame still loads and shows the
  normal login screen. Nothing breaks, it just isn't automatic.

## Security notes

- The token is a working credential for a system holding student dismissal
  data. `/api/crp/token` is restricted to the signage subnet by default.
- The token appears briefly in the iframe URL. The content script removes it
  via `history.replaceState` at `document_start`, before CRP's scripts run.
- The CRP account should be scoped to dismissal, not full admin.
- `CRP_PASSWORD` lives in `.env`, which is gitignored. Do not commit it.
- Nothing durable is written to the device, so this works with the read-only
  overlay and with the launcher's per-boot profile wipe. No `PRESERVE_PROFILE`
  flag needed.
