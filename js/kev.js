/* ============================================================
   GHOSTGRID — kev.js
   Real data source: CISA's own Known Exploited Vulnerabilities
   (KEV) catalog, mirrored to GitHub by CISA itself and served from
   raw.githubusercontent.com (CORS-enabled, no key, no rate limit
   concerns — it's a static file, updated whenever CISA updates KEV).
   This is the authoritative U.S. government list of CVEs confirmed
   to be actively exploited in the wild.
   ============================================================ */
window.Sentinel = window.Sentinel || {};

(function(){
  const KEV_URLS = [
    'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json',
    'https://cdn.jsdelivr.net/gh/cisagov/kev-data@develop/known_exploited_vulnerabilities.json',
  ];
  const REFRESH_MS = 15 * 60 * 1000; // KEV updates a few times a week at most — no need to poll hard
  const FETCH_TIMEOUT_MS = 8000;

  function fetchWithTimeout(url, opts={}){
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, {...opts, signal: ctrl.signal}).finally(()=>clearTimeout(t));
  }

  async function fetchKev(){
    let lastErr = null;
    for(const url of KEV_URLS){
      try{
        const res = await fetchWithTimeout(url, {cache:'no-store'});
        if(!res.ok) throw new Error('bad status ' + res.status);
        const json = await res.json();
        const rows = (json.vulnerabilities || [])
          .slice()
          .sort((a,b)=> new Date(b.dateAdded) - new Date(a.dateAdded))
          .slice(0, 25)
          .map(v => ({
            cveId: v.cveID,
            vendor: v.vendorProject,
            product: v.product,
            name: v.vulnerabilityName,
            dateAdded: v.dateAdded,
            ransomware: v.knownRansomwareCampaignUse && v.knownRansomwareCampaignUse !== 'Unknown',
            url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v.cveID)}`,
          }));
        return { entries: rows, catalogVersion: json.catalogVersion, totalCount: (json.vulnerabilities||[]).length };
      }catch(err){
        lastErr = err;
        console.warn('[kev] source failed:', url, err.message);
      }
    }
    throw lastErr || new Error('all KEV sources failed');
  }

  const listeners = [];
  function onUpdate(fn){ listeners.push(fn); }

  async function refresh(){
    try{
      const data = await fetchKev();
      listeners.forEach(fn=>fn({ok:true, ...data}));
    }catch(err){
      console.warn('[kev] unavailable this cycle', err);
      listeners.forEach(fn=>fn({ok:false}));
    }
  }

  function start(){
    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  window.Sentinel.kev = { start, onUpdate };
})();
