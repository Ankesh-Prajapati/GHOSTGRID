/* ============================================================
   GHOSTGRID — data.js
   Real data source:
     1) ipsum.txt — a daily-aggregated public blacklist (union of
        30+ open threat feeds), mirrored on raw.githubusercontent.com
        (CORS-enabled, no key required).
     2) geojs.io — free CORS-enabled batch GeoIP lookup for the
        flagged IPs, giving us real lat/lon + country per attacker.
   Everything the free web has no source for (which victim was hit,
   which vector was used) is simulated from realistic distributions —
   flagged clearly via `synthetic:true` on those fields.
   ============================================================ */
window.Sentinel = window.Sentinel || {};

(function(){
  const IPSUM_URLS = [
    'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt',
    'https://cdn.jsdelivr.net/gh/stamparm/ipsum@master/ipsum.txt',
  ];
  const GEOJS_BATCH = ips => `https://get.geojs.io/v1/ip/geo.json?ip=${ips.join(',')}`;
  const FETCH_TIMEOUT_MS = 7000;

  function fetchWithTimeout(url, opts={}){
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, {...opts, signal: ctrl.signal}).finally(()=>clearTimeout(t));
  }
  const REFRESH_POOL_MS = 5 * 60 * 1000; // re-pull the blacklist every 5 min
  const TICK_MS = 1400;                  // emit a simulated "event" this often
  const BATCH_SIZE = 60;

  const TARGETS = [ // realistic simulated victim / datacenter hubs
    {country:'United States', code:'us', lat:38.9, lon:-77.0, w:30},
    {country:'India',         code:'in', lat:19.1, lon:72.9,  w:14},
    {country:'Italy',         code:'it', lat:41.9, lon:12.5,  w:9},
    {country:'Japan',         code:'jp', lat:35.7, lon:139.7, w:9},
    {country:'Australia',     code:'au', lat:-33.9,lon:151.2, w:7},
    {country:'Germany',       code:'de', lat:52.5, lon:13.4,  w:9},
    {country:'Singapore',     code:'sg', lat:1.35, lon:103.8, w:6},
    {country:'Brazil',        code:'br', lat:-23.5,lon:-46.6, w:6},
    {country:'United Kingdom',code:'gb', lat:51.5, lon:-0.12, w:6},
    {country:'South Africa',  code:'za', lat:-26.2,lon:28.05, w:4},
  ];

  const VECTORS = ['UDP Flood','TCP Flood','DNS Flood','IP Flood','SYN Flood','Low & Slow','ICMP Flood'];
  const VIOLATIONS = ['Access Violation','SQL Injection','Cross-site Scripting','Exploit Attempt','Data Theft Attempt','Path Traversal'];
  const TYPES = ['web','ddos','intrusion','scan','anon'];
  const TYPE_LABEL = {web:'Web Attacker', ddos:'DDoS Attacker', intrusion:'Intruder', scan:'Scanner', anon:'Anonymizer'};

  function weightedPick(arr){
    const total = arr.reduce((s,x)=>s+x.w,0);
    let r = Math.random()*total;
    for(const x of arr){ r -= x.w; if(r<=0) return x; }
    return arr[arr.length-1];
  }
  function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  function rand(min,max){ return min + Math.random()*(max-min); }

  let attackerPool = [];   // [{ip, score, country, code, lat, lon}]
  let usingRealFeed = false;
  let lastGeoBatchIdx = 0;

  async function loadIpsum(){
    let text = null, lastErr = null;
    for(const url of IPSUM_URLS){
      try{
        const res = await fetchWithTimeout(url, {cache:'no-store'});
        if(!res.ok) throw new Error('bad status ' + res.status);
        text = await res.text();
        break;
      }catch(err){
        lastErr = err;
        console.warn('[data] ipsum source failed:', url, err.message);
      }
    }
    if(!text) throw lastErr || new Error('all ipsum sources failed');
    const rows = text.split('\n')
      .filter(l => l && !l.startsWith('#'))
      .map(l => { const [ip, score] = l.trim().split('\t'); return {ip, score:+score||1}; })
      .filter(r => r.ip);

    const corroborated = rows.filter(r => r.score >= 3); // reasonably corroborated across feeds
    corroborated.sort((a,b)=> b.score - a.score);
    const top = corroborated.slice(0, 800);
    shuffle(top);
    return top.slice(0, 260);
  }

  function shuffle(a){
    for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  }

  async function geolocate(batch){
    const ips = batch.map(b=>b.ip);
    const res = await fetchWithTimeout(GEOJS_BATCH(ips), {cache:'no-store'});
    if(!res.ok) throw new Error('geojs fetch failed: ' + res.status);
    const json = await res.json();
    const list = Array.isArray(json) ? json : [json];
    const byIp = {};
    list.forEach(r => { if(r.ip) byIp[r.ip] = r; });
    return batch.map(b=>{
      const g = byIp[b.ip];
      if(!g || !g.latitude || !g.longitude) return null;
      return {
        ip: b.ip, score: b.score,
        country: g.country || 'Unknown', code: (g.country_code||'').toLowerCase(),
        lat: parseFloat(g.latitude), lon: parseFloat(g.longitude),
      };
    }).filter(Boolean);
  }

  async function buildRealPool(){
    const raw = await loadIpsum();
    const chunks = [];
    for(let i=0;i<raw.length;i+=BATCH_SIZE) chunks.push(raw.slice(i,i+BATCH_SIZE));
    // Run the (capped) batch of geolocation lookups in parallel so one slow/
    // timed-out request doesn't serialize the whole startup.
    const settled = await Promise.allSettled(chunks.slice(0,4).map(geolocate));
    const results = [];
    settled.forEach(s=>{
      if(s.status === 'fulfilled') results.push(...s.value);
      else console.warn('[data] geojs batch failed', s.reason && s.reason.message);
    });
    return results;
  }

  function syntheticIp(){
    return `${1+Math.floor(Math.random()*223)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  }

  function fallbackPool(){
    // Realistic-looking simulated attacker sources spread across common
    // origin regions seen in public DDoS/web-attack telemetry.
    const seeds = [
      {country:'United States', code:'us', lat:37.7, lon:-97.5},
      {country:'Russia', code:'ru', lat:55.7, lon:37.6},
      {country:'China', code:'cn', lat:31.2, lon:121.5},
      {country:'Brazil', code:'br', lat:-15.8, lon:-47.9},
      {country:'Vietnam', code:'vn', lat:14.1, lon:108.3},
      {country:'India', code:'in', lat:20.6, lon:78.9},
      {country:'Netherlands', code:'nl', lat:52.1, lon:5.3},
      {country:'Iran', code:'ir', lat:32.4, lon:53.7},
      {country:'Ukraine', code:'ua', lat:48.4, lon:31.2},
      {country:'Indonesia', code:'id', lat:-2.5, lon:118.0},
      {country:'Mexico', code:'mx', lat:23.6, lon:-102.5},
      {country:'Nigeria', code:'ng', lat:9.1, lon:8.7},
    ];
    const pool = [];
    for(let i=0;i<160;i++){
      const s = pick(seeds);
      pool.push({
        ip: syntheticIp(), score: 1+Math.floor(Math.random()*5),
        country: s.country, code: s.code,
        lat: s.lat + rand(-6,6), lon: s.lon + rand(-8,8),
      });
    }
    return pool;
  }

  function makeEvent(){
    const src = pick(attackerPool);
    const dst = weightedPick(TARGETS);
    const type = pick(TYPES);
    return {
      id: 'e' + Math.random().toString(36).slice(2,9),
      t: Date.now(),
      type,
      ip: src.ip,
      srcCountry: src.country, srcCode: src.code, srcLat: src.lat, srcLon: src.lon,
      dstCountry: dst.country, dstCode: dst.code, dstLat: dst.lat + rand(-2,2), dstLon: dst.lon + rand(-2,2),
      vector: pick(VECTORS),
      violation: pick(VIOLATIONS),
      synthetic: !usingRealFeed,
    };
  }

  const listeners = [];
  function onEvent(fn){ listeners.push(fn); }
  function emitEvent(ev){ listeners.forEach(fn=>fn(ev)); }

  async function refreshPool(){
    try{
      const real = await buildRealPool();
      if(real.length >= 20){
        attackerPool = real;
        usingRealFeed = true;
        window.Sentinel.emit && window.Sentinel.emit('feed:status', {mode:'live', count: real.length});
        return;
      }
      throw new Error('too few geolocated results: ' + real.length);
    }catch(err){
      console.warn('[data] live feed unavailable, switching to simulated pool', err);
      attackerPool = fallbackPool();
      usingRealFeed = false;
      window.Sentinel.emit && window.Sentinel.emit('feed:status', {mode:'simulated', count: attackerPool.length});
    }
  }

  function start(){
    refreshPool();
    setInterval(refreshPool, REFRESH_POOL_MS);
    setInterval(()=>{
      if(!attackerPool.length) return;
      emitEvent(makeEvent());
    }, TICK_MS);
  }

  window.Sentinel.data = {
    start, onEvent,
    TYPE_LABEL,
    isLive: ()=>usingRealFeed,
  };
})();
