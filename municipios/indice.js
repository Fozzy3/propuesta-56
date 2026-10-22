// Cálculo del índice de riesgo: funciones puras, sin DOM (probadas en indice.test.js).

export const tasa = (valor, poblacion) => (valor == null || !poblacion ? null : (valor / poblacion) * 1e4);

// Rango percentil medio: (menores + mitad de los iguales) / n. Los nulos se quedan nulos.
export function percentiles(valores) {
  const xs = valores.filter(v => v != null).sort((a, b) => a - b);
  const n = xs.length;
  const menores = v => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; xs[m] < v ? lo = m + 1 : hi = m; } return lo; };
  const hasta = v => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; xs[m] <= v ? lo = m + 1 : hi = m; } return lo; };
  return valores.map(v => (v == null ? null : (menores(v) + (hasta(v) - menores(v)) / 2) / n));
}

// ev = { tipo: [eventos, fallecidos, ...] }; suma la medida i de los tipos encendidos.
export const sumaEventos = (ev, tipos, i) => tipos.reduce((s, t) => s + (ev?.[t]?.[i] ?? 0), 0);

// filas = [{ id, dpto, valores: { var: número|null } }], vars = [{ id, inverso? }] encendidas.
// Puntaje = promedio de los percentiles con dato × 100; cobertura = cuántas variables tuvieron dato.
export function calcular(filas, vars) {
  const pcts = vars.map(v => {
    const p = percentiles(filas.map(f => f.valores[v.id] ?? null));
    return v.inverso ? p.map(x => (x == null ? null : 1 - x)) : p;
  });
  return filas
    .map((f, i) => {
      const pct = {};
      let suma = 0, cobertura = 0;
      vars.forEach((v, j) => { const x = pcts[j][i]; pct[v.id] = x; if (x != null) { suma += x; cobertura++; } });
      return { id: f.id, dpto: f.dpto, puntaje: cobertura ? (100 * suma) / cobertura : null, cobertura, pct };
    })
    .sort((a, b) => (b.puntaje ?? -1) - (a.puntaje ?? -1));
}

// ¿El puesto depende de qué variables se escogieron? En cada variante se deja cada variable con
// probabilidad p (al menos una) y se mira quién queda en el top. Devuelve Map id -> fracción de variantes.
// ponytail: solo varía el conjunto de variables (no pesos ni tasa vs. absoluto); semilla fija para que sea reproducible.
export function robustez(filas, vars, { top = 20, iter = 200, p = 0.7, semilla = 1 } = {}) {
  if (!vars.length) return new Map();
  let s = semilla;
  const azar = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  const pcts = vars.map(v => { const q = percentiles(filas.map(f => f.valores[v.id] ?? null)); return v.inverso ? q.map(x => (x == null ? null : 1 - x)) : q; });
  const veces = new Map(filas.map(f => [f.id, 0]));
  for (let k = 0; k < iter; k++) {
    let usar = vars.map(() => azar() < p);
    if (!usar.some(Boolean)) usar[Math.floor(azar() * vars.length)] = true;
    const prom = filas.map((f, i) => {
      let suma = 0, n = 0;
      pcts.forEach((q, j) => { if (usar[j] && q[i] != null) { suma += q[i]; n++; } });
      return { id: f.id, x: n ? suma / n : -1 };
    }).sort((a, b) => b.x - a.x);
    for (const r of prom.slice(0, top)) if (r.x >= 0) veces.set(r.id, veces.get(r.id) + 1);
  }
  return new Map([...veces].map(([id, n]) => [id, n / iter]));
}

// Voraz: primero el mejor de cada departamento (los minDptos mejores), luego se completa
// con el ranking sin pasar de maxPorDpto. Devuelve en orden de puntaje.
export function sugerir(ranking, { n = 7, minDptos = 5, maxPorDpto = 2 } = {}) {
  const validos = ranking.filter(r => r.puntaje != null).sort((a, b) => b.puntaje - a.puntaje);
  const primero = new Map();
  for (const r of validos) if (!primero.has(r.dpto)) primero.set(r.dpto, r);
  const elegidos = [...primero.values()].slice(0, minDptos);
  const cuenta = new Map(elegidos.map(r => [r.dpto, 1]));
  for (const r of validos) {
    if (elegidos.length >= n) break;
    if (elegidos.includes(r) || (cuenta.get(r.dpto) ?? 0) >= maxPorDpto) continue;
    elegidos.push(r); cuenta.set(r.dpto, (cuenta.get(r.dpto) ?? 0) + 1);
  }
  return elegidos.sort((a, b) => b.puntaje - a.puntaje);
}
