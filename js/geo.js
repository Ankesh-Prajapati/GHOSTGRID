/* ============================================================
   GHOSTGRID — geo.js
   Renders the world basemap (equirectangular) with d3-geo +
   topojson, and exposes a shared lon/lat -> px projector that
   map.js uses to place arcs/pulses on the canvas layer above it.
   ============================================================ */
window.Sentinel = window.Sentinel || {};

(function(){
  const WORLD_ATLAS_URLS = [ // last-resort mirrors only; embedded data is the primary source
    'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json',
    'https://unpkg.com/world-atlas@2/countries-50m.json',
  ];

  let projection, pathGen, svgEl, width = 0, height = 0;
  let libsReady = false;
  let countryLayers = [];
  const ISO2_TO_NUMERIC = {
    au:'036', br:'076', de:'276', gb:'826', in:'356',
    it:'380', jp:'392', sg:'702', us:'840', za:'710'
  };

  function buildProjection(w, h){
    // Fall back to a hand-rolled equirectangular projector if d3-geo
    // didn't load (blocked CDN, offline, etc.) so arcs still line up
    // with lon/lat even without the fancy basemap.
    if(typeof d3 !== 'undefined' && d3.geoEquirectangular){
      projection = d3.geoEquirectangular().scale(w / 6.4).translate([w / 2, h / 2]);
      pathGen = typeof d3.geoPath === 'function' ? d3.geoPath(projection) : null;
      libsReady = true;
    } else {
      libsReady = false;
      pathGen = null;
      const scale = w / 360;
      projection = ([lon, lat]) => [ (lon + 180) * scale, (90 - lat) * scale * (h / (w/2)) ];
    }
  }

  function project(lon, lat){
    if(!projection) return [0,0];
    const p = projection([lon, lat]);
    return p || [0,0];
  }

  function resize(){
    try{
      const wrap = document.getElementById('mapWrap');
      width = wrap.clientWidth || 800;
      height = wrap.clientHeight || 480;
      svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
      buildProjection(width, height);
      renderPaths();
    }catch(err){
      console.warn('[geo] resize failed', err);
    }
    window.Sentinel.emit && window.Sentinel.emit('map:resize', {width, height});
  }

  let worldData = null;

  function drawFallbackGrid(){
    // No d3-geo / no atlas data available — draw a plain lon/lat grid
    // so the stage isn't empty and arcs still have a visual reference.
    svgEl.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    const bg = document.createElementNS(ns,'rect');
    bg.setAttribute('class','sphere');
    bg.setAttribute('x',0); bg.setAttribute('y',0);
    bg.setAttribute('width',width); bg.setAttribute('height',height);
    svgEl.appendChild(bg);

    const frag = document.createDocumentFragment();
    for(let lon=-180; lon<=180; lon+=20){
      const [x] = project(lon,0);
      const line = document.createElementNS(ns,'line');
      line.setAttribute('class','graticule');
      line.setAttribute('x1',x); line.setAttribute('y1',0);
      line.setAttribute('x2',x); line.setAttribute('y2',height);
      frag.appendChild(line);
    }
    for(let lat=-80; lat<=80; lat+=20){
      const [,y] = project(0,lat);
      const line = document.createElementNS(ns,'line');
      line.setAttribute('class','graticule');
      line.setAttribute('x1',0); line.setAttribute('y1',y);
      line.setAttribute('x2',width); line.setAttribute('y2',y);
      frag.appendChild(line);
    }
    svgEl.appendChild(frag);
  }

  function renderPaths(){
    countryLayers = [];
    if(!libsReady || !pathGen){
      drawFallbackGrid();
      return;
    }
    svgEl.innerHTML = '';

    const sphere = document.createElementNS('http://www.w3.org/2000/svg','path');
    sphere.setAttribute('class','sphere');
    sphere.setAttribute('d', pathGen({type:'Sphere'}));
    svgEl.appendChild(sphere);

    const grat = d3.geoGraticule10();
    const gPath = document.createElementNS('http://www.w3.org/2000/svg','path');
    gPath.setAttribute('class','graticule');
    gPath.setAttribute('d', pathGen(grat));
    svgEl.appendChild(gPath);

    if(!worldData || typeof topojson === 'undefined'){ return; } // grid/sphere only, that's fine

    try{
      const countries = topojson.feature(worldData, worldData.objects.countries).features;
      const frag = document.createDocumentFragment();
      countries.forEach(f=>{
        const d = pathGen(f);
        if(!d) return;
        const el = document.createElementNS('http://www.w3.org/2000/svg','path');
        el.setAttribute('class','country');
        el.setAttribute('d', d);
        countryLayers.push({feature:f, el, id:String(f.id || '').padStart(3,'0')});
        frag.appendChild(el);
      });
      svgEl.appendChild(frag);
    }catch(err){
      console.warn('[geo] rendering countries failed', err);
    }
  }

  async function fetchWorldData(){
    // The topology is embedded directly in js/world-data.js (loaded as a
    // plain <script> before this file), so there's no fetch/path/CORS
    // dependency at all for the basemap — it's guaranteed present as long
    // as the js/ folder was copied, same as every other script on the page.
    if(window.Sentinel && window.Sentinel.worldTopology){
      return window.Sentinel.worldTopology;
    }
    console.warn('[geo] embedded world topology missing (js/world-data.js not loaded) — trying CDN mirrors');
    for(const url of WORLD_ATLAS_URLS){
      try{
        const res = await fetch(url, {cache:'force-cache'});
        if(!res.ok) throw new Error('bad status ' + res.status);
        return await res.json();
      }catch(err){
        console.warn('[geo] atlas source failed:', url, err.message);
      }
    }
    return null;
  }

  async function init(){
    try{
      svgEl = document.getElementById('worldSvg');
      resize();
      window.addEventListener('resize', debounce(resize, 200));
      if('ResizeObserver' in window){
        const wrap = document.getElementById('mapWrap');
        new ResizeObserver(debounce(resize, 80)).observe(wrap);
      }

      if(typeof d3 === 'undefined' || typeof topojson === 'undefined'){
        console.warn('[geo] d3-geo/topojson not available — using fallback grid basemap');
        return; // non-fatal: rest of the app still works
      }
      worldData = await fetchWorldData();
      if(!worldData){
        console.warn('[geo] world atlas unavailable from all sources — using fallback grid basemap');
      }
      renderPaths();
    }catch(err){
      console.warn('[geo] init failed, continuing with fallback grid', err);
    }
  }

  function debounce(fn, ms){
    let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); };
  }

  function countryName(feature){
    return feature && feature.properties && feature.properties.name ? feature.properties.name : '';
  }

  function normalizeCountryName(name){
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function countryMatches(layer, targetName, targetCode){
    if(targetCode){
      const numeric = ISO2_TO_NUMERIC[String(targetCode).toLowerCase()];
      if(numeric && layer.id === numeric) return true;
    }
    const featureName = countryName(layer.feature);
    const a = normalizeCountryName(featureName);
    const b = normalizeCountryName(targetName);
    if(!a || !b) return false;
    const aliases = {
      unitedstates: ['unitedstatesofamerica'],
      unitedkingdom: ['unitedkingdom'],
      russia: ['russia'],
      southafrica: ['southafrica'],
    };
    return a === b || (aliases[b] || []).includes(a);
  }

  function flashImpact(lon, lat, country, countryCode){
    if(!Number.isFinite(lon) || !Number.isFinite(lat)) return;

    const point = [lon, lat];
    let layer = null;
    if(typeof d3 !== 'undefined' && typeof d3.geoContains === 'function'){
      layer = countryLayers.find(item => d3.geoContains(item.feature, point));
    }
    if(!layer && (country || countryCode)){
      layer = countryLayers.find(item => countryMatches(item, country, countryCode));
    }

    if(layer){
      layer.el.classList.remove('impact');
      // Restart the CSS animation even when the same country is hit repeatedly.
      void layer.el.getBoundingClientRect();
      layer.el.classList.add('impact');
      setTimeout(()=>layer.el.classList.remove('impact'), 1200);
    }
  }

  window.Sentinel.geo = { init, project, getSize: ()=>({width,height}), flashImpact };
})();
