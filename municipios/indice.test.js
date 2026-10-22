// node --test tablero_riesgo/indice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tasa, percentiles, sumaEventos, calcular, sugerir, robustez } from './indice.js';

test('robustez: fracción de variantes (subconjuntos de variables) en que queda en el top', () => {
  // a gana en todas, d pierde en todas, b y c se reparten
  const filas = [
    { id: 'a', dpto: 'X', valores: { v1: 9, v2: 9, v3: 9 } },
    { id: 'b', dpto: 'X', valores: { v1: 8, v2: 1, v3: 5 } },
    { id: 'c', dpto: 'Y', valores: { v1: 1, v2: 8, v3: 5 } },
    { id: 'd', dpto: 'Y', valores: { v1: 0, v2: 0, v3: 0 } },
  ];
  const vars = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];
  const r = robustez(filas, vars, { top: 2, iter: 300 });
  assert.equal(r.get('a'), 1);
  assert.equal(r.get('d'), 0);
  assert.ok(r.get('b') > 0 && r.get('b') < 1);
  assert.ok(Math.abs(r.get('b') + r.get('c') - 1) < 1e-9); // el segundo puesto siempre es b o c (empates: el orden estable de filas)
  assert.deepEqual(robustez(filas, vars, { top: 2, iter: 300 }), r); // misma semilla, mismo resultado
  assert.equal(robustez(filas, [], { top: 2 }).size, 0);
});

test('tasa: por cada 10.000 habitantes y sin dato si falta población', () => {
  assert.equal(tasa(5, 50000), 1);
  assert.equal(tasa(0, 1000), 0);
  assert.equal(tasa(null, 1000), null);
  assert.equal(tasa(3, 0), null);
});

test('percentiles: rango medio, empates iguales y nulos se conservan', () => {
  assert.deepEqual(percentiles([10, 20, 30, 40]), [0.125, 0.375, 0.625, 0.875]);
  assert.deepEqual(percentiles([5, 5, null, 9]), [1 / 3, 1 / 3, null, 5 / 6]);
  assert.deepEqual(percentiles([7]), [0.5]);
  assert.deepEqual(percentiles([null, null]), [null, null]);
});

test('sumaEventos: suma una medida solo sobre los tipos encendidos', () => {
  const ev = { sismo: [2, 1, 10], movimiento_masa: [5, 0, 40], incendio_forestal: [9, 0, 0] };
  assert.equal(sumaEventos(ev, ['sismo', 'movimiento_masa'], 0), 7);
  assert.equal(sumaEventos(ev, ['sismo', 'movimiento_masa'], 2), 50);
  assert.equal(sumaEventos(ev, ['granizada'], 0), 0);
  assert.equal(sumaEventos(undefined, ['sismo'], 0), 0);
});

test('calcular: promedio de percentiles, inverso y cobertura', () => {
  const filas = [
    { id: 'a', dpto: 'X', valores: { lluvia: 100, ips: 1 } },
    { id: 'b', dpto: 'X', valores: { lluvia: 300, ips: 9 } },
    { id: 'c', dpto: 'Y', valores: { lluvia: null, ips: 5 } },
  ];
  const r = calcular(filas, [{ id: 'lluvia' }, { id: 'ips', inverso: true }]);
  const por = Object.fromEntries(r.map(x => [x.id, x]));
  // lluvia: a=.25 b=.75 ; ips invertido: a=1-1/6 b=1-5/6 c=.5
  assert.ok(Math.abs(por.a.puntaje - 100 * (0.25 + 5 / 6) / 2) < 1e-9);
  assert.ok(Math.abs(por.b.puntaje - 100 * (0.75 + 1 / 6) / 2) < 1e-9);
  assert.equal(por.c.puntaje, 50);
  assert.equal(por.c.cobertura, 1);
  assert.equal(por.a.cobertura, 2);
  assert.deepEqual(r.map(x => x.id), ['a', 'c', 'b']); // ordenado de mayor a menor
});

test('calcular: sin variables encendidas no hay puntaje', () => {
  const r = calcular([{ id: 'a', dpto: 'X', valores: { v: 1 } }], []);
  assert.equal(r[0].puntaje, null);
});

test('sugerir: 7 municipios, al menos 5 departamentos y máximo 2 por departamento', () => {
  const ranking = [
    ['1', 'A'], ['2', 'A'], ['3', 'A'], ['4', 'B'], ['5', 'B'], ['6', 'B'],
    ['7', 'C'], ['8', 'D'], ['9', 'E'], ['10', 'F'],
  ].map(([id, dpto], i) => ({ id, dpto, puntaje: 100 - i }));
  const s = sugerir(ranking);
  assert.equal(s.length, 7);
  const dptos = new Set(s.map(x => x.dpto));
  assert.ok(dptos.size >= 5);
  for (const d of dptos) assert.ok(s.filter(x => x.dpto === d).length <= 2);
  assert.deepEqual(s.map(x => x.id), ['1', '2', '4', '5', '7', '8', '9']);
});

test('sugerir: si hay menos departamentos que el mínimo, usa los que hay', () => {
  const ranking = ['A', 'A', 'A', 'B', 'B'].map((dpto, i) => ({ id: String(i), dpto, puntaje: 10 - i }));
  const s = sugerir(ranking);
  assert.deepEqual(s.map(x => x.id), ['0', '1', '3', '4']);
});

test('sugerir: ignora municipios sin puntaje', () => {
  const ranking = [{ id: 'x', dpto: 'A', puntaje: null }, { id: 'y', dpto: 'B', puntaje: 3 }];
  assert.deepEqual(sugerir(ranking).map(x => x.id), ['y']);
});
