// Athletic Schedule Template JavaScript
// This runs when the schedule-rotation template is loaded

(function() {
    'use strict';
    
    console.log('Schedule script loading...');
    
    // Wait for deviceConfig to be available
    function waitForConfig(callback) {
        if (window.deviceConfig) {
            callback();
        } else {
            setTimeout(function() { waitForConfig(callback); }, 100);
        }
    }
    
    waitForConfig(function() {
        console.log('Device config available, initializing schedule...');
        
        const CONFIG = {
            deviceId: window.deviceConfig.deviceId,
            slideId: window.deviceConfig.slideId || '',
            enableRotation: true,
            scheduleDisplayTime: 30000,
            slidesDisplayTime: parseInt(window.deviceConfig.presentationDuration || 180) * 1000,
            scheduleRefreshInterval: 15 * 60 * 1000,
            alertCheckInterval: 5 * 60 * 1000,
            scrollSpeed: parseFloat(window.deviceConfig.scrollSpeed || 1.0),
            autoScroll: window.deviceConfig.autoScroll === true || window.deviceConfig.autoScroll === 'TRUE'
        };

        let currentView = 'schedule';
        let rotationTimer = null;
        let elements = {};

        // Fetch schedule from API
        async function fetchSchedule() {
            try {
                console.log('📅 Fetching schedule from API...');
                const response = await fetch('/api/schedule/upcoming?limit=20');
                const data = await response.json();
                
                if (!data.success) {
                    throw new Error(data.error || 'Failed to fetch schedule');
                }
                
                console.log('✅ Loaded ' + data.events.length + ' upcoming events');
                return data.events;
            } catch (error) {
                console.error('❌ Error fetching schedule:', error);
                throw error;
            }
        }

        // Group events by date, then by time
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

        // Escape HTML
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Render schedule HTML - smart fitting to screen
        function renderSchedule(events) {
            if (!events || events.length === 0) {
                elements.eventsList.innerHTML = '<div class="no-events">No upcoming events scheduled</div>';
                return;
            }
            
            const grouped = groupEventsByDateTime(events);
            const dates = Object.keys(grouped);
            
            // Clear container and render ALL days first
            elements.eventsList.innerHTML = '';
            
            dates.forEach(function(date) {
                const dayDiv = document.createElement('div');
                dayDiv.className = 'event-group';
                dayDiv.setAttribute('data-date', date);
                
                let dayHtml = '<div class="date-header">' + date + '</div>';
                
                const timeGroups = grouped[date];
                Object.keys(timeGroups).forEach(function(time) {
                    dayHtml += '<div class="time-group">';
                    dayHtml += '<div class="time-box">' + time + '</div>';
                    dayHtml += '<div class="events-at-time">';
                    
                    timeGroups[time].forEach(function(event) {
                        const fullTitle = typeof event.title === 'object' ? event.title.val : event.title;
                        const vsMatch = fullTitle.match(/^(.+?)\s+(vs|@)\s+(.+)$/);
                        const sport = vsMatch ? vsMatch[1] : fullTitle;
                        const indicator = vsMatch ? vsMatch[2] : '';
                        const opponent = vsMatch ? vsMatch[3] : '';
                        
                        let locationDisplay = '';
                        if (event.location) {
                            const siteMatch = event.description ? event.description.match(/Site:\s*(.+?)(?:\n|$)/) : null;
                            const subsiteMatch = event.description ? event.description.match(/Subsite:\s*(.+?)(?:\n|$)/) : null;
                            const siteName = siteMatch ? siteMatch[1].trim() : '';
                            const subsite = subsiteMatch ? subsiteMatch[1].trim() : '';
                            
                            let parts = [];
                            if (siteName) parts.push(siteName);
                            if (subsite && subsite !== siteName) parts.push(subsite);
                            
                            locationDisplay = parts.join(', ') || event.location.trim();
                        }
                        
                        dayHtml += '<div class="event-card">';
                        dayHtml += '<div class="event-title">' + escapeHtml(sport) + '</div>';
                        if (opponent) {
                            dayHtml += '<div class="event-opponent">' + escapeHtml(indicator + ' ' + opponent) + '</div>';
                        }
                        if (locationDisplay) {
                            dayHtml += '<div class="event-location">' + escapeHtml(locationDisplay) + '</div>';
                        }
                        if (event.location) {
                            dayHtml += '<div class="event-address">' + escapeHtml(event.location.trim()) + '</div>';
                        }
                        dayHtml += '</div>';
                    });
                    
                    dayHtml += '</div></div>';
                });
                
                dayDiv.innerHTML = dayHtml;
                elements.eventsList.appendChild(dayDiv);
            });
            
            // Remove days from bottom until everything fits in VISIBLE area
            setTimeout(function() {
                const container = elements.scheduleContent.querySelector('.schedule-content');
                const allDays = Array.from(elements.eventsList.querySelectorAll('.event-group'));
                
                // Get the actual visible height (viewport minus header and footer)
                const header = document.querySelector('.schedule-header');
                const infoBar = document.getElementById('info-bar');
                const headerHeight = header ? header.offsetHeight : 0;
                const infoBarHeight = infoBar ? infoBar.offsetHeight : 0;
                const visibleHeight = window.innerHeight - headerHeight - infoBarHeight;
                
                console.log('Visible height for schedule: ' + visibleHeight + 'px (window: ' + window.innerHeight + ', header: ' + headerHeight + ', infoBar: ' + infoBarHeight + ')');
                
                let removed = 0;
                while (allDays.length > 1) {
                    const contentHeight = elements.eventsList.scrollHeight;
                    const totalNeeded = contentHeight + 40; // Small buffer for padding
                    
                    if (totalNeeded <= visibleHeight + 20) { // Add 20px tolerance
                        break;
                    }
                    
                    const lastDay = allDays.pop();
                    elements.eventsList.removeChild(lastDay);
                    removed++;
                }
                
                console.log('📊 Final: showing ' + allDays.length + ' complete days (removed ' + removed + ' partial days)');
            }, 1000);
        }

        // Load schedule
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

        // Check if rotation should be enabled
        function shouldEnableRotation() {
            return CONFIG.enableRotation && CONFIG.slideId && CONFIG.slideId.trim() !== '';
        }

        // Switch between schedule and slides
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

        // Auto-scroll functionality
        let scrollAnimation = null;
        let isScrolling = false;

        function startAutoScroll() {
            if (!CONFIG.autoScroll) {
                console.log('📜 Auto-scroll is disabled');
                return;
            }
            
            const container = elements.scheduleContent.querySelector('.schedule-content');
            if (!container || isScrolling) return;
            
            stopAutoScroll();
            isScrolling = true;
            
            function doScroll() {
                if (!isScrolling) return;
                
                const scrollHeight = container.scrollHeight;
                const clientHeight = container.clientHeight;
                const maxScroll = scrollHeight - clientHeight;
                
                if (maxScroll <= 0) {
                    console.log('📜 Content fits on screen - no scrolling needed');
                    isScrolling = false;
                    return;
                }
                
                const pixelsPerSecond = 50 * CONFIG.scrollSpeed;
                const scrollDuration = (maxScroll / pixelsPerSecond) * 1000;
                
                console.log('📜 Starting scroll: ' + maxScroll + 'px over ' + (scrollDuration/1000) + 's at ' + CONFIG.scrollSpeed + 'x speed');
                
                let startTime = null;
                let startScroll = 0;
                
                function animate(currentTime) {
                    if (!isScrolling) return;
                    
                    if (!startTime) {
                        startTime = currentTime;
                        startScroll = container.scrollTop;
                    }
                    
                    const elapsed = currentTime - startTime;
                    const progress = Math.min(elapsed / scrollDuration, 1);
                    
                    container.scrollTop = startScroll + (maxScroll * progress);
                    
                    if (progress < 1) {
                        scrollAnimation = requestAnimationFrame(animate);
                    } else {
                        setTimeout(function() {
                            if (!isScrolling) return;
                            container.scrollTop = 0;
                            console.log('📜 Scroll complete - restarting from top');
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
            if (scrollAnimation) {
                cancelAnimationFrame(scrollAnimation);
                scrollAnimation = null;
            }
            const container = elements.scheduleContent ? elements.scheduleContent.querySelector('.schedule-content') : null;
            if (container) container.scrollTop = 0;
        }

        // Start rotation
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

        // Initialize
        function initialize() {
            console.log('🏀 Initializing athletic schedule display...');
            console.log('Device ID:', CONFIG.deviceId);
            console.log('Slide ID:', CONFIG.slideId);
            console.log('Rotation enabled:', shouldEnableRotation());
            console.log('Scroll speed:', CONFIG.scrollSpeed);
            
            // Query elements
            elements = {
                scheduleContainer: document.getElementById('scheduleContainer'),
                slideContainer: document.getElementById('slideContainer'),
                loadingState: document.getElementById('loadingState'),
                errorState: document.getElementById('errorState'),
                scheduleContent: document.getElementById('scheduleContent'),
                eventsList: document.getElementById('eventsList')
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

        // Wait for DOM and run
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize);
        } else {
            setTimeout(initialize, 100);
        }
    });
    
})();