// Gemelo digital RECONSTRUYE: sismo y maremoto sobre el mapa real (técnicas del artículo de HazardSim en freeCodeCamp).
// Datos que llegan solos: catastro del IGAC, edificaciones de Overture Maps, relieve Terrarium, sismos del USGS.
// Datos guardados en datos/: el sismo real del 10 de agosto de 2026 (ShakeMap, PAGER) y el riesgo de lluvia por municipio.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import {
  mmiEn, mmiEscenario, distanciaKm, probDano, probColapso, estado, areaM2, centroide, escombroTon, bloques, prioridad,
  leerInventario, collapseK, cajaOrientada, aTesela, deTesela, elegirZoom, terrarium, mediana3, mascaraMar, inundar,
  costaYMar, frente, colorAgua, suavizar, T_LLEGADA, T_LLENO, SUPUESTOS,
} from './modelo.js';

const $ = id => document.getElementById(id);
const num = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('es-CO', { style: 'percent', maximumFractionDigits: 0 });
const ROMANO = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const romano = m => ROMANO[Math.max(1, Math.min(12, Math.round(m)))];
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);
const titulo = s => s.toLowerCase().split(' ').map((w, i) => i && MENORES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const plano = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ALTO = (navigator.hardwareConcurrency || 4) >= 8; // ponytail: nivel de equipo por núcleos; medir FPS si hace falta afinar
const COLOR = { rojo: '#c33d2a', amarillo: '#c98a0e', verde: '#2f8a5b', agua: '#2b6f9e', nueva: '#1f6f5c', habitable: '#bcd7c5' };
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const evento = (ev, ms) => Promise.race([map.once(ev), espera(ms)]);
const rad = g => g * Math.PI / 180;

function avisar(texto, ms = 5000) {
  const a = $('aviso'); a.textContent = texto; a.hidden = false;
  clearTimeout(avisar.t); if (ms) avisar.t = setTimeout(() => { a.hidden = true; }, ms);
}
function azar(semilla) { // mulberry32: el mismo lugar da el mismo sorteo, así comparar es justo
  let a = semilla >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const semillaDe = ([lon, lat]) => Math.round(lon * 1e4) * 31 + Math.round(lat * 1e4);

// ---------------------------------------------------------------- datos guardados
let D;
try {
  const leer = n => fetch(`datos/${n}.json`).then(r => { if (!r.ok) throw new Error(n); return r.json(); });
  const [sismo, malla, replicas, mun] = await Promise.all(['sismo', 'mmi', 'replicas', 'riesgo_lluvia'].map(leer));
  D = { sismo, malla, replicas, mun };
} catch (e) {
  $('cargando').textContent = 'Abra el simulador con un servidor local: python3 -m http.server, desde la carpeta propuesta-56.';
  throw e;
}
const S = D.sismo;
const ciudadesPager = new Map(S.ciudades.map(c => [plano(c.nombre), c]));
for (const m of D.mun) {
  const c = ciudadesPager.get(plano(m.nombre));
  m.centro = c && distanciaKm(c.lon, c.lat, m.lon, m.lat) < 15 ? [c.lon, c.lat] : [m.lon, m.lat];
  m.mmi = mmiEn(D.malla, S, ...m.centro).mmi;
  m.prio = prioridad(m.mmi, m.pl ?? 0);
  m.N = titulo(m.nombre); m.Dp = titulo(m.dpto);
}
const porId = new Map(D.mun.map(m => [m.id, m]));
const ordenados = [...D.mun].sort((a, b) => (b.afectado - a.afectado) || a.N.localeCompare(b.N, 'es'));
const etiqueta = m => `${m.N} · ${m.Dp}`;
for (const m of ordenados) m.clave = plano(etiqueta(m));
const porEtiqueta = new Map(ordenados.map(m => [m.clave, m]));
// ponytail: un datalist con los 1.102 municipios tarda en desplegarse; se ofrecen solo los 30 que coinciden
function sugerir(q = '') {
  const p = plano(q.trim());
  $('municipios').innerHTML = (p ? ordenados.filter(m => m.clave.includes(p)) : ordenados).slice(0, 30).map(m => `<option value="${etiqueta(m)}"></option>`).join('');
}
sugerir();

// Overture publica sus edificaciones del mundo entero como PMTiles; se toma la versión más reciente del catálogo
const BASE_OVERTURE = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/';
async function urlOverture() {
  try {
    const cat = await Promise.race([fetch('https://stac.overturemaps.org/catalog.json').then(r => r.json()), espera(5000).then(() => null)]);
    const rel = cat?.links.filter(l => l.rel === 'child').map(l => l.href.split('/').at(-2)).sort().at(-1);
    if (rel) { const u = `${BASE_OVERTURE}${rel}/buildings.pmtiles`; if (await Promise.race([new pmtiles.PMTiles(u).getHeader(), espera(5000).then(() => null)])) return u; }
  } catch { /* se usa la versión conocida */ }
  return `${BASE_OVERTURE}2026-09-23.1/buildings.pmtiles`;
}
const IGAC = 'https://mapas.igac.gov.co/server/rest/services';

// ---------------------------------------------------------------- mapa
const protocolo = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocolo.tile);
const map = new maplibregl.Map({
  container: 'mapa', style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-75.9, 4.9], zoom: innerWidth < 900 ? 6 : 6.9, maxPitch: 80, attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Catastro y suelos: IGAC · Sismos: USGS · Relieve: Terrarium' }));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const [ovUrl] = await Promise.all([urlOverture(), map.once('load')]);
const primerSimbolo = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
const visible = (id, si) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', si ? 'visible' : 'none');

map.addSource('dem', { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 13 });
map.addLayer({ id: 'relieve', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5b5a52' } }, primerSimbolo);
map.addSource('suelos', { type: 'raster', tileSize: 256, attribution: 'Suelos: IGAC',
  tiles: [`${IGAC}/agrologia/capacidaddeusodelastierrasterritorionacional/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`] });
map.addLayer({ id: 'suelos', type: 'raster', source: 'suelos', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.6 } }, primerSimbolo);

// --- fachadas generadas en canvas (artículo): una textura por altura, para el mapa y para Three.js
function fachada(tipo) {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), g = c.getContext('2d');
  const [muro, vidrio, filas, cols] = { baja: ['#e9dfcc', '#7d8a93', 2, 3], media: ['#d6d1c7', '#6c7b86', 4, 4], alta: ['#b9c3c9', '#3f5868', 8, 5] }[tipo];
  g.fillStyle = muro; g.fillRect(0, 0, 64, 64);
  const ah = 64 / filas, aw = 64 / cols;
  for (let f = 0; f < filas; f++) for (let k = 0; k < cols; k++) {
    g.fillStyle = vidrio; g.fillRect(k * aw + aw * 0.22, f * ah + ah * 0.25, aw * 0.56, ah * 0.5);
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(k * aw + aw * 0.22, f * ah + ah * 0.25, aw * 0.56, ah * 0.12);
  }
  g.fillStyle = 'rgba(0,0,0,.07)'; for (let f = 1; f < filas; f++) g.fillRect(0, f * ah - 1, 64, 2);
  return c;
}
const FACHADAS = Object.fromEntries(['baja', 'media', 'alta'].map(t => [t, fachada(t)]));
for (const [t, c] of Object.entries(FACHADAS)) map.addImage(`f-${t}`, c.getContext('2d').getImageData(0, 0, 64, 64));

// --- sacudida real del 10 de agosto: la malla de ShakeMap pintada en un canvas que el mapa proyecta
const M = D.malla;
const lienzo = Object.assign(document.createElement('canvas'), { width: M.nx, height: M.ny });
const ctxMmi = lienzo.getContext('2d'), imgMmi = ctxMmi.createImageData(M.nx, M.ny);
const PALETA = [[1, [255, 255, 255]], [2, [191, 204, 255]], [3, [160, 230, 255]], [4, [128, 255, 255]], [5, [122, 255, 147]], [6, [255, 255, 0]], [7, [255, 200, 0]], [8, [255, 145, 0]], [9, [255, 0, 0]], [10, [200, 0, 0]]];
const colorMmi = m => { const x = Math.max(1, Math.min(10, m)), i = Math.min(8, Math.floor(x) - 1), t = x - PALETA[i][0]; return PALETA[i][1].map((c, k) => c + (PALETA[i + 1][1][k] - c) * t); };
const distCelda = new Float32Array(M.nx * M.ny);
for (let iy = 0; iy < M.ny; iy++) for (let ix = 0; ix < M.nx; ix++)
  distCelda[iy * M.nx + ix] = Math.hypot((M.x0 + ix * M.dx - S.lon) * Math.cos(rad(S.lat)), M.y0 + iy * M.dy - S.lat) * 111.2;
function pintarMmi(fr) {
  const px = imgMmi.data;
  for (let iy = 0; iy < M.ny; iy++) for (let ix = 0; ix < M.nx; ix++) {
    const k = iy * M.nx + ix, v = M.v[k], o = ((M.ny - 1 - iy) * M.nx + ix) * 4, d = distCelda[k];
    if (v == null || v < 4.5 || d > fr) { px[o + 3] = 0; continue; }
    const [r, g, b] = colorMmi(v), borde = Math.max(0, 1 - (fr - d) / 35);
    px[o] = r + (255 - r) * borde * 0.7; px[o + 1] = g + (255 - g) * borde * 0.7; px[o + 2] = b + (255 - b) * borde * 0.7;
    px[o + 3] = Math.min(1, (v - 4.5) / 1.2) * 215; // bajo V se apaga: así no se ve el borde de la malla
  }
  ctxMmi.putImageData(imgMmi, 0, 0);
}
const xR = M.x0 + (M.nx - 1) * M.dx, yT = M.y0 + (M.ny - 1) * M.dy;
map.addSource('mmi10', { type: 'canvas', canvas: lienzo, animate: true,
  coordinates: [[M.x0 - M.dx / 2, yT + M.dy / 2], [xR + M.dx / 2, yT + M.dy / 2], [xR + M.dx / 2, M.y0 - M.dy / 2], [M.x0 - M.dx / 2, M.y0 - M.dy / 2]] });
map.addLayer({ id: 'mmi10', type: 'raster', source: 'mmi10', maxzoom: 12, paint: { 'raster-opacity': 0.6, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, primerSimbolo);
function ondaMmi() {
  const t0 = performance.now(), dur = reducido ? 0 : 2600;
  const paso = ahora => {
    const u = dur ? Math.min(1, (ahora - t0) / dur) : 1;
    pintarMmi(900 * (1 - (1 - u) ** 3));
    if (u < 1) requestAnimationFrame(paso); else { pintarMmi(1e9); requestAnimationFrame(() => map.getSource('mmi10').pause()); }
  };
  map.getSource('mmi10').play(); requestAnimationFrame(paso);
}

for (const [id, capa] of Object.entries(S.suelo)) {
  map.addSource(id, { type: 'image', url: `datos/${capa.imagen}`, coordinates: capa.esquinas });
  map.addLayer({ id, type: 'raster', source: id, maxzoom: 12, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 } }, primerSimbolo);
}
map.addSource('replicas', { type: 'geojson', data: { type: 'FeatureCollection', features: D.replicas.map(([lon, lat, prof, mag]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { mag, prof } })) } });
map.addLayer({ id: 'replicas', type: 'circle', source: 'replicas', maxzoom: 12, paint: {
  'circle-radius': ['interpolate', ['exponential', 1.6], ['get', 'mag'], 2.5, 3, 5, 8, 7.4, 24],
  'circle-color': '#7a2418', 'circle-opacity': 0.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
map.addSource('mundo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
map.addLayer({ id: 'mundo', type: 'circle', source: 'mundo', layout: { visibility: 'none' }, paint: {
  'circle-radius': ['interpolate', ['exponential', 1.7], ['get', 'mag'], 4.5, 4, 7, 14, 8.5, 26],
  'circle-color': '#c33d2a', 'circle-opacity': 0.55, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
map.addSource('mun', { type: 'geojson', data: { type: 'FeatureCollection', features: D.mun.map(m => ({ type: 'Feature', geometry: { type: 'Point', coordinates: m.centro }, properties: { id: m.id, prio: m.prio, afectado: m.afectado } })) } });
map.addLayer({ id: 'mun', type: 'circle', source: 'mun', maxzoom: 13, layout: { visibility: 'none' }, filter: ['get', 'afectado'], paint: {
  'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 9, 8],
  'circle-color': ['match', ['get', 'prio'], 'rojo', COLOR.rojo, 'amarillo', COLOR.amarillo, COLOR.verde],
  'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });

// --- edificaciones: Overture (mundo), catastro IGAC e inventario de la alcaldía. Muros con fachada y techo con el estado
const ALTURA_OV = ['coalesce', ['get', 'height'], ['*', ['coalesce', ['get', 'num_floors'], 2], 3.2]]; // sin dato: 2 pisos
map.addSource('ov', { type: 'vector', url: `pmtiles://${ovUrl}`, promoteId: { building: 'id' } });
map.addSource('igac', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Catastro: IGAC' });
map.addSource('inv', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
const k = ['coalesce', ['feature-state', 'k'], 1];
const PATRON = h => ['step', h, 'f-baja', 10, 'f-media', 30, 'f-alta'];
// ponytail: un muro con textura y altura por feature-state se reconstruye en cada cambio (1–2 fps con cientos de colapsos).
// Mientras se anima, los muros van en color liso; al terminar vuelve la fachada.
const patrones = {};
function fachadas(si) { for (const [id, pat] of Object.entries(patrones)) map.setPaintProperty(id, 'fill-extrusion-pattern', si ? pat : undefined); }
function capasEdificios(fuente, h, extra = {}) {
  const muros = `${fuente}-muros`, techos = `${fuente}-techos`;
  map.addLayer({ id: muros, type: 'fill-extrusion', source: fuente, minzoom: 13, ...extra, paint: {
    'fill-extrusion-height': ['*', h, k],
    'fill-extrusion-color': ['step', h, '#e6dccb', 10, '#d3cec5', 30, '#9fb0ba'],
    'fill-extrusion-pattern': PATRON(h),
    'fill-extrusion-vertical-gradient': true,
    'fill-extrusion-opacity': 1 } });
  patrones[muros] = PATRON(h);
  map.addLayer({ id: techos, type: 'fill-extrusion', source: fuente, minzoom: 13, ...extra, paint: {
    'fill-extrusion-base': ['max', 0, ['-', ['*', h, k], 0.6]],
    'fill-extrusion-height': ['+', ['*', h, k], 0.05],
    'fill-extrusion-color': ['match', ['coalesce', ['feature-state', 'e'], ''],
      'demoler', COLOR.rojo, 'reparar', '#e0a52c', 'habitable', COLOR.habitable, 'nueva', COLOR.nueva, 'inundada', '#3d8fd1', '#d8d0c2'],
    'fill-extrusion-opacity': 1 } });
}
capasEdificios('ov', ALTURA_OV, { 'source-layer': 'building', filter: ['!=', ['get', 'is_underground'], true] });
capasEdificios('igac', ['get', 'h']);
capasEdificios('inv', ['get', 'h']);
// edificaciones que alcanza el maremoto: copia en GeoJSON con id propio (a zoom 13 Overture no trae id ni altura)
map.addSource('mojadas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
map.addLayer({ id: 'mojadas', type: 'fill-extrusion', source: 'mojadas', paint: {
  'fill-extrusion-height': ['case', ['boolean', ['feature-state', 'm'], false], ['+', ['get', 'h'], 0.4], 0],
  'fill-extrusion-color': '#3d8fd1', 'fill-extrusion-opacity': 0.95 } });
if (map.getLayer('building')) visible('building', false);
for (const f of ['igac', 'inv']) { visible(`${f}-muros`, false); visible(`${f}-techos`, false); }
function mostrarFuente(f) {
  for (const x of ['ov', 'igac', 'inv']) { visible(`${x}-muros`, x === f); visible(`${x}-techos`, x === f); }
}

// ---------------------------------------------------------------- Three.js: torres que se ladean y escombros
const deb = { escena: new THREE.Scene(), camara: new THREE.Camera(), origen: null, escala: 1, lon0: 0, lat0: 0 };
const POOLS = {};
const CERO = new THREE.Matrix4().makeScale(0, 0, 0), aux = new THREE.Object3D();
const texturas = Object.fromEntries(Object.entries(FACHADAS).map(([t, c]) => {
  const tx = new THREE.CanvasTexture(c); tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.colorSpace = THREE.SRGBColorSpace; return [t, tx];
}));
map.addLayer({
  id: 'tres', type: 'custom', renderingMode: '3d',
  onAdd(_, gl) {
    deb.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    deb.renderer.autoClear = false;
    const sol = new THREE.DirectionalLight(0xffffff, 2.2); sol.position.set(-60, -90, 160);
    deb.escena.add(sol, new THREE.AmbientLight(0xffffff, 1.25));
    const concreto = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const def = {
      losa: [new THREE.BoxGeometry(1, 1, 1), concreto, ALTO ? 30000 : 9000, [0.06, 0.04, 0.62]],
      muro: [new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), 1500, [0.09, 0.25, 0.8]],
      varilla: [new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x6e4c38, metalness: 0.25, roughness: 0.7 }), ALTO ? 20000 : 6000, null],
      roca: [new THREE.IcosahedronGeometry(0.5, 0), concreto, ALTO ? 9000 : 3000, [0.07, 0.06, 0.5]],
    };
    const c = new THREE.Color();
    for (const [nombre, [geo, mat, cap, hsl]] of Object.entries(def)) {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      for (let i = 0; i < cap; i++) { m.setMatrixAt(i, CERO); if (hsl) m.setColorAt(i, c.setHSL(hsl[0], hsl[1], hsl[2] + (Math.random() - 0.5) * 0.18)); } // instanceColor completo antes del primer render
      m.frustumCulled = false; deb.escena.add(m);
      POOLS[nombre] = { m, cap, n: 0, vivos: [] };
    }
  },
  render(_, matrix) {
    if (!deb.origen) return;
    const m = new THREE.Matrix4().fromArray(matrix);
    const l = new THREE.Matrix4().makeTranslation(deb.origen.x, deb.origen.y, deb.origen.z).scale(new THREE.Vector3(deb.escala, -deb.escala, deb.escala));
    deb.camara.projectionMatrix = m.multiply(l); // marco local: x este, y norte, z arriba, en metros
    deb.renderer.resetState();
    deb.renderer.render(deb.escena, deb.camara);
  },
});
const MPG = 111194.9; // metros por grado (R = 6371 km)
const local = (lon, lat) => [(lon - deb.lon0) * MPG * Math.cos(rad(deb.lat0)), (lat - deb.lat0) * MPG];
const global = (x, y) => [deb.lon0 + x / (MPG * Math.cos(rad(deb.lat0))), deb.lat0 + y / MPG];
let torres = [];
function origenTres([lon, lat]) {
  deb.lon0 = lon; deb.lat0 = lat;
  deb.origen = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
  deb.escala = deb.origen.meterInMercatorCoordinateUnits();
  for (const p of Object.values(POOLS)) { for (let i = 0; i < p.cap; i++) p.m.setMatrixAt(i, CERO); p.m.instanceMatrix.needsUpdate = true; p.n = 0; p.vivos = []; }
  for (const t of torres) deb.escena.remove(t.grupo);
  torres = [];
}
function lanzar(pool, [x, y, z], [vx, vy, vz], s) {
  const p = POOLS[pool]; if (!p || ![x, y, z, vx, vy, vz, ...s].every(Number.isFinite)) return; // un NaN nunca toca el piso
  if (p.n >= p.cap) return; // pool lleno: lo que ya cayó queda como escombro
  const i = p.n++;
  p.vivos.push({ i, p: [x, y, z], v: [vx, vy, vz], r: [Math.random() * 3, Math.random() * 3, Math.random() * 3], w: [(Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8], s });
}
// Lanza escombro desde bordes de la huella hacia afuera (artículo). fase 'inicio': trozos de muro y piedra; 'fin': losas y varillas.
let reparto = 1; // con muchos colapsos, menos piezas por edificación: el total cabe en los pools
function escombros(e, fase, x0, y0, factor = 1) {
  const r = Math.max(2, Math.sqrt(e.area) / 2), n = Math.min(1, e.area * e.pisos / 500) * factor * reparto * (ALTO ? 1 : 0.4);
  const [cx, cy] = x0 == null ? local(e.x, e.y) : [x0, y0];
  const salir = (pool, cant, alto, v, s) => {
    for (let i = 0; i < cant; i++) {
      const a = Math.random() * Math.PI * 2, vel = v * (0.5 + Math.random());
      lanzar(pool, [cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9, 0.5 + Math.random() * alto], [Math.cos(a) * vel, Math.sin(a) * vel, Math.random() * 3], s());
    }
  };
  if (fase === 'inicio') {
    salir('muro', Math.ceil((4 + 10 * n) * reparto), e.h * 0.8, 4, () => [1 + Math.random() * 2.5, 0.25, 1 + Math.random() * 1.8]);
    salir('roca', Math.ceil((10 + 40 * n) * reparto), e.h * 0.7, 5, () => { const s = 0.4 + Math.random() * 1.2; return [s, s, s]; });
  } else {
    salir('losa', Math.ceil((12 + 70 * n) * reparto), 3, 2.5, () => [2 + Math.random() * 3.5, 2 + Math.random() * 3.5, 0.25]);
    salir('varilla', Math.ceil((8 + 40 * n) * reparto), 3, 2, () => [0.07, 0.07, 1.5 + Math.random() * 3]);
    salir('roca', Math.ceil((20 + 60 * n) * reparto), 2, 3, () => { const s = 0.3 + Math.random() * 1; return [s, s, s]; });
  }
}
function moverEscombros(dt) {
  let hay = false;
  for (const p of Object.values(POOLS)) {
    if (!p.vivos.length) continue;
    for (let j = p.vivos.length - 1; j >= 0; j--) {
      const q = p.vivos[j];
      q.v[2] -= 9.8 * dt;
      for (let a = 0; a < 3; a++) { q.p[a] += q.v[a] * dt; q.r[a] += q.w[a] * dt; }
      if (q.p[2] <= q.s[2] / 2) { q.p[2] = q.s[2] / 2; q.r[0] = q.r[1] = 0; p.vivos[j] = p.vivos[p.vivos.length - 1]; p.vivos.pop(); } // queda en el piso como escombro
      aux.position.set(...q.p); aux.rotation.set(...q.r); aux.scale.set(...q.s); aux.updateMatrix();
      p.m.setMatrixAt(q.i, aux.matrix);
    }
    p.m.instanceMatrix.needsUpdate = true; hay = true;
  }
  return hay;
}

// Torre que se ladea (artículo): bloques apilados que giran desde la base, se doblan y se sueltan.
function crearTorre(e, r) {
  const c = cajaOrientada(e.anillos[0], deb.lon0, deb.lat0);
  const n = Math.min(4, Math.max(2, Math.round(e.h / 9))), hs = e.h / n;
  const grupo = new THREE.Group(); grupo.position.set(c.cx, c.cy, 0); grupo.rotation.z = c.ang + (r() < 0.5 ? 0 : Math.PI);
  const mat = new THREE.MeshLambertMaterial({ map: texturas.alta.clone(), side: THREE.DoubleSide });
  mat.map.repeat.set(Math.max(1, c.L1 / 10), Math.max(1, hs / 8)); mat.map.needsUpdate = true;
  const bloquesT = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.L1, c.L2, hs), mat); grupo.add(m);
    bloquesT.push({ m, libre: false, quieto: false, p: new THREE.Vector3(0, 0, hs * (i + 0.5)), prev: new THREE.Vector3(0, 0, hs * (i + 0.5)), v: new THREE.Vector3(), ang: 0, w: 0 });
  }
  deb.escena.add(grupo);
  const t = { e, grupo, b: bloquesT, n, hs, L1: c.L1, th: 0.03, om: 0.22, curva: 0.1 + 0.14 * r(), umbral: 0.4 + 0.3 * r(), roto: false, bisagra: false, listo: false };
  torres.push(t); posTorre(t);
  return t;
}
function posTorre(t) {
  let y = 0, z = 0;
  for (let i = 0; i < t.n; i++) {
    const b = t.b[i]; if (b.libre) continue;
    const phi = t.th * (1 + t.curva * i);
    b.prev.copy(b.p); b.p.set(0, y + Math.sin(phi) * t.hs / 2, z + Math.cos(phi) * t.hs / 2); b.ang = phi;
    b.m.position.copy(b.p); b.m.rotation.set(-phi, 0, 0);
    y += Math.sin(phi) * t.hs; z += Math.cos(phi) * t.hs;
  }
}
function caeBloque(t, b) { // el bloque toca el piso: polvo y escombro en ese punto
  const w = b.m.getWorldPosition(new THREE.Vector3()), [lon, lat] = global(w.x, w.y);
  soltarPolvo(lon, lat, 7, 34);
  escombros({ ...t.e, area: t.L1 * t.L1, pisos: Math.max(2, t.hs / 3) }, 'fin', w.x, w.y, 0.8);
}
function moverTorre(t, dt) {
  if (!t.bisagra) {
    t.om = Math.min(2.2, t.om + 1.5 * 9.8 / t.e.h * Math.sin(t.th) * dt);
    t.th += Math.min(0.09, t.om * dt);
    if (t.th >= 1.25) { t.th = 1.25; t.bisagra = true; }
    posTorre(t);
    if (t.bisagra) caeBloque(t, t.b[0]);
    if (!t.roto && t.th * (1 + t.curva * (t.n - 1)) > t.umbral) {
      t.roto = true;
      for (let i = 1; i < t.n; i++) {
        const b = t.b[i]; b.libre = true;
        b.v.subVectors(b.p, b.prev).divideScalar(Math.max(dt, 0.008)).clampScalar(-18, 18); b.w = t.om * (1 + t.curva * i);
      }
    }
  }
  for (let i = 1; i < t.n; i++) {
    const b = t.b[i];
    if (!b.libre || b.quieto) continue;
    b.v.z -= 9.8 * dt; b.p.addScaledVector(b.v, dt); b.ang += b.w * dt;
    if (b.p.z < Math.min(t.hs, t.L1) * 0.5 + 0.3) { b.p.z = Math.min(t.hs, t.L1) * 0.5 + 0.3; b.quieto = true; caeBloque(t, b); }
    b.m.position.copy(b.p); b.m.rotation.set(-b.ang, 0, 0);
  }
  t.listo = t.bisagra && t.b.every(b => !b.libre || b.quieto);
}

// ---------------------------------------------------------------- polvo: sprites en pantalla, solo por eventos
const polvo = $('polvo'), ctxP = polvo.getContext('2d'), nubes = [];
const sprite = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
{ const g = sprite.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(116,102,84,.6)'); r.addColorStop(1, 'rgba(116,102,84,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); }
function ajustarPolvo() { const d = devicePixelRatio || 1; polvo.width = polvo.clientWidth * d; polvo.height = polvo.clientHeight * d; ctxP.setTransform(d, 0, 0, d, 0, 0); }
addEventListener('resize', ajustarPolvo); ajustarPolvo();
const TOPE_POLVO = ALTO ? 420 : 160;
function soltarPolvo(lon, lat, n, tam) {
  for (let i = 0; i < n && nubes.length < TOPE_POLVO; i++) nubes.push({ lon, lat, dx: (Math.random() - .5) * 26, dy: -Math.random() * 16, r: tam * (0.6 + Math.random() * 0.8), vida: 2.5 + Math.random() * 2, t: 0 });
}
function moverPolvo(dt) {
  ctxP.clearRect(0, 0, polvo.clientWidth, polvo.clientHeight);
  for (let i = nubes.length - 1; i >= 0; i--) {
    const n = nubes[i]; n.t += dt;
    if (n.t > n.vida) { nubes.splice(i, 1); continue; }
    const p = map.project([n.lon, n.lat]), u = n.t / n.vida, r = n.r * (1 + 1.7 * u);
    ctxP.globalAlpha = 0.55 * (1 - u) * Math.min(1, n.t * 3);
    ctxP.drawImage(sprite, p.x + n.dx * n.t - r, p.y + n.dy * n.t - r * 1.3, r * 2, r * 2); // de atrás hacia adelante no hace falta: son suaves
  }
  ctxP.globalAlpha = 1;
}

// ---------------------------------------------------------------- sacudida de cámara (envolvente del artículo)
function sacudir(Mag, durS) {
  const esc = $('escenario');
  if (reducido) return () => true;
  const W = innerWidth, H = innerHeight, amp = Math.min(28, 0.02 * W, Math.max(6, (Mag - 4) * 4.2)), dir = Math.random() * Math.PI;
  let fase = 0, antes = performance.now();
  const ini = antes;
  return ahora => {
    const kk = (ahora - ini) / 1000 / durS, dt = Math.min(0.05, (ahora - antes) / 1000); antes = ahora;
    if (kk >= 1) { esc.style.transform = ''; return true; }
    let env, om;
    if (kk < 0.35) { const u = kk / 0.35; env = 0.15 + 0.85 * u * u * (3 - 2 * u); om = 7 + 39 * u * u; }
    else { const v = (kk - 0.35) / 0.65; env = (1 - v) ** 1.4; om = 46 - 18 * v; }
    fase += om * dt;
    const osc = 0.78 * Math.sin(fase) + 0.44 * (Math.random() - 0.5) * Math.min(1, om / 30), a = amp * env;
    esc.style.transform = `translate(${Math.cos(dir) * osc * a}px, ${0.7 * Math.sin(dir) * osc * a}px) rotate(${osc * a * 0.012}deg) scale(${1 + 2.4 * amp * env / Math.min(W, H)})`;
    return false;
  };
}

// ---------------------------------------------------------------- estado y tablero
const est = {
  amenaza: 'sismo', real: true, epi: [S.lon, S.lat], foco: null, costa: null, sel: null,
  fuente: 'ov', inventario: null, corriendo: false, E: [], fase: 'listo', primera: null,
};
const marcaEpi = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'marca-epi' }) }).setLngLat(est.epi).addTo(map);
const marcaCosta = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'marca-costa' }) });
const perilla = (id, fmt) => { const r = $(`r-${id}`), o = $(`o-${id}`), f = () => { o.textContent = fmt(+r.value); }; r.addEventListener('input', f); f(); return r; };
const rMag = perilla('mag', v => num1.format(v)), rProf = perilla('prof', v => `${num.format(v)} km`);
const rPrec = perilla('prec', v => `${v} %`), rOla = perilla('ola', v => `${v} m`);

function pista() {
  $('pista').textContent = est.amenaza === 'mar' ? 'Toque un punto de la costa.'
    : est.real ? 'Sismo real del 10 de agosto de 2026. Toque el mapa para elegir dónde mirar.'
    : 'Toque el mapa: ahí ocurre el sismo. También puede tocar un sismo real del mundo (Capas).';
}
function modoAmenaza(a) {
  est.amenaza = a;
  $('m-sismo').setAttribute('aria-pressed', a === 'sismo'); $('m-mar').setAttribute('aria-pressed', a === 'mar');
  document.querySelectorAll('[data-modo]').forEach(el => { el.hidden = el.dataset.modo !== a; });
  marcaEpi.getElement().hidden = a !== 'sismo';
  limpiarAgua(); $('resultado').hidden = true; leyenda();
  if (a === 'mar') {
    if (!est.costa) ponerCosta([-78.7647, 1.8064]); // Tumaco (Nariño)
    map.flyTo({ center: est.costa, zoom: 11.2, pitch: 0, bearing: 0, duration: reducido ? 0 : 1800 });
  } else marcaCosta.remove();
  pista();
}
function modoEscenario(real) {
  est.real = real;
  $('e-real').setAttribute('aria-pressed', real); $('e-libre').setAttribute('aria-pressed', !real);
  rMag.disabled = rProf.disabled = real;
  if (real) { rMag.value = S.mag; rProf.value = Math.round(S.prof); est.epi = [S.lon, S.lat]; }
  else { rMag.value = 6.8; rProf.value = 15; est.epi = est.foco ?? est.sel?.centro ?? est.epi; }
  rMag.dispatchEvent(new Event('input')); rProf.dispatchEvent(new Event('input'));
  marcaEpi.setLngLat(est.epi);
  pista();
}
function ponerCosta(p) { est.costa = p; marcaCosta.setLngLat(p).addTo(map); alLado(p); }
function alLado(p) { // el municipio más cercano pasa a ser el protagonista
  let mejor = null, dmin = 40;
  for (const m of D.mun) { const d = distanciaKm(p[0], p[1], ...m.centro); if (d < dmin) { dmin = d; mejor = m; } }
  if (mejor && mejor !== est.sel) { const foco = est.foco; seleccionar(mejor.id, { volar: false }); est.foco = foco; }
}
$('m-sismo').onclick = () => !est.corriendo && modoAmenaza('sismo');
$('m-mar').onclick = () => !est.corriendo && modoAmenaza('mar');
$('e-real').onclick = () => !est.corriendo && modoEscenario(true);
$('e-libre').onclick = () => !est.corriendo && modoEscenario(false);
rPrec.addEventListener('change', () => { if (!est.corriendo && est.E.length) reiniciarEdificios(); });

map.on('click', e => {
  if (est.corriendo) return;
  const ll = [e.lngLat.lng, e.lngLat.lat];
  const sismoMundo = map.getLayer('mundo') && map.queryRenderedFeatures(e.point, { layers: ['mundo'] })[0];
  if (est.amenaza === 'sismo' && sismoMundo) {
    const p = sismoMundo.properties;
    modoEscenario(false);
    rMag.value = p.mag; rProf.value = Math.min(150, Math.max(5, p.prof)); rMag.dispatchEvent(new Event('input')); rProf.dispatchEvent(new Event('input'));
    est.epi = est.foco = sismoMundo.geometry.coordinates.slice(0, 2); marcaEpi.setLngLat(est.epi);
    avisar(`${p.lugar}: M ${num1.format(p.mag)}. Listo para simular.`, 3500);
    return;
  }
  const mun = map.getLayer('mun') && map.queryRenderedFeatures(e.point, { layers: ['mun'] })[0];
  if (mun) { seleccionar(mun.properties.id); return; }
  if (est.amenaza === 'mar') { ponerCosta(ll); limpiarAgua(); return; }
  alLado(ll); // primero: cambiar de municipio no debe mover el epicentro que se acaba de tocar
  if (!est.real) { est.epi = ll; marcaEpi.setLngLat(ll); }
  est.foco = ll; pedirIgac(ll);
});

// ---------------------------------------------------------------- lugar
async function gestorCatastral(id) {
  try {
    const r = await fetch(`${IGAC}/catastro/Gestores_Catastrales/MapServer/1/query?where=${encodeURIComponent(`divipola='${id}'`)}&outFields=gestor_catastral&returnGeometry=false&f=json`, { signal: AbortSignal.timeout(6000) });
    return (await r.json()).features?.[0]?.attributes?.gestor_catastral ?? null;
  } catch { return null; }
}
function seleccionar(id, { volar = true } = {}) {
  const m = porId.get(id); if (!m) return;
  est.sel = m; est.foco = m.centro;
  history.replaceState(null, '', `?mpio=${m.id}`);
  $('b-presentacion').href = `../presentacion_ejecutiva.html?mpio=${m.id}`;
  $('nombre').textContent = m.N; $('dpto').textContent = m.Dp;
  const COLP = { rojo: COLOR.rojo, amarillo: COLOR.amarillo, verde: COLOR.verde };
  $('insignias').innerHTML = `<span class="insignia" title="Intensidad del sismo del 10 de agosto (ShakeMap, USGS)">${romano(m.mmi)}</span>`
    + (m.pl == null ? '' : `<span class="insignia" title="Probabilidad mensual de emergencia por lluvia en octubre y noviembre">${pct.format(m.pl)} lluvia</span>`)
    + `<span class="insignia" title="Prioridad: sismo × lluvia"><i style="background:${COLP[m.prio]}"></i>${m.prio}</span>`;
  if (!est.real) { est.epi = m.centro; marcaEpi.setLngLat(est.epi); }
  if (volar) map.flyTo({ center: m.centro, zoom: Math.max(map.getZoom(), 11.5), pitch: 30, duration: reducido ? 0 : 2000 });
  pedirIgac(m.centro);
  gestorCatastral(m.id).then(g => { // no detiene nada: el servidor del IGAC a veces tarda
    if (g && est.sel === m) $('insignias').insertAdjacentHTML('beforeend', `<span class="insignia igac" title="Gestor catastral (IGAC)">Catastro: ${titulo(g.replace(/^MUNICIPIO DE /, '')).slice(0, 34)}</span>`);
  });
}
const buscar = $('buscar-input');
buscar.addEventListener('input', () => {
  const m = porEtiqueta.get(plano(buscar.value));
  if (!m) return sugerir(buscar.value);
  buscar.value = ''; buscar.blur(); sugerir(); seleccionar(m.id);
});
buscar.addEventListener('change', () => { if (buscar.value) { buscar.value = ''; sugerir(); avisar('Elija un municipio de la lista.'); } });

// ---------------------------------------------------------------- capas, alcaldía e información
const popovers = { 'b-capas': 'p-capas', 'b-inv': 'p-inv', 'b-info': 'p-info' };
for (const [b, p] of Object.entries(popovers)) $(b).addEventListener('click', () => {
  const abrir = $(p).hidden;
  for (const [b2, p2] of Object.entries(popovers)) { $(p2).hidden = true; $(b2).setAttribute('aria-expanded', false); }
  $(p).hidden = !abrir; $(b).setAttribute('aria-expanded', abrir);
});
let mundoCargado = false;
async function cargarMundo() {
  try {
    const d = await (await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson')).json();
    map.getSource('mundo').setData({ type: 'FeatureCollection', features: d.features.map(f => ({ type: 'Feature', geometry: { type: 'Point', coordinates: f.geometry.coordinates.slice(0, 2) }, properties: { mag: f.properties.mag, prof: f.geometry.coordinates[2], lugar: f.properties.place } })) });
    return d.features.length;
  } catch { avisar('No se pudo leer el catálogo del USGS.'); return 0; }
}
document.querySelectorAll('[data-capa]').forEach(ch => ch.addEventListener('change', async () => {
  const id = ch.dataset.capa;
  if (id === 'mundo' && ch.checked && !mundoCargado) {
    const n = await cargarMundo(); mundoCargado = n > 0; if (n) { avisar(`${n} sismos de magnitud 4,5 o más en los últimos 30 días. Toque uno para simularlo.`, 4500); map.flyTo({ zoom: 1.6, center: [-60, 5], pitch: 0, duration: 1800 }); }
  }
  visible(id, ch.checked); leyenda();
}));
$('supuestos').innerHTML = [
  'Edificaciones: catastro del IGAC (pisos y tipo de construcción) donde está publicado; en el resto, Overture Maps (OpenStreetMap, Google y Microsoft); o el inventario de la alcaldía, leído solo en este equipo.',
  'Sismo real: malla ShakeMap v9 del USGS (evento us6000tjl2). Escenario libre: MMI = 1,5·M − 3·log10(R) − 0,0018·R + 1,6.',
  'Fragilidad calibrada con Pereira: 571 viviendas destruidas de 136.803 (UNGRD; DANE). Construcción "no convencional" del catastro IGAC = precaria.',
  `Escombro: ${num1.format(SUPUESTOS.tonPorM2)} t por m² que colapsa. Bloques: ${pct.format(SUPUESTOS.aprovechable)} aprovechable, ${SUPUESTOS.kgPorBloque} kg por bloque.`,
  'Maremoto: relieve Terrarium; el agua baja en línea recta hasta 12 km tierra adentro y no cruza lomas.',
  'Lluvia: probabilidad mensual de emergencia por municipio, modelo del equipo (UNGRD, CHIRPS, DANE). Suelos: capacidad de uso, IGAC.',
  'Es un escenario para decidir; la decisión sobre cada casa la confirma una inspección en campo.',
].map(t => `<li>${t}</li>`).join('');

// ---------------------------------------------------------------- leyenda
function leyenda() {
  const L = $('leyenda'), partes = [];
  if (est.amenaza === 'sismo' && map.getLayoutProperty('mmi10', 'visibility') !== 'none' && map.getZoom() < 12) {
    const niv = [5, 6, 7, 8, 9, 10];
    partes.push(`<b>Intensidad</b><div class="escala">${niv.map(n => `<i style="background:rgb(${colorMmi(n).join(',')})"></i>`).join('')}${niv.map(n => `<span>${ROMANO[n]}</span>`).join('')}</div>`);
  }
  if (est.E.length && est.fase !== 'listo') partes.push([[COLOR.habitable, 'Habitable'], ['#e0a52c', 'Reparar'], [COLOR.rojo, 'Demoler'], [COLOR.nueva, 'NSR-10']].map(([c, t]) => `<span class="item"><i class="cubo" style="background:${c}"></i>${t}</span>`).join(''));
  if (map.getSource('agua')) partes.push(`<b>Agua</b><span class="item"><i class="cubo" style="background:#5f7987"></i>poca</span><span class="item"><i class="cubo" style="background:#28465f"></i>profunda</span><span class="item"><i class="cubo" style="background:#3d8fd1"></i>edificación alcanzada</span>`);
  L.innerHTML = partes.join('');
  L.hidden = !partes.length;
}
map.on('zoomend', leyenda);

// ---------------------------------------------------------------- edificaciones para simular
const TOPE = ALTO ? 9000 : 4000;
async function desdeIgac([lon, lat]) { // catastro IGAC publicado: pisos y tipo de construcción
  const d = 0.0045, caja = [lon - d, lat - d, lon + d, lat + d].map(v => v.toFixed(5)).join(','); // ~1 km de lado
  const feats = [];
  try {
    for (let off = 0; off < 4000; off += 2000) { // ponytail: dos páginas bastan para el centro; más páginas si se quiere el casco entero
      const u = `${IGAC}/catastro/Cambiosconstruccionesmunicipio/MapServer/2/query?geometry=${caja}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NUMERO_PIS,TIPO_CONST&outSR=4326&geometryPrecision=6&resultOffset=${off}&resultRecordCount=2000&f=geojson`;
      const fc = await fetch(u, { signal: AbortSignal.timeout(60000) }).then(r => r.json());
      feats.push(...(fc.features ?? []));
      if ((fc.features ?? []).length < 2000) break;
    }
  } catch { return null; }
  if (feats.length < 30) return null;
  return feats.filter(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon').map(f => {
    const anillos = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0], pisos = Math.max(1, f.properties.NUMERO_PIS || 1);
    return { anillos, h: pisos * 3, pisos, clase: f.properties.TIPO_CONST === 'NO CONVENCIONAL' ? 'precaria' : null, observado: null };
  });
}
// El catastro del IGAC tarda de 10 a 40 s en responder: se pide apenas hay un lugar y se usa si ya llegó; si no, Overture
const igacPedido = new Map();
function pedirIgac(foco) {
  const clave = foco.map(v => v.toFixed(4)).join();
  if (!igacPedido.has(clave)) igacPedido.set(clave, desdeIgac(foco));
  return igacPedido.get(clave);
}
function desdeOverture() {
  const vistos = new Set(), lista = [];
  for (const f of map.querySourceFeatures('ov', { sourceLayer: 'building' })) {
    const id = f.id ?? f.properties.id;
    if (id == null || vistos.has(id) || f.properties.is_underground) continue;
    const g = f.geometry, anillos = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates[0] : null;
    if (!anillos || anillos[0].length < 4) continue;
    vistos.add(id);
    const h = f.properties.height ?? (f.properties.num_floors ? f.properties.num_floors * 3.2 : 6);
    lista.push({ id, anillos, h, pisos: Math.max(1, Math.round(h / 3)), clase: null, observado: null });
  }
  return lista;
}
function desdeInventario(inv) {
  return inv.edificios.map(b => { const pisos = b.pisos ?? 1; return { anillos: b.anillos, h: pisos * 3, pisos, clase: b.clase, observado: b.estado }; });
}
function centroInventario(inv) {
  const c = inv.edificios.map(b => centroide(b.anillos));
  return [c.reduce((s, p) => s + p[0], 0) / c.length, c.reduce((s, p) => s + p[1], 0) / c.length];
}
async function cargarEdificios(foco) {
  let lista, fuente = 'ov';
  if (est.inventario) { lista = desdeInventario(est.inventario); fuente = 'inv'; }
  else {
    lista = await Promise.race([pedirIgac(foco), espera(0).then(() => null)]); // ya resuelto gana; pendiente, no se espera
    if (lista) fuente = 'igac';
    else { lista = desdeOverture(); if (lista.length < 50) { await evento('idle', 4000); lista = desdeOverture(); } }
  }
  const conDist = lista.map(e => { const [x, y] = centroide(e.anillos); return { ...e, x, y, d: distanciaKm(x, y, ...foco) }; })
    .sort((a, b) => a.d - b.d).slice(0, TOPE);
  conDist.forEach((e, i) => { if (fuente !== 'ov') e.id = i; e.area = areaM2(e.anillos); });
  if (fuente !== 'ov') map.getSource(fuente).setData({ type: 'FeatureCollection', features: conDist.map(e => ({ type: 'Feature', id: e.id, geometry: { type: 'Polygon', coordinates: e.anillos }, properties: { h: e.h } })) });
  est.fuente = fuente; mostrarFuente(fuente);
  return conDist;
}
const ref = e => ({ source: est.fuente, id: e.id, ...(est.fuente === 'ov' ? { sourceLayer: 'building' } : {}) });
const marcar = (e, estado) => map.setFeatureState(ref(e), estado);
function reiniciarEdificios() {
  for (const f of ['ov', 'igac', 'inv']) map.removeFeatureState({ source: f, ...(f === 'ov' ? { sourceLayer: 'building' } : {}) });
  for (const e of est.E) { e.rec = false; e.fin = null; }
  est.fase = 'listo'; est.primera = null; $('resultado').hidden = true;
  if (deb.origen) origenTres([deb.lon0, deb.lat0]);
  leyenda();
}

// ---------------------------------------------------------------- simulación del sismo
async function bucear(foco) { // artículo: picada hasta 16,2 a 62°; se espera lo justo para que lleguen las teselas
  const llega = evento('moveend', 2500); // antes de volar: con duración 0 el evento sale al instante
  map.flyTo({ center: foco, zoom: 16.2, pitch: 62, bearing: -25, duration: reducido ? 0 : 1800 });
  await llega; await evento('idle', 1200);
}
function mezcla() { const p = +rPrec.value / 100; return { precaria: p, media: (1 - p) / 3, nsr10: 2 * (1 - p) / 3 }; }
function decidir() {
  const mz = mezcla(), Mag = +rMag.value, prof = +rProf.value;
  for (const e of est.E) {
    e.mmi = est.real ? mmiEn(D.malla, S, e.x, e.y).mmi : mmiEscenario(Mag, prof, distanciaKm(est.epi[0], est.epi[1], e.x, e.y));
    // "convencional" en catastro no dice si es confinada o no: se sortea entre media y norma con la misma proporción 1 a 2
    const base = e.clase ?? (e.v < mz.precaria ? 'precaria' : e.v < mz.precaria + mz.media ? 'media' : 'nsr10');
    const clase = e.rec ? 'nsr10' : base;
    e.fin = est.real && !e.rec && e.observado ? e.observado : estado(e.u, probDano(e.mmi, clase), probColapso(e.mmi, clase));
  }
}
function contar(lista = est.E) {
  const c = { habitable: 0, reparar: 0, demoler: 0, ton: 0 };
  for (const e of lista) {
    c[e.fin]++;
    if (e.fin === 'demoler') c.ton += escombroTon(e.area, e.pisos);
    if (e.fin === 'reparar') c.ton += escombroTon(e.area, e.pisos) * SUPUESTOS.fraccionReparar;
  }
  return c;
}
function bloquear(si) {
  est.corriendo = si;
  $('simular').disabled = si;
  document.querySelectorAll('#tablero .seg button, #tablero input').forEach(b => { b.disabled = si || (b === rMag || b === rProf) && est.real; });
}

async function simularSismo() {
  bloquear(true); limpiarAgua();
  const foco = est.inventario ? centroInventario(est.inventario) : est.foco ?? (est.real ? (est.sel?.centro ?? [-75.6946, 4.8143]) : est.epi);
  reiniciarEdificios(); pedirIgac(foco);
  await bucear(foco);
  origenTres(foco);
  est.E = await cargarEdificios(foco);
  if (!est.E.length) { avisar('No hay edificaciones mapeadas aquí. Acérquese a un casco urbano o cargue el inventario de la alcaldía.'); bloquear(false); return; }
  const r = azar(semillaDe(foco));
  est.E.forEach(e => { e.u = r(); e.v = r(); e.rec = false; });
  decidir();
  await animarSismo();
  terminarSismo();
  bloquear(false);
}
function animarSismo() {
  return new Promise(listo => {
    const r = azar(est.E.length + (est.fase === 'reconstruido' ? 7 : 1)), Mag = +rMag.value;
    const caen = [], fisuras = [];
    for (const e of est.E) {
      e.hecho = false; e.arranco = false; e.paso = -1;
      if (e.fin === 'demoler') {
        e.kf = Math.max(0.04, 1.6 / e.h); e.ini = 0.8 + 2.8 * r();
        if (e.h >= 25 && r() < 0.6) e.modo = 'torre';
        else { const m = e.h < 8 ? ['panqueque', 'lateral'] : e.h < 20 ? ['panqueque', 'pisos', 'blando', 'lateral'] : ['pisos', 'cima', 'blando', 'panqueque']; e.modo = m[Math.floor(r() * m.length)]; }
        e.dur = 1.6 + 0.9 * r() + e.h / 40;
        caen.push(e);
      } else if (e.fin === 'reparar') { e.ini = 0.6 + 3 * r(); fisuras.push(e); }
    }
    // ponytail: cada cambio de altura es un feature-state; solo se animan las más cercanas a la cámara, el resto salta al final
    caen.sort((a, b) => a.d - b.d).forEach((e, i) => { e.salta = i >= 250; if (e.salta && e.modo === 'torre') e.modo = 'panqueque'; });
    fisuras.sort((a, b) => a.d - b.d).forEach((e, i) => { e.salta = i >= 400; });
    reparto = Math.min(1, 160 / Math.max(1, Math.min(250, caen.length)));
    fachadas(false);
    const durS = Math.min(7, Math.max(3.5, 4.6 + (Mag - 6) * 0.6));
    let temblor = sacudir(Mag, durS), replica = null;
    const inicio = performance.now();
    let antes = inicio;
    const cerrar = () => { // deja todo en su estado final y termina
      for (const e of caen) if (!e.hecho) { e.hecho = true; marcar(e, { k: e.kf, e: 'demoler' }); }
      for (const e of fisuras) if (!e.hecho) { e.hecho = true; marcar(e, { k: 1 - 0.5 / e.h, e: 'reparar' }); }
      $('escenario').style.transform = ''; fachadas(true); listo();
    };
    const paso = ahora => { try { pasoSeguro(ahora); } catch (err) { console.error(err); cerrar(); } };
    const pasoSeguro = ahora => {
      const t = (ahora - inicio) / 1000, dt = Math.min(0.1, (ahora - antes) / 1000); antes = ahora;
      if (t > 45) { console.warn('simulación cortada a los 45 s', { caen: caen.filter(e => !e.hecho).length, fisuras: fisuras.filter(e => !e.hecho).length, nubes: nubes.length }); cerrar(); return; } // ponytail: tope de seguridad
      if (temblor(ahora) && !replica && t > durS + 1.8) replica = sacudir(Mag - 1.4, 2.2); // réplica
      if (replica) replica(ahora);
      for (const e of caen) {
        if (t < e.ini || e.hecho) continue;
        if (e.salta) { if (t >= e.ini + e.dur) { e.hecho = true; marcar(e, { k: e.kf, e: 'demoler' }); } continue; }
        if (!e.arranco) {
          e.arranco = true; soltarPolvo(e.x, e.y, 3, 12 + e.pisos * 3); escombros(e, 'inicio');
          if (e.modo === 'torre') { e.torre = crearTorre(e, r); marcar(e, { k: 0 }); }
        }
        if (e.modo === 'torre') {
          moverTorre(e.torre, dt);
          if (e.torre.listo) { e.hecho = true; marcar(e, { k: e.kf, e: 'demoler' }); }
          continue;
        }
        const u = Math.min(1, (t - e.ini) / e.dur);
        marcar(e, { k: collapseK(e.modo, u, e.kf, e.h) });
        if (e.modo === 'pisos') { const s = Math.floor(u * Math.min(8, Math.max(2, Math.round(e.h / 3.2)))); if (s !== e.paso) { e.paso = s; soltarPolvo(e.x, e.y, 2, 10 + e.pisos * 2); } }
        if (e.modo === 'blando' && u > 0.12 && e.paso < 0) { e.paso = 0; soltarPolvo(e.x, e.y, 4, 14 + e.pisos * 2); }
        if (u === 1) { e.hecho = true; soltarPolvo(e.x, e.y, 6, 18 + e.pisos * 4); escombros(e, 'fin'); marcar(e, { e: 'demoler' }); }
      }
      for (const e of fisuras) {
        if (t < e.ini || e.hecho) continue;
        if (e.salta) { e.hecho = true; marcar(e, { k: 1 - 0.5 / e.h, e: 'reparar' }); continue; }
        const u = Math.min(1, (t - e.ini) / 0.5);
        marcar(e, { k: 1 - (0.5 / e.h) * u, ...(u === 1 ? { e: 'reparar' } : {}) }); // se asienta medio metro
        if (u === 1) { e.hecho = true; soltarPolvo(e.x, e.y, 1, 9); }
      }
      const vuelan = moverEscombros(dt); moverPolvo(dt); map.triggerRepaint();
      const pendientes = caen.some(e => !e.hecho) || fisuras.some(e => !e.hecho) || t < durS + 4.2;
      if (pendientes || vuelan || nubes.length) requestAnimationFrame(paso);
      else { $('escenario').style.transform = ''; fachadas(true); listo(); }
    };
    requestAnimationFrame(paso);
  });
}
function terminarSismo() {
  for (const e of est.E) if (e.fin === 'habitable') marcar(e, { e: e.rec ? 'nueva' : 'habitable' });
  const c = contar();
  if (est.fase === 'listo') { est.fase = 'simulado'; est.primera = est.E.filter(e => e.fin !== 'habitable').map(e => ({ id: e.id, fin: e.fin })); }
  else if (est.fase === 'reconstruido') est.fase = 'repetido';
  let comp = '';
  if (est.fase === 'repetido') {
    const ids = new Set(est.primera.map(p => p.id)), ahora = contar(est.E.filter(e => ids.has(e.id)));
    const antes = est.primera.filter(p => p.fin === 'demoler').length;
    comp = `<div class="dato"><b>${num.format(antes)} → ${num.format(ahora.demoler)}</b><span>colapsos tras reconstruir</span></div>`;
  }
  const FUENTE = { ov: 'Overture Maps', igac: 'catastro IGAC', inv: 'inventario de la alcaldía' };
  $('resultado').innerHTML = `
    <div class="dato"><b>${num.format(c.demoler)}</b><span><i class="punto" style="background:${COLOR.rojo}"></i>colapsan</span></div>
    <div class="dato"><b>${num.format(c.reparar)}</b><span><i class="punto" style="background:#e0a52c"></i>a reparar</span></div>
    <div class="dato"><b>${num.format(c.ton)} t</b><span>escombro</span></div>
    <div class="dato"><b>${num.format(bloques(c.ton))}</b><span>bloques reciclados</span></div>
    ${comp}
    <div class="dato"><b>${num.format(est.E.length)}</b><span>edificaciones · ${FUENTE[est.fuente]}</span></div>
    <div class="acc"><button class="btn2" id="reconstruir" ${est.primera?.length && est.fase === 'simulado' ? '' : 'disabled'}>Reconstruir con NSR-10</button>
    <button class="btn2" id="repetir" ${est.fase === 'reconstruido' ? '' : 'disabled'}>Repetir el sismo</button></div>`;
  $('resultado').hidden = false;
  $('reconstruir').onclick = reconstruir; $('repetir').onclick = repetir;
  leyenda();
}
function reconstruir() {
  if (est.corriendo) return;
  bloquear(true); origenTres([deb.lon0, deb.lat0]);
  const lista = est.E.filter(e => e.fin !== 'habitable'), ini = performance.now(), dur = reducido ? 1 : 1600;
  fachadas(false);
  lista.forEach(e => { e.rec = true; marcar(e, { e: 'nueva' }); });
  const paso = ahora => {
    const u = Math.min(1, (ahora - ini) / dur), kk = 0.05 + 0.95 * (1 - (1 - u) ** 3);
    lista.forEach(e => marcar(e, { k: Math.max(kk, e.fin === 'reparar' ? 0.97 : 0) }));
    if (u < 1) requestAnimationFrame(paso);
    else { est.fase = 'reconstruido'; fachadas(true); bloquear(false); $('reconstruir').disabled = true; $('repetir').disabled = false; }
  };
  requestAnimationFrame(paso);
}
async function repetir() {
  if (est.corriendo) return;
  bloquear(true);
  for (const e of est.E) marcar(e, { k: 1, e: e.rec ? 'nueva' : '' });
  decidir(); await animarSismo(); terminarSismo(); bloquear(false);
}

// ---------------------------------------------------------------- maremoto
let agua = null;
function limpiarAgua() {
  if (agua) { agua.cancelado = true; agua = null; }
  map.getSource('mojadas')?.setData({ type: 'FeatureCollection', features: [] });
  if (map.getLayer('agua')) map.removeLayer('agua');
  if (map.getSource('agua')) map.removeSource('agua');
  leyenda();
}
const cargarImagen = url => new Promise((ok, mal) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = mal; i.src = url; });
const ondas = (() => { // textura de agua hecha a mano (el artículo usa un video)
  const c = Object.assign(document.createElement('canvas'), { width: 96, height: 96 }), g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.4;
  for (let y = 6; y < 96; y += 12) { g.beginPath(); for (let x = 0; x <= 96; x += 4) g.lineTo(x, y + Math.sin(x / 96 * Math.PI * 4 + y) * 2.5); g.stroke(); }
  return c;
})();
async function simularMaremoto() {
  bloquear(true); limpiarAgua(); reiniciarEdificios();
  const p = est.costa, H = +rOla.value, L = 12000, rM = L + 3000;
  const dLat = rM / 111320, dLon = dLat / Math.cos(rad(p[1]));
  const [oeste, sur, este, norte] = [p[0] - dLon, p[1] - dLat, p[0] + dLon, p[1] + dLat];
  const z = elegirZoom(oeste, sur, este, norte);
  const [x1f, y1f] = aTesela(oeste, norte, z), [x2f, y2f] = aTesela(este, sur, z);
  const tx1 = Math.floor(x1f), ty1 = Math.floor(y1f), tx2 = Math.floor(x2f), ty2 = Math.floor(y2f);
  const lienzoT = Object.assign(document.createElement('canvas'), { width: (tx2 - tx1 + 1) * 256, height: (ty2 - ty1 + 1) * 256 }), gT = lienzoT.getContext('2d', { willReadFrequently: true });
  try {
    const teselas = [];
    for (let ty = ty1; ty <= ty2; ty++) for (let tx = tx1; tx <= tx2; tx++) teselas.push([tx, ty]);
    await Promise.all(teselas.map(async ([tx, ty]) => gT.drawImage(await cargarImagen(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`), (tx - tx1) * 256, (ty - ty1) * 256)));
  } catch { avisar('No se pudo leer el relieve. Revise la conexión.'); bloquear(false); return; }
  const px0 = Math.floor((x1f - tx1) * 256), py0 = Math.floor((y1f - ty1) * 256), w = Math.ceil((x2f - x1f) * 256), h = Math.ceil((y2f - y1f) * 256);
  const datos = gT.getImageData(px0, py0, w, h).data, crudo = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) crudo[i] = terrarium(datos[i * 4], datos[i * 4 + 1], datos[i * 4 + 2]);
  const elev = suavizar(mediana3(crudo, w, h), w, h), mar = mascaraMar(elev, w, h);
  const celdaM = 156543.03392 * Math.cos(rad(p[1])) / 2 ** z;
  const res = inundar(elev, mar, w, h, celdaM, H, L);
  const [cxf, cyf] = aTesela(p[0], p[1], z), cx = Math.round((cxf - tx1) * 256 - px0), cy = Math.round((cyf - ty1) * 256 - py0);
  const costa = costaYMar(mar, w, h, cx, cy, Math.max(6, Math.round(2500 / celdaM)));
  if (!costa || !res.maxAlcance) { avisar('Ahí no hay costa cerca. Toque un punto en la orilla del mar.'); bloquear(false); return; }
  const aLL = (gx, gy) => deTesela(tx1 + (px0 + gx) / 256, ty1 + (py0 + gy) / 256, z);

  // canvas de agua sobre el mapa, alineado a las teselas
  const cv = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = cv.getContext('2d'), img = g.createImageData(w, h);
  map.addSource('agua', { type: 'canvas', canvas: cv, animate: true, coordinates: [aLL(0, 0), aLL(w, 0), aLL(w, h), aLL(0, h)] });
  map.addLayer({ id: 'agua', type: 'raster', source: 'agua', paint: { 'raster-opacity': 0.94, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, 'ov-muros');
  agua = { cancelado: false };
  const yo = agua;
  const celdas = [], ruido = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) if (res.prof[i] > 0) { celdas.push(i); ruido[i] = Math.random() - 0.5; }
  leyenda();

  // cámara: parada tierra adentro, mirando al mar, y luego se retira (artículo)
  const costaLL = aLL(costa.x + 0.5, costa.y + 0.5), rumbo = Math.atan2(costa.dx, -costa.dy) * 180 / Math.PI;
  const atras = 900 / celdaM, centro = aLL(costa.x + 0.5 + costa.dx * atras * 0.4, costa.y + 0.5 + costa.dy * atras * 0.4);
  const llega = evento('moveend', 2500);
  map.flyTo({ center: centro, zoom: Math.min(13.6, z + 2.8), pitch: 72, bearing: rumbo, duration: reducido ? 0 : 1200 });
  await llega;
  origenTres(costaLL); est.fuente = 'ov'; mostrarFuente('ov');

  // edificaciones que el agua alcanza: se leen cuando cargan las teselas, sin detener la ola
  const alcanzadas = [];
  const recogidas = evento('idle', 6000).then(() => {
    if (yo.cancelado) return;
    const vistos = new Set();
    for (const f of map.querySourceFeatures('ov', { sourceLayer: 'building' })) {
      const gm = f.geometry, anillos = gm.type === 'Polygon' ? gm.coordinates : gm.type === 'MultiPolygon' ? gm.coordinates[0] : null;
      if (!anillos || anillos[0].length < 4) continue;
      const [x, y] = centroide(anillos), clave = `${x.toFixed(5)},${y.toFixed(5)},${anillos[0].length}`; // las teselas se solapan
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const [gx, gy] = aTesela(x, y, z), i = Math.floor((gy - ty1) * 256 - py0) * w + Math.floor((gx - tx1) * 256 - px0);
      if (i >= 0 && i < w * h && res.prof[i] > 0.15)
        alcanzadas.push({ id: alcanzadas.length, anillos, h: f.properties.height ?? (f.properties.num_floors ?? 2) * 3.2, llegada: res.alcance[i] + ruido[i] * 180, marcado: false });
    }
    map.getSource('mojadas').setData({ type: 'FeatureCollection', features: alcanzadas.map(e => ({ type: 'Feature', id: e.id, geometry: { type: 'Polygon', coordinates: e.anillos }, properties: { h: e.h } })) });
  });
  const area = celdas.length * celdaM * celdaM / 1e6;
  let profMax = 0; for (const i of celdas) profMax = Math.max(profMax, res.prof[i]);

  await new Promise(fin => {
    const ini = performance.now(); let retirado = false, desfase = 0;
    const px = img.data;
    const paso = ahora => {
      if (yo.cancelado) return fin();
      const t = (ahora - ini) / 1000, F = frente(t, res.maxAlcance), m = Math.min(1, Math.max(0, (t - T_LLEGADA) / 7));
      for (const i of celdas) {
        const llegada = res.alcance[i] + ruido[i] * 180, o = i * 4;
        if (llegada > F) { px[o + 3] = 0; continue; }
        const [r, gg, b, a] = colorAgua(res.prof[i], (F - llegada) / 150);
        px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = a;
      }
      g.putImageData(img, 0, 0);
      // textura de oleaje y barro, solo donde ya hay agua (source-atop)
      desfase = (desfase + 0.6) % 96;
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = 0.3; g.fillStyle = g.createPattern(ondas, 'repeat'); g.translate(desfase, desfase / 3); g.fillRect(-desfase, -desfase, w + 96, h + 96); g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = (0.5 + 0.38 * m) * 0.22; g.fillStyle = `rgb(${28 + 108 * m},${112 - 10 * m},${178 - 126 * m})`; g.fillRect(0, 0, w, h);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      for (const e of alcanzadas) if (!e.marcado && e.llegada <= F) { e.marcado = true; map.setFeatureState({ source: 'mojadas', id: e.id }, { m: true }); }
      if (!retirado && t > T_LLEGADA + 3.2) { retirado = true; map.easeTo({ zoom: Math.min(13.6, z + 2.8) - 1.3, pitch: 55, duration: reducido ? 0 : 2600 }); }
      if (t < T_LLENO + 0.5) requestAnimationFrame(paso);
      else { map.getSource('agua')?.pause(); fin(); }
    };
    requestAnimationFrame(paso);
  });
  await recogidas;
  if (yo.cancelado) { bloquear(false); return; }
  $('resultado').innerHTML = `
    <div class="dato"><b>${num1.format(area)} km²</b><span><i class="punto" style="background:${COLOR.agua}"></i>bajo el agua</span></div>
    <div class="dato"><b>${num.format(alcanzadas.length)}</b><span>edificaciones alcanzadas</span></div>
    <div class="dato"><b>${num1.format(profMax)} m</b><span>agua más profunda</span></div>
    <div class="dato"><b>${num1.format(res.maxAlcance / 1000)} km</b><span>tierra adentro</span></div>`;
  $('resultado').hidden = false;
  bloquear(false);
}

// ---------------------------------------------------------------- inventario privado: FileReader, sin envíos
async function cargarArchivo(file) {
  if (!file) return;
  if (file.size > 60e6) { avisar('El archivo pesa más de 60 MB. Divídalo por sectores.'); return; }
  const r = leerInventario(await file.text());
  $('errores').innerHTML = '';
  for (const t of r.errores.slice(0, 5).concat(r.errores.length > 5 ? [`y ${r.errores.length - 5} avisos más`] : [])) $('errores').appendChild(Object.assign(document.createElement('li'), { textContent: t }));
  if (!r.edificios.length) { avisar('El archivo no trae edificaciones válidas.'); return; }
  est.inventario = r; $('quitar-inv').hidden = false;
  avisar(`${num.format(r.edificios.length)} edificaciones de la alcaldía, leídas en este equipo.`, 3500);
  if (est.amenaza !== 'sismo') modoAmenaza('sismo');
  est.foco = centroInventario(r);
}
$('archivo').addEventListener('change', e => cargarArchivo(e.target.files[0]));
const zona = $('soltar');
zona.addEventListener('dragover', e => { e.preventDefault(); zona.classList.add('encima'); });
zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
zona.addEventListener('drop', e => { e.preventDefault(); zona.classList.remove('encima'); cargarArchivo(e.dataTransfer.files[0]); });
$('quitar-inv').onclick = () => { est.inventario = null; $('quitar-inv').hidden = true; $('errores').innerHTML = ''; mostrarFuente('ov'); };

// ---------------------------------------------------------------- arranque
$('simular').onclick = () => { if (est.corriendo) return; (est.amenaza === 'mar' ? simularMaremoto() : simularSismo()).catch(err => { console.error(err); avisar('Algo falló en la simulación. Intente de nuevo.'); bloquear(false); }); };
addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('input, button, a')) $('simular').click(); });
const pedido = new URLSearchParams(location.search).get('mpio');
seleccionar(porId.has(pedido) ? pedido : '66001', { volar: false });
modoEscenario(true); pista(); leyenda(); ondaMmi();
$('cargando').classList.add('listo');
if (pedido && !porId.has(pedido)) avisar(`No encontré el código ${pedido}. Muestro Pereira.`);
