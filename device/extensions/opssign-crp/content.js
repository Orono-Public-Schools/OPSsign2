/*
 * OPSsign Car Rider Pro Bridge
 *
 * Why this exists:
 *   The OPSsign display page embeds the CarRiderPro portal in an iframe. CRP
 *   authenticates by reading "accessToken" from localStorage/sessionStorage.
 *   Same-origin policy means the OPSsign page cannot write into the iframe's
 *   storage, so it cannot hand over a token it minted server-side.
 *
 *   A content script is not subject to that restriction: it runs INSIDE the
 *   carriderpro.com origin, so writing localStorage here is an ordinary
 *   same-origin write, not a bypass. No --disable-web-security needed.
 *
 * What it seeds, and why all three keys matter (queuemanager.js, init()):
 *
 *     if (localStorage["lineManagerSchoolId"]
 *         && localStorage["lineManagerSchoolId"] == datacontextQueue.schoolId().toString()
 *         && localStorage["lineManagerZoneId"]) {
 *         selectedZoneId(parseInt(localStorage["lineManagerZoneId"]));
 *     } else {
 *         selectedZoneId(datacontextQueue.zones()[0].zoneId);   // falls back to the FIRST zone
 *     }
 *
 *   All three conditions must hold or the app silently selects zones()[0] and
 *   overwrites lineManagerZoneId with it. So the school ID is not optional -
 *   without it the zone is ignored.
 *
 * IMPORTANT: the URL must NOT contain a #queuemanager/<id> route.
 *   activate(zoneId) treats a routed zone as "navigated from Home" and skips
 *   datacontextQueue.initialize() entirely, assuming the data is already
 *   loaded. On a display booting with a wiped profile it is not, so zones() is
 *   empty, _.find returns undefined, and the zones()[0] fallback throws
 *   "Cannot read properties of undefined (reading 'zoneId')".
 *   Point slideId at the bare /schoolportal and let these keys pick the zone.
 */
(function () {
    'use strict';

    var TOKEN_PARAM  = 'opssign_token';
    var ZONE_PARAM   = 'opssign_zone';
    var SCHOOL_PARAM = 'opssign_school';

    var params, token, zone, school;

    try {
        params = new URLSearchParams(window.location.search);
        token  = params.get(TOKEN_PARAM);
        zone   = params.get(ZONE_PARAM);
        school = params.get(SCHOOL_PARAM);
    } catch (e) {
        return;
    }

    if (!token && !zone) {
        return;   // normal browsing - do nothing
    }

    try {
        if (token) {
            // Match what setAccessToken(token, true) does for "remember me".
            localStorage.setItem('accessToken', token);
            // A stale sessionStorage token wins over localStorage in
            // getSecurityHeaders(), so clear it or an expired one keeps
            // being used.
            sessionStorage.removeItem('accessToken');
        }

        // Both zone and school, or init() ignores the zone entirely.
        if (zone && school) {
            localStorage.setItem('lineManagerSchoolId', school);
            localStorage.setItem('lineManagerZoneId', zone);
        } else if (zone) {
            console.warn('[opssign-crp] zone given without a school id - CRP ' +
                'will ignore it and use the first zone. Add ?school=<id> to ' +
                'the slideId.');
        }

        console.log('[opssign-crp] seeded'
            + (token ? ' token' : '')
            + (zone && school ? ' zone=' + zone + ' school=' + school : ''));
    } catch (e) {
        // Never break the portal - worst case staff see the login screen.
        console.warn('[opssign-crp] could not seed:', e);
        return;
    }

    // Keep the values out of the visible URL, the DOM and any referrer.
    try {
        params.delete(TOKEN_PARAM);
        params.delete(ZONE_PARAM);
        params.delete(SCHOOL_PARAM);
        var qs = params.toString();
        history.replaceState(null, '',
            location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) { /* cosmetic only */ }
})();
