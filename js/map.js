/* ============================================================
   GHOSTGRID — map.js
   Canvas overlay: animated great-circle-ish arcs from attacker
   to target, with glowing pulses and impact ripples.
   ============================================================ */
window.Sentinel = window.Sentinel || {};

(function(){
  const COLORS = {
    web:'#ff3b6b', ddos:'#ffb020', intrusion:'#29e2ff', scan:'#4fd67e', anon:'#b072ff'
  };
  const ARC_TRAVEL_MS = 2200;
  const ARC_HOLD_MS = 0;
  const ARC_FADE_MS = 850;
  const ARC_LIFE = ARC_TRAVEL_MS + ARC_HOLD_MS + ARC_FADE_MS;
  const RIPPLE_LIFE = 1400; // ms for the impact ripple
  const LABEL_LIFE = 1800;
  const MARKER_LIFE = 90000;

  let canvas, ctx, dpr = 1;
  let arcs = [];     // in-flight
  let ripples = [];  // impact effects
  let labels = [];   // short-lived country labels
  let markers = [];  // recent clickable endpoints
  let activeTypes = new Set(Object.keys(COLORS));
  let hoverMarker = null;
  let paused = false;

  function resize(){
    const wrap = document.getElementById('mapWrap');
    dpr = Math.min(window.devicePixelRatio||1, 2);
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function curvePoint(p0, p1, t){
    // quadratic bezier bowing "up" (toward lower y) between the two points,
    // giving the classic threat-map arc look on a flat projection
    const mx = (p0[0]+p1[0])/2;
    const my = (p0[1]+p1[1])/2;
    const dx = p1[0]-p0[0], dy = p1[1]-p0[1];
    const dist = Math.hypot(dx,dy);
    const bow = Math.min(dist*0.28, 140);
    const cx = mx, cy = my - bow;
    const x = (1-t)*(1-t)*p0[0] + 2*(1-t)*t*cx + t*t*p1[0];
    const y = (1-t)*(1-t)*p0[1] + 2*(1-t)*t*cy + t*t*p1[1];
    return [x,y];
  }

  function addEvent(ev){
    if(!Sentinel.geo || paused) return;
    // Guard against any bad/NaN coordinates reaching the canvas — a single
    // non-finite value passed to ctx.createLinearGradient()/arc() throws and
    // would otherwise kill the requestAnimationFrame loop for good.
    if(![ev.srcLon, ev.srcLat, ev.dstLon, ev.dstLat].every(Number.isFinite)) return;
    arcs.push({ ev, start: performance.now(), color: COLORS[ev.type] || '#29e2ff' });
    markers.push({ev, kind:'src', lon:ev.srcLon, lat:ev.srcLat, start:performance.now()});
    markers.push({ev, kind:'dst', lon:ev.dstLon, lat:ev.dstLat, start:performance.now()});
    labels.push({
      lon: ev.srcLon,
      lat: ev.srcLat,
      text: ev.srcCountry || 'Unknown',
      color: COLORS[ev.type] || '#29e2ff',
      start: performance.now()
    });
    if(markers.length > 240) markers.splice(0, markers.length - 240);
  }

  function draw(now){
    try{
      drawFrame(now);
    }catch(err){
      // Never let a single bad frame (e.g. a stray non-finite coordinate)
      // permanently stop the animation — log it and keep the rAF chain alive.
      console.warn('[map] draw frame failed, skipping', err);
    }
    requestAnimationFrame(draw);
  }

  function drawFrame(now){
    const {width, height} = Sentinel.geo ? Sentinel.geo.getSize() : {width:canvas.clientWidth,height:canvas.clientHeight};
    ctx.clearRect(0,0,width,height);

    arcs = arcs.filter(a => now - a.start < ARC_LIFE);
    ripples = ripples.filter(r => now - r.start < RIPPLE_LIFE);
    labels = labels.filter(l => now - l.start < LABEL_LIFE);
    markers = markers.filter(m => now - m.start < MARKER_LIFE);

    for(const a of arcs){
      if(!activeTypes.has(a.ev.type)) continue;
      const src = Sentinel.geo.project(a.ev.srcLon, a.ev.srcLat);
      const dst = Sentinel.geo.project(a.ev.dstLon, a.ev.dstLat);
      const age = now - a.start;
      const travelT = Math.min(age / ARC_TRAVEL_MS, 1);
      const fadeT = age <= ARC_TRAVEL_MS + ARC_HOLD_MS ? 0 : Math.min((age - ARC_TRAVEL_MS - ARC_HOLD_MS) / ARC_FADE_MS, 1);
      const easedFade = 1 - Math.pow(1 - fadeT, 3);
      const alpha = 1 - easedFade;
      const head = travelT;
      const baseTail = Math.max(0, head - 0.28);
      const tailStart = fadeT > 0 ? baseTail + (1 - baseTail) * easedFade : baseTail;

      // trailing path
      ctx.beginPath();
      const steps = 24;
      for(let i=0;i<=steps;i++){
        const tt = tailStart + (head-tailStart)*(i/steps);
        const [x,y] = curvePoint(src, dst, tt);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      const grad = ctx.createLinearGradient(src[0],src[1],dst[0],dst[1]);
      grad.addColorStop(0, hexA(a.color, fadeT > 0 ? 0.18 * alpha : 0));
      grad.addColorStop(1, hexA(a.color, .82 * alpha));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.15 + alpha * .25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = a.color;
      ctx.shadowBlur = 2 * alpha;
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.shadowBlur = 0;

      // source ping
      if(travelT < 0.15){
        drawPing(src, a.color, travelT/0.15);
      }
      // head dot
      if(head < 1){
        const [hx,hy] = curvePoint(src, dst, head);
        ctx.beginPath();
        ctx.arc(hx,hy,2.4,0,Math.PI*2);
        ctx.fillStyle = a.color;
        ctx.shadowColor = a.color; ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else if(head >= 1 && !a.landed){
        a.landed = true;
        ripples.push({lon:a.ev.dstLon, lat:a.ev.dstLat, color:a.color, start:now});
        labels.push({
          lon: a.ev.dstLon,
          lat: a.ev.dstLat,
          text: a.ev.dstCountry || 'Unknown',
          color: a.color,
          start: now
        });
        Sentinel.geo.flashImpact && Sentinel.geo.flashImpact(a.ev.dstLon, a.ev.dstLat, a.ev.dstCountry, a.ev.dstCode);
      } else if(head >= 1 && fadeT < .08) {
        const [x,y] = dst;
        ctx.beginPath();
        ctx.arc(x, y, 3.5 + fadeT * 18, 0, Math.PI*2);
        ctx.fillStyle = hexA(a.color, .55 * (1 - fadeT / .08));
        ctx.fill();
      }
    }

    for(const r of ripples){
      const [x,y] = Sentinel.geo.project(r.lon, r.lat);
      const t = (now - r.start)/RIPPLE_LIFE;
      const radius = 4 + t*30;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI*2);
      ctx.fillStyle = hexA(r.color, .12 * (1-t));
      ctx.fill();
      ctx.strokeStyle = hexA(r.color, .85 * (1-t));
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    for(const m of markers){
      if(!activeTypes.has(m.ev.type)) continue;
      const [x,y] = Sentinel.geo.project(m.lon, m.lat);
      const age = Math.min((now - m.start) / MARKER_LIFE, 1);
      const color = COLORS[m.ev.type] || '#29e2ff';
      ctx.beginPath();
      ctx.arc(x, y, m === hoverMarker ? 4.2 : 2.8, 0, Math.PI*2);
      ctx.fillStyle = hexA(color, m.kind === 'dst' ? 0.72 - age * 0.42 : 0.46 - age * 0.3);
      ctx.fill();
      if(m === hoverMarker){
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI*2);
        ctx.strokeStyle = hexA(color, .65);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    for(const l of labels){
      const [x,y] = Sentinel.geo.project(l.lon, l.lat);
      const t = (now - l.start) / LABEL_LIFE;
      const alpha = t < .12 ? t / .12 : 1 - Math.max(0, (t - .72) / .28);
      drawLabel(x, y, l.text, l.color, Math.max(0, Math.min(1, alpha)));
    }
  }

  function drawLabel(x, y, text, color, alpha){
    if(!text || alpha <= 0) return;
    ctx.save();
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const label = String(text);
    const w = ctx.measureText(label).width;
    const px = Math.min(Math.max(x + 10, 6), canvas.clientWidth - w - 8);
    const py = Math.min(Math.max(y - 12, 8), canvas.clientHeight - 8);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(3, 8, 16, .72)';
    ctx.fillRect(px - 5, py - 8, w + 10, 16);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.fillText(label, px, py);
    ctx.restore();
  }

  function drawPing(p, color, t){
    const radius = 2 + t*10;
    ctx.beginPath();
    ctx.arc(p[0],p[1],radius,0,Math.PI*2);
    ctx.strokeStyle = hexA(color, 1-t);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function hexA(hex, a){
    const n = parseInt(hex.slice(1),16);
    const r=(n>>16)&255, g=(n>>8)&255, b=n&255;
    return `rgba(${r},${g},${b},${a})`;
  }

  function setActiveTypes(set){ activeTypes = set; }
  function setPaused(value){ paused = Boolean(value); }
  function findMarker(clientX, clientY){
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null, bestDist = 12;
    for(const m of markers){
      if(!activeTypes.has(m.ev.type)) continue;
      const p = Sentinel.geo.project(m.lon, m.lat);
      const dist = Math.hypot(p[0] - x, p[1] - y);
      if(dist < bestDist){ best = m; bestDist = dist; }
    }
    return best;
  }

  function init(){
    canvas = document.getElementById('arcCanvas');
    ctx = canvas.getContext('2d');
    resize();
    canvas.addEventListener('mousemove', e=>{
      hoverMarker = findMarker(e.clientX, e.clientY);
      canvas.classList.toggle('has-hover', Boolean(hoverMarker));
    });
    canvas.addEventListener('mouseleave', ()=>{
      hoverMarker = null;
      canvas.classList.remove('has-hover');
    });
    canvas.addEventListener('click', e=>{
      const marker = findMarker(e.clientX, e.clientY);
      if(marker && Sentinel.emit) Sentinel.emit('threat:selected', marker.ev);
    });
    window.addEventListener('resize', ()=>setTimeout(resize,60));
    if('ResizeObserver' in window){
      const wrap = document.getElementById('mapWrap');
      new ResizeObserver(()=>resize()).observe(wrap);
    }
    requestAnimationFrame(draw);
  }

  window.Sentinel.map = { init, addEvent, setActiveTypes, setPaused };
})();
