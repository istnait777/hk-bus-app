const KMB_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const BOOKMARKS_KEY = 'hk_bus_bookmarks_v1';
const TRACKED_KEY = 'hk_bus_tracked_v1';

let allRoutes = [];
let stopsMap = {};
let activeEtaInterval = null;
let globalRemainInterval = null;
let alertWatchInterval = null;
let activeAlerts = {}; // { bookmarkId: true }

// --- Audio Beep & Pop-Up Window Alert ---
function playAlertBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {}
}

function triggerPopupAlert(bookmark, minsText) {
  playAlertBeep();
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);

  const title = `Route ${bookmark.route} • ${minsText}`;
  const body = `Bus to ${bookmark.destEn} (${bookmark.destTc}) is arriving at ${bookmark.stopNameEn} (${bookmark.stopNameTc})!`;

  // 1. Show custom pop-up modal window inside app
  document.getElementById('alertModalTitle').textContent = title;
  document.getElementById('alertModalBody').textContent = body;
  document.getElementById('alertModal').classList.remove('hidden');

  // 2. Also fire browser pop-up alert window
  setTimeout(() => {
    alert(`🔔 ${title}\n${body}`);
  }, 100);
}

function toggleOneMinAlert(id) {
  if (activeAlerts[id]) {
    delete activeAlerts[id];
  } else {
    activeAlerts[id] = true;
    // Unlock audio context on iOS tap
    playAlertBeep();
  }

  const btn = document.getElementById(`alert-btn-${id}`);
  if (btn) {
    btn.classList.toggle('active', !!activeAlerts[id]);
    btn.textContent = activeAlerts[id] ? '🔔 1m ON' : '🔕 1m Alert';
  }
  startAlertWatcher();
}

function startAlertWatcher() {
  clearInterval(alertWatchInterval);
  const alertIds = Object.keys(activeAlerts);
  if (!alertIds.length) return;

  const checkAlerts = async () => {
    const bookmarks = getBookmarks();
    const now = new Date();

    for (const id of Object.keys(activeAlerts)) {
      const b = bookmarks.find(item => item.id === id);
      if (!b) {
        delete activeAlerts[id];
        continue;
      }

      try {
        const res = await fetch(`${KMB_BASE}/eta/${b.stopId}/${b.route}/${b.serviceType}`);
        const json = await res.json();
        const validEtas = json.data.filter(e => e.dir === b.bound && e.eta);

        if (validEtas.length) {
          const diffSec = Math.round((new Date(validEtas[0].eta) - now) / 1000);
          // Trigger when remaining time is 1 minute or less (<= 75 seconds)
          if (diffSec <= 75 && diffSec >= -30) {
            delete activeAlerts[id]; // Auto-turn off after alerting once
            const btn = document.getElementById(`alert-btn-${id}`);
            if (btn) {
              btn.classList.remove('active');
              btn.textContent = '🔕 1m Alert';
            }
            const label = diffSec <= 20 ? 'Arriving Now' : '1 Min Remaining';
            triggerPopupAlert(b, label);
          }
        }
      } catch (e) {}
    }

    if (!Object.keys(activeAlerts).length) {
      clearInterval(alertWatchInterval);
    }
  };

  checkAlerts();
  alertWatchInterval = setInterval(checkAlerts, 10000); // Check every 10s
}

// --- Bookmark Storage Helpers ---
function getBookmarks() {
  return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
}

function isBookmarked(route, bound, serviceType, stopId) {
  const id = `${route}_${bound}_${serviceType}_${stopId}`;
  return getBookmarks().some(b => b.id === id);
}

function toggleBookmark(btnEl, route, bound, serviceType, stopId, destEn, destTc) {
  const id = `${route}_${bound}_${serviceType}_${stopId}`;
  let bookmarks = getBookmarks();
  const existsIndex = bookmarks.findIndex(b => b.id === id);

  if (existsIndex >= 0) {
    bookmarks.splice(existsIndex, 1);
    delete activeAlerts[id];
    if (btnEl) {
      btnEl.classList.remove('bookmarked');
      btnEl.textContent = '☆';
    }
  } else {
    const stopInfo = stopsMap[stopId] || { name_en: 'Unknown Stop', name_tc: '' };
    bookmarks.push({
      id,
      route,
      bound,
      serviceType,
      stopId,
      stopNameEn: stopInfo.name_en,
      stopNameTc: stopInfo.name_tc,
      destEn,
      destTc
    });
    if (btnEl) {
      btnEl.classList.add('bookmarked');
      btnEl.textContent = '★';
    }
  }

  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

// --- Track "Time Remain" Helpers ---
function getTrackedBus() {
  return JSON.parse(localStorage.getItem(TRACKED_KEY) || 'null');
}

function trackStopRemain(route, bound, serviceType, stopId, destEn, destTc) {
  const stopInfo = stopsMap[stopId] || { name_en: 'Selected Stop', name_tc: '' };
  const tracked = {
    route,
    bound,
    serviceType,
    stopId,
    stopNameEn: stopInfo.name_en,
    stopNameTc: stopInfo.name_tc,
    destEn,
    destTc
  };
  localStorage.setItem(TRACKED_KEY, JSON.stringify(tracked));
  startFloatingRemainTracker();
  showRemainTab();
}

function clearTrackedBus(e) {
  if (e) e.stopPropagation();
  localStorage.removeItem(TRACKED_KEY);
  clearInterval(globalRemainInterval);
  document.getElementById('floatingRemainBar').classList.add('hidden');
  if (!document.getElementById('remainSection').classList.contains('hidden')) {
    showRemainTab();
  }
}

async function startFloatingRemainTracker() {
  clearInterval(globalRemainInterval);
  const tracked = getTrackedBus();
  const bar = document.getElementById('floatingRemainBar');
  const textEl = document.getElementById('floatingRemainText');

  if (!tracked) {
    bar.classList.add('hidden');
    updateRemainScreen(null, []);
    return;
  }

  bar.classList.remove('hidden');

  const pollTracked = async () => {
    const current = getTrackedBus();
    if (!current) return;
    try {
      const res = await fetch(`${KMB_BASE}/eta/${current.stopId}/${current.route}/${current.serviceType}`);
      const json = await res.json();
      const now = new Date();
      const validEtas = json.data.filter(e => e.dir === current.bound && e.eta);

      if (!validEtas.length) {
        textEl.innerHTML = `<strong>${current.route}</strong> (${current.stopNameEn}) • No buses scheduled`;
        updateRemainScreen(current, []);
        return;
      }

      const nextEta = new Date(validEtas[0].eta);
      const diffSec = Math.max(0, Math.round((nextEta - now) / 1000));
      const mins = Math.floor(diffSec / 60);
      const secs = diffSec % 60;
      const remainStr = diffSec <= 30 ? 'Arriving now' : `${mins}m ${secs < 10 ? '0' : ''}${secs}s remain`;

      textEl.innerHTML = `⏱️ <strong>${current.route}</strong> • ${remainStr} (${current.stopNameEn})`;
      updateRemainScreen(current, validEtas);
    } catch (err) {
      textEl.innerHTML = `<strong>${current.route}</strong> • Updating...`;
    }
  };

  await pollTracked();
  globalRemainInterval = setInterval(pollTracked, 10000);
}

function updateRemainScreen(tracked, validEtas) {
  const container = document.getElementById('remainContent');
  if (!container) return;

  if (!tracked) {
    const bookmarks = getBookmarks();
    const savedQuickPick = bookmarks.length
      ? `<div style="margin-top:16px; text-align:left;">
          <div style="font-weight:700; margin-bottom:8px; color:#333;">Or pick from your Saved Stops:</div>
          ${bookmarks.map(b => {
            const safeDest = b.destEn.replace(/'/g, "\\'");
            return `
              <div class="route-card" onclick="trackStopRemain('${b.route}', '${b.bound}', '${b.serviceType}', '${b.stopId}', '${safeDest}', '${b.destTc}')">
                <div class="route-num">${b.route}</div>
                <div class="route-dest">
                  <strong>${b.stopNameEn} (${b.stopNameTc})</strong>
                  <small>→ ${b.destEn}</small>
                </div>
                <span style="color:#d32f2f; font-weight:700;">Track →</span>
              </div>
            `;
          }).join('')}
        </div>`
      : '';

    container.innerHTML = `
      <div class="empty-state">
        <p style="font-size:1.1rem; margin-bottom:6px;"><strong>⏱️ No Bus Selected Yet</strong></p>
        <p style="margin-bottom:14px;">Open any route, tap a red minute badge (e.g. <strong>8 min</strong>), and its live countdown will appear here.</p>
        <button class="eta-badge" style="font-size:1rem; padding:10px 18px;" onclick="showRoutesHome()">Browse Routes</button>
      </div>
      ${savedQuickPick}
    `;
    return;
  }

  const now = new Date();
  if (!validEtas.length) {
    container.innerHTML = `
      <div class="remain-card">
        <div class="remain-route-pill">${tracked.route}</div>
        <div><strong>To ${tracked.destEn} (${tracked.destTc})</strong></div>
        <div style="color:#666; margin-top:4px;">📍 ${tracked.stopNameEn} (${tracked.stopNameTc})</div>
        <div class="remain-big-time" style="font-size:1.6rem;">No Departures</div>
        <button class="stop-track-btn" onclick="clearTrackedBus()">Stop Tracking</button>
      </div>
    `;
    return;
  }

  const firstEta = new Date(validEtas[0].eta);
  const diffMins = Math.max(0, Math.round((firstEta - now) / 60000));
  const clockStr = firstEta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const otherBadges = validEtas.slice(1).map(e => {
    const m = Math.max(0, Math.round((new Date(e.eta) - now) / 60000));
    const t = new Date(e.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="eta-badge">${m === 0 ? 'Arriving' : m + ' min'} <span>(${t})</span></div>`;
  }).join('');

  container.innerHTML = `
    <div class="remain-card">
      <div class="remain-route-pill">${tracked.route}</div>
      <div><strong>To ${tracked.destEn} (${tracked.destTc})</strong></div>
      <div style="color:#555; margin-top:6px; font-size:0.95rem;">📍 ${tracked.stopNameEn} (${tracked.stopNameTc})</div>

      <div class="remain-big-time">${diffMins === 0 ? 'Arriving' : diffMins + ' min'}</div>
      <div class="remain-sub-clock">Estimated arrival at <strong>${clockStr}</strong></div>

      ${otherBadges ? `<div class="remain-upcoming-list">${otherBadges}</div>` : ''}
      <button class="stop-track-btn" onclick="clearTrackedBus()">Stop Tracking</button>
    </div>
  `;
}

// --- Initialization ---
async function initApp() {
  const routeListEl = document.getElementById('routeList');
  routeListEl.innerHTML = '<p>Loading KMB route & stop database...</p>';

  const cached = JSON.parse(localStorage.getItem('kmb_static_cache_v2') || 'null');
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    allRoutes = cached.routes;
    stopsMap = cached.stops;
  } else {
    const [routesRes, stopsRes] = await Promise.all([
      fetch(`${KMB_BASE}/route/`),
      fetch(`${KMB_BASE}/stop`)
    ]);
    const routesJson = await routesRes.json();
    const stopsJson = await stopsRes.json();

    allRoutes = routesJson.data;
    stopsJson.data.forEach(s => {
      stopsMap[s.stop] = {
        name_en: s.name_en,
        name_tc: s.name_tc,
        lat: parseFloat(s.lat),
        long: parseFloat(s.long)
      };
    });

    try {
      localStorage.setItem('kmb_static_cache_v2', JSON.stringify({
        timestamp: Date.now(),
        routes: allRoutes,
        stops: stopsMap
      }));
    } catch (e) {}
  }

  renderRouteSearch('');
  startFloatingRemainTracker();
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function setActiveTab(tab) {
  document.getElementById('tabRoutes').classList.toggle('active', tab === 'routes');
  document.getElementById('tabNearby').classList.toggle('active', tab === 'nearby');
  document.getElementById('tabSaved').classList.toggle('active', tab === 'saved');
  document.getElementById('tabRemain').classList.toggle('active', tab === 'remain');
}

function hideAllSections() {
  clearInterval(activeEtaInterval);
  document.getElementById('routeList').classList.add('hidden');
  document.getElementById('nearbySection').classList.add('hidden');
  document.getElementById('savedSection').classList.add('hidden');
  document.getElementById('remainSection').classList.add('hidden');
  document.getElementById('stopSection').classList.add('hidden');
}

function showRoutesHome() {
  hideAllSections();
  setActiveTab('routes');
  document.getElementById('routeList').classList.remove('hidden');
}

function renderRouteSearch(query) {
  const routeListEl = document.getElementById('routeList');
  const cleanQuery = query.trim().toUpperCase();

  const matches = allRoutes
    .filter(r => r.route.startsWith(cleanQuery))
    .slice(0, 40);

  routeListEl.innerHTML = matches.map(r => `
    <div class="route-card" onclick="selectRoute('${r.route}', '${r.bound}', '${r.service_type}', '${r.dest_en.replace(/'/g, "\\'")}', '${r.dest_tc}')">
      <div class="route-num">${r.route}</div>
      <div class="route-dest">
        <strong>To ${r.dest_en} (${r.dest_tc})</strong>
        <small>From ${r.orig_en} ${r.service_type !== '1' ? '• Special Departure' : ''}</small>
      </div>
    </div>
  `).join('');
}

async function selectRoute(route, bound, serviceType, destEn, destTc) {
  hideAllSections();
  document.getElementById('stopSection').classList.remove('hidden');
  document.getElementById('selectedRouteTitle').innerHTML = `<strong>${route}</strong> → ${destEn} (${destTc})`;

  const stopListEl = document.getElementById('stopList');
  stopListEl.innerHTML = '<p>Loading stops & live ETAs...</p>';

  const direction = bound === 'O' ? 'outbound' : 'inbound';
  const res = await fetch(`${KMB_BASE}/route-stop/${route}/${direction}/${serviceType}`);
  const data = await res.json();
  const safeDestEn = destEn.replace(/'/g, "\\'");

  stopListEl.innerHTML = data.data.map(item => {
    const stopInfo = stopsMap[item.stop] || { name_en: 'Unknown Stop', name_tc: '' };
    const saved = isBookmarked(route, bound, serviceType, item.stop);
    return `
      <div class="stop-item">
        <div class="stop-header">
          <span>${item.seq}. ${stopInfo.name_en} (${stopInfo.name_tc})</span>
          <button class="star-btn ${saved ? 'bookmarked' : ''}"
            onclick="toggleBookmark(this, '${route}', '${bound}', '${serviceType}', '${item.stop}', '${safeDestEn}', '${destTc}')">
            ${saved ? '★' : '☆'}
          </button>
        </div>
        <div class="eta-box" id="eta-seq-${item.seq}">Fetching live ETA...</div>
      </div>
    `;
  }).join('');

  const updateAllRouteETAs = async () => {
    try {
      const etaRes = await fetch(`${KMB_BASE}/route-eta/${route}/${serviceType}`);
      const etaJson = await etaRes.json();
      const now = new Date();

      const etaBySeq = {};
      etaJson.data.forEach(e => {
        if (e.dir === bound && e.eta) {
          if (!etaBySeq[e.seq]) etaBySeq[e.seq] = [];
          etaBySeq[e.seq].push(e);
        }
      });

      data.data.forEach(item => {
        const box = document.getElementById(`eta-seq-${item.seq}`);
        if (!box) return;

        const stopEtas = etaBySeq[item.seq] || [];
        if (!stopEtas.length) {
          box.innerHTML = '<span class="no-eta">No scheduled departures</span>';
          return;
        }

        box.innerHTML = stopEtas.map(e => {
          const diffMins = Math.max(0, Math.round((new Date(e.eta) - now) / 60000));
          const label = diffMins === 0 ? 'Arriving' : `${diffMins} min`;
          const remark = e.rmk_en ? `<span>(${e.rmk_en})</span>` : '';
          return `<button class="eta-badge" onclick="trackStopRemain('${route}', '${bound}', '${serviceType}', '${item.stop}', '${safeDestEn}', '${destTc}')">${label} ${remark}</button>`;
        }).join('');
      });
    } catch (err) {
      console.error('ETA fetch error:', err);
    }
  };

  await updateAllRouteETAs();
  activeEtaInterval = setInterval(updateAllRouteETAs, 30000);
}

function findNearbyStops() {
  hideAllSections();
  setActiveTab('nearby');
  document.getElementById('nearbySection').classList.remove('hidden');

  const nearbyListEl = document.getElementById('nearbyList');
  const gpsStatusEl = document.getElementById('gpsStatus');
  gpsStatusEl.textContent = 'Locating...';
  nearbyListEl.innerHTML = '<p>Requesting GPS location...</p>';

  if (!navigator.geolocation) {
    nearbyListEl.innerHTML = '<p>Geolocation is not supported by your browser.</p>';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      gpsStatusEl.textContent = 'GPS Active';

      const nearbyStops = Object.entries(stopsMap)
        .map(([id, info]) => ({
          id,
          ...info,
          distance: Math.round(getDistanceMeters(latitude, longitude, info.lat, info.long))
        }))
        .filter(s => s.distance <= 400)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);

      if (!nearbyStops.length) {
        nearbyListEl.innerHTML = '<p>No KMB stops found within 400 meters.</p>';
        return;
      }

      nearbyListEl.innerHTML = nearbyStops.map(s => `
        <div class="stop-item">
          <div class="stop-header">
            <span>${s.name_en} (${s.name_tc})</span>
            <span class="dist-tag">${s.distance}m</span>
          </div>
          <div id="nearby-etas-${s.id}" style="margin-top:8px;">Loading routes...</div>
        </div>
      `).join('');

      const updateNearbyETAs = async () => {
        const now = new Date();
        await Promise.all(nearbyStops.map(async (stop) => {
          const container = document.getElementById(`nearby-etas-${stop.id}`);
          if (!container) return;

          try {
            const res = await fetch(`${KMB_BASE}/stop-eta/${stop.id}`);
            const json = await res.json();

            const grouped = {};
            json.data.forEach(e => {
              if (!e.eta) return;
              const key = `${e.route}_${e.dir}_${e.service_type}`;
              if (!grouped[key]) {
                grouped[key] = {
                  route: e.route,
                  bound: e.dir,
                  serviceType: e.service_type,
                  dest_en: e.dest_en,
                  dest_tc: e.dest_tc,
                  etas: []
                };
              }
              if (grouped[key].etas.length < 2) {
                const diffMins = Math.max(0, Math.round((new Date(e.eta) - now) / 60000));
                grouped[key].etas.push(diffMins === 0 ? 'Arriving' : `${diffMins}m`);
              }
            });

            const rows = Object.values(grouped);
            if (!rows.length) {
              container.innerHTML = '<span class="no-eta">No upcoming buses at this stop.</span>';
              return;
            }

            container.innerHTML = rows.map(r => {
              const saved = isBookmarked(r.route, r.bound, r.serviceType, stop.id);
              const safeDestEn = r.dest_en.replace(/'/g, "\\'");
              return `
                <div class="nearby-route-row">
                  <div class="nearby-route-info">
                    <strong>${r.route}</strong>
                    <small>→ ${r.dest_en} (${r.dest_tc})</small>
                  </div>
                  <div class="nearby-etas">
                    ${r.etas.map(t => `<button class="eta-badge" onclick="trackStopRemain('${r.route}', '${r.bound}', '${r.serviceType}', '${stop.id}', '${safeDestEn}', '${r.dest_tc}')">${t}</button>`).join('')}
                    <button class="star-btn ${saved ? 'bookmarked' : ''}"
                      onclick="toggleBookmark(this, '${r.route}', '${r.bound}', '${r.serviceType}', '${stop.id}', '${safeDestEn}', '${r.dest_tc}')">
                      ${saved ? '★' : '☆'}
                    </button>
                  </div>
                </div>
              `;
            }).join('');
          } catch (err) {
            container.innerHTML = '<span class="no-eta">Failed to load ETAs.</span>';
          }
        }));
      };

      await updateNearbyETAs();
      activeEtaInterval = setInterval(updateNearbyETAs, 30000);
    },
    (err) => {
      gpsStatusEl.textContent = 'GPS Error';
      nearbyListEl.innerHTML = `<p>Unable to get location: ${err.message}. Ensure the site is hosted on HTTPS.</p>`;
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
  );
}

// --- Tab 3: Bookmarked Stops with "🔔 1m Alert" Button ---
async function showSavedStops() {
  hideAllSections();
  setActiveTab('saved');
  document.getElementById('savedSection').classList.remove('hidden');

  const savedListEl = document.getElementById('savedList');
  const bookmarks = getBookmarks();

  if (!bookmarks.length) {
    savedListEl.innerHTML = `
      <div class="empty-state">
        <p><strong>No bookmarked stops yet</strong></p>
        <p>Tap the ☆ icon next to any bus stop in Routes or Nearby to pin it here.</p>
      </div>
    `;
    return;
  }

  savedListEl.innerHTML = bookmarks.map(b => {
    const isAlertOn = !!activeAlerts[b.id];
    return `
      <div class="stop-item" id="saved-card-${b.id}">
        <div class="stop-header">
          <div style="flex:1;">
            <span class="saved-route-badge">${b.route}</span>
            <span>→ ${b.destEn} (${b.destTc})</span>
            <div style="margin-top:6px; font-size:0.9rem; color:#444;">
              📍 ${b.stopNameEn} (${b.stopNameTc})
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <button id="alert-btn-${b.id}" class="alert-toggle-btn ${isAlertOn ? 'active' : ''}"
              onclick="toggleOneMinAlert('${b.id}')">
              ${isAlertOn ? '🔔 1m ON' : '🔕 1m Alert'}
            </button>
            <button class="star-btn bookmarked" title="Remove bookmark"
              onclick="removeSavedCard('${b.id}', '${b.route}', '${b.bound}', '${b.serviceType}', '${b.stopId}')">
              ★
            </button>
          </div>
        </div>
        <div class="eta-box" id="saved-eta-${b.id}">Fetching live ETA...</div>
      </div>
    `;
  }).join('');

  const updateSavedETAs = async () => {
    const now = new Date();
    const currentBookmarks = getBookmarks();

    await Promise.all(currentBookmarks.map(async (b) => {
      const box = document.getElementById(`saved-eta-${b.id}`);
      if (!box) return;
      const safeDestEn = b.destEn.replace(/'/g, "\\'");

      try {
        const res = await fetch(`${KMB_BASE}/eta/${b.stopId}/${b.route}/${b.serviceType}`);
        const json = await res.json();

        const validEtas = json.data.filter(e => e.dir === b.bound && e.eta);
        if (!validEtas.length) {
          box.innerHTML = '<span class="no-eta">No scheduled departures right now.</span>';
          return;
        }

        box.innerHTML = validEtas.map(e => {
          const diffMins = Math.max(0, Math.round((new Date(e.eta) - now) / 60000));
          const label = diffMins === 0 ? 'Arriving' : `${diffMins} min`;
          const remark = e.rmk_en ? `<span>(${e.rmk_en})</span>` : '';
          return `<button class="eta-badge" onclick="trackStopRemain('${b.route}', '${b.bound}', '${b.serviceType}', '${b.stopId}', '${safeDestEn}', '${b.destTc}')">${label} ${remark}</button>`;
        }).join('');
      } catch (err) {
        box.innerHTML = '<span class="no-eta">Failed to load ETA.</span>';
      }
    }));
  };

  await updateSavedETAs();
  activeEtaInterval = setInterval(updateSavedETAs, 30000);
}

function removeSavedCard(id, route, bound, serviceType, stopId) {
  toggleBookmark(null, route, bound, serviceType, stopId, '', '');
  const card = document.getElementById(`saved-card-${id}`);
  if (card) card.remove();
  if (!getBookmarks().length) showSavedStops();
}

function showRemainTab() {
  hideAllSections();
  setActiveTab('remain');
  document.getElementById('remainSection').classList.remove('hidden');
  const tracked = getTrackedBus();
  if (!tracked) {
    updateRemainScreen(null, []);
  } else {
    startFloatingRemainTracker();
  }
}

document.getElementById('routeInput').addEventListener('input', (e) => {
  showRoutesHome();
  renderRouteSearch(e.target.value);
});

document.getElementById('tabRoutes').addEventListener('click', showRoutesHome);
document.getElementById('tabNearby').addEventListener('click', findNearbyStops);
document.getElementById('tabSaved').addEventListener('click', showSavedStops);
document.getElementById('tabRemain').addEventListener('click', showRemainTab);
document.getElementById('backBtn').addEventListener('click', showRoutesHome);
document.getElementById('floatingRemainBar').addEventListener('click', showRemainTab);
document.getElementById('floatingClearBtn').addEventListener('click', clearTrackedBus);
document.getElementById('alertModalOkBtn').addEventListener('click', () => {
  document.getElementById('alertModal').classList.add('hidden');
});

initApp();
