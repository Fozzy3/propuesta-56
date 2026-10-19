// Pruebas del modelo del simulador. Correr: node --test simulador/modelo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mmiEn, mmiEscenario, claseDe, probDano, probColapso, tasas, MEZCLA_BASE, estado, areaM2, escombroTon, bloques,
  prioridad, leerInventario, collapseK, MODOS, cajaOrientada,
  aTesela, deTesela, elegirZoom, terrarium, mediana3, suavizar, mascaraMar, inundar, costaYMar, frente, colorAgua,
} from './modelo.js';

const malla = { x0: 10, dx: 1, nx: 2, y0: 0, dy: 1, ny: 2, v: [6, 7, 8, null] };
const sismo = { lon: 0, lat: 0, atenuacion: { repi: [0, 100, 200], mmi: [8, 6, 4] } };
const cerca = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// ---- sismo ----
test('mmiEn interpola la malla de ShakeMap', () => {
  assert.deepEqual(mmiEn(malla, sismo, 10, 0), { mmi: 6, fuente: 'shakemap' });
  assert.equal(mmiEn(malla, sismo, 11, 0).mmi, 7);
  assert.equal(mmiEn(malla, sismo, 10, 1).mmi, 8);
  assert.equal(mmiEn(malla, sismo, 10.5, 0).mmi, 6.5);
});

test('mmiEn usa la curva de atenuación fuera de la malla o en celdas vacías', () => {
  const r = mmiEn(malla, sismo, 0.4497, 0); // ~50 km del epicentro
  assert.equal(r.fuente, 'curva');
  cerca(r.mmi, 7, 0.02);
  assert.equal(mmiEn(malla, sismo, 11, 1).fuente, 'curva');
  assert.equal(mmiEn(malla, sismo, 0, 9).mmi, 4);
});

test('mmiEscenario sigue la atenuación del artículo y se acota a 0–12', () => {
  cerca(mmiEscenario(7, 10, 0), 1.5 * 7 - 3 * Math.log10(10) - 0.018 + 1.6);
  assert.ok(mmiEscenario(7, 10, 5) > mmiEscenario(7, 10, 50));
  assert.ok(mmiEscenario(7, 10, 20) > mmiEscenario(7, 60, 20)); // más profundo, menos intenso
  assert.equal(mmiEscenario(12, 0.1, 0), 12);
  assert.equal(mmiEscenario(2, 10, 2000), 0);
});

test('fragilidad: más intensidad, más daño; nsr10 < media < precaria', () => {
  for (const c of ['precaria', 'media', 'nsr10']) {
    assert.ok(probColapso(8, c) < probColapso(9, c));
    assert.ok(probDano(8.4, c) >= probColapso(8.4, c));
  }
  assert.ok(probColapso(8.4, 'nsr10') < probColapso(8.4, 'media'));
  assert.ok(probColapso(8.4, 'media') < probColapso(8.4, 'precaria'));
});

test('calibración con Pereira (MMI 8,1 en la malla de ShakeMap v9)', () => {
  const t = tasas(8.1, MEZCLA_BASE);
  assert.ok(t.colapso > 0.003 && t.colapso < 0.006, `colapso ${t.colapso}`);
  const razon = (t.dano - t.colapso) / t.colapso;
  assert.ok(razon > 2.5 && razon < 5, `razón ${razon}`);
  assert.ok(tasas(8.1, { precaria: 0, media: 0, nsr10: 1 }).colapso < 0.0005);
});

test('estado sale del sorteo, en orden demoler → reparar → habitable', () => {
  assert.equal(estado(0.01, 0.2, 0.05), 'demoler');
  assert.equal(estado(0.1, 0.2, 0.05), 'reparar');
  assert.equal(estado(0.5, 0.2, 0.05), 'habitable');
});

test('claseDe normaliza el sistema estructural que trae la alcaldía', () => {
  assert.equal(claseDe('Bahareque'), 'precaria');
  assert.equal(claseDe('Mampostería no confinada'), 'media');
  assert.equal(claseDe('porticos'), 'nsr10');
  assert.equal(claseDe('otro'), null);
  assert.equal(claseDe(undefined), null);
});

test('áreas, escombros y bloques', () => {
  const cuadro = [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]];
  assert.ok(Math.abs(areaM2(cuadro) - 12364) < 125, areaM2(cuadro));
  assert.equal(escombroTon(100, 2), 240);
  assert.equal(bloques(1), 67);
});

test('prioridad cruza sismo y lluvia', () => {
  assert.equal(prioridad(7.5, 0.3), 'rojo');
  assert.equal(prioridad(6.5, 0.1), 'amarillo');
  assert.equal(prioridad(5, 0.3), 'amarillo');
  assert.equal(prioridad(5, 0.1), 'verde');
});

test('leerInventario acepta el inventario válido y reporta lo que descarta', () => {
  const pol = { type: 'Polygon', coordinates: [[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]]] };
  const fc = {
    type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: pol, properties: { pisos: 2, sistema: 'tapia', estado: 'reparar', uso: 'vivienda' } },
      { type: 'Feature', geometry: pol, properties: { pisos: 'tres', estado: 'roto' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    ],
  };
  const r = leerInventario(JSON.stringify(fc));
  assert.equal(r.edificios.length, 2);
  assert.deepEqual([r.edificios[0].pisos, r.edificios[0].clase, r.edificios[0].estado], [2, 'precaria', 'reparar']);
  assert.deepEqual([r.edificios[1].pisos, r.edificios[1].clase, r.edificios[1].estado], [null, null, null]);
  assert.equal(r.errores.length, 3);
  assert.equal(leerInventario('{no es json').edificios.length, 0);
  assert.equal(leerInventario('{"type":"Feature"}').errores.length, 1);
});

test('collapseK: los cinco modos del artículo bajan de 1 a kf sin subir nunca', () => {
  assert.deepEqual(MODOS, ['panqueque', 'pisos', 'blando', 'cima', 'lateral']);
  for (const h of [6, 15, 40]) {
    const kf = Math.max(0.04, 1.6 / h);
    for (const modo of MODOS) {
      cerca(collapseK(modo, 0, kf, h), 1);
      cerca(collapseK(modo, 1, kf, h), kf, 1e-9);
      let antes = 1;
      for (let u = 0; u <= 1.0001; u += 0.005) {
        const k = collapseK(modo, Math.min(u, 1), kf, h);
        assert.ok(k <= antes + 1e-9, `${modo} h=${h} sube en u=${u}`);
        antes = k;
      }
    }
  }
});

test('cajaOrientada: el lado largo da el ángulo y las medidas', () => {
  const m = 111194.9; // metros por grado en el ecuador (R = 6371 km)
  const rect = [[0, 0], [20 / m, 0], [20 / m, 10 / m], [0, 10 / m], [0, 0]];
  const c = cajaOrientada(rect, 0, 0);
  cerca(c.L1, 20, 0.05); cerca(c.L2, 10, 0.05);
  cerca(Math.abs(Math.sin(c.ang)), 0, 1e-6);
  cerca(c.cx, 10, 0.05); cerca(c.cy, 5, 0.05);
  assert.equal(cajaOrientada([[0, 0], [0.1 / m, 0], [0.1 / m, 0.1 / m], [0, 0]], 0, 0).L2, 2); // mínimo 2 m
});

// ---- maremoto ----
test('teselas: ida y vuelta entre lon/lat y teselas Web Mercator', () => {
  const [x, y] = aTesela(-77.03, 1.8, 12);
  const [lon, lat] = deTesela(x, y, 12);
  cerca(lon, -77.03, 1e-9); cerca(lat, 1.8, 1e-9);
  assert.deepEqual(aTesela(0, 0, 1), [1, 1]);
});

test('elegirZoom: el mayor zoom que cabe en 780 px de ancho y 620.000 celdas', () => {
  assert.equal(elegirZoom(-77.01, 1.79, -77.0, 1.8), 15);
  const z = elegirZoom(-77.2, 1.6, -76.9, 1.9);
  const [x1, y1] = aTesela(-77.2, 1.9, z), [x2, y2] = aTesela(-76.9, 1.6, z);
  assert.ok((x2 - x1) * 256 <= 780 && (x2 - x1) * (y2 - y1) * 65536 <= 620000);
  const [a1] = aTesela(-77.2, 1.9, z + 1), [a2] = aTesela(-76.9, 1.6, z + 1);
  assert.ok((a2 - a1) * 256 > 780 || z === 15);
  assert.equal(elegirZoom(-90, -30, -60, 10), 8);
});

test('terrarium decodifica la altura en metros', () => {
  assert.equal(terrarium(128, 0, 0), 0);
  assert.equal(terrarium(0, 0, 0), -32768);
  assert.equal(terrarium(128, 10, 128), 10.5);
});

test('mediana3 quita picos sueltos', () => {
  const a = new Float32Array(25).fill(5); a[12] = 900;
  assert.equal(mediana3(a, 5, 5)[12], 5);
});

test('suavizar: conserva lo plano y redondea los escalones del relieve', () => {
  const plano = new Float32Array(36).fill(7);
  assert.ok(suavizar(plano, 6, 6).every(v => Math.abs(v - 7) < 1e-6));
  const esc = new Float32Array(36); for (let i = 0; i < 36; i++) esc[i] = i % 6 < 3 ? 0 : 10;
  const s = suavizar(esc, 6, 6);
  assert.ok(s[2] > 0 && s[2] < 10 && s[3] > 0 && s[3] < 10);
});

test('mascaraMar: mar es lo que está a 0 m o menos y toca el borde; una laguna interior no', () => {
  const w = 6, h = 5, e = new Float32Array(w * h).fill(10);
  for (let y = 0; y < h; y++) e[y * w] = -3;     // columna oeste: mar
  e[2 * w + 3] = -1;                              // laguna encerrada
  const mar = mascaraMar(e, w, h);
  assert.equal(mar[2 * w], 1);
  assert.equal(mar[2 * w + 3], 0);
  assert.equal(mar[2 * w + 1], 0);
});

test('inundar: el agua baja con la distancia y no cruza una loma', () => {
  const w = 10, h = 3, e = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e[y * w + x] = x < 2 ? -5 : x - 1;
  const mar = mascaraMar(e, w, h);
  const r = inundar(e, mar, w, h, 100, 3);
  assert.ok(r.prof[w + 2] > 1.9 && r.prof[w + 3] > 0.9);  // columnas 2 y 3 se inundan
  assert.equal(r.prof[w + 4], 0);                         // columna 4 queda seca
  cerca(r.alcance[w + 3], 100);
  // una loma de 50 m en la columna 3 protege lo que hay detrás, aunque esté bajo
  const e2 = Float32Array.from(e); for (let y = 0; y < h; y++) { e2[y * w + 3] = 50; e2[y * w + 4] = 0.2; }
  const r2 = inundar(e2, mascaraMar(e2, w, h), w, h, 100, 3);
  assert.equal(r2.prof[w + 4], 0);
  // un hueco bajo cero que no toca el mar (laguna, error del relieve) se moja como si estuviera a 0 m, no a −30 m
  const e3 = Float32Array.from(e); e3[w + 3] = -30; // encerrado: arriba y abajo hay tierra
  const r3 = inundar(e3, mascaraMar(e3, w, h), w, h, 100, 3);
  assert.ok(r3.prof[w + 3] < 3, `prof ${r3.prof[w + 3]}`);
});

test('costaYMar: encuentra la costa más cercana y mira hacia el mar', () => {
  const w = 20, h = 20, e = new Float32Array(w * h).fill(5);
  for (let y = 0; y < h; y++) for (let x = 0; x < 6; x++) e[y * w + x] = -10; // mar al oeste
  const c = costaYMar(mascaraMar(e, w, h), w, h, 12, 10, 8);
  assert.equal(c.x, 6); assert.equal(c.y, 10);
  assert.ok(c.dx < -0.9 && Math.abs(c.dy) < 0.2, `${c.dx},${c.dy}`);
});

test('frente: nada antes de la llegada, todo el alcance al final', () => {
  assert.equal(frente(1, 5000), -1e9);
  assert.equal(frente(10.9, 5000), 5000);
  assert.ok(frente(6, 5000) > 0 && frente(6, 5000) < 5000);
});

test('colorAgua: más clara en lo bajo, espuma en el frente', () => {
  assert.deepEqual(colorAgua(0, 9), [100, 120, 135, 215]);
  assert.deepEqual(colorAgua(10, 9), [40, 70, 95, 245]);
  const [r] = colorAgua(10, 0);
  assert.ok(r > 150);
});
