/* ============================================================
   GHOSTGRID — app.js
   Wires geo.js + data.js + map.js together, drives the UI:
   stats panels, threat log, filters, clock, timeline, boot screen.
   ============================================================ */
(function(){
  window.Sentinel = window.Sentinel || {};

  /* --- tiny event bus, used by geo/data modules --- */
  const busListeners = {};
  window.Sentinel.emit = (name, payload)=>{ (busListeners[name]||[]).forEach(fn=>fn(payload)); };
  window.Sentinel.on   = (name, fn)=>{ (busListeners[name] = busListeners[name]||[]).push(fn); };

  const COLORS = { web:'#ff3b6b', ddos:'#ffb020', intrusion:'#29e2ff', scan:'#4fd67e', anon:'#b072ff' };
  const TYPE_LABEL = { web:'Web Attacker', ddos:'DDoS Attacker', intrusion:'Intruder', scan:'Scanner', anon:'Anonymizer' };

  let history = [];               // all events, newest last
  const groupedThreats = new Map();
  const ipActivity = new Map();
  // Unlike the visible DOM log (capped at 60 rows) and `history` (capped at
  // 4000), these two maps used to grow without limit for the life of the tab
  // — every event ever seen stayed in memory, slowing down long-running
  // sessions. Cap per-entry arrays and evict the oldest entries once the
  // maps get large, same idea as the log/history caps above.
  const MAX_EVENTS_PER_GROUP = 200;   // summarizeEvents() only needs recent samples
  const MAX_EVENTS_PER_IP = 200;      // detail view only needs recent samples
  const MAX_GROUPS = 500;
  const MAX_TRACKED_IPS = 500;
  let activeTypes = new Set(Object.keys(COLORS));
  let intervalMin = 60;
  let streamPaused = false;
  let selectedEvent = null;

  /* ---------------- boot sequence ---------------- */
  function runBoot(){
    const lines = [
      'INITIALIZING SENSOR GRID…',
      'CONNECTING THREAT INTEL FEEDS…',
      'RESOLVING GEO-IP ENDPOINTS…',
      'CALIBRATING RADAR SWEEP…',
      'GHOSTGRID ONLINE',
    ];
    const lineEl = document.getElementById('bootLine');
    const barEl = document.getElementById('bootBar');
    let i = 0;
    const step = ()=>{
      lineEl.textContent = lines[i];
      barEl.style.width = `${((i+1)/lines.length)*100}%`;
      i++;
      if(i < lines.length){ setTimeout(step, 380); }
      else{ setTimeout(()=> document.getElementById('boot').classList.add('hide'), 420); }
    };
    step();
  }

  /* ---------------- clock ---------------- */
  function tickClock(){
    const el = document.getElementById('clock');
    const d = new Date();
    el.textContent = d.toLocaleTimeString('en-GB', {hour12:false});
  }

  /* ---------------- feed status pill ---------------- */
  Sentinel.on('feed:status', ({mode, count})=>{
    const pill = document.getElementById('feedStatus');
    const text = document.getElementById('feedStatusText');
    const dot = pill.querySelector('.dot');
    dot.className = 'dot ' + (mode==='live' ? 'dot-live' : 'dot-sim');
    text.textContent = mode==='live'
      ? `LIVE FEED · ${count} SOURCES`
      : `SIMULATED · ${count} SOURCES`;
    document.getElementById('sourceNote').textContent = mode==='live'
      ? 'Attacker IPs sourced live from public blacklist aggregation (ipsum) + GeoIP · targets & vectors simulated'
      : 'Live feed unreachable — running on simulated threat data';
    pushSystemLog(mode==='live'
      ? `Live feed connected · ${count} geolocated sources`
      : 'Live feed unavailable · using built-in simulated fallback');
  });

  /* ---------------- legend / filters ---------------- */
  function initLegend(){
    document.querySelectorAll('#legendList li').forEach(li=>{
      li.addEventListener('click', ()=>{
        const type = li.dataset.type;
        if(activeTypes.has(type)){ activeTypes.delete(type); li.classList.add('off'); }
        else{ activeTypes.add(type); li.classList.remove('off'); }
        Sentinel.map.setActiveTypes(activeTypes);
        renderStats();
      });
    });
  }

  /* ---------------- threat log ---------------- */
  function pushSystemLog(message){
    const log = document.getElementById('threatLog');
    if(!log) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry log-system';
    entry.innerHTML = `<div class="log-route">${escapeHtml(message)}</div>`;
    log.prepend(entry);
    while(log.children.length > 60) log.removeChild(log.lastChild);
  }

  function pushLog(ev){
    const log = document.getElementById('threatLog');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.tabIndex = 0;
    entry.setAttribute('role', 'button');
    entry.dataset.eventId = ev.id;
    entry.style.borderLeftColor = COLORS[ev.type];
    const time = new Date(ev.t).toLocaleTimeString('en-GB',{hour12:false});
    entry.innerHTML = `<span class="log-time">${time}</span>` +
      `<span class="tag" style="background:${COLORS[ev.type]}22;color:${COLORS[ev.type]}">${TYPE_LABEL[ev.type]}</span>` +
      `<b>${ev.ip}</b> (${ev.srcCountry}) → ${ev.dstCountry} <span style="color:#6d89a8">· ${ev.vector}</span>`;
    entry.innerHTML = `
      <div class="log-top">
        <span class="tag" style="background:${COLORS[ev.type]}1f;color:${COLORS[ev.type]}">${TYPE_LABEL[ev.type]}</span>
        <span class="log-time">${time}</span>
      </div>
      <div class="log-route"><b>${escapeHtml(ev.ip)}</b> ${escapeHtml(ev.srcCountry)} → ${escapeHtml(ev.dstCountry)}</div>
      <div class="log-vector">${escapeHtml(ev.vector)}</div>`;
    entry.addEventListener('click', ()=>selectThreat(ev));
    entry.addEventListener('keydown', e=>{
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        selectThreat(ev);
      }
    });
    log.prepend(entry);
    while(log.children.length > 60) log.removeChild(log.lastChild);
  }

  function renderThreatRow(group){
    const log = document.getElementById('threatLog');
    const entry = group.row || document.createElement('div');
    const color = COLORS[group.type] || COLORS.intrusion;
    const isNew = !group.row;
    entry.className = 'log-entry';
    entry.tabIndex = 0;
    entry.setAttribute('role', 'button');
    entry.dataset.threatKey = group.key;
    entry.style.borderLeftColor = color;
    entry.innerHTML = `
      <div class="log-top">
        <span class="tag" style="background:${color}1f;color:${color}">${escapeHtml(TYPE_LABEL[group.type] || group.type)}</span>
        <span class="log-time">x${group.count}</span>
      </div>
      <div class="log-route"><button class="ip-link" type="button">${escapeHtml(group.sourceIp)}</button> → ${escapeHtml(group.target)}</div>
      <div class="log-vector">${escapeHtml(group.vector)} · first ${formatTime(group.firstSeen)} · last ${formatTime(group.lastSeen)}</div>`;
    if(isNew){
      entry.addEventListener('click', e=>{
        if(e.target.closest('.ip-link')) return;
        selectThreat(group);
      });
      entry.addEventListener('keydown', e=>{
        if(e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          selectThreat(group);
        }
      });
      group.row = entry;
    }
    const ipButton = entry.querySelector('.ip-link');
    ipButton.addEventListener('click', e=>{
      e.stopPropagation();
      selectIp(group.sourceIp);
    }, {once:true});
    log.prepend(entry);
    while(log.children.length > 60) log.removeChild(log.lastChild);
  }

  function escapeHtml(value){
    return String(value).replace(/[&<>"']/g, ch => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[ch]));
  }

  function safe(value, fallback='Unknown'){
    return value === null || value === undefined || value === '' ? fallback : value;
  }

  function eventTime(ev){
    const t = Number(ev && ev.t);
    return Number.isFinite(t) ? t : Date.now();
  }

  function formatTime(ts){
    return new Date(ts).toLocaleString('en-GB', {
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit',
      hour12:false
    });
  }

  function threatKey(ev){
    return [
      safe(ev.ip),
      safe(ev.dstCountry),
      safe(ev.type),
      safe(ev.vector)
    ].join('|').toLowerCase();
  }

  function uniqValues(events, key){
    return [...new Set(events.map(ev => safe(ev[key])).filter(v => v !== 'Unknown'))];
  }

  function severityFor(ev){
    const score = {
      ddos: 'High',
      intrusion: 'High',
      web: 'Medium',
      scan: 'Low',
      anon: 'Medium',
    };
    return score[ev.type] || 'Medium';
  }

  function indexEvent(ev){
    const ts = eventTime(ev);
    const key = threatKey(ev);
    let group = groupedThreats.get(key);
    if(!group){
      group = {
        key,
        sourceIp: safe(ev.ip),
        sourceCountry: safe(ev.srcCountry),
        target: safe(ev.dstCountry),
        type: safe(ev.type),
        vector: safe(ev.vector),
        firstSeen: ts,
        lastSeen: ts,
        count: 0,
        events: [],
        row: null,
      };
      groupedThreats.set(key, group);
      if(groupedThreats.size > MAX_GROUPS){
        // Map preserves insertion order; the first key is the oldest group.
        groupedThreats.delete(groupedThreats.keys().next().value);
      }
    }
    group.count += 1;
    group.firstSeen = Math.min(group.firstSeen, ts);
    group.lastSeen = Math.max(group.lastSeen, ts);
    group.events.push(ev);
    if(group.events.length > MAX_EVENTS_PER_GROUP) group.events.shift();

    const ip = safe(ev.ip);
    if(!ipActivity.has(ip)){
      ipActivity.set(ip, []);
      if(ipActivity.size > MAX_TRACKED_IPS){
        ipActivity.delete(ipActivity.keys().next().value);
      }
    }
    const activity = ipActivity.get(ip);
    activity.push(ev);
    if(activity.length > MAX_EVENTS_PER_IP) activity.shift();
    return group;
  }

  function summarizeEvents(events){
    const sorted = [...events].sort((a,b)=>eventTime(a)-eventTime(b));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      events: sorted,
      firstSeen: first ? eventTime(first) : Date.now(),
      lastSeen: last ? eventTime(last) : Date.now(),
      total: sorted.length,
      targets: uniqValues(sorted, 'dstCountry'),
      vectors: uniqValues(sorted, 'vector'),
      countries: uniqValues(sorted, 'srcCountry').concat(uniqValues(sorted, 'dstCountry'))
    };
  }

  function selectThreat(ev){
    selectedEvent = ev;
    document.querySelectorAll('.log-entry.selected').forEach(el=>el.classList.remove('selected'));
    const row = document.querySelector(`.log-entry[data-event-id="${CSS.escape(ev.id)}"]`);
    if(row) row.classList.add('selected');
    renderThreatDetail(ev);
  }

  function renderThreatDetail(ev){
    const el = document.getElementById('threatDetail');
    if(!el || !ev) return;
    const time = new Date(ev.t).toLocaleTimeString('en-GB',{hour12:false});
    el.classList.add('show');
    el.innerHTML = `
      <div class="detail-head">
        <span>${escapeHtml(TYPE_LABEL[ev.type] || ev.type)}</span>
        <button type="button" id="detailClose" aria-label="Close threat details">×</button>
      </div>
      <dl>
        <div><dt>Source IP</dt><dd>${escapeHtml(ev.ip)}</dd></div>
        <div><dt>Source Country</dt><dd>${escapeHtml(ev.srcCountry)}</dd></div>
        <div><dt>Target</dt><dd>${escapeHtml(ev.dstCountry)}</dd></div>
        <div><dt>Attack Type</dt><dd>${escapeHtml(TYPE_LABEL[ev.type] || ev.type)}</dd></div>
        <div><dt>Vector</dt><dd>${escapeHtml(ev.vector)}</dd></div>
        <div><dt>Time</dt><dd>${time}</dd></div>
        <div><dt>Severity</dt><dd>${severityFor(ev)}</dd></div>
      </dl>`;
    document.getElementById('detailClose').addEventListener('click', ()=>{
      el.classList.remove('show');
      selectedEvent = null;
      document.querySelectorAll('.log-entry.selected').forEach(row=>row.classList.remove('selected'));
    });
  }

  function selectIp(ip){
    const events = ipActivity.get(safe(ip)) || history.filter(ev => safe(ev.ip) === safe(ip));
    renderIpDetail(safe(ip), events);
  }

  function renderIpDetail(ip, events){
    const el = document.getElementById('threatDetail');
    if(!el) return;
    const summary = summarizeEvents(events);
    const sourceCountries = uniqValues(events, 'srcCountry');
    const recent = summary.events.slice(-8).reverse();
    el.classList.add('show');
    el.innerHTML = `
      <div class="detail-head">
        <span>IP investigation</span>
        <button type="button" id="detailClose" aria-label="Close threat details">×</button>
      </div>
      <dl>
        <div><dt>Source IP</dt><dd>${escapeHtml(ip)}</dd></div>
        <div><dt>Event Count</dt><dd>${summary.total}</dd></div>
        <div><dt>First Seen</dt><dd>${formatTime(summary.firstSeen)}</dd></div>
        <div><dt>Last Seen</dt><dd>${formatTime(summary.lastSeen)}</dd></div>
        <div><dt>Previous Targets</dt><dd>${escapeHtml(summary.targets.join(', ') || 'Unknown')}</dd></div>
        <div><dt>Attack Vectors</dt><dd>${escapeHtml(summary.vectors.join(', ') || 'Unknown')}</dd></div>
        <div><dt>Countries</dt><dd>${escapeHtml([...new Set(sourceCountries.concat(summary.targets))].join(', ') || 'Unknown')}</dd></div>
      </dl>
      <div class="detail-subtitle">Recent events</div>
      <ul class="detail-events">
        ${recent.map(ev => `<li>${formatTime(eventTime(ev))} · ${escapeHtml(safe(ev.dstCountry))} · ${escapeHtml(safe(ev.vector))}</li>`).join('')}
      </ul>`;
    document.getElementById('detailClose').addEventListener('click', closeThreatDetail);
  }

  function selectThreat(groupOrEvent){
    const group = groupOrEvent && groupOrEvent.events ? groupOrEvent : groupedThreats.get(threatKey(groupOrEvent));
    if(!group) return;
    selectedEvent = group;
    document.querySelectorAll('.log-entry.selected').forEach(el=>el.classList.remove('selected'));
    const row = document.querySelector(`.log-entry[data-threat-key="${CSS.escape(group.key)}"]`);
    if(row) row.classList.add('selected');
    renderThreatDetail(group);
  }

  function renderThreatDetail(group){
    const el = document.getElementById('threatDetail');
    if(!el || !group) return;
    const summary = summarizeEvents(group.events);
    const recent = summary.events.slice(-8).reverse();
    el.classList.add('show');
    el.innerHTML = `
      <div class="detail-head">
        <span>Threat history</span>
        <button type="button" id="detailClose" aria-label="Close threat details">×</button>
      </div>
      <dl>
        <div><dt>Source IP</dt><dd><button class="ip-link detail-ip" type="button">${escapeHtml(group.sourceIp)}</button></dd></div>
        <div><dt>Source Country</dt><dd>${escapeHtml(group.sourceCountry)}</dd></div>
        <div><dt>Target</dt><dd>${escapeHtml(group.target)}</dd></div>
        <div><dt>Attack Type</dt><dd>${escapeHtml(TYPE_LABEL[group.type] || group.type)}</dd></div>
        <div><dt>Attack Vector</dt><dd>${escapeHtml(group.vector)}</dd></div>
        <div><dt>Severity</dt><dd>${severityFor({type:group.type})}</dd></div>
        <div><dt>Event Count</dt><dd>${group.count}</dd></div>
        <div><dt>First Seen</dt><dd>${formatTime(summary.firstSeen)}</dd></div>
        <div><dt>Last Seen</dt><dd>${formatTime(summary.lastSeen)}</dd></div>
        <div><dt>Total Events</dt><dd>${summary.total}</dd></div>
        <div><dt>Targets</dt><dd>${summary.targets.length}</dd></div>
        <div><dt>Target Countries</dt><dd>${escapeHtml(summary.targets.join(', ') || 'Unknown')}</dd></div>
        <div><dt>Attack Vectors</dt><dd>${escapeHtml(summary.vectors.join(', ') || 'Unknown')}</dd></div>
      </dl>
      <div class="detail-subtitle">Recent events</div>
      <ul class="detail-events">
        ${recent.map(ev => `<li>${formatTime(eventTime(ev))} · ${escapeHtml(safe(ev.dstCountry))} · ${escapeHtml(safe(ev.vector))}</li>`).join('')}
      </ul>`;
    el.querySelector('.detail-ip').addEventListener('click', ()=>selectIp(group.sourceIp));
    document.getElementById('detailClose').addEventListener('click', closeThreatDetail);
  }

  function closeThreatDetail(){
    const el = document.getElementById('threatDetail');
    if(el) el.classList.remove('show');
    selectedEvent = null;
    document.querySelectorAll('.log-entry.selected').forEach(row=>row.classList.remove('selected'));
  }

  /* ---------------- stats panels ---------------- */
  function withinWindow(ev, now){ return now - ev.t <= intervalMin*60*1000; }

  function topN(map, n){
    return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n);
  }

  function renderBars(containerId, entries, total, colorFn){
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    if(!entries.length){
      el.innerHTML = '<div style="color:var(--text-faint);font-size:.7rem;">Awaiting data…</div>';
      return;
    }
    entries.forEach(([name,count])=>{
      const pct = total ? Math.round((count/total)*100) : 0;
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = `
        <div class="meta"><span class="name">${name}</span><span class="pct">${pct}%</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>`;
      el.appendChild(row);
    });
  }

  function renderStats(){
    const now = Date.now();
    const win = history.filter(ev => withinWindow(ev, now) && activeTypes.has(ev.type));

    const attackers = new Map(), attacked = new Map(), vectors = new Map(), violations = new Map();
    win.forEach(ev=>{
      attackers.set(ev.srcCountry, (attackers.get(ev.srcCountry)||0)+1);
      attacked.set(ev.dstCountry, (attacked.get(ev.dstCountry)||0)+1);
      vectors.set(ev.vector, (vectors.get(ev.vector)||0)+1);
      violations.set(ev.violation, (violations.get(ev.violation)||0)+1);
    });

    renderBars('topAttackers', topN(attackers,5), win.length);
    renderBars('topAttacked', topN(attacked,5), win.length);
    renderBars('topVectors', topN(vectors,5), win.length);
    renderBars('topViolations', topN(violations,5), win.length);
    renderLegendCounts(now);
  }

  function renderLegendCounts(now){
    // Legend always reflects the full unfiltered window so toggling a
    // type off doesn't zero out its own percentage.
    const win = history.filter(ev => withinWindow(ev, now));
    const counts = {web:0, ddos:0, intrusion:0, scan:0, anon:0};
    win.forEach(ev => { if(counts[ev.type] !== undefined) counts[ev.type]++; });
    const total = win.length || 1;
    Object.keys(counts).forEach(type=>{
      const el = document.getElementById('pct-' + type);
      if(el) el.textContent = Math.round((counts[type]/total)*100) + '%';
    });
  }

  /* ---------------- timeline mini-chart ---------------- */
  const BUCKET_MS = 10_000;   // 10s buckets
  const BUCKET_COUNT = 180;   // 30 min of history
  let buckets = new Array(BUCKET_COUNT).fill(0).map(()=>({web:0,ddos:0,intrusion:0,scan:0,anon:0}));

  function bucketFor(t){
    const idx = Math.floor(t / BUCKET_MS) % BUCKET_COUNT;
    return idx;
  }
  let lastBucketKey = Math.floor(Date.now()/BUCKET_MS);

  function recordBucket(ev){
    const key = Math.floor(ev.t / BUCKET_MS);
    if(key !== lastBucketKey){
      // rolled into new bucket(s): clear the ones we skipped
      let k = lastBucketKey + 1;
      while(k <= key){ buckets[bucketFor(k*BUCKET_MS)] = {web:0,ddos:0,intrusion:0,scan:0,anon:0}; k++; }
      lastBucketKey = key;
    }
    buckets[bucketFor(ev.t)][ev.type]++;
  }

  function drawTimeline(){
    const canvas = document.getElementById('timelineCanvas');
    const dpr = Math.min(window.devicePixelRatio||1,2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if(canvas.width !== w*dpr || canvas.height !== h*dpr){
      canvas.width = w*dpr; canvas.height = h*dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);

    const order = ['web','ddos','intrusion','scan','anon'];
    const maxVal = Math.max(2, ...buckets.map(b=>order.reduce((s,k)=>s+b[k],0)));
    const startIdx = bucketFor((lastBucketKey - BUCKET_COUNT + 1)*BUCKET_MS);

    order.forEach((type, li)=>{
      ctx.beginPath();
      for(let i=0;i<BUCKET_COUNT;i++){
        const idx = (startIdx + i) % BUCKET_COUNT;
        const v = buckets[idx][type];
        const x = (i/(BUCKET_COUNT-1))*w;
        const y = h - (v/maxVal)*h*0.92 - 1;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.strokeStyle = COLORS[type];
      ctx.globalAlpha = activeTypes.has(type) ? 0.9 : 0.15;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    requestAnimationFrame(drawTimeline);
  }

  /* ---------------- CVE / KEV watch ---------------- */
  function renderKev(data){
    const badge = document.getElementById('kevBadge');
    const list = document.getElementById('kevList');
    if(!data.ok || !data.entries || !data.entries.length){
      badge.textContent = 'OFFLINE';
      badge.style.color = 'var(--text-faint)'; badge.style.borderColor = 'var(--text-faint)';
      list.innerHTML = '<div class="kev-error">CISA KEV feed unavailable right now.</div>';
      return;
    }
    badge.textContent = 'LIVE';
    badge.style.color = ''; badge.style.borderColor = '';
    list.innerHTML = data.entries.slice(0,10).map(e => `
      <div class="kev-entry">
        <a href="${e.url}" target="_blank" rel="noopener">${escapeHtml(e.cveId)}</a> — ${escapeHtml(e.name)}
        ${e.ransomware ? '<span class="kev-ransom">⚠ RANSOMWARE</span>' : ''}
        <div class="kev-meta">${escapeHtml(e.vendor)} / ${escapeHtml(e.product)} · added ${escapeHtml(e.dateAdded)}</div>
      </div>`).join('');
  }

  /* ---------------- misc UI wiring ---------------- */
  function initMisc(){
    document.getElementById('year').textContent = new Date().getFullYear();

    document.getElementById('intervalSelect').addEventListener('change', e=>{
      intervalMin = +e.target.value;
      document.querySelectorAll('#timeFilter button').forEach(btn=>{
        btn.classList.toggle('active', +btn.dataset.min === intervalMin);
      });
      renderStats();
    });

    document.querySelectorAll('#timeFilter button').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        intervalMin = +btn.dataset.min;
        document.getElementById('intervalSelect').value = String(intervalMin);
        document.querySelectorAll('#timeFilter button').forEach(b=>b.classList.toggle('active', b === btn));
        renderStats();
      });
    });

    document.getElementById('streamToggle').addEventListener('click', e=>{
      streamPaused = !streamPaused;
      e.currentTarget.classList.toggle('paused', streamPaused);
      e.currentTarget.setAttribute('aria-pressed', String(streamPaused));
      e.currentTarget.innerHTML = streamPaused ? '<span></span> PAUSED' : '<span></span> LIVE';
      Sentinel.map.setPaused && Sentinel.map.setPaused(streamPaused);
    });

    document.getElementById('collapseRails').addEventListener('click', ()=>{
      document.querySelectorAll('.rail').forEach(r=>r.classList.toggle('collapsed'));
    });

    const modal = document.getElementById('aboutModal');
    document.getElementById('aboutLink').addEventListener('click', e=>{ e.preventDefault(); modal.classList.add('show'); });
    document.getElementById('aboutClose').addEventListener('click', ()=> modal.classList.remove('show'));
    modal.addEventListener('click', e=>{ if(e.target===modal) modal.classList.remove('show'); });
    Sentinel.on('threat:selected', selectThreat);
  }

  /* ---------------- boot everything ---------------- */
  async function main(){
    runBoot();
    initLegend();
    initMisc();
    tickClock(); setInterval(tickClock, 1000);

    // Each stage is isolated: if the basemap fails to load (blocked CDN,
    // offline, etc.) the data feed / stats / log must still run, and vice
    // versa — one broken piece should never take the whole page down.
    try{ await Sentinel.geo.init(); }
    catch(err){ console.error('[app] geo.init failed', err); }

    try{ Sentinel.map.init(); }
    catch(err){ console.error('[app] map.init failed', err); }

    try{
      Sentinel.data.onEvent(ev=>{
        if(streamPaused) return;
        history.push(ev);
        if(history.length > 4000) history.shift();
        const group = indexEvent(ev);
        recordBucket(ev);
        try{ Sentinel.map.addEvent(ev); }catch(err){ console.warn('[app] map.addEvent failed', err); }
        renderThreatRow(group);
      });
      Sentinel.data.start();
    }catch(err){
      console.error('[app] data layer failed to start', err);
    }

    try{
      Sentinel.kev.onUpdate(renderKev);
      Sentinel.kev.start();
    }catch(err){
      console.error('[app] KEV feed failed to start', err);
    }

    setInterval(renderStats, 1500);
    requestAnimationFrame(drawTimeline);

    // Watchdog: if nothing has updated the status pill within 12s
    // (unexpected error somewhere in the feed pipeline), don't leave the
    // user staring at "CONNECTING…" forever.
    setTimeout(()=>{
      const text = document.getElementById('feedStatusText');
      if(text && text.textContent.includes('CONNECTING')){
        console.warn('[app] feed status watchdog fired — forcing simulated status label');
        Sentinel.emit('feed:status', {mode:'simulated', count: 0});
      }
    }, 12000);
  }

  document.addEventListener('DOMContentLoaded', main);
})();
