// ==============================================
// SAFE localStorage HELPERS
// ==============================================
const LS = {
    get: function(key, fallback = null) {
        try { return localStorage.getItem(key); } catch (e) { return fallback; }
    },
    set: function(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (e) {
            console.warn('localStorage write failed for key "' + key + '":', e);
            return false;
        }
    },
    remove: function(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }
};

// ==============================================
// HISTORY API MANAGER
// ==============================================
const HistoryManager = {
    /** @type {Array<{id: string, name: string}>} */
    _stack: [],

    /** Maximum stack depth to prevent excessive history entries */
    _MAX_DEPTH: 20,

    /** Whether we're currently handling a popstate event (to avoid double-triggering close logic) */
    _handlingPopState: false,

    init: function() {
        window.addEventListener('popstate', this._onPopState.bind(this));
        // Push initial state so the first back press goes back to this state
        history.replaceState({ id: '__root__', name: 'root' }, '');
        this._stack = [{ id: '__root__', name: 'root' }];
    },

    /**
     * Open a view/overlay. Pushes a history state.
     * @param {string} id - Unique identifier for the view (e.g. 'preview', 'result', 'custom-plan', 'changelog', 'timer')
     * @param {string} [name] - Display name for the state
     * @param {Function} [onPopCallback] - Function to call when this state is popped (back navigation). If not provided, will try to find a close function automatically.
     */
    open: function(id, name, onPopCallback) {
        if (this._stack.length >= this._MAX_DEPTH) {
            // Prevent stack from growing too large - replace the deepest non-root entry
            var deepestIdx = this._stack.findIndex(function(s) { return s.id !== '__root__'; });
            if (deepestIdx > 0) {
                var removed = this._stack.splice(deepestIdx, 1);
                // We can't truly remove a history entry, but we can replace the last one
                // This is a best-effort approach
            }
        }

        var state = { id: id, name: name || id, onPopCallback: onPopCallback ? onPopCallback.toString() : null };
        history.pushState(state, '');
        this._stack.push({ id: id, name: name || id, onPopCallback: onPopCallback || null });
    },

    /**
     * Close the current view (called from close/back buttons).
     * Pops the last history state so the back button doesn't try to close again.
     */
    close: function() {
        if (this._stack.length <= 1) return; // Don't pop root
        var popped = this._stack.pop();
        // Go back in history to 'undo' the pushState
        if (history.state && history.state.id === popped.id) {
            this._handlingPopState = true;
            history.back();
            // Reset flag after a short delay
            var self = this;
            setTimeout(function() { self._handlingPopState = false; }, 100);
        }
    },

    /**
     * Called when a user presses the back button / back swipe.
     * Finds the last open view and closes it.
     */
    _onPopState: function(e) {
        if (this._handlingPopState) {
            this._handlingPopState = false;
            return;
        }

        // We need to close the topmost view in our stack
        if (this._stack.length <= 1) return; // Nothing to close beyond root

        var currentState = e.state;
        var popped = this._stack.pop();

        // Determine what to close based on the popped state id
        var viewId = (currentState && currentState.id) || (popped && popped.id);

        // If we have a stored callback, try to execute it
        if (popped && popped.onPopCallback) {
            try {
                // Use setTimeout to let the popstate finish cleanly first
                var callback = popped.onPopCallback;
                setTimeout(function() { callback(); }, 0);
                return;
            } catch (err) {
                console.warn('HistoryManager: onPopCallback error', err);
            }
        }

        // Fallback: auto-detect and close the appropriate view
        if (this._isViewVisible('timer-display')) {
            this._closeView('timer-display');
        } else if (this._isViewVisible('preview-overlay')) {
            this._closeView('preview-overlay');
        } else if (this._isViewVisible('result-screen')) {
            this._closeView('result-screen');
        } else if (this._isViewVisible('custom-plan-sheet')) {
            this._closeView('custom-plan-sheet');
        } else if (document.getElementById('changelog-overlay')) {
            this._closeView('changelog-overlay');
        }
    },

    /** Check if a view element is currently visible */
    _isViewVisible: function(elId) {
        var el = document.getElementById(elId);
        if (!el) return false;
        var style = window.getComputedStyle(el);
        // Some overlays use display: none/flex (e.g. preview-overlay), others use .active class (e.g. result-screen, custom-plan-sheet)
        var isVisibleByDisplay = style.display !== 'none';
        var isVisibleByClass = el.classList.contains('active');
        return isVisibleByDisplay || isVisibleByClass;
    },

    /** Close a view by its element ID */
    _closeView: function(elId) {
        var el = document.getElementById(elId);
        if (!el) return;
        switch (elId) {
            case 'preview-overlay':
                el.style.display = 'none';
                break;
            case 'result-screen':
                UI.closeResultScreen(false);
                break;
            case 'custom-plan-sheet':
                UI.closeCustomPlanSheet({ stopPropagation: function() {} });
                break;
            case 'timer-display':
                APP.finishTraining();
                break;
            case 'changelog-overlay':
                var overlay = document.getElementById('changelog-overlay');
                if (overlay) overlay.remove();
                break;
            default:
                el.style.display = 'none';
        }
    }
};

// ==============================================
// DATA MODEL (DB)
// ==============================================
const DB = {
    _db: null,
    _DB_NAME: 'JellyLegsDB',
    _DB_VERSION: 1,

    init: function(callback) {
        const request = indexedDB.open(this._DB_NAME, this._DB_VERSION);
        request.onupgradeneeded = (e) => {
            this._db = e.target.result;
            if (!this._db.objectStoreNames.contains('runs'))
                this._db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
        };
        request.onsuccess = (e) => {
            this._db = e.target.result;
            this._migrateData();
            if (callback) callback();
        };
        request.onerror = (e) => {
            console.error('IndexedDB fout:', e.target.error);
        };
    },

    _migrateData: function() {
        try {
            const oldData = LS.get('strive_ult_h');
            if (oldData) {
                const runs = JSON.parse(oldData);
                if (Array.isArray(runs)) {
                    const tx = this._db.transaction('runs', 'readwrite');
                    runs.forEach(run => tx.objectStore('runs').add(run));
                    tx.oncomplete = () => LS.remove('strive_ult_h');
                }
            }
        } catch (e) {}
    },

    getAll: function(callback) {
        const tx = this._db.transaction('runs', 'readonly');
        const req = tx.objectStore('runs').getAll();
        req.onsuccess = () => callback(req.result);
    },

    get: function(id, callback) {
        const tx = this._db.transaction('runs', 'readonly');
        const req = tx.objectStore('runs').get(id);
        req.onsuccess = () => callback(req.result);
    },

    add: function(run, callback) {
        const tx = this._db.transaction('runs', 'readwrite');
        tx.objectStore('runs').add(run);
        tx.oncomplete = () => { if (callback) callback(); };
    },

    delete: function(e, id) {
        e.stopPropagation();
        if (confirm('Wissen?')) {
            const tx = this._db.transaction('runs', 'readwrite');
            tx.objectStore('runs').delete(id);
            tx.oncomplete = () => APP.init();
        }
    },

    clearAllHistory: function() {
        if (confirm('Alles wissen?')) {
            const tx = this._db.transaction('runs', 'readwrite');
            tx.objectStore('runs').clear();
            tx.oncomplete = () => APP.init();
        }
    },

    saveUserProfile: function() {
        var w = parseInt(document.getElementById('user-weight').value);
        var h = parseInt(document.getElementById('user-height').value);
        var a = parseInt(document.getElementById('user-age').value);

        // Valideer en corrigeer waarden
        if (isNaN(w) || w < 30) w = 30;
        if (w > 200) w = 200;
        if (isNaN(h) || h < 100) h = 100;
        if (h > 220) h = 220;
        if (isNaN(a) || a < 12) a = 12;
        if (a > 99) a = 99;

        document.getElementById('user-weight').value = w;
        document.getElementById('user-height').value = h;
        document.getElementById('user-age').value = a;

        LS.set('user_weight', w.toString());
        LS.set('user_height', h.toString());
        LS.set('user_age', a.toString());
        LS.set('user_gender', document.getElementById('user-gender').value);
        APP.vibrate([50]);
        const fb = document.getElementById('save-feedback');
        fb.style.opacity = '1';
        setTimeout(() => { fb.style.opacity = '0'; }, 1700);
    },

    saveOnboardingProfile: function() {
        document.getElementById('user-weight').value = document.getElementById('ob-weight').value;
        document.getElementById('user-height').value = document.getElementById('ob-height').value;
        document.getElementById('user-age').value = document.getElementById('ob-age').value;
        document.getElementById('user-gender').value = document.getElementById('ob-gender').value;
        this.saveUserProfile();
        LS.set('onboarding_complete', 'true');
    },

    updateWarmupCoolDown: function() {
        const w = parseInt(document.getElementById('warmup-time').value);
        const c = parseInt(document.getElementById('cooldown-time').value);
        document.getElementById('warmup-val').innerText = w;
        document.getElementById('cooldown-val').innerText = c;
        LS.set('warmup_time', w.toString());
        LS.set('cooldown_time', c.toString());
    },

    getCustomPlan: function() {
        const json = LS.get('jellylegs_custom_plan');
        return json ? JSON.parse(json) : null;
    },

    getDynamicPlan: function() {
        const json = LS.get('jellylegs_dynamic_plan');
        return json ? JSON.parse(json) : null;
    },

    saveDynamicPlan: function(plan) {
        LS.set('jellylegs_dynamic_plan', JSON.stringify(plan));
    },

    clearDynamicPlan: function() {
        LS.remove('jellylegs_dynamic_plan');
    },

    processWeeklyData: function(runs) {
        const weeks = {};
        runs.forEach(run => {
            const parts = run.d.split(/[.-]/);
            const d = new Date(parts[2], parts[1] - 1, parts[0]);
            const day = d.getDay() || 7;
            const monday = new Date(d);
            monday.setDate(d.getDate() - day + 1);
            monday.setHours(0, 0, 0, 0);
            const key = monday.getTime();
            if (!weeks[key]) {
                weeks[key] = { monday, label: 'Week van ' + monday.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }), shortLabel: monday.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }), totalDist: 0, totalTime: 0, runs: [] };
            }
            weeks[key].totalDist += parseFloat(run.dist) || 0;
            weeks[key].totalTime += parseInt(run.duration) || 0;
            weeks[key].runs.push(run);
        });
        return Object.values(weeks).sort((a, b) => b.monday - a.monday);
    }
};

// ==============================================
// UI CONTROLLER
// ==============================================
const UI = {
    mapInstance: null,
    liveMapInstance: null,
    livePolyline: null,
    paceChartObj: null,
    weeklyVolumeChartObj: null,
    paceTrendChartObj: null,
    liveMapEnabled: LS.get('live_map_enabled') === 'true',

    applyTheme: function(isLight) {
        document.body.classList.toggle('light-mode', isLight);
        var sw = document.getElementById('theme-toggle-switch');
        if (sw) sw.classList.toggle('active', !isLight);
        LS.set('strive_theme', isLight ? 'light' : 'dark');
        document.querySelector('meta[name="theme-color"]').setAttribute('content', isLight ? '#f2f2f7' : '#1c1c1e');
    },

    toggleTheme: function() {
        var isLight = !document.body.classList.contains('light-mode');
        this.applyTheme(isLight);
        APP.vibrate([50]);
    },

    toggleLiveMap: function() {
        this.liveMapEnabled = !this.liveMapEnabled;
        LS.set('live_map_enabled', this.liveMapEnabled.toString());
        document.getElementById('live-map-toggle').classList.toggle('active', this.liveMapEnabled);
        APP.vibrate([50]);
    },

    openTab: function(tabName, element) {
        const fn = () => {
            document.querySelectorAll('.tab-view').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById('tab-' + tabName).classList.add('active');
            element.classList.add('active');
            APP.vibrate([30]);
            // When opening training tab, refresh the dynamic plan view
            if (tabName === 'training') APP.refreshPlanDisplay();
        };
        if ('startViewTransition' in document) document.startViewTransition(fn);
        else fn();
    },

    nextOnboardingStep: function() {
        document.getElementById('onboard-step-1').classList.remove('active');
        document.getElementById('onboard-step-2').classList.add('active');
    },

    openCustomPlanSheet: function() {
        document.getElementById('custom-plan-sheet').classList.add('active');
        HistoryManager.open('custom-plan', 'Custom Plan', function() {
            document.getElementById('custom-plan-sheet').classList.remove('active');
        });
    },
    closeCustomPlanSheet: function(e) {
        if (e) e.stopPropagation();
        document.getElementById('custom-plan-sheet').classList.remove('active');
        HistoryManager.close();
    },

    openResultScreen: function() {
        document.getElementById('result-screen').classList.add('active');
        // Update the button based on whether this is a history run or freshly finished session
        var btn = document.getElementById('res-btn');
        if (STATE._viewingHistoryRun) {
            btn.innerText = 'SLUITEN';
            btn.onclick = function() { UI.closeResultScreen(false); };
        } else {
            btn.innerText = 'OPSLAAN IN LOGBOEK';
            btn.onclick = function() { UI.closeResultScreen(true); };
        }
        HistoryManager.open('result', 'Result', function() {
            document.getElementById('result-screen').classList.remove('active');
        });
    },
    closeResultScreen: function(reload) {
        document.getElementById('result-screen').classList.remove('active');
        // Reset the history-run flag when closing
        if (STATE._viewingHistoryRun) {
            STATE._viewingHistoryRun = false;
        }
        HistoryManager.close();
        if (reload) setTimeout(() => location.reload(), 400);
    },

    _recentActivityMap: null,
    _recentActivityPolyline: null,

    _recentRunId: null,

    renderRecentActivity: function(runs) {
        var sorted = runs.slice().sort(function(a, b) { return b.id - a.id; });
        var dateEl = document.getElementById('recent-activity-date');
        var distEl = document.getElementById('recent-activity-distance');
        var timeEl = document.getElementById('recent-activity-time');
        var paceEl = document.getElementById('recent-activity-pace');
        var mapEl = document.getElementById('recent-activity-map');
        var cardEl = document.getElementById('recent-activity-card');

        // Make card clickable to view the latest run
        if (cardEl) {
            cardEl.style.cursor = 'pointer';
            cardEl.onclick = null;
        }

        if (sorted.length > 0) {
            var latest = sorted[0];
            this._recentRunId = latest.id;
            dateEl.innerText = latest.d;
            distEl.innerText = latest.dist + ' KM';
            var dur = parseInt(latest.duration) || 0;
            timeEl.innerText = 'Tijd ' + APP.formatT(dur);
            var pace = parseFloat(latest.pace);
            if (pace > 0) {
                var paceMin = Math.floor(pace);
                var paceSec = Math.round((pace - paceMin) * 60);
                paceEl.innerText = 'Tempo ' + paceMin + ':' + paceSec.toString().padStart(2, '0') + ' min/km';
            } else {
                paceEl.innerText = 'Tempo --:-- min/km';
            }
            if (latest.route && latest.route.length >= 2) {
                this._renderMiniMap(mapEl, latest.route);
            } else {
                this._destroyMiniMap();
                mapEl.innerHTML = '<div class="map-mini-route"></div>';
            }
            // Click on the card to view the latest run
            if (cardEl) {
                cardEl.onclick = function(e) {
                    // Don't trigger if clicking the map (Leaflet handles its own clicks)
                    if (e.target.closest('.leaflet-container')) return;
                    APP.viewRun(UI._recentRunId);
                };
            }
        } else {
            this._recentRunId = null;
            this._destroyMiniMap();
            // Show a simple message when there are no activities yet
            mapEl.style.display = 'none';
            dateEl.style.display = 'none';
            distEl.innerText = 'Nog geen recente activiteiten';
            distEl.style.fontSize = '13px';
            distEl.style.fontWeight = '600';
            distEl.style.color = 'var(--text-muted)';
            timeEl.innerText = '';
            paceEl.innerText = '';
        }
    },

    _destroyMiniMap: function() {
        if (this._recentActivityMap) {
            this._recentActivityMap.remove();
            this._recentActivityMap = null;
            this._recentActivityPolyline = null;
        }
    },

    _renderMiniMap: function(container, route) {
        this._destroyMiniMap();
        container.innerHTML = '';

        var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        route.forEach(function(p) {
            if (p[0] < minLat) minLat = p[0];
            if (p[0] > maxLat) maxLat = p[0];
            if (p[1] < minLng) minLng = p[1];
            if (p[1] > maxLng) maxLng = p[1];
        });
        var pad = 0.0004;
        if (maxLat - minLat < 0.0005) { minLat -= pad; maxLat += pad; }
        if (maxLng - minLng < 0.0005) { minLng -= pad; maxLng += pad; }

        var map = L.map(container, {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            scrollWheelZoom: false,
            touchZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            fadeAnimation: false,
            zoomAnimation: false,
            markerZoomAnimation: false
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            zoomControl: false,
            attributionControl: false
        }).addTo(map);

        var latLngs = route.map(function(p) { return [p[0], p[1]]; });
        var polyline = L.polyline(latLngs, { color: '#ff6b00', weight: 4, opacity: 0.8 }).addTo(map);

        var bounds = L.latLngBounds(latLngs);
        if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [10, 10], maxZoom: 17 });
        }

        this._recentActivityMap = map;
        this._recentActivityPolyline = polyline;

        // Force correct sizing after a short delay (Leaflet needs this inside hidden containers)
        setTimeout(function() {
            map.invalidateSize();
        }, 100);
    },

    renderDashboard: function(runs) {
        document.getElementById('dash-total').innerText = runs.reduce((a, b) => a + parseFloat(b.dist), 0).toFixed(1);
        const vp = runs.map(r => parseFloat(r.pace)).filter(p => p > 0);
        if (vp.length > 0) {
            const best = Math.min(...vp);
            document.getElementById('dash-pb').innerText = Math.floor(best) + ':' + Math.round((best - Math.floor(best)) * 60).toString().padStart(2, '0');
        } else document.getElementById('dash-pb').innerText = '--';
        
        var pr1 = APP.calcPRForDistance(runs, 1);
        var pr3 = APP.calcPRForDistance(runs, 3);
        var pr5 = APP.calcPRForDistance(runs, 5);
        document.getElementById('pr-1k').innerText = pr1.paceStr;
        document.getElementById('pr-1k-time').innerText = pr1.timeStr;
        document.getElementById('pr-3k').innerText = pr3.paceStr;
        document.getElementById('pr-3k-time').innerText = pr3.timeStr;
        document.getElementById('pr-5k').innerText = pr5.paceStr;
        document.getElementById('pr-5k-time').innerText = pr5.timeStr;
        
        const streak = APP.calculateStreak(runs);
        const sc = document.getElementById('streak-container');
        if (streak > 0) { sc.style.display = 'inline-flex'; document.getElementById('dash-streak').innerText = streak; }
        else sc.style.display = 'none';
    },

    renderDataTab: function(runs) {
        const wd = DB.processWeeklyData(runs);
        const tc = document.getElementById('data-timeline');
        if (wd.length === 0) {
            tc.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px">Voer eerst een training uit.</div>';
            document.getElementById('weekly-comparison').innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px">Nog geen data.</div>';
            return;
        }

        const cd = wd.slice(0, 12).reverse();
        const ctx = document.getElementById('weeklyVolumeChart').getContext('2d');
        if (this.weeklyVolumeChartObj) this.weeklyVolumeChartObj.destroy();
        this.weeklyVolumeChartObj = new Chart(ctx, {
            type: 'bar',
            data: { labels: cd.map(w => w.shortLabel), datasets: [{ data: cd.map(w => parseFloat(w.totalDist.toFixed(1))), backgroundColor: '#ff6b00', borderRadius: 6 }] },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, grid:{color:'rgba(120,120,120,0.08)'} }, x: { grid: { display: false } } }, plugins: { legend: { display: false } } }
        });

        const sr = runs.slice().sort((a, b) => { const pa = a.d.split(/[.-]/), pb = b.d.split(/[.-]/); return new Date(pa[2], pa[1] - 1, pa[0]) - new Date(pb[2], pb[1] - 1, pb[0]); });
        const pl = [], pv = [], pav = [];
        sr.forEach(r => {
            const pace = parseFloat(r.pace);
            if (pace > 0) {
                const parts = r.d.split(/[.-]/);
                pl.push(new Date(parts[2], parts[1] - 1, parts[0]).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }));
                pv.push(pace);
                const win = pv.slice(Math.max(0, pv.length - 3));
                pav.push(parseFloat((win.reduce((a, b) => a + b, 0) / win.length).toFixed(2)));
            }
        });
        const pCtx = document.getElementById('paceTrendChart').getContext('2d');
        if (this.paceTrendChartObj) this.paceTrendChartObj.destroy();
        if (pv.length >= 2) {
            this.paceTrendChartObj = new Chart(pCtx, {
                type: 'line',
                data: { labels: pl, datasets: [ { label: 'Gem. Pace', data: pv, borderColor: '#0a84ff', backgroundColor: 'rgba(10,132,255,0.08)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3 }, { label: 'Trend', data: pav, borderColor: '#ff6b00', borderWidth: 2, borderDash: [5, 5], pointRadius: 0, fill: false, tension: 0.4 } ] },
                options: { responsive: true, maintainAspectRatio: false, scales: { y: { reverse: true, grid:{color:'rgba(120,120,120,0.08)'} }, x: { grid: { display: false } } }, plugins: { legend: { display: false } } }
            });
        }

        const comp = document.getElementById('weekly-comparison');
        if (wd.length >= 2) {
            const tw = wd[0], lw = wd[1];
            var calcPct = function(curr, prev) { if (prev === 0) return curr > 0 ? '+∞' : '0%'; var p = ((curr - prev) / prev) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; };
            comp.innerHTML = '<table style="width:100%; border-collapse: collapse; font-size: 13px;"><thead><tr style="color: var(--text-muted); font-size: 10px; text-transform: uppercase;"><th style="text-align:left; padding: 4px;"></th><th style="text-align:center; padding: 4px;">' + lw.shortLabel + '</th><th style="text-align:center; padding: 4px;">' + tw.shortLabel + '</th><th style="text-align:right; padding: 4px;">Δ</th></tr></thead><tbody>' +
                '<tr><td style="padding: 4px; font-weight:700;">Afstand</td><td style="text-align:center; color:var(--text-muted)">' + lw.totalDist.toFixed(1) + ' km</td><td style="text-align:center;">' + tw.totalDist.toFixed(1) + ' km</td><td style="text-align:right; font-weight:700; color:' + (tw.totalDist >= lw.totalDist ? 'var(--primary)' : 'var(--danger)') + '">' + calcPct(tw.totalDist, lw.totalDist) + '</td></tr>' +
                '<tr><td style="padding: 4px; font-weight:700;">Tijd</td><td style="text-align:center; color:var(--text-muted)">' + APP.formatT(lw.totalTime) + '</td><td style="text-align:center;">' + APP.formatT(tw.totalTime) + '</td><td style="text-align:right; font-weight:700; color:' + (tw.totalTime >= lw.totalTime ? 'var(--primary)' : 'var(--danger)') + '">' + calcPct(tw.totalTime, lw.totalTime) + '</td></tr>' +
                '</tbody></table>';
        }

        this._renderCalendarHeatmap(runs);

        var tl = '';
        wd.forEach(function(w) {
            tl += '<div style="margin-bottom:20px;"><div style="display:flex; justify-content:space-between; margin-bottom:6px; border-bottom:1px solid var(--border); padding-bottom:4px;"><span style="font-weight:900;">' + w.label + '</span><span style="color:var(--primary); font-size:12px; font-weight:700;">' + w.totalDist.toFixed(1) + ' KM</span></div>';
            w.runs.sort(function(a, b) { return b.id - a.id; }).forEach(function(r) {
                tl += '<div class="history-item" onclick="APP.viewRun(' + r.id + ')"><div style="flex-grow:1"><div style="font-weight:800; font-size:14px;">' + r.n + '</div><div style="font-size:11px; color:var(--text-muted)">' + r.d + ' &bull; ' + r.dist + 'km &bull; ' + APP.formatT(r.duration || 0) + '</div></div><button class="delete-btn" aria-label="Verwijder sessie" onclick="event.stopPropagation(); DB.delete(event, ' + r.id + ')">🗑️</button></div>';
            });
            tl += '</div>';
        });
        tc.innerHTML = tl;
    },

    _renderCalendarHeatmap: function(runs) {
        var hc = document.getElementById('calendar-heatmap');
        if (!hc) return;
        var dm = {}; runs.forEach(function(r) { dm[r.d] = (dm[r.d] || 0) + parseFloat(r.dist); });
        var maxD = Math.max.apply(null, Object.values(dm).concat([0.01]));
        var today = new Date(), dow = today.getDay() || 7;
        var lastMon = new Date(today); lastMon.setDate(today.getDate() - dow + 1); lastMon.setHours(0, 0, 0, 0);
        var html = '<div style="display:flex; gap: 3px; overflow-x: auto; padding-bottom: 4px;"><div style="display:flex; flex-direction:column; gap:3px; padding-right: 4px; justify-content: flex-start;">';
        ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'].forEach(function(d) { html += '<div style="font-size:9px; color:var(--text-muted); height:14px; display:flex; align-items:center; font-weight:700;">' + d + '</div>'; });
        html += '</div>';
        for (var w = 12; w >= 0; w--) {
            html += '<div style="display:flex; flex-direction:column; gap:3px;">';
            for (var d = 0; d < 7; d++) {
                var date = new Date(lastMon); date.setDate(lastMon.getDate() - (w * 7) + d);
                var ds = date.toLocaleDateString('nl-NL'); var dist = dm[ds] || 0;
                var color = dist === 0 ? 'rgba(120,120,120,0.08)' : dist < maxD * 0.25 ? 'rgba(255,107,0,0.25)' : dist < maxD * 0.5 ? 'rgba(255,107,0,0.5)' : dist < maxD * 0.75 ? 'rgba(255,107,0,0.75)' : '#ff6b00';
                html += '<div title="' + ds + ': ' + dist.toFixed(2) + ' km" style="width:14px; height:14px; border-radius:4px; background:' + color + '; cursor:pointer;"></div>';
            }
            html += '</div>';
        }
        html += '</div>';
        hc.innerHTML = html;
    },

    renderPlan: function(pk) {
        var list = document.getElementById('app-list');
        if (!list) return;
        list.innerHTML = '';
        var plan = pk ? STATE.schemas[pk] : null;
        if (!plan || !plan.weeks) return;
        
        plan.weeks.forEach(function(w, i) {
            var card = document.createElement('div'); card.className = 'card';
            card.innerHTML = '<span class="dash-label">Week ' + w.w + '</span>';
            Object.keys(w).filter(function(k) { return k.match(/^t\d+$/); }).sort().forEach(function(t) {
                var done = LS.get('done_' + pk + '_' + i + '_' + t) === 'true';
                var row = document.createElement('div');
                row.className = 'training-row' + (done ? ' is-done' : '');
                row.innerHTML = '<div style="display:flex; align-items:center; gap:10px"><div class="check-circle' + (done ? ' checked' : '') + '" onclick="APP.toggleManualComplete(\'' + pk + '\',' + i + ',\'' + t + '\')">' + (done ? '✓' : '') + '</div><div><div style="font-weight:700; font-size:14px;">' + w[t].label + '</div></div></div><button class="btn btn-primary" style="width:auto; padding: 8px 16px; font-size:11px;" onclick="UI.openPreview(\'' + pk + '\',' + i + ',\'' + t + '\')">START</button>';
                card.appendChild(row);
            });
            list.appendChild(card);
        });
    },

    renderDynamicPlan: function(plan) {
        var container = document.getElementById('plan-week-list');
        var display = document.getElementById('plan-display');
        var emptyState = document.getElementById('plan-empty-state');
        var generator = document.getElementById('plan-generator');
        
        if (!plan || !plan.weeks || plan.weeks.length === 0) {
            if (display) display.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
            if (generator) generator.style.display = 'block';
            return;
        }
        
        if (generator) generator.style.display = 'none';
        if (emptyState) emptyState.style.display = 'none';
        if (display) {
            display.style.display = 'block';
            document.getElementById('plan-name').innerText = plan.name;
        }
        
        container.innerHTML = '';
        plan.weeks.forEach(function(w, i) {
            var card = document.createElement('div'); card.className = 'card';
            var isTaper = (i === plan.weeks.length - 1) || ((i + 1) % 4 === 0);
            card.innerHTML = '<span class="dash-label" style="color:' + (isTaper ? 'var(--warning)' : 'var(--primary)') + ';">' + (isTaper ? '📉 ' : '') + 'Week ' + w.w + (isTaper ? ' (Taper)' : '') + '</span>';
            
            Object.keys(w).filter(function(k) { return k.match(/^t\d+$/); }).sort().forEach(function(t) {
                var done = LS.get('done_dynamic_' + i + '_' + t) === 'true';
                var row = document.createElement('div');
                row.className = 'training-row' + (done ? ' is-done' : '');
                row.innerHTML = '<div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;"><div class="check-circle' + (done ? ' checked' : '') + '" onclick="APP.toggleManualComplete(\'dynamic\',' + i + ',\'' + t + '\')">' + (done ? '✓' : '') + '</div><div style="min-width:0;"><div style="font-weight:700; font-size:14px;">' + w[t].label + '</div></div></div><button class="btn btn-primary" style="width:auto; padding: 8px 16px; font-size:11px; flex-shrink:0;" onclick="UI.openPreview(\'dynamic\',' + i + ',\'' + t + '\')">START</button>';
                card.appendChild(row);
            });
            container.appendChild(card);
        });
    },

    openPreview: function(plan, wIdx, type) {
        STATE.activePlanKey = plan;
        STATE.activeWeekIdx = wIdx;
        STATE.activeType = type;
        
        // Support both dynamic plans and old plan format
        var training;
        if (plan === 'dynamic') {
            var dp = DB.getDynamicPlan();
            if (dp && dp.weeks && dp.weeks[wIdx]) training = dp.weeks[wIdx][type];
        } else {
            if (STATE.schemas[plan] && STATE.schemas[plan].weeks && STATE.schemas[plan].weeks[wIdx])
                training = STATE.schemas[plan].weeks[wIdx][type];
        }
        
        if (!training) { APP.speak('Training niet gevonden'); return; }
        
        STATE.sessionBlocks = APP._translateSessionBlocks(APP.applyCustomTimings(training.b));
        document.getElementById('pre-title').innerText = training.label;
        document.getElementById('pre-time').innerText = Math.round(STATE.sessionBlocks.reduce(function(a, b) { return a + b.t; }, 0) / 60) + ' min';
        document.getElementById('pre-type').innerText = plan === 'dynamic' ? 'Dynamisch Plan' : (STATE.schemas[plan] ? STATE.schemas[plan].name : 'Plan');
        var maxT = Math.max.apply(null, STATE.sessionBlocks.map(function(b) { return b.t; }));
        document.getElementById('pre-chart').innerHTML = STATE.sessionBlocks.map(function(b) { return '<div class="bar ' + b.m + '" style="height:' + Math.max(15, (b.t / maxT) * 100) + '%"><span>' + Math.round(b.t / 60) + 'm</span></div>'; }).join('');
        document.getElementById('preview-overlay').style.display = 'flex';
        HistoryManager.open('preview', 'Training Preview', function() {
            document.getElementById('preview-overlay').style.display = 'none';
        });
    },

    initLiveMap: function() {
        if (!this.liveMapEnabled) return;
        var mapEl = document.getElementById('live-training-map');
        if (this.liveMapInstance) {
            // If already initialized, just invalidate size to handle layout changes
            var self = this;
            setTimeout(function() { if (self.liveMapInstance) self.liveMapInstance.invalidateSize(); }, 50);
            setTimeout(function() { if (self.liveMapInstance) self.liveMapInstance.invalidateSize(); }, 300);
            return;
        }
        mapEl.style.height = '160px';
        mapEl.style.width = '100%';
        // Use OpenStreetMap tiles for reliable rendering
        var tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
        this.liveMapInstance = L.map(mapEl, { zoomControl: false, attributionControl: false, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
        L.tileLayer(tileUrl, { zoomControl: false, attributionControl: false, maxZoom: 19 }).addTo(this.liveMapInstance);
        this.livePolyline = L.polyline([], { color: '#ff6b00', weight: 5 }).addTo(this.liveMapInstance);
        // Multiple invalidate calls with delays to ensure proper sizing after display changes from none to flex
        var self = this;
        setTimeout(function() { if (self.liveMapInstance) self.liveMapInstance.invalidateSize(); }, 100);
        setTimeout(function() { if (self.liveMapInstance) self.liveMapInstance.invalidateSize(); }, 500);
        setTimeout(function() { if (self.liveMapInstance) self.liveMapInstance.invalidateSize(); }, 1000);
    },

    updateLiveMap: function(route) {
        if (!this.liveMapEnabled || !this.liveMapInstance || !this.livePolyline) return;
        var latLngs = route.map(function(p) { return [p[0], p[1]]; });
        this.livePolyline.setLatLngs(latLngs);
        if (latLngs.length >= 2) { var b = this.livePolyline.getBounds(); if (b.isValid()) this.liveMapInstance.fitBounds(b, { padding: [30, 30], maxZoom: 16 }); }
        else if (latLngs.length === 1) this.liveMapInstance.setView(latLngs[0], 16);
    },

    renderResultMap: function(route) {
        if (this.mapInstance) this.mapInstance.remove();
        this.mapInstance = L.map('map', { zoomControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(this.mapInstance);
        if (!route || route.length === 0) { this.mapInstance.setView([52.1, 5.2], 14); return; }
        this.mapInstance.setView([route[0][0], route[0][1]], 14);
        if (route.length > 1) {
            var bounds = [];
            var hasPace = route[0].length >= 3;
            if (hasPace) {
                for (var i = 0; i < route.length - 1; i++) {
                    var p1 = route[i], p2 = route[i + 1];
                    var pace = p2[2] || p1[2] || 0;
                    var color;
                    if (pace === 0) color = 'var(--text-muted)';
                    else if (pace < 4.0) color = 'var(--danger)';
                    else if (pace < 6.5) color = 'var(--primary)';
                    else if (pace < 9.0) color = 'var(--success)';
                    else color = 'var(--warning)';
                    L.polyline([[p1[0], p1[1]], [p2[0], p2[1]]], { color: color, weight: 5, lineCap: 'round' }).addTo(this.mapInstance);
                }
            } else L.polyline(route, { color: '#ff6b00', weight: 4 }).addTo(this.mapInstance);
            route.forEach(function(p) { bounds.push([p[0], p[1]]); });
            this.mapInstance.fitBounds(L.latLngBounds(bounds), { padding: [20, 20] });
        }
    },

    renderPaceChart: function(data) {
        var ctx = document.getElementById('paceChart').getContext('2d');
        if (this.paceChartObj) this.paceChartObj.destroy();
        if (!data || data.length === 0) { ctx.canvas.parentElement.parentElement.style.display = 'none'; return; }
        ctx.canvas.parentElement.parentElement.style.display = '';
        this.paceChartObj = new Chart(ctx, {
            type: 'line',
            data: { labels: data.map(function(_, i) { return i + 1; }), datasets: [{ label: 'Pace', data: data, segment: { borderColor: function(ctx) { var p = ctx.p1.parsed.y; return p >= 9.0 ? '#f39c12' : p >= 6.5 ? '#0a84ff' : '#ff6b00'; } }, backgroundColor: 'rgba(255,107,0,0.05)', fill: true, tension: 0.4, borderWidth: 3, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { reverse: true, grid:{color:'rgba(120,120,120,0.08)'} }, x: { display: false } }, plugins: { legend: { display: false } } }
        });
    },

    showChangelog: function() {
        var overlay = document.createElement('div');
        overlay.id = 'changelog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);z-index:5000;display:flex;align-items:center;padding:24px;overflow-y:auto;';
        var content = document.createElement('div'); content.className = 'card'; content.style.cssText = 'width:100%;max-width:480px;margin:auto;';
        var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px"><h2 style="margin:0">📜 Wijzigingen</h2><button class="clear-history-btn" id="changelog-close-btn">Sluiten</button></div>';
        APP.CHANGELOG.forEach(function(e) {
            html += '<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:var(--border)"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span style="font-size:14px;font-weight:900;color:var(--primary)">v' + e.version + '</span><span style="font-size:10px;font-weight:600;color:var(--text-muted)">' + e.date + '</span></div><ul style="margin:0;padding-left:18px;font-size:12px;">';
            e.changes.forEach(function(c) { html += '<li style="margin-bottom:3px;">' + c + '</li>'; });
            html += '</ul></div>';
        });
        content.innerHTML = html;
        overlay.appendChild(content);
        document.getElementById('app-container').appendChild(overlay);
        HistoryManager.open('changelog', 'Changelog', function() {
            var o = document.getElementById('changelog-overlay');
            if (o) o.remove();
        });
        // Bind close button after element exists in DOM
        var self = this;
        setTimeout(function() {
            var closeBtn = document.getElementById('changelog-close-btn');
            if (closeBtn) {
                closeBtn.onclick = function() {
                    document.getElementById('changelog-overlay').remove();
                    HistoryManager.close();
                };
            }
        }, 0);
    }
};

// ==============================================
// APP STATE
// ==============================================
const STATE = {
    status: 'IDLE', activePlanKey: undefined, activeWeekIdx: undefined, activeType: undefined,
    sessionBlocks: [], currentBIdx: 0, blockRem: 0, totalRem: 0, totalDist: 0, currentRoute: [],
    viewedRoute: null, paceData: [], lastKMSpeech: 0, lastPaceTime: 0, startTime: null, activeSeconds: 0,
    isPaused: false, lastGpsTime: 0, speedEMA: 0, timerId: null, watchId: null, wakeLock: null,
    synth: window.speechSynthesis, voices: [], heartRateDevice: null, heartRateCharacteristic: null,
    currentHeartRate: 0, countdownInterval: null, schemas: {},
    _viewingHistoryRun: false
};

// ==============================================
// APP LOGIC (APP)
// ==============================================
const APP = {
    CHANGELOG: [
        { version: '1.6.0', date: '20-05-2026', changes: [
            '🎯 Dynamische Plan Generator - stel zelf je doelen in',
            '🚀 Kies afstand, weken en frequentie voor een persoonlijk schema',
            '📊 Wetenschappelijke periodisering met polarized training',
            '🗑️ Oude vaste schema\'s vervangen door dynamisch systeem'
        ]},
        { version: '1.5.0', date: '15-05-2026', changes: [
            '🎨 RunFlow Visual Design Update (compleet vernieuwde UI)',
            '💪 WebGL shader achtergrond met dynamische animatie',
            '📍 GPS feedback indicator tijdens het hardlopen',
            '📋 Verbeterde kaartprestaties'
        ]}
    ],

    init: async function() {
        if ('serviceWorker' in navigator) {
            try {
                var swResp = await fetch('./sw.js', { method: 'HEAD' });
                if (swResp.ok) await navigator.serviceWorker.register('./sw.js', { scope: './' });
            } catch (e) {}
        }
        var savedTheme = LS.get('strive_theme');
        UI.applyTheme(savedTheme === null ? true : savedTheme === 'light');
        
        this._loadSettings();

        DB.getAll(function(runs) {
            UI.renderDashboard(runs);
            UI.renderDataTab(runs);
            UI.renderRecentActivity(runs);
            APP.renderWeekTotal(runs);
        });

        document.addEventListener('visibilitychange', function() {
            if (STATE.wakeLock !== null && document.visibilityState === 'visible') APP.requestWakeLock();
        });

        window.speechSynthesis.onvoiceschanged = function() {
            STATE.voices = window.speechSynthesis.getVoices();
            var dutch = STATE.voices.filter(function(v) { return v.lang.includes('nl'); });
            var sel = document.getElementById('voice-select');
            if (sel) sel.innerHTML = dutch.map(function(v) { return '<option value="' + v.name + '">' + v.name + '</option>'; }).join('') || '<option>Standaard Stem</option>';
        };

        this.renderHeartRateZones();

        if (!LS.get('onboarding_complete')) {
            document.getElementById('onboarding-screen').style.display = 'block';
        }

        // Initialize HistoryManager
        HistoryManager.init();
    },

    finishOnboarding: function(startTest) {
        DB.saveOnboardingProfile();
        document.getElementById('onboarding-screen').style.display = 'none';
        if (startTest) {
            UI.openTab('training', document.querySelectorAll('.nav-item')[1]);
            this.startBaselineTest();
        }
    },

    _loadSettings: function() {
        var m = function(id, key) { var v = LS.get(key); if (v) document.getElementById(id).value = v; };
        m('warmup-time', 'warmup_time');
        m('cooldown-time', 'cooldown_time');
        m('user-weight', 'user_weight');
        m('user-height', 'user_height');
        m('user-age', 'user_age');
        m('user-gender', 'user_gender');
        if (LS.get('live_map_enabled') === 'true') document.getElementById('live-map-toggle').classList.add('active');
        DB.updateWarmupCoolDown();
    },

    applyCustomTimings: function(blocks) {
        var ws = (parseInt(LS.get('warmup_time', '5'))) * 60;
        var cs = (parseInt(LS.get('cooldown_time', '5'))) * 60;
        var nb = blocks.slice();
        if (nb.length > 0 && nb[0].m === 'warmup') nb[0] = Object.assign({}, nb[0], { t: ws });
        if (nb.length > 0 && nb[nb.length - 1].m === 'warmup' && (nb[nb.length - 1].s.toLowerCase().includes('cool') || nb[nb.length - 1].s.toLowerCase().includes('cooldown')))
            nb[nb.length - 1] = Object.assign({}, nb[nb.length - 1], { t: cs });
        return nb;
    },

    renderHeartRateZones: function() {
        var age = parseInt(LS.get('user_age', '30'));
        if (!age || age < 12) age = 30;
        var zones = APP.POLARIZED.getHeartRateZones(age);
        var display = document.getElementById('hr-zones-display');
        if (!display) return;
        display.innerHTML = '<div style="font-size: 13px; font-weight: 800; color: var(--primary); margin-bottom: 10px;">❤️ Max HR: ~' + zones.hrMax + ' bpm</div>' +
            '<div style="display: flex; flex-direction: column; gap: 5px;">' +
            '<div style="display: flex; justify-content: space-between; font-size:12px;"><span style="font-weight:700; color:var(--primary);">Z1</span><span>' + zones.zone1.low + '-' + zones.zone1.high + ' bpm</span></div>' +
            '<div style="display: flex; justify-content: space-between; font-size:12px;"><span style="font-weight:700; color:var(--success);">Z2</span><span>' + zones.zone2.low + '-' + zones.zone2.high + ' bpm</span></div>' +
            '<div style="display: flex; justify-content: space-between; font-size:12px;"><span style="font-weight:700; color:var(--warning);">Z3</span><span>' + zones.zone3.low + '-' + zones.zone3.high + ' bpm</span></div>' +
            '<div style="display: flex; justify-content: space-between; font-size:12px;"><span style="font-weight:700; color:var(--danger);">Z4</span><span>' + zones.zone4.low + '-' + zones.zone4.high + ' bpm</span></div>' +
            '</div>';
    },

    toggleManualComplete: function(plan, week, type) {
        var key = 'done_' + plan + '_' + week + '_' + type;
        LS.set(key, !(LS.get(key) === 'true'));
        if (plan === 'dynamic') UI.renderDynamicPlan(DB.getDynamicPlan());
        else UI.renderPlan(plan);
    },

    // Mapping van technische/oude namen naar eenvoudige display labels
    // De m (mode) blijft de korte code (warmup/sprint/run/jog/walk) voor CSS classes
    // Alleen s (display text) wordt vertaald naar Nederlands

    // Bepaalt de korte mode code op basis van mode en description
    _getSimpleMode: function(mode, description) {
        var desc = (description || '').toLowerCase();
        // Herken bekende modes direct
        if (mode === 'warmup' || mode === 'warmingup') return 'warmup';
        if (mode === 'sprint') return 'sprint';
        if (mode === 'run') return 'run';
        if (mode === 'jog') return 'jog';
        if (mode === 'walk') return 'walk';

        // Fallback op description
        if (desc.includes('warm') || desc.includes('cool') || desc.includes('cooldown')) return 'warmup';
        if (desc.includes('sprint') || desc.includes('interval') || desc.includes('hit')) return 'sprint';
        if (desc.includes('run') || desc.includes('long') || desc.includes('ren')) return 'run';
        if (desc.includes('jog') || desc.includes('easy') || desc.includes('herstel') || desc.includes('recovery')) return 'jog';
        if (desc.includes('walk') || desc.includes('loop') || desc.includes('lopen')) return 'walk';
        return 'jog'; // default
    },

    // Vertaalt mode naar een Nederlands display label
    _getDisplayLabel: function(mode, description) {
        var simpleMode = this._getSimpleMode(mode, description);
        var labelMap = {
            'warmup': 'warmingup',
            'sprint': 'sprinten',
            'run': 'rennen',
            'jog': 'joggen',
            'walk': 'lopen'
        };
        return labelMap[simpleMode] || 'joggen';
    },

    // Vertaalt alle blokken in een sessie: mode blijft korte code, s wordt Nederlands label
    _translateSessionBlocks: function(blocks) {
        return blocks.map(function(b) {
            return {
                m: this._getSimpleMode(b.m, b.s),
                s: this._getDisplayLabel(b.m, b.s),
                t: b.t
            };
        }.bind(this));
    },

    formatT: function(s) { return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); },
    calcDist: function(l1, ln1, l2, ln2) { var R = 6371, dLat = (l2 - l1) * Math.PI / 180, dLon = (ln2 - ln1) * Math.PI / 180, a = Math.sin(dLat / 2) ** 2 + Math.cos(l1 * Math.PI / 180) * Math.cos(l2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2; a = Math.min(1, Math.max(0, a)); return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); },

    calculateStreak: function(runs) {
        if (!runs || runs.length === 0) return 0;
        var sr = runs.map(function(r) { var p = r.d.split(/[.-]/); return Object.assign({}, r, { dateObj: new Date(p[2], p[1] - 1, p[0]) }); }).sort(function(a, b) { return a.dateObj - b.dateObj; });
        var today = new Date(); today.setHours(0, 0, 0, 0);
        if (Math.floor((today - sr[sr.length - 1].dateObj) / 86400000) > 7) return 0;
        var streak = 0, last = null;
        sr.forEach(function(r) {
            if (last) { var diff = Math.floor((r.dateObj - last) / 86400000); streak = diff <= 7 ? streak + 1 : 1; }
            else streak = 1;
            last = r.dateObj;
        });
        return streak;
    },

    calcPRForDistance: function(runs, minKm) {
        var best = null; var bestTime = 0;
        runs.forEach(function(r) {
            if (parseFloat(r.dist) >= minKm && r.pace && parseFloat(r.pace) > 0) {
                var p = parseFloat(r.pace);
                if (best === null || p < best) { best = p; bestTime = r.duration || 0; }
            }
        });
        if (best === null) return { paceStr: '--', timeStr: '' };
        var paceStr = Math.floor(best) + ':' + Math.round((best - Math.floor(best)) * 60).toString().padStart(2, '0');
        var timeStr = bestTime > 0 ? '⏱ ' + APP.formatT(bestTime) : '';
        return { paceStr: paceStr, timeStr: timeStr };
    },

    VDOT: {
        fromRace: function(distanceKm, timeSeconds) {
            var speedMperMin = ((distanceKm * 1000) / timeSeconds) * 60;
            var vo2 = -4.60 + 0.182258 * speedMperMin + 0.000104 * (speedMperMin * speedMperMin);
            return Math.max(20, Math.min(85, Math.round(vo2)));
        },
        fromPaceMinPerKm: function(paceMinPerKm) {
            if (!paceMinPerKm || paceMinPerKm <= 0) return 30;
            var speedMperMin = 1000 / paceMinPerKm;
            var vo2 = -4.60 + 0.182258 * speedMperMin + 0.000104 * (speedMperMin * speedMperMin);
            return Math.max(20, Math.min(85, Math.round(vo2)));
        },
        getTrainingPaces: function(vdot) {
            var vvo2max = (vdot + 33.0) / 0.166667;
            var paces = { easy: 60 / (vvo2max * 0.65), marathon: 60 / (vvo2max * 0.80), threshold: 60 / (vvo2max * 0.88), interval: 60 / (vvo2max * 0.98), repetition: 60 / (vvo2max * 1.08) };
            var fmt = function(pace) { return Math.floor(pace) + ':' + Math.round((pace - Math.floor(pace)) * 60).toString().padStart(2, '0'); };
            return {
                easy: { minPerKm: paces.easy, display: fmt(paces.easy) },
                marathon: { minPerKm: paces.marathon, display: fmt(paces.marathon) },
                threshold: { minPerKm: paces.threshold, display: fmt(paces.threshold) },
                interval: { minPerKm: paces.interval, display: fmt(paces.interval) },
                repetition: { minPerKm: paces.repetition, display: fmt(paces.repetition) }
            };
        },
        predictRaceTime: function(vdot, distanceKm) {
            var paces = this.getTrainingPaces(vdot);
            var threshPace = 1 / paces.threshold.minPerKm;
            var intPace = 1 / paces.interval.minPerKm;
            var racePaceMperMin = (threshPace + intPace) / 2;
            var racePaceMinPerKm = 1 / racePaceMperMin;
            return Math.round(distanceKm * racePaceMinPerKm * 60);
        }
    },

    ACWR: {
        calculate: function(runs, userBaseVolume) {
            var now = new Date(); var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            var oneDayMs = 86400000; var acuteDistance = 0; var chronicDistances = [];
            var baseVolume = parseFloat(userBaseVolume) || 5;
            runs.forEach(function(run) {
                try {
                    var parts = run.d.split(/[.-]/);
                    var runDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                    var daysDiff = Math.floor((today - runDate) / oneDayMs);
                    if (daysDiff < 0) return;
                    var dist = parseFloat(run.dist) || 0;
                    if (daysDiff < 7) acuteDistance += dist;
                    if (daysDiff < 28) {
                        var weekIdx = Math.floor(daysDiff / 7);
                        if (!chronicDistances[weekIdx]) chronicDistances[weekIdx] = 0;
                        chronicDistances[weekIdx] += dist;
                    }
                } catch (e) {}
            });
            for (var i = 0; i < 4; i++) { if (!chronicDistances[i]) chronicDistances[i] = baseVolume; }
            var chronicLoad = chronicDistances.reduce(function(a, b) { return a + b; }, 0) / chronicDistances.length;
            var acwr = chronicLoad > 0 ? acuteDistance / chronicLoad : 0.5;
            return { acuteLoad: acuteDistance, chronicLoad: parseFloat(chronicLoad.toFixed(1)), acwr: parseFloat(acwr.toFixed(2)), zone: acwr < 0.8 ? 'detraining' : acwr <= 1.3 ? 'optimal' : acwr <= 1.5 ? 'caution' : 'danger' };
        },
        getSafeWeeklyIncrease: function(acwrData) {
            if (acwrData.acwr < 0.8) return 0.20; if (acwrData.acwr <= 1.0) return 0.15; if (acwrData.acwr <= 1.3) return 0.10; if (acwrData.acwr <= 1.5) return 0.0; return -0.15;
        }
    },

    POLARIZED: {
        getHeartRateZones: function(age, restingHR) {
            restingHR = restingHR || 60; var hrMax = 208 - 0.7 * age; var hrr = hrMax - restingHR;
            return {
                hrMax: Math.round(hrMax),
                zone1: { low: Math.round(restingHR + hrr * 0.50), high: Math.round(restingHR + hrr * 0.60) },
                zone2: { low: Math.round(restingHR + hrr * 0.60), high: Math.round(restingHR + hrr * 0.75) },
                zone3: { low: Math.round(restingHR + hrr * 0.80), high: Math.round(restingHR + hrr * 0.90) },
                zone4: { low: Math.round(restingHR + hrr * 0.90), high: Math.round(hrMax) }
            };
        },
        distributeWeeklyVolume: function(weeklyVolumeKm, frequency) {
            var liKm = weeklyVolumeKm * 0.80; var hiKm = weeklyVolumeKm * 0.20;
            var hiSessions = Math.max(1, Math.round(frequency * 0.2)); var plan = {};
            if (frequency >= 3) plan.t1 = { type: 'HIT', durationKm: parseFloat((hiKm / hiSessions).toFixed(1)), label: '⚡ HIT Sessie' };
            if (frequency >= 2) plan.t2 = { type: 'EASY', durationKm: parseFloat((liKm * 0.4).toFixed(1)), label: '✅ Zone 2 Herstelrun' };
            if (frequency >= 3) plan.t3 = { type: 'LONG', durationKm: parseFloat((liKm - (liKm * 0.4)).toFixed(1)), label: '🏃 Lange Duurloop (Zone 2)' };
            if (frequency >= 4) plan.t4 = { type: 'EASY', durationKm: parseFloat((liKm * 0.15).toFixed(1)), label: '✅ Zone 2 Duurloop' };
            if (frequency >= 5) plan.t5 = { type: 'RECOVERY', durationKm: parseFloat(Math.max(weeklyVolumeKm - plan.t1.durationKm - plan.t2.durationKm - plan.t3.durationKm - plan.t4.durationKm, 0).toFixed(1)), label: '🧘 Actief Herstel' };
            var filteredPlan = {};
            Object.keys(plan).sort().forEach(function(key) { if (plan[key].durationKm > 0) filteredPlan[key] = plan[key]; });
            return filteredPlan;
        }
    },

    PERIODIZATION: {
        generateWeeklyVolumes: function(baseVolume, weeks) {
            var volumes = []; var currentVolume = parseFloat(baseVolume) || 5;
            for (var w = 1; w <= weeks; w++) {
                // Taper every 4th week (50% reduction)
                if (w % 4 === 0) volumes.push(Math.round(currentVolume * 0.5 * 10) / 10);
                else { currentVolume = currentVolume * (w === 1 ? 1.0 : 1.08); volumes.push(Math.round(currentVolume * 10) / 10); }
            }
            return volumes;
        }
    },

    calculateCalories: function(distanceKm, durationMin) {
        var weightKg = parseInt(LS.get('user_weight', '75'));
        if (distanceKm <= 0.01 || durationMin <= 0) return 0;
        var speedKmh = distanceKm / (durationMin / 60); var met;
        if (speedKmh < 4.0) met = 2.5; else if (speedKmh < 5.0) met = 3.5; else if (speedKmh < 6.0) met = 5.0; else if (speedKmh < 7.0) met = 6.0; else if (speedKmh < 8.0) met = 7.0; else if (speedKmh < 9.0) met = 8.3; else if (speedKmh < 10.0) met = 9.8; else if (speedKmh < 11.0) met = 11.0; else met = 12.5;
        return Math.round(met * weightKg * (durationMin / 60));
    },

    updateGPSStatus: function(status, accuracy, color) {
        var dot = document.getElementById('gps-dot');
        var text = document.getElementById('gps-text');
        var accEl = document.getElementById('gps-accuracy');
        if (!dot || !text) return;
        dot.style.background = color || 'var(--text-muted)';
        text.innerText = status;
        text.style.color = color || 'var(--text-muted)';
        if (accEl) {
            if (accuracy > 0) {
                accEl.innerText = '±' + Math.round(accuracy) + 'm';
                accEl.style.color = accuracy <= 10 ? 'var(--success)' : accuracy <= 25 ? 'var(--warning)' : 'var(--danger)';
            } else { accEl.innerText = ''; }
        }
    },

    vibrate: function(pattern) { if ('vibrate' in navigator) navigator.vibrate(pattern); },
    speak: function(t) {
        if (!t) return;
        if (STATE.synth.speaking) STATE.synth.cancel();
        var u = new SpeechSynthesisUtterance(t);
        u.voice = STATE.voices.find(function(v) { return v.name === document.getElementById('voice-select').value; }) || null;
        u.lang = 'nl-NL'; u.rate = 0.95; u.volume = 1.0;
        STATE.synth.speak(u);
    },
    requestWakeLock: async function() { try { if ('wakeLock' in navigator) STATE.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} },
    releaseWakeLock: function() { if (STATE.wakeLock) { STATE.wakeLock.release(); STATE.wakeLock = null; } },

    realStart: function() {
        if (STATE.countdownInterval) return;
        this.requestWakeLock();
        document.getElementById('preview-overlay').style.display = 'none';
        // Pop the preview state since we're transitioning to timer
        HistoryManager.close();
        
        document.querySelectorAll('.tab-view').forEach(t => t.classList.remove('active'));
        document.getElementById('timer-display').classList.add('active');
        // Push timer state
        HistoryManager.open('timer', 'Training Active', function() {
            APP.finishTraining();
        });

        STATE.totalDist = 0; STATE.currentRoute = []; STATE.paceData = [];
        STATE.lastKMSpeech = 0; STATE.lastPaceTime = Date.now(); STATE.startTime = Date.now();
        STATE.activeSeconds = 0; STATE.isPaused = false; STATE.currentBIdx = 0;
        STATE.totalRem = STATE.sessionBlocks.reduce(function(a, b) { return a + b.t; }, 0);
        STATE.lastGpsTime = 0; STATE.speedEMA = 0;
        this.speak('Training begint over 5 seconden');
        var count = 5;
        STATE.countdownInterval = setInterval(function() {
            count--;
            document.getElementById('timer-time').innerText = '00:0' + count;
            if (count > 0) APP.speak(count.toString());
            if (count <= 0) {
                clearInterval(STATE.countdownInterval); STATE.countdownInterval = null;
                UI.initLiveMap(); APP.startGPS(); APP.startBlock();
            }
        }, 1000);
    },

    startGPS: function() {
        APP.updateGPSStatus('GPS zoeken...', 0, 'var(--warning)');
        var gpsWarnTimeout = setTimeout(function() {
            APP.updateGPSStatus('GPS nog niet gevonden', 0, 'var(--danger)');
        }, 15000);

        var gpsAttempts = 0;

        function onGPSSuccess(p) {
            clearTimeout(gpsWarnTimeout);
            gpsAttempts = 0;
            var acc = p.coords.accuracy;
            var status, color;
            if (acc <= 10) { status = 'GPS sterk'; color = 'var(--success)'; }
            else if (acc <= 30) { status = 'GPS goed'; color = 'var(--success)'; }
            else if (acc <= 60) { status = 'GPS matig'; color = 'var(--warning)'; }
            else { status = 'GPS zwak'; color = 'var(--danger)'; }
            APP.updateGPSStatus(status, acc, color);

            if (STATE.isPaused) return;
            if (p.coords.speed !== null && p.coords.speed < 0.4) return;
            var lat = p.coords.latitude, lng = p.coords.longitude, now = Date.now();
            var pointPace = 0;
            if (STATE.currentRoute.length > 0) {
                var last = STATE.currentRoute[STATE.currentRoute.length - 1];
                var d = APP.calcDist(last[0], last[1], lat, lng);
                if (d < 0.005) return;
                var td = (now - STATE.lastGpsTime) / 1000;
                if (STATE.lastGpsTime && td > 0) {
                    var spd = d / (td / 3600);
                    if (spd > 35) return;
                    STATE.totalDist += d;
                    var km = Math.floor(STATE.totalDist);
                    if (km > STATE.lastKMSpeech && km > 0) { STATE.lastKMSpeech = km; APP.vibrate([300, 100, 300, 100, 300]); APP.speak(km + ' kilometer gerend! Goed bezig!'); }
                    var em = STATE.activeSeconds / 60;
                    if (STATE.totalDist > 0.05 && em > 0) {
                        var ap = em / STATE.totalDist;
                        document.getElementById('avg-pace').innerText = Math.floor(ap) + ':' + Math.round((ap - Math.floor(ap)) * 60).toString().padStart(2, '0');
                        if (now - STATE.lastPaceTime >= 30000) { STATE.lastPaceTime = now; STATE.paceData.push(ap.toFixed(2)); }
                    }
                    if (spd >= 1.0) {
                        var cp = 60 / spd;
                        if (cp > 2 && cp < 20) { STATE.speedEMA = STATE.speedEMA === 0 ? cp : STATE.speedEMA * 0.7 + cp * 0.3; document.getElementById('live-pace').innerText = Math.floor(STATE.speedEMA) + ':' + Math.round((STATE.speedEMA - Math.floor(STATE.speedEMA)) * 60).toString().padStart(2, '0'); }
                    }
                    pointPace = STATE.speedEMA;
                }
                document.getElementById('live-dist').innerText = STATE.totalDist.toFixed(2);
                STATE.lastGpsTime = now;
            } else STATE.lastGpsTime = now;
            STATE.currentRoute.push([lat, lng, pointPace]);
            UI.updateLiveMap(STATE.currentRoute);
        }

        function onGPSError(err) {
            gpsAttempts++;
            console.warn('GPS fout #' + gpsAttempts + ':', err.code, err.message);
            APP.updateGPSStatus('GPS fout (' + gpsAttempts + ')', 0, 'var(--danger)');
            
            if (gpsAttempts >= 3 && !STATE._gpsFallbackStarted) {
                STATE._gpsFallbackStarted = true;
                navigator.geolocation.clearWatch(STATE.watchId);
                APP.updateGPSStatus('GPS opnieuw (standby)...', 0, 'var(--warning)');
                setTimeout(function() {
                    STATE.watchId = navigator.geolocation.watchPosition(onGPSSuccess, onGPSError, {
                        enableHighAccuracy: false, maximumAge: 10000, timeout: 20000
                    });
                }, 3000);
            }
        }

        STATE._gpsFallbackStarted = false;
        STATE.watchId = navigator.geolocation.watchPosition(onGPSSuccess, onGPSError, {
            enableHighAccuracy: true, maximumAge: 10000, timeout: 15000
        });

        setTimeout(function() {
            if (STATE.currentRoute.length === 0 && !STATE._gpsFallbackStarted) {
                STATE._gpsFallbackStarted = true;
                navigator.geolocation.clearWatch(STATE.watchId);
                APP.updateGPSStatus('GPS standby modus...', 0, 'var(--warning)');
                STATE.watchId = navigator.geolocation.watchPosition(onGPSSuccess, onGPSError, {
                    enableHighAccuracy: false, maximumAge: 30000, timeout: 30000
                });
            }
        }, 25000);
    },

    startBlock: function() {
        if (STATE.currentBIdx >= STATE.sessionBlocks.length) return this.finishTraining();
        var b = STATE.sessionBlocks[STATE.currentBIdx];
        STATE.blockRem = b.t;
        document.getElementById('timer-status').innerText = b.s;
        this.speak('Begin met ' + b.s);
        if (STATE.timerId) clearInterval(STATE.timerId);
        STATE.timerId = setInterval(function() {
            if (STATE.isPaused) return;
            STATE.blockRem--; STATE.totalRem--; STATE.activeSeconds++;
            document.getElementById('timer-time').innerText = APP.formatT(STATE.blockRem);
            document.getElementById('total-time-left').innerText = APP.formatT(STATE.totalRem);
            if (STATE.blockRem <= 0) { clearInterval(STATE.timerId); STATE.currentBIdx++; APP.startBlock(); }
        }, 1000);
    },

    skipBlock: function() { clearInterval(STATE.timerId); STATE.totalRem -= STATE.blockRem; STATE.currentBIdx++; this.startBlock(); },
    togglePause: function() { STATE.isPaused = !STATE.isPaused; document.getElementById('btn-pause').innerText = STATE.isPaused ? 'HERVAT' : 'PAUZE'; document.getElementById('timer-display').classList.toggle('paused', STATE.isPaused); this.speak(STATE.isPaused ? 'Gepauzeerd' : 'We gaan weer verder'); },
    confirmStop: function() { if (!STATE.startTime) return; if (confirm('Stoppen?')) this.finishTraining(); },

    finishTraining: async function() {
        if (!STATE.startTime) return;
        STATE.startTime = null;
        this.releaseWakeLock(); clearInterval(STATE.timerId); navigator.geolocation.clearWatch(STATE.watchId);
        
        document.getElementById('timer-display').classList.remove('active');
        // Pop the timer state since we're transitioning to result
        HistoryManager.close();
        // Clear any stale viewedRoute so generateShareImage uses currentRoute
        STATE.viewedRoute = null;
        
        document.getElementById('tab-home').classList.add('active');

        var ts = STATE.activeSeconds; var dm = ts / 60;
        var paceNum = STATE.totalDist > 0.1 ? dm / STATE.totalDist : 0;
        var pace = paceNum > 0 ? paceNum.toFixed(2) : '0.00';
        var cal = this.calculateCalories(STATE.totalDist, dm);

        document.getElementById('res-d').innerText = STATE.totalDist.toFixed(2);

        // Format pace as mm:ss
        if (paceNum > 0) {
            var paceMin = Math.floor(paceNum);
            var paceSec = Math.round((paceNum - paceMin) * 60);
            document.getElementById('res-p').innerText = paceMin + ':' + paceSec.toString().padStart(2, '0');
        } else {
            document.getElementById('res-p').innerText = '0:00';
        }

        document.getElementById('res-time').innerText = this.formatT(ts);
        document.getElementById('res-cal').innerText = cal;

        // Save to IndexedDB
        var now = new Date();
        var nowStr = now.toLocaleDateString('nl-NL');
        var timeStr = now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

        var ss = 0, rs = 0, js = 0, ws = 0;
        if (STATE.paceData && STATE.paceData.length > 0) {
            STATE.paceData.forEach(function(p) { var v = parseFloat(p); if (v < 4.0) ss += 30; else if (v < 6.5) rs += 30; else if (v < 9.0) js += 30; else ws += 30; });
            var totS = ss + rs + js + ws;
            if (totS > 0) { var r = ts / totS; ss *= r; rs *= r; js *= r; ws *= r; }
        } else { var ap = parseFloat(pace); if (ap < 4.0) ss = ts; else if (ap < 6.5) rs = ts; else if (ap < 9.0) js = ts; else ws = ts; }
        var tc = ss + rs + js + ws;
        var sp = tc > 0 ? Math.round((ss / tc) * 100) : 0; var rp = tc > 0 ? Math.round((rs / tc) * 100) : 0;
        var jp = tc > 0 ? Math.round((js / tc) * 100) : 0; var wp = tc > 0 ? Math.max(0, 100 - sp - rp - jp) : 0;
        
        document.getElementById('stat-sprint-percent').innerText = sp + '%';
        document.getElementById('stat-run-percent').innerText = rp + '%';
        document.getElementById('stat-jog-percent').innerText = jp + '%';
        document.getElementById('stat-walk-percent').innerText = wp + '%';
        document.getElementById('stat-sprint-bar').style.width = sp + '%';
        document.getElementById('stat-run-bar').style.width = rp + '%';
        document.getElementById('stat-jog-bar').style.width = jp + '%';
        document.getElementById('stat-walk-bar').style.width = wp + '%';

        document.getElementById('stat-sprint-time').innerText = this.formatT(ss);
        document.getElementById('stat-run-time').innerText = this.formatT(rs);
        document.getElementById('stat-jog-time').innerText = this.formatT(js);
        document.getElementById('stat-walk-time').innerText = this.formatT(ws);

        UI.renderResultMap(STATE.currentRoute);
        UI.renderPaceChart(STATE.paceData);
        UI.openResultScreen();

        // Automatically save the run to IndexedDB
        var runData = {
            d: nowStr,
            t: timeStr,
            n: 'Training',
            dist: STATE.totalDist.toFixed(2),
            duration: ts,
            pace: paceNum > 0 ? paceNum.toFixed(2) : '0.00',
            calories: cal,
            sprintTime: Math.round(ss),
            runTime: Math.round(rs),
            jogTime: Math.round(js),
            walkTime: Math.round(ws),
            route: STATE.currentRoute,
            paceData: STATE.paceData
        };

        DB.add(runData, function() {
            console.log('Sessie opgeslagen');
        });
    },

    startBaselineTest: function() {
        var planKey = 'custom';
        STATE.schemas[planKey] = {
            name: 'Baseline Test',
            weeks: [{ w: 1, t1: { label: '📊 Baseline Test (30 min)', b: [{ m: 'warmup', s: 'Warming-up', t: 300 }, { m: 'run', s: 'Loop rustig in eigen tempo', t: 1800 }, { m: 'warmup', s: 'Cool-down', t: 300 }] } }]
        };
        var training = STATE.schemas[planKey].weeks[0].t1;
        STATE.sessionBlocks = APP._translateSessionBlocks(APP.applyCustomTimings(training.b));
        document.getElementById('pre-title').innerText = training.label;
        document.getElementById('pre-time').innerText = Math.round(STATE.sessionBlocks.reduce(function(a, b) { return a + b.t; }, 0) / 60) + ' min';
        document.getElementById('pre-type').innerText = 'Baseline Test';
        var maxT = Math.max.apply(null, STATE.sessionBlocks.map(function(b) { return b.t; }));
        document.getElementById('pre-chart').innerHTML = STATE.sessionBlocks.map(function(b) { return '<div class="bar ' + b.m + '" style="height:' + Math.max(15, (b.t / maxT) * 100) + '%"><span>' + Math.round(b.t / 60) + 'm</span></div>'; }).join('');
        document.getElementById('preview-overlay').style.display = 'flex';
        HistoryManager.open('preview', 'Baseline Test Preview', function() {
            document.getElementById('preview-overlay').style.display = 'none';
        });
    },

    generateCustomPlan: function() {
        var freq = parseInt(document.getElementById('train-frequency').value);
        var goal = document.getElementById('train-goal').value;
        var baseVolume = parseFloat(document.getElementById('user-base-volume').value) || 5;
        if (freq < 2) { this.speak('Minimaal 2 trainingen per week vereist'); return; }
        var goalDistMap = { '3km': 3, '5km': 5, '10km': 10, 'halve': 21.1 };
        var goalDist = goalDistMap[goal] || 5;
        var vdot = this.VDOT.fromPaceMinPerKm(baseVolume > 0 ? (freq * 30) / baseVolume : 0);
        if (vdot < 20) vdot = 30;
        var targetVolume = Math.max(baseVolume * 1.2, goalDist * 0.6);
        var volumes = this.PERIODIZATION.generateWeeklyVolumes(targetVolume, 8);
        var plan = { name: freq + 'x/' + goal + ' (AI)', weeks: [] };
        for (var w = 0; w < 8; w++) {
            var weekVolume = volumes[w] || targetVolume;
            var sessionPlan = (APP.POLARIZED_FIXED || APP.POLARIZED).distributeWeeklyVolume(weekVolume, freq);
            var weekObj = { w: w + 1 };
            var keys = Object.keys(sessionPlan).sort();
            keys.forEach(function(key, idx) {
                var s = sessionPlan[key];
                var totalSec = Math.round((s.durationKm / 5.0) * 3600);
                var blocks = [];
                if (s.type === 'EASY' || s.type === 'RECOVERY') blocks = [{ m: 'jog', s: s.type === 'EASY' ? 'Zone 2 Duurloop' : 'Actief Herstel', t: totalSec }];
                else if (s.type === 'LONG') blocks = [{ m: 'run', s: 'Lange Duurloop (Zone 2)', t: totalSec }];
                else if (s.type === 'HIT') blocks = [{ m: 'jog', s: 'Jog', t: 120 }, { m: 'sprint', s: 'Interval', t: 60 }, { m: 'jog', s: 'Actief Herstel', t: 120 }, { m: 'sprint', s: 'Interval', t: 60 }, { m: 'jog', s: 'Actief Herstel', t: 120 }, { m: 'sprint', s: 'Interval', t: 60 }, { m: 'jog', s: 'Afkoelen', t: 120 }];
                weekObj['t' + (idx + 1)] = { label: s.label, b: blocks };
            });
            plan.weeks.push(weekObj);
        }
        STATE.schemas['custom'] = plan;
        LS.set('jellylegs_custom_plan', JSON.stringify(plan));
        this.speak('AI Plan gegenereerd, pas je warmingup en cooldown aan in instellingen');
    },

    renderWeekTotal: function(runs) {
        var wd = DB.processWeeklyData(runs);
        var currentWeek = wd.length > 0 ? wd[0] : null;
        if (currentWeek) {
            // Calculate a simple weekly goal: previous week's distance, or base volume as fallback
            var prevWeek = wd.length > 1 ? wd[1] : null;
            var goalKm = prevWeek ? Math.round(prevWeek.totalDist * 1.1 * 10) / 10 : 10;
            var currentKm = currentWeek.totalDist;
            var pct = goalKm > 0 ? Math.min(100, Math.round((currentKm / goalKm) * 100)) : 0;

            document.getElementById('week-progress-current').innerText = currentKm.toFixed(1) + ' KM gelopen';
            document.getElementById('week-progress-target').innerText = 'Doel: ' + goalKm.toFixed(1) + ' km';
            document.getElementById('week-progress-fill').style.width = pct + '%';
        } else {
            document.getElementById('week-progress-current').innerText = '0.0 KM gelopen';
            document.getElementById('week-progress-target').innerText = 'Doel: - km';
            document.getElementById('week-progress-fill').style.width = '0%';
        }
    },

    // ==============================================
    // DYNAMIC PLAN GENERATOR
    // ==============================================
    // Fix: ensure 2x/week gives 2 sessions (HIT + EASY)
    POLARIZED_FIXED: {
        distributeWeeklyVolume: function(weeklyVolumeKm, frequency) {
            var liKm = weeklyVolumeKm * 0.80; var hiKm = weeklyVolumeKm * 0.20;
            var hiSessions = Math.max(1, Math.round(frequency * 0.2)); var plan = {};
            // Frequency 2: one HIT (or tempo) + one EASY
            if (frequency >= 2) plan.t1 = { type: 'HIT', durationKm: parseFloat((hiKm / hiSessions).toFixed(1)), label: '⚡ HIT Sessie' };
            if (frequency >= 2) plan.t2 = { type: 'EASY', durationKm: parseFloat((liKm * 0.6).toFixed(1)), label: '✅ Zone 2 Herstelrun' };
            if (frequency >= 3) plan.t3 = { type: 'LONG', durationKm: parseFloat((liKm * 0.4).toFixed(1)), label: '🏃 Lange Duurloop (Zone 2)' };
            if (frequency >= 4) plan.t4 = { type: 'EASY', durationKm: parseFloat((liKm * 0.15).toFixed(1)), label: '✅ Zone 2 Duurloop' };
            if (frequency >= 5) plan.t5 = { type: 'RECOVERY', durationKm: parseFloat(Math.max(weeklyVolumeKm - plan.t1.durationKm - plan.t2.durationKm - plan.t3.durationKm - plan.t4.durationKm, 0).toFixed(1)), label: '🧘 Actief Herstel' };
            var filteredPlan = {};
            Object.keys(plan).sort().forEach(function(key) { if (plan[key].durationKm > 0.5) filteredPlan[key] = plan[key]; });
            return filteredPlan;
        }
    },

    onPlanConfigChange: function() {
        // Optional: auto-update preview, for now just visual feedback
    },

    generateDynamicPlan: function() {
        var goalDist = parseFloat(document.getElementById('goal-distance').value);
        var totalWeeks = parseInt(document.getElementById('plan-weeks').value);
        var freq = parseInt(document.getElementById('plan-frequency').value);
        var baseVolume = parseFloat(document.getElementById('plan-base-volume').value) || 5;
        
        if (freq < 2) { this.speak('Minimaal 2 trainingen per week vereist'); return; }
        
        var isConditioning = (goalDist === 0 || isNaN(goalDist));
        
        // Calculate target volume
        var targetVolume;
        if (isConditioning) {
            // For conditie, gradually increase base volume by 50-100% over the weeks
            targetVolume = Math.min(baseVolume * 2, baseVolume + 15);
        } else {
            targetVolume = Math.max(baseVolume * 1.1, Math.min(goalDist * 0.7, baseVolume * 3));
        }
        
        // Generate weekly volumes with scientific periodization (every 4th week taper)
        var volumes = this.PERIODIZATION.generateWeeklyVolumes(targetVolume, totalWeeks);
        
        // Estimate VDOT from base volume pace
        var estPace = baseVolume > 0 ? (freq * 30) / baseVolume : 0;
        var vdot = this.VDOT.fromPaceMinPerKm(estPace > 0 ? estPace : 30);
        if (vdot < 20) vdot = 30;
        
        var planName = isConditioning ? 
            '🏃 Conditie in ' + totalWeeks + ' weken (' + freq + 'x/w)' : 
            goalDist + 'km in ' + totalWeeks + ' weken (' + freq + 'x/w)';
        
        var plan = {
            name: planName,
            goalDist: goalDist,
            totalWeeks: totalWeeks,
            frequency: freq,
            baseVolume: baseVolume,
            weeks: []
        };
        
        for (var w = 0; w < totalWeeks; w++) {
            var weekVolume = volumes[w] || targetVolume;
            var sessionPlan = this.POLARIZED_FIXED.distributeWeeklyVolume(weekVolume, freq);
            var currentVdot = Math.round(vdot + (w / totalWeeks) * 3); // Slight progression
            var trainingPaces = this.VDOT.getTrainingPaces(currentVdot);
            
            var weekObj = { w: w + 1 };
            var keys = Object.keys(sessionPlan).sort();
            
            keys.forEach(function(key, idx) {
                var s = sessionPlan[key];
                var totalSec = Math.round((s.durationKm / 5.0) * 3600);
                var blocks = [];
                
                if (s.type === 'EASY' || s.type === 'RECOVERY') {
                    blocks = [
                        { m: 'warmup', s: 'Warming-up', t: 300 },
                        { m: 'jog', s: s.type === 'EASY' ? 'Zone 2 Duurloop (' + trainingPaces.easy.display + '/km)' : 'Actief Herstel', t: totalSec },
                        { m: 'warmup', s: 'Cool-down', t: 300 }
                    ];
                } else if (s.type === 'LONG') {
                    blocks = [
                        { m: 'warmup', s: 'Warming-up', t: 300 },
                        { m: 'run', s: 'Lange Duurloop (Zone 2 - ' + trainingPaces.easy.display + '/km)', t: totalSec },
                        { m: 'warmup', s: 'Cool-down', t: 300 }
                    ];
                } else if (s.type === 'HIT') {
                    // HIIT session with intervals based on vdot
                    var intervalPace = trainingPaces.interval.display;
                    var repCount = Math.min(8, Math.max(4, Math.round(freq + w)));
                    var blocks = [{ m: 'warmup', s: 'Warming-up', t: 300 }, { m: 'jog', s: 'Jog', t: 120 }];
                    for (var r = 0; r < repCount; r++) {
                        blocks.push({ m: 'sprint', s: 'Interval (' + intervalPace + '/km)', t: 60 });
                        blocks.push({ m: 'jog', s: 'Actief Herstel', t: 90 });
                    }
                    blocks.push({ m: 'jog', s: 'Jog', t: 120 });
                    blocks.push({ m: 'warmup', s: 'Cool-down', t: 300 });
                }
                
                weekObj['t' + (idx + 1)] = { label: s.label, b: blocks };
            });
            
            plan.weeks.push(weekObj);
        }
        
        // Save plan
        DB.saveDynamicPlan(plan);
        this.refreshPlanDisplay();
        var speechMsg = isConditioning ? 
            'Conditieplan gegenereerd voor ' + totalWeeks + ' weken, ' + freq + ' keer per week' : 
            'Trainingsplan gegenereerd voor ' + goalDist + ' kilometer in ' + totalWeeks + ' weken';
        this.speak(speechMsg);
    },

    clearDynamicPlan: function() {
        if (confirm('Weet je zeker dat je dit plan wilt verwijderen?')) {
            DB.clearDynamicPlan();
            this.refreshPlanDisplay();
        }
    },

    refreshPlanDisplay: function() {
        var plan = DB.getDynamicPlan();
        UI.renderDynamicPlan(plan);
    },

    // ==============================================
    // Run History
    // ==============================================
    viewRun: function(id) {
        STATE._viewingHistoryRun = true;
        DB.get(id, function(data) {
            if (!data) return;
            STATE.viewedRoute = data.route || [];
            document.getElementById('res-d').innerText = data.dist;
            var paceNum = parseFloat(data.pace) || 0;
            if (paceNum > 0) {
                var paceMin = Math.floor(paceNum);
                var paceSec = Math.round((paceNum - paceMin) * 60);
                document.getElementById('res-p').innerText = paceMin + ':' + paceSec.toString().padStart(2, '0');
            } else {
                document.getElementById('res-p').innerText = '0:00';
            }
            document.getElementById('res-time').innerText = APP.formatT(data.duration || 0);
            document.getElementById('res-cal').innerText = data.calories || 0;
            var ss = parseFloat(data.sprintTime) || 0;
            var rs = parseFloat(data.runTime) || 0;
            var js = parseFloat(data.jogTime) || 0;
            var ws = parseFloat(data.walkTime) || 0;
            var tc = ss + rs + js + ws;
            var sp = tc > 0 ? Math.round(ss / tc * 100) : 0;
            var rp = tc > 0 ? Math.round(rs / tc * 100) : 0;
            var jp = tc > 0 ? Math.round(js / tc * 100) : 0;
            var wp = tc > 0 ? Math.max(0, 100 - sp - rp - jp) : 0;
            document.getElementById('stat-sprint-percent').innerText = sp + '%'; document.getElementById('stat-run-percent').innerText = rp + '%';
            document.getElementById('stat-jog-percent').innerText = jp + '%'; document.getElementById('stat-walk-percent').innerText = wp + '%';
            document.getElementById('stat-sprint-bar').style.width = sp + '%'; document.getElementById('stat-run-bar').style.width = rp + '%';
            document.getElementById('stat-jog-bar').style.width = jp + '%'; document.getElementById('stat-walk-bar').style.width = wp + '%';
            document.getElementById('stat-sprint-time').innerText = APP.formatT(ss); document.getElementById('stat-run-time').innerText = APP.formatT(rs);
            document.getElementById('stat-jog-time').innerText = APP.formatT(js); document.getElementById('stat-walk-time').innerText = APP.formatT(ws);
            UI.renderResultMap(data.route || []);
            UI.renderPaceChart(data.paceData || []);
            UI.openResultScreen();
        });
    },

    shareResult: function() {
        if (navigator.share) navigator.share({ title: 'Mijn hardloopsessie', text: 'Zojuist ' + document.getElementById('res-d').innerText + ' km gelopen!' }).catch(function(e) {});
        else APP.speak('Delen niet beschikbaar');
    },

    generateShareImage: function() {
        var canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 800;
        var ctx = canvas.getContext('2d');

        // Top section: dark header with stats
        var headerHeight = 310;
        var gradient = ctx.createLinearGradient(0, 0, 0, headerHeight);
        gradient.addColorStop(0, '#1c1c1e'); gradient.addColorStop(1, '#2c2c2e');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, headerHeight);

        // App title
        ctx.fillStyle = 'white'; ctx.font = 'bold 48px Inter, sans-serif'; ctx.fillText('JellyLegs', 40, 100);
        // Stats
        ctx.fillStyle = '#ff6b00'; ctx.font = 'bold 24px Inter, sans-serif'; ctx.fillText('🏃‍♂️ ' + document.getElementById('res-d').innerText + ' km', 40, 170);
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '18px Inter, sans-serif'; ctx.fillText('⏱ ' + document.getElementById('res-time').innerText, 40, 220);
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '18px Inter, sans-serif'; ctx.fillText('🔥 ' + document.getElementById('res-cal').innerText + ' kcal', 40, 260);

        // Map area background
        var mapY = headerHeight;
        var mapHeight = canvas.height - mapY - 50; // Leave room for footer
        var mapLeft = 0;
        var mapTop = mapY;
        var mapWidth = canvas.width;
        
        // Map background color (like OpenStreetMap default tile color)
        ctx.fillStyle = '#f8f4f0';
        ctx.fillRect(mapLeft, mapTop, mapWidth, mapHeight);

        var route = STATE.viewedRoute || STATE.currentRoute || [];
        if (route.length >= 2) {
            // Calculate route bounds
            var minLat = Math.min.apply(null, route.map(function(p) { return p[0]; })), maxLat = Math.max.apply(null, route.map(function(p) { return p[0]; }));
            var minLng = Math.min.apply(null, route.map(function(p) { return p[1]; })), maxLng = Math.max.apply(null, route.map(function(p) { return p[1]; }));
            var lr = maxLat - minLat || 0.001; var lnr = maxLng - minLng || 0.001;
            
            // Padding around route (20% extra on each side)
            var padX = mapWidth * 0.05;
            var padY = mapHeight * 0.05;
            var drawW = mapWidth - padX * 2;
            var drawH = mapHeight - padY * 2;

            // Helper to convert lat/lng to canvas coordinates
            function toCanvas(lat, lng) {
                var x = ((lng - minLng) / lnr) * drawW + padX;
                var y = ((maxLat - lat) / lr) * drawH + mapTop + padY;
                return { x: x, y: y };
            }

            // Draw subtle grid lines (simulating map tile grid)
            ctx.strokeStyle = 'rgba(0,0,0,0.04)';
            ctx.lineWidth = 1;
            var gridSteps = 8;
            for (var i = 0; i <= gridSteps; i++) {
                var frac = i / gridSteps;
                // Vertical lines
                ctx.beginPath();
                ctx.moveTo(padX + frac * drawW, mapTop + padY);
                ctx.lineTo(padX + frac * drawW, mapTop + mapHeight - padY);
                ctx.stroke();
                // Horizontal lines
                ctx.beginPath();
                ctx.moveTo(padX, mapTop + padY + frac * drawH);
                ctx.lineTo(mapWidth - padX, mapTop + padY + frac * drawH);
                ctx.stroke();
            }

            // Draw minor roads (lighter, thinner lines simulating street grid)
            var roadColors = ['rgba(200,190,180,0.4)', 'rgba(210,200,190,0.3)'];
            for (var r = 0; r < 3; r++) {
                ctx.strokeStyle = roadColors[r % roadColors.length];
                ctx.lineWidth = r === 0 ? 2 : 1;
                for (var j = 0; j < 4; j++) {
                    var rFrac = (j + 1) / 5;
                    ctx.beginPath();
                    ctx.moveTo(toCanvas(minLat + lr * rFrac, minLng).x, toCanvas(minLat + lr * rFrac, minLng).y);
                    ctx.lineTo(toCanvas(minLat + lr * rFrac, maxLng).x, toCanvas(minLat + lr * rFrac, maxLng).y);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(toCanvas(minLat, minLng + lnr * rFrac).x, toCanvas(minLat, minLng + lnr * rFrac).y);
                    ctx.lineTo(toCanvas(maxLat, minLng + lnr * rFrac).x, toCanvas(maxLat, minLng + lnr * rFrac).y);
                    ctx.stroke();
                }
            }

            // Draw the route line
            ctx.strokeStyle = '#ff6b00';
            ctx.lineWidth = 10;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowColor = 'rgba(255,107,0,0.3)';
            ctx.shadowBlur = 12;
            ctx.beginPath();
            route.forEach(function(p, i) {
                var c = toCanvas(p[0], p[1]);
                if (i === 0) ctx.moveTo(c.x, c.y);
                else ctx.lineTo(c.x, c.y);
            });
            ctx.stroke();
            
            // Draw start marker (green dot)
            ctx.shadowBlur = 0;
            var startC = toCanvas(route[0][0], route[0][1]);
            ctx.fillStyle = '#30d158';
            ctx.beginPath();
            ctx.arc(startC.x, startC.y, 12, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = 'white';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('START', startC.x, startC.y + 24);

            // Draw end marker (red pin)
            var endC = toCanvas(route[route.length - 1][0], route[route.length - 1][1]);
            ctx.fillStyle = '#ff3b30';
            ctx.beginPath();
            ctx.arc(endC.x, endC.y, 12, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = 'white';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('FINISH', endC.x, endC.y + 24);
        } else {
            // No route data - show a placeholder message on the map area
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.font = '18px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Geen route beschikbaar', canvas.width / 2, mapTop + mapHeight / 2);
        }

        // Footer
        ctx.fillStyle = '#1c1c1e';
        ctx.fillRect(0, canvas.height - 50, canvas.width, 50);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('JellyLegs - Powered by AI', canvas.width / 2, canvas.height - 20);

        var link = document.createElement('a'); link.download = 'jellylegs-run.png'; link.href = canvas.toDataURL(); link.click();
    },

    exportAsGPX: function() {
        var route = STATE.viewedRoute || STATE.currentRoute || [];
        if (route.length === 0) { APP.speak('Geen route data beschikbaar'); return; }
        var gpx = '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>';
        route.forEach(function(p) { gpx += '<trkpt lat="' + p[0] + '" lon="' + p[1] + '"></trkpt>'; });
        gpx += '</trkseg></trk></gpx>';
        var blob = new Blob([gpx], { type: 'application/gpx+xml' });
        var link = document.createElement('a'); link.download = 'jellylegs-route.gpx'; link.href = URL.createObjectURL(blob); link.click();
        URL.revokeObjectURL(link.href);
    },

    exportAsCSV: function() {
        DB.getAll(function(runs) {
            if (runs.length === 0) { APP.speak('Geen data om te exporteren'); return; }
            var csv = 'Datum,Tijd,Afstand (km),Duur (s),Pace (min/km),Calorieën,SprintTijd,RunTijd,JogTijd,WalkTijd\n';
            runs.forEach(function(r) { csv += [r.d, r.t || '', r.dist, r.duration || 0, r.pace || 0, r.calories || 0, r.sprintTime || 0, r.runTime || 0, r.jogTime || 0, r.walkTime || 0].join(',') + '\n'; });
            var blob = new Blob([csv], { type: 'text/csv' });
            var link = document.createElement('a'); link.download = 'jellylegs-export.csv'; link.href = URL.createObjectURL(blob); link.click();
            URL.revokeObjectURL(link.href);
        });
    },

    exportAllAsJSON: function() {
        DB.getAll(function(runs) {
            if (runs.length === 0) { APP.speak('Geen data om te exporteren'); return; }
            var json = JSON.stringify(runs, null, 2);
            var blob = new Blob([json], { type: 'application/json' });
            var link = document.createElement('a'); link.download = 'jellylegs-backup.json'; link.href = URL.createObjectURL(blob); link.click();
            URL.revokeObjectURL(link.href);
        });
    },

    connectHeartRateMonitor: function() {
        if (!navigator.bluetooth) { APP.speak('Bluetooth niet beschikbaar'); return; }
        APP.speak('Zoeken naar hartslagmeter...');
        navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] }).then(function(device) {
            STATE.heartRateDevice = device;
            return device.gatt.connect();
        }).then(function(server) { return server.getPrimaryService('heart_rate'); }).then(function(service) {
            return service.getCharacteristic('heart_rate_measurement');
        }).then(function(characteristic) {
            STATE.heartRateCharacteristic = characteristic;
            characteristic.addEventListener('characteristicvaluechanged', function(event) {
                var value = event.target.value;
                var flags = value.getUint8(0);
                var hr16Bit = flags & 0x1;
                STATE.currentHeartRate = hr16Bit ? value.getUint16(1, true) : value.getUint8(1);
                var display = document.getElementById('hr-zones-display');
                if (display) {
                    var age = parseInt(LS.get('user_age', '30'));
                    var zones = APP.POLARIZED.getHeartRateZones(age);
                    var zone = STATE.currentHeartRate <= zones.zone1.high ? 'Z1' : STATE.currentHeartRate <= zones.zone2.high ? 'Z2' : STATE.currentHeartRate <= zones.zone3.high ? 'Z3' : 'Z4';
                    display.innerHTML = '<div style="font-size: 32px; font-weight: 900; color: var(--danger); text-align: center; margin-bottom: 8px;">❤️ ' + STATE.currentHeartRate + ' bpm</div><div style="font-size: 13px; font-weight: 800; color: var(--primary); margin-bottom: 10px;">Max HR: ~' + zones.hrMax + ' bpm | Zone: ' + zone + '</div><div style="display: flex; flex-direction: column; gap: 5px;">' + Object.keys(zones).filter(function(k) { return k.startsWith('zone'); }).map(function(k) { return '<div style="display: flex; justify-content: space-between; font-size:12px;"><span style="font-weight:700; color:' + (zone === k.toUpperCase() ? 'var(--danger)' : 'var(--text-muted)') + ';">' + k.toUpperCase() + '</span><span>' + zones[k].low + '-' + zones[k].high + ' bpm</span></div>'; }).join('') + '</div>';
                }
            });
            return characteristic.startNotifications();
        }).then(function() {
            APP.speak('Hartslagmeter gekoppeld!');
        }).catch(function(err) {
            console.warn('Bluetooth fout:', err);
            APP.speak('Koppelen mislukt. Probeer opnieuw.');
        });
    },

    closeApp: function() {
        if ('onbeforeunload' in window) window.close();
        else APP.speak('Sluit het tabblad om de app te verlaten');
    }
};

// ==============================================
// WEBGL SHADER BACKGROUND ANIMATION
// ==============================================
(function initShader() {
    var canvas = document.getElementById('shader-canvas');
    if (!canvas) return;
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return;

    function resizeShaderCanvas() {
        var displayWidth = canvas.clientWidth;
        var displayHeight = canvas.clientHeight;
        if (canvas.width !== displayWidth * window.devicePixelRatio || canvas.height !== displayHeight * window.devicePixelRatio) {
            canvas.width = displayWidth * window.devicePixelRatio;
            canvas.height = displayHeight * window.devicePixelRatio;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }
    }

    var vsSource = [
        'attribute vec2 position;',
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = position * 0.5 + 0.5;',
        '  gl_Position = vec4(position, 0.0, 1.0);',
        '}'
    ].join('\n');

    var fsSource = [
        'precision highp float;',
        'varying vec2 vUv;',
        'uniform float uTime;',
        'uniform float uLight;',
        'void main() {',
        '  vec2 uv = vUv;',
        '  float wave1 = sin(uv.x * 5.0 + uTime * 0.4) * cos(uv.y * 4.0 + uTime * 0.25);',
        '  float wave2 = cos(uv.y * 6.0 - uTime * 0.35) * sin(uv.x * 3.0 + uTime * 0.5);',
        '  float wave3 = sin((uv.x + uv.y) * 3.5 + uTime * 0.45) * 0.5;',
        '  float combined = wave1 * 0.4 + wave2 * 0.35 + wave3 * 0.25;',
        '  combined = combined * 0.5 + 0.5;',
        '  vec3 darkColor = vec3(0.25, 0.18, 0.08);',
        '  vec3 midColor = vec3(0.65, 0.55, 0.25);',
        '  vec3 lightColor = vec3(0.95, 0.85, 0.55);',
        '  vec3 col1 = mix(darkColor, midColor, combined);',
        '  vec3 col2 = mix(midColor, lightColor, combined * 0.8);',
        '  float blend = sin(uv.x * 2.0 + uv.y * 1.5 + uTime * 0.1) * 0.5 + 0.5;',
        '  vec3 finalColor = mix(col1, col2, blend);',
        '  float vignette = 1.0 - length(uv - 0.5) * 0.8;',
        '  finalColor *= mix(0.7, 1.0, uLight);',
        '  finalColor *= vignette;',
        '  gl_FragColor = vec4(finalColor, 1.0);',
        '}'
    ].join('\n');

    function createShader(type, source) {
        var s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn('Shader compile error:', gl.getShaderInfoLog(s));
            gl.deleteShader(s); return null;
        }
        return s;
    }

    var vs = createShader(gl.VERTEX_SHADER, vsSource);
    var fs = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    var program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn('Shader link error'); return; }

    var positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    var posLoc = gl.getAttribLocation(program, 'position');
    var timeLoc = gl.getUniformLocation(program, 'uTime');
    var lightLoc = gl.getUniformLocation(program, 'uLight');

    resizeShaderCanvas();
    window.addEventListener('resize', resizeShaderCanvas);

    function getLightValue() { return document.body.classList.contains('light-mode') ? 0.0 : 1.0; }
    function getClearColor() { return document.body.classList.contains('light-mode') ? [0.95, 0.93, 0.90, 1] : [0, 0, 0, 1]; }

    function shaderLoop(time) {
        time *= 0.002;
        resizeShaderCanvas();
        var cc = getClearColor();
        gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!document.body.classList.contains('light-mode')) {
            gl.useProgram(program);
            gl.enableVertexAttribArray(posLoc);
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
            gl.uniform1f(timeLoc, time);
            gl.uniform1f(lightLoc, getLightValue());
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        requestAnimationFrame(shaderLoop);
    }
    requestAnimationFrame(shaderLoop);
})();

// ==============================================
// BOOTSTRAP
// ==============================================
document.addEventListener('DOMContentLoaded', function() {
    DB.init(function() { APP.init(); });
});