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
        LS.set('user_weight', document.getElementById('user-weight').value);
        LS.set('user_height', document.getElementById('user-height').value);
        LS.set('user_age', document.getElementById('user-age').value);
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
            document.querySelectorAll('.tab-view').forEach(t => { if(t.id !== 'timer-display') t.classList.remove('active'); });
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById('tab-' + tabName).classList.add('active');
            element.classList.add('active');
            APP.vibrate([30]);
        };
        if ('startViewTransition' in document) document.startViewTransition(fn);
        else fn();
    },

    nextOnboardingStep: function() {
        document.getElementById('onboard-step-1').classList.remove('active');
        document.getElementById('onboard-step-2').classList.add('active');
    },

    openCustomPlanSheet: function() { document.getElementById('custom-plan-sheet').classList.add('active'); },
    closeCustomPlanSheet: function(e) { if (e) e.stopPropagation(); document.getElementById('custom-plan-sheet').classList.remove('active'); },

    openResultScreen: function() { document.getElementById('result-screen').classList.add('active'); },
    closeResultScreen: function(reload) {
        document.getElementById('result-screen').classList.remove('active');
        if (reload) setTimeout(() => location.reload(), 400);
    },

    renderRecentActivity: function(runs) {
        var sorted = runs.slice().sort(function(a, b) { return b.id - a.id; });
        var dateEl = document.getElementById('recent-activity-date');
        var distEl = document.getElementById('recent-activity-distance');
        var timeEl = document.getElementById('recent-activity-time');
        var paceEl = document.getElementById('recent-activity-pace');
        var mapEl = document.getElementById('recent-activity-map');

        if (sorted.length > 0) {
            var latest = sorted[0];
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
            // If the run has route data, render a mini leaflet map
            if (latest.route && latest.route.length >= 2) {
                this._renderMiniRoute(mapEl, latest.route);
            } else {
                // Use CSS placeholder route
                mapEl.innerHTML = '<div class="map-mini-route"></div>';
            }
        } else {
            dateEl.innerText = 'Geen sessies';
            distEl.innerText = '-- KM';
            timeEl.innerText = 'Tijd --:--';
            paceEl.innerText = 'Tempo --:-- min/km';
            mapEl.innerHTML = '<div class="map-mini-route"></div>';
        }
    },

    _renderMiniRoute: function(container, route) {
        container.innerHTML = '';
        // Create a mini SVG canvas sized to the container
        var svgNS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.style.position = 'absolute';
        svg.style.inset = '0';

        var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        route.forEach(function(p) {
            if (p[0] < minLat) minLat = p[0];
            if (p[0] > maxLat) maxLat = p[0];
            if (p[1] < minLng) minLng = p[1];
            if (p[1] > maxLng) maxLng = p[1];
        });
        var pad = 0.0002;
        if (maxLat - minLat < 0.0005) { minLat -= pad; maxLat += pad; }
        if (maxLng - minLng < 0.0005) { minLng -= pad; maxLng += pad; }
        var latRange = maxLat - minLat || 0.001;
        var lngRange = maxLng - minLng || 0.001;

        var polyline = document.createElementNS(svgNS, 'polyline');
        var points = route.map(function(p) {
            var x = ((p[1] - minLng) / lngRange) * 90 + 5;
            var y = ((maxLat - p[0]) / latRange) * 90 + 5;
            return x + ',' + y;
        }).join(' ');
        polyline.setAttribute('points', points);
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', 'var(--primary)');
        polyline.setAttribute('stroke-width', '3');
        polyline.setAttribute('stroke-linecap', 'round');
        polyline.setAttribute('stroke-linejoin', 'round');
        polyline.setAttribute('opacity', '0.7');
        svg.appendChild(polyline);

        // Start dot
        if (route.length > 0) {
            var sx = ((route[0][1] - minLng) / lngRange) * 90 + 5;
            var sy = ((maxLat - route[0][0]) / latRange) * 90 + 5;
            var startDot = document.createElementNS(svgNS, 'circle');
            startDot.setAttribute('cx', sx);
            startDot.setAttribute('cy', sy);
            startDot.setAttribute('r', '3');
            startDot.setAttribute('fill', 'var(--success)');
            svg.appendChild(startDot);
        }
        // End dot
        if (route.length > 1) {
            var last = route[route.length - 1];
            var ex = ((last[1] - minLng) / lngRange) * 90 + 5;
            var ey = ((maxLat - last[0]) / latRange) * 90 + 5;
            var endDot = document.createElementNS(svgNS, 'circle');
            endDot.setAttribute('cx', ex);
            endDot.setAttribute('cy', ey);
            endDot.setAttribute('r', '3');
            endDot.setAttribute('fill', 'var(--danger)');
            svg.appendChild(endDot);
        }
        container.appendChild(svg);
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
        const h = runs.slice().sort((a, b) => b.id - a.id);
        document.getElementById('history-list').innerHTML = h.slice(0, 10).map(r =>
            '<div class="history-item" onclick="APP.viewRun(' + r.id + ')"><div style="flex-grow:1"><div style="font-weight:800; font-size:14px;">' + r.n + '</div><div style="font-size:11px; color:var(--text-muted)">' + r.d + ' &bull; ' + r.dist + 'km</div></div><button class="delete-btn" aria-label="Verwijder activiteit" onclick="DB.delete(event, ' + r.id + ')">🗑️</button></div>'
        ).join('') || '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:10px">Nog geen activiteiten</div>';
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
            var fmtPace = function(p) { if (p <= 0) return '--'; return Math.floor(p) + ':' + Math.round((p - Math.floor(p)) * 60).toString().padStart(2, '0'); };
            var tAvg = tw.totalDist > 0 ? (tw.totalTime / 60) / tw.totalDist : 0;
            var lAvg = lw.totalDist > 0 ? (lw.totalTime / 60) / lw.totalDist : 0;
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
                tl += '<div class="history-item" onclick="APP.viewRun(' + r.id + ')"><div style="flex-grow:1"><div style="font-weight:800; font-size:14px;">' + r.n + '</div><div style="font-size:11px; color:var(--text-muted)">' + r.d + ' &bull; ' + r.dist + 'km &bull; ' + APP.formatT(r.duration || 0) + '</div></div><div style="color:var(--primary); font-weight:900; font-size:18px;">›</div></div>';
            });
            tl += '</div>';
        });
        tc.innerHTML = tl;
    },

    _renderCalendarHeatmap: function(runs) {
        var hc = document.getElementById('calendar-heatmap');
        if (!hc) {
            var dt = document.getElementById('tab-data');
            var c = dt.querySelector('.card');
            var nc = document.createElement('div'); nc.className = 'card';
            nc.innerHTML = '<span class="dash-label">🔥 Activiteiten Kalender</span><div id="calendar-heatmap" style="margin-top: 14px;"></div>';
            c.parentElement.insertBefore(nc, c.nextSibling);
            hc = document.getElementById('calendar-heatmap');
        }
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

    renderPlan: function() {
        var pk = document.getElementById('plan-select').value;
        var list = document.getElementById('app-list');
        list.innerHTML = '';
        if (!STATE.schemas[pk]) return;
        STATE.schemas[pk].weeks.forEach(function(w, i) {
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

    openPreview: function(plan, wIdx, type) {
        STATE.activePlanKey = plan;
        STATE.activeWeekIdx = wIdx;
        STATE.activeType = type;
        var training = STATE.schemas[plan].weeks[wIdx][type];
        STATE.sessionBlocks = APP.applyCustomTimings(training.b);
        document.getElementById('pre-title').innerText = training.label;
        document.getElementById('pre-time').innerText = Math.round(STATE.sessionBlocks.reduce(function(a, b) { return a + b.t; }, 0) / 60) + ' min';
        document.getElementById('pre-type').innerText = STATE.schemas[plan].name;
        var maxT = Math.max.apply(null, STATE.sessionBlocks.map(function(b) { return b.t; }));
        document.getElementById('pre-chart').innerHTML = STATE.sessionBlocks.map(function(b) { return '<div class="bar ' + b.m + '" style="height:' + Math.max(15, (b.t / maxT) * 100) + '%"><span>' + Math.round(b.t / 60) + 'm</span></div>'; }).join('');
        document.getElementById('preview-overlay').style.display = 'flex';
    },

    initLiveMap: function() {
        if (!this.liveMapEnabled) return;
        document.getElementById('live-training-map').style.display = 'block';
        if (this.liveMapInstance) this.liveMapInstance.remove();
        this.liveMapInstance = L.map('live-training-map', { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(this.liveMapInstance);
        this.livePolyline = L.polyline([], { color: '#ff6b00', weight: 5 }).addTo(this.liveMapInstance);
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
                    if (pace === 0) color = 'var(--text-muted)'; // Muted grey for no pace data or very slow
                    else if (pace < 4.0) color = 'var(--danger)'; // Sprint (Danger Red)
                    else if (pace < 6.5) color = 'var(--primary)'; // Run (Primary Orange)
                    else if (pace < 9.0) color = 'var(--success)'; // Jog (Success Green)
                    else color = 'var(--warning)'; // Walk (Warning Yellow)
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
        var content = document.createElement('div');
        content.className = 'card';
        content.style.cssText = 'width:100%;max-width:480px;margin:auto;';
        var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px"><h2 style="margin:0">📜 Wijzigingen</h2><button class="clear-history-btn" onclick="this.closest(\'#changelog-overlay\').remove()">Sluiten</button></div>';
        APP.CHANGELOG.forEach(function(e) {
            html += '<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:var(--border)"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span style="font-size:14px;font-weight:900;color:var(--primary)">v' + e.version + '</span><span style="font-size:10px;font-weight:600;color:var(--text-muted)">' + e.date + '</span></div><ul style="margin:0;padding-left:18px;font-size:12px;">';
            e.changes.forEach(function(c) { html += '<li style="margin-bottom:3px;">' + c + '</li>'; });
            html += '</ul></div>';
        });
        content.innerHTML = html;
        overlay.appendChild(content);
        document.getElementById('app-container').appendChild(overlay);
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
    currentHeartRate: 0, countdownInterval: null, schemas: {}
};

// ==============================================
// APP LOGIC (APP)
// ==============================================
const APP = {
    CHANGELOG: [
        { version: '1.5.0', date: '15-05-2026', changes: [
            '🎨 RunFlow Visual Design Update (compleet vernieuwde UI)',
            '🚀 5 complete trainingsschema\'s: conditie, 5KM beginner, 5KM ervaren, 10KM, Halve Marathon',
            '📊 8-weken schema\'s met intervallen, duurlopen, drempeltraining en taper-weken',
            '🎯 Wetenschappelijk AI plan generator met VDOT, ACWR, polarized training en periodization',
            '✨ Overige functies identiek aan JellyLegs V1.5'
        ]},
        { version: '1.1.0', date: '08-05-2026', changes: [
            '✨ Kaart in resultatenscherm is nu licht (OpenStreetMap) i.p.v. donker',
            '🐛 Donkere flits bij laden kaart verholpen',
            '📦 Versiebeheer systeem toegevoegd met changelog',
            '🗺️ Route-minimap toegevoegd aan share afbeelding'
        ]},
        { version: '1.0.0', date: '01-05-2026', changes: [
            '🎉 Eerste volledige release van JellyLegs',
            '🏃 Training schema\'s voor 3km, 5km, 10km en halve marathon',
            '📍 GPS tracking met live kaart tijdens het hardlopen',
            '📊 Gedetailleerde resultaten met pace grafiek',
            '🔥 Streak tracking en persoonlijke records',
            '❤️ Bluetooth hartslagmeter ondersteuning',
            '📤 Deel resultaten via social media',
            '🖼️ Generate share afbeelding voor Instagram',
            '📍 GPX export voor Strava/Garmin',
            '🎯 Wetenschappelijk 80/20 trainingsplan generator met ACWR'
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
        
        var cp = DB.getCustomPlan();
        if (cp) STATE.schemas['custom'] = cp;

        var ps = document.getElementById('plan-select');
        ps.innerHTML = Object.keys(STATE.schemas).map(function(k) { return '<option value="' + k + '">' + STATE.schemas[k].name + '</option>'; }).join('');
        var sp = LS.get('strive_selected_plan');
        ps.value = (sp && STATE.schemas[sp]) ? sp : Object.keys(STATE.schemas)[0];
        LS.set('strive_selected_plan', ps.value);

        this._loadSettings();

        DB.getAll(function(runs) {
            UI.renderDashboard(runs);
            UI.renderDataTab(runs);
            UI.renderRecentActivity(runs);
            APP.renderWeekTotal(runs);
        });

        UI.renderPlan();
        setTimeout(function() { APP.addDeletePlanButton(); }, 100);

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

    saveSelectedPlan: function() {
        LS.set('strive_selected_plan', document.getElementById('plan-select').value);
        UI.renderPlan();
        this.addDeletePlanButton();
    },

    addDeletePlanButton: function() {
        var existing = document.getElementById('delete-plan-btn');
        if (existing) existing.remove();
        var sel = document.getElementById('plan-select').value;
        if (sel === 'custom' && STATE.schemas['custom']) {
            var btn = document.createElement('button');
            btn.id = 'delete-plan-btn';
            btn.className = 'btn btn-ghost';
            btn.style.cssText = 'margin-top:10px; color:var(--danger);';
            btn.innerText = '🗑️ VERWIJDER PLAN';
            btn.onclick = function() { APP.deletePersonalPlan(); };
            document.getElementById('plan-select').parentElement.appendChild(btn);
        }
    },

    deletePersonalPlan: function() {
        if (confirm('Weet je zeker dat je dit persoonlijke plan wilt verwijderen?')) {
            delete STATE.schemas['custom'];
            var ps = document.getElementById('plan-select');
            var co = ps.querySelector('option[value="custom"]');
            if (co) co.remove();
            LS.remove('jellylegs_custom_plan');
            ps.value = Object.keys(STATE.schemas)[0];
            LS.set('strive_selected_plan', ps.value);
            var db = document.getElementById('delete-plan-btn');
            if (db) db.remove();
            UI.renderPlan();
            this.speak('Persoonlijk plan verwijderd');
        }
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
        UI.renderPlan();
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
        generateWeeklyVolumes: function(chronicLoad, weeks) {
            weeks = weeks || 8; var volumes = []; var currentVolume = chronicLoad;
            for (var w = 1; w <= weeks; w++) {
                if (w % 4 === 0) volumes.push(Math.round(currentVolume * 0.5 * 10) / 10);
                else { currentVolume = currentVolume * ((w % 4 === 1) ? 1.10 : 1.08); volumes.push(Math.round(currentVolume * 10) / 10); }
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
        
        document.querySelectorAll('.tab-view').forEach(t => t.classList.remove('active'));
        document.getElementById('timer-display').classList.add('active');

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
        STATE.watchId = navigator.geolocation.watchPosition(function(p) {
            if (STATE.isPaused || p.coords.accuracy > 40) return;
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
        }, function(err) { console.warn('GPS Fout', err); APP.speak('Geen GPS-signaal. Beweging wordt niet geregistreerd.'); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
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
        document.getElementById('tab-home').classList.add('active');

        var ts = STATE.activeSeconds; var dm = ts / 60;
        var pace = STATE.totalDist > 0.1 ? (dm / STATE.totalDist).toFixed(2) : '0.00';
        var cal = this.calculateCalories(STATE.totalDist, dm);

        document.getElementById('res-d').innerText = STATE.totalDist.toFixed(2);
        document.getElementById('res-p').innerText = pace;
        document.getElementById('res-time').innerText = this.formatT(ts);
        document.getElementById('res-cal').innerText = cal;

        var speechText = 'Sessie voltooid! ';
        if (STATE.totalDist > 0.1) speechText += STATE.totalDist.toFixed(2) + ' kilometer gerend in ' + this.formatT(ts) + '. ';
        this.speak(speechText);

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
        document.getElementById('stat-sprint-time').innerText = this.formatT(Math.round(ss));
        document.getElementById('stat-run-time').innerText = this.formatT(Math.round(rs));
        document.getElementById('stat-jog-time').innerText = this.formatT(Math.round(js));
        document.getElementById('stat-walk-time').innerText = this.formatT(Math.round(ws));

        if (STATE.activePlanKey !== undefined) LS.set('done_' + STATE.activePlanKey + '_' + STATE.activeWeekIdx + '_' + STATE.activeType, 'true');

        var run = { d: new Date().toLocaleDateString('nl-NL'), n: document.getElementById('pre-title').innerText, dist: STATE.totalDist.toFixed(2), pace: pace, duration: ts, calories: cal, route: STATE.currentRoute, paceHistory: STATE.paceData };
        DB.add(run, function() {
            UI.openResultScreen();
            setTimeout(function() { UI.renderResultMap(run.route); UI.renderPaceChart(run.paceHistory); }, 400);
        });
    },

    viewRun: function(id) {
        DB.get(id, function(run) {
            document.getElementById('res-title').innerText = run.n;
            document.getElementById('res-d').innerText = run.dist;
            document.getElementById('res-p').innerText = run.pace;
            document.getElementById('res-time').innerText = APP.formatT(run.duration || 0);
            document.getElementById('res-cal').innerText = run.calories || 0;
            STATE.viewedRoute = run.route || [];
            UI.openResultScreen();
            var ts = run.duration || 0, pd = run.paceHistory || [];
            var ss = 0, rs = 0, js = 0, ws = 0;
            if (pd.length > 0) {
                pd.forEach(function(p) { var v = parseFloat(p); if (v < 4.0) ss += 30; else if (v < 6.5) rs += 30; else if (v < 9.0) js += 30; else ws += 30; });
                var tot = ss + rs + js + ws;
                if (tot > 0) { var r = ts / tot; ss *= r; rs *= r; js *= r; ws *= r; }
            } else { var ap = parseFloat(run.pace); if (ap < 4.0) ss = ts; else if (ap < 6.5) rs = ts; else if (ap < 9.0) js = ts; else ws = ts; }
            var tc = ss + rs + js + ws;
            var sp = tc > 0 ? Math.round((ss / tc) * 100) : 0; var rp = tc > 0 ? Math.round((rs / tc) * 100) : 0;
            var jp = tc > 0 ? Math.round((js / tc) * 100) : 0; var wp = tc > 0 ? Math.max(0, 100 - sp - rp - jp) : 0;
            document.getElementById('stat-sprint-percent').innerText = sp + '%'; document.getElementById('stat-run-percent').innerText = rp + '%';
            document.getElementById('stat-jog-percent').innerText = jp + '%'; document.getElementById('stat-walk-percent').innerText = wp + '%';
            document.getElementById('stat-sprint-bar').style.width = sp + '%'; document.getElementById('stat-run-bar').style.width = rp + '%';
            document.getElementById('stat-jog-bar').style.width = jp + '%'; document.getElementById('stat-walk-bar').style.width = wp + '%';
            document.getElementById('stat-sprint-time').innerText = APP.formatT(Math.round(ss)); document.getElementById('stat-run-time').innerText = APP.formatT(Math.round(rs));
            document.getElementById('stat-jog-time').innerText = APP.formatT(Math.round(js)); document.getElementById('stat-walk-time').innerText = APP.formatT(Math.round(ws));
            setTimeout(function() { UI.renderResultMap(run.route || []); UI.renderPaceChart(run.paceHistory || []); }, 400);
        });
    },

    renderWeekTotal: function(runs) {
        var wd = DB.processWeeklyData(runs);
        var currentWeek = wd.length > 0 ? wd[0] : null;
        var currentDist = currentWeek ? currentWeek.totalDist : 0;
        var ubv = parseFloat(LS.get('user_base_volume', '5')) || 5;
        var target = Math.max(ubv * 1.1, 5);
        var pct = Math.min((currentDist / target) * 100, 100);
        
        var fill = document.getElementById('week-progress-fill');
        var currentEl = document.getElementById('week-progress-current');
        var targetEl = document.getElementById('week-progress-target');
        
        if (fill) fill.style.width = Math.max(2, pct) + '%';
        if (currentEl) currentEl.innerText = currentDist.toFixed(1) + ' KM gelopen';
        if (targetEl) targetEl.innerText = target.toFixed(1);
    },

    startBaselineTest: function() {
        STATE.activePlanKey = 'baseline'; STATE.activeWeekIdx = 0; STATE.activeType = 't1';
        var ws = (parseInt(LS.get('warmup_time', '5'))) * 60; var cs = (parseInt(LS.get('cooldown_time', '5'))) * 60;
        STATE.sessionBlocks = [{ t: ws, s: 'Warming-up', m: 'warmup' }, { t: 1800, s: 'Loop op je eigen tempo', m: 'run' }, { t: cs, s: 'Cool-down', m: 'warmup' }];
        STATE.sessionBlocks = this.applyCustomTimings(STATE.sessionBlocks);
        document.getElementById('pre-title').innerText = '📊 30 Minuten Baseline Test';
        document.getElementById('pre-time').innerText = Math.round(STATE.sessionBlocks.reduce(function(a, b) { return a + b.t; }, 0) / 60) + ' min';
        document.getElementById('pre-type').innerText = 'Basis Test';
        var mt = Math.max.apply(null, STATE.sessionBlocks.map(function(b) { return b.t; }));
        document.getElementById('pre-chart').innerHTML = STATE.sessionBlocks.map(function(b) { return '<div class="bar ' + b.m + '" style="height:' + Math.max(15, (b.t / mt) * 100) + '%"><span>' + Math.round(b.t / 60) + 'm</span></div>'; }).join('');
        document.getElementById('preview-overlay').style.display = 'flex';
    },

    _generateSessionBlocks: function(type, durationMin, ws, cs, age) {
        ws = ws || (parseInt(LS.get('warmup_time', '5'))) * 60;
        cs = cs || (parseInt(LS.get('cooldown_time', '5'))) * 60;
        var workTime = (durationMin * 60) - ws - cs;
        if (workTime < 60) workTime = 60;

        if (type === 'EASY' || type === 'RECOVERY') {
            return [{ t: ws, s: 'Warming-up', m: 'warmup' }, { t: Math.round(workTime), s: 'Zone 2 Easy Run (Rustig)', m: 'run' }, { t: cs, s: 'Cool-down', m: 'warmup' }];
        }
        if (type === 'LONG') {
            var stridesTime = Math.min(workTime, 300); var longRunTime = workTime - stridesTime;
            var blocks = [{ t: ws, s: 'Warming-up', m: 'warmup' }, { t: Math.round(longRunTime), s: '🏃 Lange Duurloop (Zone 2)', m: 'run' }];
            if (stridesTime >= 240) { for (var si = 0; si < 4; si++) { blocks.push({ t: 30, s: '⚡ Strides', m: 'sprint' }); blocks.push({ t: 30, s: '🟢 Rustig joggen', m: 'jog' }); } }
            blocks.push({ t: cs, s: 'Cool-down', m: 'warmup' }); return blocks;
        }
        if (type === 'HIT') {
            var cycleTime = 4 * 60 + 3 * 60; var numCycles = Math.max(2, Math.min(5, Math.floor(workTime / cycleTime)));
            var actualWork = numCycles * 4 * 60; var actualRest = numCycles * 3 * 60; var remaining = workTime - actualWork - actualRest;
            var blocks = [{ t: ws, s: 'Warming-up', m: 'warmup' }];
            for (var ci = 0; ci < numCycles; ci++) { blocks.push({ t: 240, s: '🔴 HIT: 4min Tempo', m: 'run' }); blocks.push({ t: 180, s: '🟢 Actief Herstel', m: 'jog' }); }
            if (remaining > 30) blocks.push({ t: Math.round(remaining), s: '✅ Uitlopen', m: 'jog' });
            blocks.push({ t: cs, s: 'Cool-down', m: 'warmup' }); return blocks;
        }
        return [{ t: ws, s: 'Warming-up', m: 'warmup' }, { t: Math.round(workTime), s: 'Duurloop', m: 'run' }, { t: cs, s: 'Cool-down', m: 'warmup' }];
    },

    generateCustomPlan: function() {
        var freq = parseInt(document.getElementById('train-frequency').value);
        var goal = document.getElementById('train-goal').value;
        var ubv = parseFloat(document.getElementById('user-base-volume').value) || 5;
        var age = parseInt(LS.get('user_age', '30'));
        var goalDistMap = { '3km': 3, '5km': 5, '10km': 10, 'halve': 21.1 };
        var goalDist = goalDistMap[goal] || 5;

        DB.getAll(function(runs) {
            var acwrData = APP.ACWR.calculate(runs, ubv);
            var chronicLoad = acwrData.chronicLoad;
            var baselineRun = runs.slice().reverse().find(function(r) { return r.n.includes('Baseline') && r.pace; });
            var vdot = 30; var baselinePace = 7.0;
            if (baselineRun) { baselinePace = parseFloat(baselineRun.pace); vdot = APP.VDOT.fromPaceMinPerKm(baselinePace); }
            var paces = APP.VDOT.getTrainingPaces(vdot);
            var weeklyVolumes = APP.PERIODIZATION.generateWeeklyVolumes(chronicLoad, 8);
            var cw = [];
            for (var w = 0; w < weeklyVolumes.length; w++) {
                var weekNum = w + 1; var weekVol = weeklyVolumes[w]; var wd = { w: weekNum };
                var sessionPlan = APP.POLARIZED.distributeWeeklyVolume(weekVol, freq);
                var sc = 1; var sessionKeys = Object.keys(sessionPlan).sort();
                sessionKeys.forEach(function(key) {
                    var session = sessionPlan[key];
                    var sessionPace;
                    if (session.type === 'HIT') sessionPace = paces.threshold.minPerKm;
                    else if (session.type === 'LONG') sessionPace = paces.easy.minPerKm;
                    else if (session.type === 'EASY') sessionPace = paces.easy.minPerKm + 0.5;
                    else sessionPace = paces.easy.minPerKm + 1.0;
                    var sessionMinutes = Math.round(session.durationKm * sessionPace);
                    var blocks = APP._generateSessionBlocks(session.type, sessionMinutes, null, null, age);
                    wd['t' + sc] = { label: session.label + ' (' + session.durationKm.toFixed(1) + 'km)', b: blocks };
                    sc++;
                });
                cw.push(wd);
            }
            var cpd = { name: '🎯 AI Plan: ' + goal + ' (' + freq + 'x/week)', weeks: cw };
            STATE.schemas['custom'] = cpd;
            LS.set('jellylegs_custom_plan', JSON.stringify(cpd));
            var ps = document.getElementById('plan-select');
            if (!ps.querySelector('option[value="custom"]')) ps.innerHTML += '<option value="custom">' + cpd.name + '</option>';
            ps.value = 'custom'; LS.set('strive_selected_plan', 'custom');
            UI.renderPlan(); UI.closeCustomPlanSheet();
            APP.speak('AI Plan gegenereerd op basis van jouw data.');
        });
    },

    connectHeartRateMonitor: async function() {
        try {
            if (!navigator.bluetooth) { alert('Bluetooth wordt niet ondersteund in deze browser'); return; }
            this.vibrate([100, 50, 100]);
            STATE.heartRateDevice = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }], optionalServices: ['battery_service'] });
            var server = await STATE.heartRateDevice.gatt.connect();
            var service = await server.getPrimaryService('heart_rate');
            STATE.heartRateCharacteristic = await service.getCharacteristic('heart_rate_measurement');
            await STATE.heartRateCharacteristic.startNotifications();
            var age = parseInt(LS.get('user_age', '30'));
            var zones = APP.POLARIZED.getHeartRateZones(age);
            STATE.heartRateCharacteristic.addEventListener('characteristicvaluechanged', function(e) {
                var v = e.target.value, f = v.getUint8(0), r = f & 0x1 ? v.getUint16(1, true) : v.getUint8(1);
                STATE.currentHeartRate = r;
                if (r >= zones.zone4.low) APP.speak('Je hartslag is ' + r + ', maximaal! Let op je ademhaling.');
                else if (r >= zones.zone3.low) APP.speak('Goed bezig! Hartslag ' + r + ', drempel zone. Focus op tempo.');
                else if (r >= zones.zone2.low) APP.speak('Prima tempo, hartslag ' + r + ' in aerobe zone.');
            });
            this.speak('Hartslagmeter verbonden! Jouw max hartslag: ongeveer ' + zones.hrMax + ' bpm.');
        } catch (err) { console.warn('Hartslagmeter fout:', err); this.speak('Kon geen verbinding maken met de hartslagmeter'); }
    },

    shareResult: async function() {
        if (!navigator.share) { alert('Delen wordt niet ondersteund'); return; }
        try { await navigator.share({ title: '🏃 Mijn RunFlow run!', text: 'Ik heb net ' + document.getElementById('res-d').innerText + ' km gerund in ' + document.getElementById('res-time').innerText + '! Gemiddeld tempo: ' + document.getElementById('res-p').innerText + ' min/km', url: window.location.href }); } catch (e) {}
    },

    generateShareImage: async function() {
        try {
            document.getElementById('res-btn').innerText = 'GENEREREN...';
            var canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1080;
            var ctx = canvas.getContext('2d');
            var grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
            grad.addColorStop(0, '#ff6b00'); grad.addColorStop(1, '#ff8e3c');
            ctx.fillStyle = grad; ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            ctx.font = '900 60px Inter, sans-serif'; ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.fillText('RUNFLOW', 60, 90);
            ctx.font = '700 24px Inter, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.textAlign = 'right';
            ctx.fillText(new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase(), canvas.width - 60, 85);

            var mY = 160, mH = 600, mW = 960, mX = 60;
            ctx.save();
            ctx.beginPath(); ctx.roundRect(mX, mY, mW, mH, 30); ctx.clip();
            ctx.fillStyle = '#f2f2f7'; ctx.fill();

            var shareRoute = (STATE.viewedRoute && STATE.viewedRoute.length >= 2) ? STATE.viewedRoute : STATE.currentRoute;
            if (shareRoute && shareRoute.length >= 2) {
                var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                shareRoute.forEach(function(p) { if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0]; if (p[1] < minLng) minLng = p[1]; if (p[1] > maxLng) maxLng = p[1]; });
                var cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
                var merY = function(lat) { var lr = lat * Math.PI / 180; return (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2; };
                var merX = function(lng) { return (lng + 180) / 360; };
                var zoom = 18;
                while (zoom > 10) {
                    if ((merX(maxLng) - merX(minLng)) * Math.pow(2, zoom) * 256 < mW - 100 && (merY(minLat) - merY(maxLat)) * Math.pow(2, zoom) * 256 < mH - 100) break;
                    zoom--;
                }
                var cx = merX(cLng) * Math.pow(2, zoom), cy = merY(cLat) * Math.pow(2, zoom);
                var sx = Math.floor(cx - (mW / 2 / 256)) - 1, ex = Math.floor(cx + (mW / 2 / 256)) + 1;
                var sy = Math.floor(cy - (mH / 2 / 256)) - 1, ey = Math.floor(cy + (mH / 2 / 256)) + 1;
                var ccx = mX + mW / 2, ccy = mY + mH / 2;
                var tiles = [];
                for (var tx = sx; tx <= ex; tx++) { for (var ty = sy; ty <= ey; ty++) { tiles.push({ x: tx, y: ty, z: zoom }); } }
                await Promise.all(tiles.map(function(t) {
                    return new Promise(function(resolve) {
                        var img = new Image(); img.crossOrigin = 'Anonymous';
                        img.onload = function() { ctx.drawImage(img, ccx + (t.x - cx) * 256, ccy + (t.y - cy) * 256, 256, 256); resolve(); };
                        img.onerror = function() { resolve(); };
                        img.src = 'https://a.tile.openstreetmap.org/' + t.z + '/' + t.x + '/' + t.y + '.png';
                    });
                }));
                var pts = shareRoute.map(function(p) { return { x: ccx + (merX(p[1]) * Math.pow(2, zoom) - cx) * 256, y: ccy + (merY(p[0]) * Math.pow(2, zoom) - cy) * 256 }; });
                ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                for (var i = 0; i < pts.length - 1; i++) {
                    var pace = shareRoute[i + 1][2] || shareRoute[i][2] || 0;
                    var col = pace === 0 || pace >= 9.0 ? '#f39c12' : pace >= 6.5 ? '#0a84ff' : '#ff6b00';
                    ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.strokeStyle = col; ctx.stroke();
                }
            } else {
                ctx.font = '500 30px Inter, sans-serif'; ctx.fillStyle = '#8e8e93'; ctx.textAlign = 'center';
                ctx.fillText('GEEN ROUTE DATA BESCHIKBAAR', mX + mW / 2, mY + mH / 2);
            }
            ctx.restore();

            var sy2 = 820, cw2 = canvas.width / 4;
            var ds = function(x, icon, val, unit, color) {
                ctx.textAlign = 'center';
                ctx.font = '50px Inter, sans-serif'; ctx.fillText(icon, x, sy2);
                ctx.font = '900 80px Inter, sans-serif'; ctx.fillStyle = color || '#ffffff'; ctx.fillText(val, x, sy2 + 90);
                ctx.font = '700 24px Inter, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillText(unit.toUpperCase(), x, sy2 + 130);
            };
            ds(cw2 * 0.5, '📍', document.getElementById('res-d').innerText, 'KM', '#ffffff');
            ds(cw2 * 1.5, '⏱️', document.getElementById('res-time').innerText, 'TIJD', '#ffffff');
            ds(cw2 * 2.5, '⚡', document.getElementById('res-p').innerText, 'MIN/KM', '#ffffff');
            ds(cw2 * 3.5, '🔥', document.getElementById('res-cal').innerText, 'KCAL', '#ffffff');
            ctx.font = '600 22px Inter, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.textAlign = 'center';
            ctx.fillText('RUNFLOW.APP', canvas.width / 2, canvas.height - 40);
            var link = document.createElement('a');
            link.download = 'runflow-run-' + new Date().toISOString().split('T')[0] + '.png';
            link.href = canvas.toDataURL('image/png'); link.click();
            document.getElementById('res-btn').innerText = 'OPSLAAN IN LOGBOEK';
            this.vibrate([100, 50, 100]); this.speak('Poster succesvol gegenereerd!');
        } catch (err) { alert('Kon geen afbeelding genereren.'); document.getElementById('res-btn').innerText = 'OPSLAAN IN LOGBOEK'; }
    },

    exportAsGPX: function() {
        var gpxRoute = (STATE.viewedRoute && STATE.viewedRoute.length >= 2) ? STATE.viewedRoute : STATE.currentRoute;
        if (!gpxRoute || gpxRoute.length < 2) { alert('GEEN GPS DATA AANWEZIG'); return; }
        var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RunFlow App">\n  <trk>\n    <name>' + document.getElementById('res-title').innerText + '</name>\n    <trkseg>\n';
        gpxRoute.forEach(function(p) { gpx += '      <trkpt lat="' + p[0] + '" lon="' + p[1] + '"></trkpt>\n'; });
        gpx += '    </trkseg>\n  </trk>\n</gpx>';
        var blob = new Blob([gpx], { type: 'application/gpx+xml' }), url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = 'runflow-' + new Date().toISOString().split('T')[0] + '.gpx'; a.click(); URL.revokeObjectURL(url);
    },

    exportAsCSV: function() {
        DB.getAll(function(runs) {
            if (!runs || runs.length === 0) { alert('GEEN DATA'); return; }
            var csv = '\uFEFFDatum,Sessie,Afstand (km),Tijd (min),Pace (min/km),Calorieën\n';
            runs.forEach(function(r) { csv += (r.d || '') + ',' + ((r.n || '').replace(/,/g, ' ')) + ',' + (r.dist || '0') + ',' + Math.round((r.duration || 0) / 60) + ',' + (r.pace || '0') + ',' + (r.calories || '0') + '\n'; });
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' }), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = 'runflow-' + new Date().toISOString().split('T')[0] + '.csv'; a.click(); URL.revokeObjectURL(url);
        });
    },

    exportAllAsJSON: function() {
        DB.getAll(function(runs) {
            if (!runs || runs.length === 0) { alert('GEEN DATA'); return; }
            var blob = new Blob([JSON.stringify(runs, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = 'runflow-' + new Date().toISOString().split('T')[0] + '.json'; a.click(); URL.revokeObjectURL(url);
        });
    }
};

// ==============================================
// SCHEMAS (training plans)
// ==============================================
(function() {
    var s = {
        conditie: { name: 'Basis Conditie (0-3km)', weeks: [
            { w: 1, t1: { label: 'W1: Eerste Stap', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 60, s: 'Hardlopen', m: 'run' }, { t: 90, s: 'Wandelen', m: 'walk' }, { t: 60, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W1: Ritme Vinden', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 120, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 120, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 2, t1: { label: 'W2: De 3-Minuten', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W2: Uithouding', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 3, t1: { label: 'W3: Verlengen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W3: Stabiel Tempo', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 4, t1: { label: 'W4: De Helft', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 720, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 720, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W4: Constante Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 5, t1: { label: 'W5: Kracht Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 480, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 480, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 480, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W5: De 20 Minuten', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 6, t1: { label: 'W6: Lange Intervallen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W6: Focus Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1500, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 7, t1: { label: 'W7: Laatste Loodjes', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W7: Grens Verleggen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1800, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 8, t1: { label: 'W8: Activatie', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: '🏁 DE 3KM FINISH', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2100, s: '3KM POGING', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } }
        ]},
        gevorderd5k: { name: 'Beginner 5KM Plan', weeks: [
            { w: 1, t1: { label: 'W1: Start-Stop', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W1: Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 180, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 2, t1: { label: 'W2: 4/2 Interval', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W2: Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 3, t1: { label: 'W3: 5/3 Interval', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W3: Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 4, t1: { label: 'W4: 7/3 Interval', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W4: Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 420, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 5, t1: { label: 'W5: 10/3 Interval', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W5: Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 6, t1: { label: 'W6: 15/2 Interval', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W6: Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 7, t1: { label: 'W7: 25 Minuten Continuous', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1500, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W7: 30 Minuten Continuous', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1800, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 8, t1: { label: 'W8: Tapering', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: '🏁 DE 5KM FINISH', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2100, s: '5KM POGING', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } }
        ]},
        gevorderd5k_ervaren: { name: 'Ervaren Loper 5KM Plan (Snelheid)', weeks: [
            { w: 1, t1: { label: 'W1: Tempo Blokken', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W1: Lange Duurloop', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2400, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 2, t1: { label: 'W2: 1km Intervallen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W2: Hardlopen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2700, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 3, t1: { label: 'W3: Drempel Training', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Joggen', m: 'jog' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W3: Lange Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3000, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 4, t1: { label: 'W4: 800m Herhalingen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 240, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W4: Hardlopen 35m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2100, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 5, t1: { label: 'W5: 1km Tempo', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 90, s: 'Joggen', m: 'jog' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 90, s: 'Joggen', m: 'jog' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 90, s: 'Joggen', m: 'jog' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W5: Lange Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 6, t1: { label: 'W6: Drempel Blokken', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Joggen', m: 'jog' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W6: Hardlopen 40m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2400, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 7, t1: { label: 'W7: Tapering', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Joggen', m: 'jog' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W7: Activatie', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Sprint', m: 'sprint' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 8, t1: { label: 'W8: Race Week', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Sprint', m: 'sprint' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: '🏁 5KM RACE POGING', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1800, s: '5KM MAX TEMPO', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } }
        ]},
        intervallen10k: { name: '10KM Interval Focus', weeks: [
            { w: 1, t1: { label: 'W1: Basis Interval', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W1: Duurloop 40m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2400, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 2, t1: { label: 'W2: Kracht', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W2: Duurloop 45m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2700, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 3, t1: { label: 'W3: Snelheid 400s', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 120, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 120, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 120, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W3: Duurloop 50m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3000, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 4, t1: { label: 'W4: Drempel Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1500, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W4: Herstel 30m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1800, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 5, t1: { label: 'W5: Lange Intervallen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 180, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W5: Duurloop 55m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 6, t1: { label: 'W6: 1km Herhalingen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W6: Duurloop 60m', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 7, t1: { label: 'W7: Tempo Wissel', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W7: Pre-10K Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 2400, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 8, t1: { label: 'W8: Activatie', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Joggen', m: 'jog' }, { t: 60, s: 'Sprint', m: 'sprint' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: '🏁 DE 10KM TEST', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3600, s: '10KM POGING', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } }
        ]},
        halveMarathon: { name: 'Halve Marathon (21.1km)', weeks: [
            { w: 1, t1: { label: 'W1: Basis Opbouw', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W1: Lange Duurloop', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 3600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 2, t1: { label: 'W2: Tempo Intervallen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 900, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W2: 8km Run', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 4200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 3, t1: { label: 'W3: Lange Intervallen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W3: 10km Hardloop Test', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 4800, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 4, t1: { label: 'W4: Drempel Training', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1800, s: 'Hardlopen', m: 'run' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W4: 12km Hardlopen', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 5400, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 5, t1: { label: 'W5: Snelheid Werk', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 60, s: 'Wandelen', m: 'walk' }, { t: 300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W5: 14km Duurloop', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 6300, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 6, t1: { label: 'W6: Tempo Blokken', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 90, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 90, s: 'Wandelen', m: 'walk' }, { t: 1200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W6: 16km Duurloop', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 7200, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 7, t1: { label: 'W7: Tapering', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 900, s: 'Joggen', m: 'jog' }, { t: 120, s: 'Wandelen', m: 'walk' }, { t: 600, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: 'W7: 12km Test', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 5400, s: 'Hardlopen', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } },
            { w: 8, t1: { label: 'W8: Activatie', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 600, s: 'Joggen', m: 'jog' }, { t: 30, s: 'Sprint', m: 'sprint' }, { t: 300, s: 'Cool-down', m: 'warmup' }] }, t2: { label: '🏁 HALVE MARATHON', b: [{ t: 300, s: 'Warming-up', m: 'warmup' }, { t: 8400, s: '21.1KM POGING', m: 'run' }, { t: 300, s: 'Cool-down', m: 'warmup' }] } }
        ]}
    };
    STATE.schemas = s;
})();

// BOOTSTRAP
document.addEventListener('DOMContentLoaded', function() {
    DB.init(function() { APP.init(); });
});