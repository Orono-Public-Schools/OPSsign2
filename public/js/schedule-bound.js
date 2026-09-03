// Athletic Schedule Template JavaScript
// Bound iCal feed version — uses structured X-BND-* fields from server

(function() {
    'use strict';
    
    console.log('Schedule (Bound) script loading...');
    
    function waitForConfig(callback) {
        if (window.deviceConfig) {
            callback();
        } else {
            setTimeout(function() { waitForConfig(callback); }, 100);
        }
    }
    
    waitForConfig(function() {
        console.log('Device config available, initializing Bound schedule...');
        
        const CONFIG = {
            deviceId:               window.deviceConfig.deviceId,
            slideId:                window.deviceConfig.slideId || '',
            enableRotation:         true,
            scheduleDisplayTime:    30000,
            slidesDisplayTime:      parseInt(window.deviceConfig.presentationDuration || 180) * 1000,
            scheduleRefreshInterval: 15 * 60 * 1000,
            scrollSpeed:            parseFloat(window.deviceConfig.scrollSpeed || 1.0),
            autoScroll:             window.deviceConfig.autoScroll === true || window.deviceConfig.autoScroll === 'TRUE'
        };

        let currentView = 'schedule';
        let rotationTimer = null;
        let elements = {};

        // ── Bound endpoint ──────────────────────────────────────────
        async function fetchSchedule() {
            try {
                console.log('📅 Fetching Bound schedule from API...');
                const response = await fetch('/api/schedule/bound/upcoming?days=120');
                const data = await response.json();
                if (!data.success) throw new Error(data.error || 'Failed to fetch schedule');
                console.log('✅ Loaded ' + data.events.length + ' upcoming events');
                return data.events;
            } catch (error) {
                console.error('❌ Error fetching schedule:', error);
                throw error;
            }
        }

        function groupEventsByDateTime(events) {
            const dateGroups = {};
            events.forEach(function(event) {
                const date = event.dateDisplay;
                if (!dateGroups[date]) dateGroups[date] = {};
                const time = event.timeDisplay;
                if (!dateGroups[date][time]) dateGroups[date][time] = [];
                dateGroups[date][time].push(event);
            });
            return dateGroups;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ── CHANGED: Renders using structured Bound fields ───────────────────
        function renderSchedule(events) {
            if (!events || events.length === 0) {
                elements.eventsList.innerHTML = '<div class="no-events">No upcoming events scheduled</div>';
                return;
            }

            const grouped = groupEventsByDateTime(events);
            const dates = Object.keys(grouped);

            elements.eventsList.innerHTML = '';

            dates.forEach(function(date) {
                const dayDiv = document.createElement('div');
                dayDiv.className = 'event-group';
                dayDiv.setAttribute('data-date', date);

                let dayHtml = '<div class="date-header">' + escapeHtml(date) + '</div>';

                const timeGroups = grouped[date];
                Object.keys(timeGroups).forEach(function(time) {
                    dayHtml += '<div class="time-group">';
                    dayHtml += '<div class="time-box">' + escapeHtml(time) + '</div>';
                    dayHtml += '<div class="events-at-time">';

                    timeGroups[time].forEach(function(event) {
                        // Sport title line: e.g. "Boys Lacrosse" or "Girls Golf"
                        const sportTitle = [event.gender, event.sport]
                            .filter(Boolean).join(' ');

                        // Level badge: "Varsity", "Junior Varsity", etc.
                        const levelBadge = event.level
                            ? '<span class="event-level">' + escapeHtml(event.level) + '</span>'
                            : '';

                        // Matchup line
                        let matchupHtml = '';
                        if (event.isInvitational) {
                            // e.g. "Burl Oaks Invitational"
                            matchupHtml = '<div class="event-opponent">' +
                                escapeHtml(event.opponent) + '</div>';
                        } else if (event.opponent) {
                            const indicator = event.homeAway === 'home' ? 'vs' : 'at';
                            matchupHtml = '<div class="event-opponent">' +
                                escapeHtml(indicator + ' ' + event.opponent) + '</div>';
                        }

                        // Location line — always clean from Bound
                        const locationHtml = event.location
                            ? '<div class="event-location">' + escapeHtml(event.location) + '</div>'
                            : '';

                       const cardClass = event.homeAway === 'home' ? 'home' : 'away';
                        dayHtml += '<div class="event-card ' + cardClass + '">';
                        dayHtml += '<div class="event-title">' + escapeHtml(sportTitle) + levelBadge + '</div>';
                        dayHtml += matchupHtml;
                        dayHtml += locationHtml;
                        dayHtml += '</div>';
                    });

                    dayHtml += '</div></div>';
                });

                dayDiv.innerHTML = dayHtml;
                elements.eventsList.appendChild(dayDiv);
            });
        }

        // ── Everything below is identical to schedule-template.js ────────────

        async function loadSchedule() {
            try {
                elements.loadingState.style.display = 'flex';
                elements.errorState.classList.remove('active');
                elements.errorState.style.display = 'none';
                elements.scheduleContent.style.display = 'none';

                const events = await fetchSchedule();
                renderSchedule(events);

                elements.loadingState.style.display = 'none';
                elements.scheduleContent.style.display = 'flex';

                if (currentView === 'schedule') {
                    setTimeout(startAutoScroll, 500);
                }
            } catch (error) {
                console.error('Failed to load schedule:', error);
                elements.loadingState.style.display = 'none';
                elements.errorState.style.display = 'flex';
                elements.errorState.classList.add('active');
            }
        }

        function shouldEnableRotation() {
            return CONFIG.enableRotation && CONFIG.slideId && CONFIG.slideId.trim() !== '';
        }

        function switchView(view) {
            console.log('🔄 Switching to view: ' + view);
            currentView = view;
            if (view === 'schedule') {
                elements.scheduleContainer.classList.add('active');
                elements.slideContainer.classList.add('hidden');
                startAutoScroll();
            } else {
                elements.scheduleContainer.classList.remove('active');
                elements.slideContainer.classList.remove('hidden');
                stopAutoScroll();
            }
        }

        let scrollAnimation = null;
        let isScrolling = false;

        function startAutoScroll() {
            if (!CONFIG.autoScroll) return;
            const container = elements.scheduleContent.querySelector('.schedule-content');
            if (!container || isScrolling) return;
            stopAutoScroll();
            isScrolling = true;

            function doScroll() {
                if (!isScrolling) return;
                const maxScroll = container.scrollHeight - container.clientHeight;
                if (maxScroll <= 0) { isScrolling = false; return; }

                const pixelsPerSecond = 50 * CONFIG.scrollSpeed;
                const scrollDuration  = (maxScroll / pixelsPerSecond) * 1000;
                let startTime = null;

                function animate(currentTime) {
                    if (!isScrolling) return;
                    if (!startTime) { startTime = currentTime; }
                    const progress = Math.min((currentTime - startTime) / scrollDuration, 1);
                    container.scrollTop = maxScroll * progress;
                    if (progress < 1) {
                        scrollAnimation = requestAnimationFrame(animate);
                    } else {
                        setTimeout(function() {
                            if (!isScrolling) return;
                            container.scrollTop = 0;
                            scrollAnimation = null;
                            doScroll();
                        }, 1000);
                    }
                }
                scrollAnimation = requestAnimationFrame(animate);
            }
            setTimeout(doScroll, 1000);
        }

        function stopAutoScroll() {
            isScrolling = false;
            if (scrollAnimation) { cancelAnimationFrame(scrollAnimation); scrollAnimation = null; }
            const container = elements.scheduleContent
                ? elements.scheduleContent.querySelector('.schedule-content') : null;
            if (container) container.scrollTop = 0;
        }

        function startRotation() {
            if (!shouldEnableRotation()) {
                console.log('📅 Rotation disabled - showing schedule only');
                switchView('schedule');
                return;
            }
            console.log('🔄 Starting rotation between schedule and slides');
            function rotate() {
                if (currentView === 'schedule') {
                    switchView('slides');
                    rotationTimer = setTimeout(rotate, CONFIG.slidesDisplayTime);
                } else {
                    switchView('schedule');
                    rotationTimer = setTimeout(rotate, CONFIG.scheduleDisplayTime);
                }
            }
            switchView('schedule');
            rotationTimer = setTimeout(rotate, CONFIG.scheduleDisplayTime);
        }

        function initialize() {
            console.log('🏀 Initializing Bound athletic schedule display...');
            elements = {
                scheduleContainer: document.getElementById('scheduleContainer'),
                slideContainer:    document.getElementById('slideContainer'),
                loadingState:      document.getElementById('loadingState'),
                errorState:        document.getElementById('errorState'),
                scheduleContent:   document.getElementById('scheduleContent'),
                eventsList:        document.getElementById('eventsList')
            };
            if (!elements.scheduleContainer) {
                console.error('Schedule container not found!');
                return;
            }
            loadSchedule().then(function() {
                startRotation();
                setInterval(loadSchedule, CONFIG.scheduleRefreshInterval);
                console.log('✅ Initialization complete');
            }).catch(function(error) {
                console.error('Initialization failed:', error);
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize);
        } else {
            setTimeout(initialize, 100);
        }
    });
    
})();