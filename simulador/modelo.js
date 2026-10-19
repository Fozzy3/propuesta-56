// Modelo del simulador: intensidad, fragilidad, escombros y lectura del inventario privado.
// Funciones puras, sin DOM: las usa index.html y las prueba modelo.test.js.

const R_TIERRA = 6371; // km
const rad = g => g * Math.PI / 180;

export function distanciaKm(lon1, lat1, lon2, lat2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.sqrt(a));
}

function interpolar(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  }
  return ys.at(-1);
}

// Intensidad (MMI) del sismo real en un punto: la malla de ShakeMap si cubre el punto;
// si no, la curva de atenuación del mismo evento por distancia al epicentro.
export function mmiEn(malla, sismo, lon, lat) {
  const fx = (lon - malla.x0) / malla.dx, fy = (lat - malla.y0) / malla.dy;
  if (fx >= 0 && fy >= 0 && fx <= malla.nx - 1 && fy <= malla.ny - 1) {
    const ix = Math.min(Math.floor(fx), malla.nx - 2), iy = Math.min(Math.floor(fy), malla.ny - 2);
    const tx = fx - ix, ty = fy - iy;
    let suma = 0, ok = true;
    for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      if (w === 0) continue;
      const v = malla.v[(iy + dy) * malla.nx + ix + dx];
      if (v == null) { ok = false; break; }
      suma += w * v;
    }
    if (ok) return { mmi: suma, fuente: 'shakemap' };
  }
  const d = distanciaKm(sismo.lon, sismo.lat, lon, lat);
  return { mmi: interpolar(sismo.atenuacion.repi, sismo.atenuacion.mmi, d), fuente: 'curva' };
}

// Fragilidad lognormal en MMI: P = Φ((mmi − μ) / β).
// ponytail: calibrada en un solo punto, Pereira con MMI 8,1 (malla de ShakeMap v9 en el centro): 571 viviendas destruidas
// de 136.803 (UNGRD, 12 ago 2026; DANE CNPV 2018) y 3,6 averiadas por cada destruida (Risaralda).
// Recalibrar con el censo de daños de cada alcaldía.
const BETA = 0.7;
const MU = {
  precaria: { dano: 8.75, colapso: 9.3 },   // bahareque, tapia, adobe
  media: { dano: 9.75, colapso: 10.3 },     // mampostería no confinada
  nsr10: { dano: 10.95, colapso: 11.5 },    // mampostería confinada o pórticos con norma
};
export const CLASES = Object.keys(MU);
export const MEZCLA_BASE = { precaria: 0.1, media: 0.3, nsr10: 0.6 };

function phi(z) { // normal estándar acumulada (Abramowitz y Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
export const probDano = (mmi, clase) => phi((mmi - MU[clase].dano) / BETA);
export const probColapso = (mmi, clase) => phi((mmi - MU[clase].colapso) / BETA);

export function tasas(mmi, mezcla) {
  let colapso = 0, dano = 0;
  for (const c of CLASES) { colapso += mezcla[c] * probColapso(mmi, c); dano += mezcla[c] * probDano(mmi, c); }
  return { colapso, dano };
}

export const estado = (u, pDano, pColapso) => u < pColapso ? 'demoler' : u < pDano ? 'reparar' : 'habitable';
export const ESTADOS = ['habitable', 'reparar', 'demoler'];

const SISTEMAS = {
  bahareque: 'precaria', tapia: 'precaria', adobe: 'precaria',
  mamposteria_no_confinada: 'media',
  mamposteria_confinada: 'nsr10', porticos: 'nsr10', nsr10: 'nsr10',
};
export const claseDe = s => SISTEMAS[String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, '_')] ?? null;

// Área en m² de un polígono GeoJSON (anillos), con proyección equirrectangular local: basta a escala de edificio.
export function areaM2(anillos) {
  const lat0 = rad(anillos[0][0][1]), m = R_TIERRA * 1000 * Math.PI / 180;
  const plano = a => {
    let s = 0;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) s += (a[j][0] * a[i][1] - a[i][0] * a[j][1]);
    return Math.abs(s) / 2 * m * m * Math.cos(lat0);
  };
  return plano(anillos[0]) - anillos.slice(1).reduce((s, h) => s + plano(h), 0);
}

export function centroide(anillos) {
  const a = anillos[0].slice(0, -1);
  return [a.reduce((s, p) => s + p[0], 0) / a.length, a.reduce((s, p) => s + p[1], 0) / a.length];
}

export const pisosDe = alturaM => Math.max(1, Math.round((alturaM || 3) / 3));

// ponytail: órdenes de magnitud para dimensionar, no para presupuestar. Ajustar con el aforo de escombros de la alcaldía.
export const SUPUESTOS = {
  tonPorM2: 1.2,          // toneladas de escombro por m² construido que colapsa (mampostería y concreto)
  fraccionReparar: 0.1,   // una edificación que se repara genera ~10 % de ese escombro
  aprovechable: 0.6,      // fracción del escombro que sirve como agregado tras separar y triturar
  kgPorBloque: 9,         // kg de agregado reciclado en un bloque de 10 × 20 × 40 cm
};
export const escombroTon = (area, pisos) => Math.round(area * pisos * SUPUESTOS.tonPorM2 * 10) / 10;
export const bloques = ton => Math.round(ton * 1000 * SUPUESTOS.aprovechable / SUPUESTOS.kgPorBloque);

// Semáforo municipal: sacudida del 10 de agosto × riesgo de lluvia del modelo del equipo en la temporada.
export const prioridad = (mmi, pLluvia) =>
  mmi >= 7 && pLluvia >= 0.2 ? 'rojo' : mmi >= 6 || pLluvia >= 0.2 ? 'amarillo' : 'verde';

const anilloValido = a => Array.isArray(a) && a.length >= 4 &&
  a.every(p => Array.isArray(p) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
const LIMITE = 50000; // ponytail: tope para no congelar el navegador; paginar si un inventario real lo supera

// Inventario privado de la alcaldía (GeoJSON). Es la frontera de confianza: se valida todo y se descarta lo malo.
export function leerInventario(texto) {
  const edificios = [], errores = [];
  let fc;
  try { fc = typeof texto === 'string' ? JSON.parse(texto) : texto; } catch { return { edificios, errores: ['El archivo no es JSON válido.'] }; }
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return { edificios, errores: ['Se esperaba un GeoJSON de tipo FeatureCollection.'] };
  if (fc.features.length > LIMITE) errores.push(`Se leen los primeros ${LIMITE} de ${fc.features.length} edificios.`);
  fc.features.slice(0, LIMITE).forEach((f, i) => {
    const n = i + 1, g = f?.geometry, p = f?.properties ?? {};
    const anillos = g?.type === 'Polygon' ? g.coordinates : g?.type === 'MultiPolygon' ? g.coordinates?.[0] : null;
    if (!Array.isArray(anillos) || !anillos.every(anilloValido)) {
      errores.push(`Edificio ${n}: la geometría debe ser un Polygon o MultiPolygon válido; se omite.`);
      return;
    }
    const v = Number(p.pisos), pisos = Number.isInteger(v) && v >= 1 && v <= 80 ? v : null;
    if (p.pisos != null && pisos == null) errores.push(`Edificio ${n}: "pisos" debe ser un entero entre 1 y 80.`);
    const est = ESTADOS.includes(p.estado) ? p.estado : null;
    if (p.estado != null && est == null) errores.push(`Edificio ${n}: "estado" debe ser habitable, reparar o demoler.`);
    edificios.push({ anillos, pisos, clase: claseDe(p.sistema), estado: est, uso: typeof p.uso === 'string' ? p.uso.slice(0, 60) : null });
  });
  return { edificios, errores };
}

// Intensidad de un escenario libre (artículo de HazardSim): MMI = 1,5·M − 3·log10(R) − 0,0018·R + 1,6, con R hipocentral.
export function mmiEscenario(M, profKm, distKm) {
  const R = Math.max(0.1, Math.hypot(distKm, profKm));
  return Math.min(12, Math.max(0, 1.5 * M - 3 * Math.log10(R) - 0.0018 * R + 1.6));
}

// Curvas de colapso del artículo: altura relativa k según el avance u ∈ [0, 1]; kf es la altura final del escombro.
export const MODOS = ['panqueque', 'pisos', 'blando', 'cima', 'lateral'];
export function collapseK(modo, u, kf, h) {
  const sp = 1 - kf;
  if (modo === 'pisos') {            // piso por piso, con pausas
    const ns = Math.min(8, Math.max(2, Math.round(h / 3.2))), s = u * ns, i = Math.min(ns - 1, Math.floor(s)), f = s - i;
    const g = f < 0.45 ? (f * f / 0.45) * 1.1 : 0.55 + (f - 0.45) * 0.45 / 0.55;
    return 1 - sp * Math.min(1, (i + Math.min(1, g)) / ns);
  }
  if (modo === 'blando') {           // piso blando: cede un poco, aguanta y se va
    const sd = Math.min(sp * 0.5, 3.2 / h);
    if (u < 0.12) return 1 - sd * (u / 0.12) ** 2;
    if (u < 0.5) return 1 - sd;
    return 1 - sd - (sp - sd) * ((u - 0.5) / 0.5) ** 2;
  }
  if (modo === 'cima') {             // se aplasta la parte alta, aguanta y cae
    const pt = sp * 0.45;
    if (u < 0.3) return 1 - pt * (u / 0.3) ** 2;
    if (u < 0.55) return 1 - pt;
    return 1 - pt - (sp - pt) * ((u - 0.55) / 0.45) ** 2;
  }
  if (modo === 'lateral') return 1 - sp * u ** 1.6;
  return 1 - sp * u * u;             // panqueque: caída libre
}

// Caja orientada de una huella (artículo): el lado más largo da el ángulo. Metros desde (lon0, lat0).
export function cajaOrientada(anillo, lon0, lat0) {
  const m = R_TIERRA * 1000 * Math.PI / 180, c = Math.cos(rad(lat0));
  const p = anillo.map(([x, y]) => [(x - lon0) * m * c, (y - lat0) * m]);
  let ang = 0, largo = -1;
  for (let i = 0; i + 1 < p.length; i++) {
    const l = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (l > largo) { largo = l; ang = Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]); }
  }
  const ux = Math.cos(ang), uy = Math.sin(ang);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, y] of p) {
    const a = x * ux + y * uy, b = -x * uy + y * ux;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
  return { cx: am * ux - bm * uy, cy: am * uy + bm * ux, L1: Math.max(2, a1 - a0), L2: Math.max(2, b1 - b0), ang };
}

// ---- maremoto: la inundación del artículo sobre una malla alineada a teselas Web Mercator ----
export const aTesela = (lon, lat, z) => {
  const n = 2 ** z, s = Math.sin(rad(lat));
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};
export const deTesela = (x, y, z) => {
  const n = 2 ** z;
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI];
};

// El mayor zoom (15 a 8) en que la caja cabe en 780 px de ancho y 620.000 celdas.
export function elegirZoom(oeste, sur, este, norte) {
  for (let z = 15; z >= 8; z--) {
    const [x1, y1] = aTesela(oeste, norte, z), [x2, y2] = aTesela(este, sur, z);
    const w = Math.ceil((x2 - x1) * 256), h = Math.ceil((y2 - y1) * 256);
    if (w <= 780 && w * h <= 620000) return z;
  }
  return 8;
}

export const terrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

export function mediana3(a, w, h) {
  const o = new Float32Array(a.length), v = new Float32Array(9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      v[k++] = a[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
    o[y * w + x] = v.sort()[4];
  }
  return o;
}

// Promedio móvil 5 × 5, dos pasadas: el relieve de costa en Terrarium viene en bloques; así el borde del agua no sale en escalones.
// ponytail: cambia un poco la hidrología a escala de celda; quitarlo si el relieve viene de un DEM fino (p. ej. IGAC 1:2.000)
export function suavizar(a, w, h, pasadas = 2, r = 2) {
  let src = a;
  for (let p = 0; p < pasadas; p++) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
      tmp[y * w + x] = s / n;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
      out[y * w + x] = s / n;
    }
    src = out;
  }
  return src;
}

const VECINOS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// Mar: celdas a 0 m o menos conectadas con el borde. Una laguna interior no es mar.
export function mascaraMar(elev, w, h) {
  const mar = new Uint8Array(w * h), cola = [];
  const sembrar = i => { if (!mar[i] && elev[i] <= 0) { mar[i] = 1; cola.push(i); } };
  for (let x = 0; x < w; x++) { sembrar(x); sembrar((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { sembrar(y * w); sembrar(y * w + w - 1); }
  for (let q = 0; q < cola.length; q++) {
    const i = cola[q], x = i % w, y = (i - x) / w;
    for (const [dx, dy] of VECINOS.slice(0, 4)) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) sembrar(ny * w + nx);
    }
  }
  return mar;
}

// Inundación: el nivel del agua baja en línea recta con la distancia a la costa (H en 0, nada a 12 km).
// Una celda se moja si el nivel supera su altura; desde ahí sigue avanzando. Así el agua entra por los valles y no cruza lomas.
export function inundar(elev, mar, w, h, celdaM, H, L = 12000) {
  const prof = new Float32Array(w * h), alcance = new Float32Array(w * h).fill(Infinity), cola = [];
  const baja = H / L;
  for (let i = 0; i < w * h; i++) {
    if (mar[i]) continue;
    const x = i % w, y = (i - x) / w;
    if ((x > 0 && mar[i - 1]) || (x < w - 1 && mar[i + 1]) || (y > 0 && mar[i - w]) || (y < h - 1 && mar[i + w])) { alcance[i] = 0; cola.push(i); }
  }
  let maxAlcance = 0;
  for (let q = 0; q < cola.length; q++) { // ponytail: cola con relajación (SPFA); Dijkstra con montículo si la malla crece mucho
    const i = cola[q], r = alcance[i], d = H - r * baja - Math.max(0, elev[i]); // un hueco bajo cero que no es mar cuenta como 0 m
    if (d <= 0) continue;
    prof[i] = d; maxAlcance = Math.max(maxAlcance, r);
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy, c] of VECINOS) {
      const nx = x + dx, ny = y + dy, j = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || mar[j]) continue;
      const rj = r + c * celdaM;
      if (rj < alcance[j]) { alcance[j] = rj; cola.push(j); }
    }
  }
  for (let i = 0; i < w * h; i++) if (!prof[i]) alcance[i] = Infinity;
  return { prof, alcance, maxAlcance };
}

// Celda de costa más cercana a (cx, cy) y hacia dónde queda el mar, promediando el mar en un radio (en celdas).
export function costaYMar(mar, w, h, cx, cy, radio) {
  let mejor = null, dmin = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (mar[i]) continue;
    const x = i % w, y = (i - x) / w;
    if (!((x > 0 && mar[i - 1]) || (x < w - 1 && mar[i + 1]) || (y > 0 && mar[i - w]) || (y < h - 1 && mar[i + w]))) continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < dmin) { dmin = d; mejor = [x, y]; }
  }
  if (!mejor) return null;
  const [x0, y0] = mejor;
  let sx = 0, sy = 0;
  for (let y = Math.max(0, y0 - radio); y <= Math.min(h - 1, y0 + radio); y++)
    for (let x = Math.max(0, x0 - radio); x <= Math.min(w - 1, x0 + radio); x++)
      if (mar[y * w + x]) { sx += x - x0; sy += y - y0; }
  const n = Math.hypot(sx, sy) || 1;
  return { x: x0, y: y0, dx: sx / n, dy: sy / n };
}

// Tiempos del artículo: la ola toca tierra a los 3,9 s y llega a su máximo a los 10,9 s.
export const T_LLEGADA = 3.9, T_LLENO = 10.9;
export function frente(t, maxAlcance) {
  if (t < T_LLEGADA) return -1e9;
  const k = Math.min(1, Math.max(0, (t - T_LLEGADA) / (T_LLENO - T_LLEGADA)));
  return maxAlcance * (1 - (1 - k) ** 2.2);
}

// Color del agua según profundidad (m) y edad del frente (cuánto hace que pasó); espuma blanca en el borde.
export function colorAgua(d, edad) {
  let r = 40 + Math.max(0, 60 - 10 * d), g = 70 + Math.max(0, 50 - 8 * d), b = 95 + Math.max(0, 40 - 6 * d);
  const a = d < 0.5 ? 215 + 60 * d : 245;
  if (edad < 1.4) {
    const k = (1 - edad / 1.4) ** 2 * 0.8;
    r += (240 - r) * k; g += (246 - g) * k; b += (246 - b) * k;
  }
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a)];
}
