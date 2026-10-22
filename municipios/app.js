import { tasa, calcular, sugerir, sumaEventos, robustez } from './indice.js';

const $ = id => document.getElementById(id);
const num = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const num2 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);
const titulo = s => s.toLowerCase().split(' ').map((w, i) => i && MENORES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const plano = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const FOCO = ['Tolima', 'Huila', 'Caldas', 'Quindío', 'Risaralda'];
const CLASES = ['--q1', '--q2', '--q3', '--q4', '--q5'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
const guardar = (k, v) => { try { localStorage.setItem('riesgo56:' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const leer = (k, def) => { try { return JSON.parse(localStorage.getItem('riesgo56:' + k)) ?? def; } catch { return def; } };

// ---------------------------------------------------------------- datos
let MUN, META, GEO, DEC;
try {
  const traer = n => fetch(`datos/${n}`).then(r => { if (!r.ok) throw new Error(n); return r.json(); });
  [MUN, META, GEO, DEC] = await Promise.all(['municipios.json', 'variables.json', 'municipios.geojson', '../decision.json'].map(traer));
} catch {
  $('cargando').textContent = 'No se pudieron leer los datos. Abra el tablero con un servidor local: desde la carpeta del proyecto, python3 -m http.server, y luego http://localhost:8000/municipios/';
  throw new Error('sin datos');
}
for (const m of MUN) { m.N = titulo(m.n); }
const POR_ID = new Map(MUN.map(m => [m.id, m]));
const DPTOS = [...new Set(MUN.map(m => m.d))].sort((a, b) => a.localeCompare(b, 'es'));
const PDF = new Set(META.pdf);
const V = META.variables;
const MEDIDA = i => `ungrd_${i}`;

// Estado: lo que está encendido. Las claves nuevas toman su valor por defecto.
const estado = {
  vars: new Set(Object.keys(V).filter(k => leer('vars', null)?.includes(k) ?? V[k].on)),
  tipos: new Set(Object.keys(META.tipos).filter(k => leer('tipos', null)?.includes(k) ?? META.tipos[k].on)),
  medidas: new Set(META.medidas.map((_, i) => i).filter(i => leer('medidas', null)?.includes(i) ?? META.medidas[i].on)),
  dptos: new Set(leer('dptos', DPTOS)),
  orden: { col: 'puntaje', dir: -1 }, buscar: '', sel: new URLSearchParams(location.search).get('mpio'), sug: [],
};
let RANK = [], POR_RANK = new Map();
// Elegibilidad y factibilidad (decision.json): la misma regla para el botón Sugerir y la pestaña Decisión.
const info = id => DEC.municipios[id] ?? {};
const fuera = id => info(id).excluir ?? (info(id).elegible ? null : 'sin reporte propio de afectación encontrado');

// Conjunto de variables del proyecto (alerta temprana por lluvias y deslizamientos tras el sismo).
const PROYECTO = {
  vars: ['mmi', 'mmi_max', 'usgs_desliz', 'replicas', 'mm_alta', 'simma', 'ideam_desliz_mod', 'ideam_desliz_post',
    'lluvia_post', 'lluvia_maxdia', 'lluvia_30d', 'lluvia_pl', 'imrc_ir', 'ipm', 'rural', 'imrc_cap'],
  tipos: ['movimiento_masa', 'avenida_torrencial', 'creciente_subita'],
  medidas: [0, 1, 3, 5], // eventos, fallecidos, personas afectadas, viviendas destruidas
};
const DEFECTO = {
  vars: Object.keys(V).filter(k => V[k].on), tipos: Object.keys(META.tipos).filter(k => META.tipos[k].on),
  medidas: META.medidas.map((m, i) => m.on ? i : -1).filter(i => i >= 0),
};
const igual = (set, lista) => set.size === lista.length && lista.every(x => set.has(x));

// ---------------------------------------------------------------- variables activas y cálculo
function activas() {
  const lista = [...estado.vars].map(id => ({ id, inverso: V[id].inverso }));
  if (estado.tipos.size) for (const i of estado.medidas) lista.push({ id: MEDIDA(i) });
  return lista;
}
function valor(m, id, tipos = [...estado.tipos]) {
  if (id.startsWith('ungrd_')) return tasa(sumaEventos(m.ev, tipos, +id.slice(6)), m.pob);
  const x = m.v[id];
  return V[id].porHab ? tasa(x, m.pob) : x;
}
function recalcular() {
  const vars = activas();
  const filas = MUN.filter(m => estado.dptos.has(m.d)).map(m => ({ id: m.id, dpto: m.d, valores: Object.fromEntries(vars.map(v => [v.id, valor(m, v.id)])) }));
  RANK = calcular(filas, vars);
  const estab = robustez(filas, vars);
  RANK.forEach((r, i) => { r.pos = i + 1; r.estab = estab.get(r.id) ?? null; });
  POR_RANK = new Map(RANK.map(r => [r.id, r]));
  estado.sug = estado.sug.filter(id => POR_RANK.has(id));
  guardar('vars', [...estado.vars]); guardar('tipos', [...estado.tipos]); guardar('medidas', [...estado.medidas]); guardar('dptos', [...estado.dptos]);
  $('sub').textContent = `${num.format(RANK.length)} municipios en ${estado.dptos.size} departamentos · ${vars.length} variables encendidas`;
  pintarMapa(); pintarTabla(); pintarFicha(); pintarSugeridos(); pintarCuentas();
}

// ---------------------------------------------------------------- panel de variables
const FLECHA = '<svg class="flecha" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>';
function construirPanel() {
  const grupos = Object.entries(META.familias).map(([fam, nombre]) => {
    let items;
    if (fam === 'ungrd_medidas') items = META.medidas.map((m, i) => ({ clave: 'medidas', id: i, nombre: m.nombre, meta: 'Por cada 10.000 habitantes · suma de los tipos de evento encendidos' }));
    else if (fam.startsWith('ungrd_')) items = Object.entries(META.tipos).filter(([, t]) => t.familia === fam).map(([id, t]) => ({ clave: 'tipos', id, nombre: t.nombre, meta: `UNGRD ${META.ungrd.anios[0]}–${META.ungrd.anios.at(-1)}` }));
    else items = Object.entries(V).filter(([, v]) => v.familia === fam).map(([id, v]) => ({ clave: 'vars', id, nombre: v.nombre, meta: `${v.fuente} · ${v.periodo} · ${v.porHab ? v.unidad + ' por 10.000 hab.' : v.unidad}` }));
    if (!items.length) return '';
    return `<details class="grupo" data-fam="${fam}" ${fam.startsWith('ungrd_') && fam !== 'ungrd_geologico' && fam !== 'ungrd_medidas' ? '' : 'open'}>
      <summary>${FLECHA}<input type="checkbox" class="todos" aria-label="Encender o apagar todo el grupo ${esc(nombre)}">${esc(nombre)}<span class="cuenta"></span></summary>
      <div class="items">${items.map(it => `<label class="var"><input type="checkbox" data-clave="${it.clave}" data-id="${it.id}"><span>${esc(it.nombre)}<small>${esc(it.meta)}</small></span></label>`).join('')}</div>
    </details>`;
  }).join('');
  $('familias').innerHTML = grupos;
  $('familias').addEventListener('change', e => {
    const c = e.target;
    if (c.classList.contains('todos')) {
      for (const x of c.closest('details').querySelectorAll('input[data-clave]')) alternar(x.dataset.clave, x.dataset.id, c.checked);
    } else alternar(c.dataset.clave, c.dataset.id, c.checked);
    recalcular();
  });
  $('familias').addEventListener('click', e => { if (e.target.classList.contains('todos')) e.stopPropagation(); });
  $('dptos').innerHTML = DPTOS.map(d => `<label><input type="checkbox" value="${esc(d)}">${esc(d)}</label>`).join('');
  $('dptos').addEventListener('change', e => { e.target.checked ? estado.dptos.add(e.target.value) : estado.dptos.delete(e.target.value); recalcular(); });
  $('presets').addEventListener('click', e => {
    const p = e.target.closest('button')?.dataset.preset; if (!p) return;
    estado.dptos = new Set(p === 'todos' ? DPTOS : FOCO); recalcular(); encuadrar([...estado.dptos].flatMap(d => MUN.filter(m => m.d === d).map(m => m.id)));
  });
  $('presets-vars').addEventListener('click', e => {
    const p = { proyecto: PROYECTO, defecto: DEFECTO }[e.target.closest('button')?.dataset.vars]; if (!p) return;
    estado.vars = new Set(p.vars); estado.tipos = new Set(p.tipos); estado.medidas = new Set(p.medidas); recalcular();
  });
}
function alternar(clave, id, si) {
  const k = clave === 'medidas' ? +id : id;
  si ? estado[clave].add(k) : estado[clave].delete(k);
}
function pintarCuentas() {
  for (const det of document.querySelectorAll('details[data-fam]')) {
    const cs = [...det.querySelectorAll('input[data-clave]')];
    for (const c of cs) c.checked = estado[c.dataset.clave].has(c.dataset.clave === 'medidas' ? +c.dataset.id : c.dataset.id);
    const on = cs.filter(c => c.checked).length, todos = det.querySelector('.todos');
    todos.checked = on === cs.length; todos.indeterminate = on > 0 && on < cs.length;
    det.querySelector('.cuenta').textContent = `${on} de ${cs.length}`;
  }
  for (const c of $('dptos').querySelectorAll('input')) c.checked = estado.dptos.has(c.value);
  $('cuenta-dptos').textContent = `${estado.dptos.size} de ${DPTOS.length}`;
  const foco = estado.dptos.size === FOCO.length && FOCO.every(d => estado.dptos.has(d));
  for (const b of $('presets').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.preset === 'todos' ? estado.dptos.size === DPTOS.length : foco));
  for (const b of $('presets-vars').querySelectorAll('button')) {
    const p = b.dataset.vars === 'proyecto' ? PROYECTO : DEFECTO;
    b.setAttribute('aria-pressed', String(igual(estado.vars, p.vars) && igual(estado.tipos, p.tipos) && igual(estado.medidas, p.medidas)));
  }
}

// ---------------------------------------------------------------- mapa
const map = new maplibregl.Map({ container: 'mapa', style: 'https://tiles.openfreemap.org/styles/positron', center: [-75.4, 4.6], zoom: 5.6, attributionControl: false });
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Polígonos: SGC y DANE' }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
await new Promise(r => map.loaded() ? r() : map.on('load', r));
const primerSimbolo = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
map.addSource('mun', { type: 'geojson', data: GEO, promoteId: 'id' });
const fs = (k, d) => ['coalesce', ['feature-state', k], d];
map.addLayer({ id: 'relleno', type: 'fill', source: 'mun', paint: {
  'fill-color': ['match', fs('clase', -1), 0, CLASES[0], 1, CLASES[1], 2, CLASES[2], 3, CLASES[3], 4, CLASES[4], '#d9d5cc'],
  'fill-opacity': ['case', ['==', fs('clase', -1), -1], 0.25, 0.82] } }, primerSimbolo);
map.addLayer({ id: 'borde', type: 'line', source: 'mun', paint: { 'line-color': '#fffdf9', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.2, 9, 0.9] } }, primerSimbolo);
map.addLayer({ id: 'pdf', type: 'line', source: 'mun', filter: ['in', ['get', 'id'], ['literal', META.pdf]], paint: { 'line-color': '#1b2126', 'line-width': 1.6, 'line-dasharray': [2, 1.5] } });
map.addLayer({ id: 'sug', type: 'line', source: 'mun', paint: { 'line-color': '#1f6f5c', 'line-width': ['case', fs('sug', false), 3, 0] } });
map.addLayer({ id: 'sel', type: 'line', source: 'mun', paint: { 'line-color': '#1b2126', 'line-width': ['case', fs('sel', false), 3.2, 0] } });
const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
map.on('mousemove', 'relleno', e => {
  const m = POR_ID.get(e.features[0].properties.id), r = POR_RANK.get(m.id);
  map.getCanvas().style.cursor = 'pointer';
  pop.setLngLat(e.lngLat).setHTML(`<b>${esc(m.N)}</b> · ${esc(m.d)}<br>${r ? `Puesto ${r.pos} de ${RANK.length} · puntaje ${r.puntaje == null ? '—' : num1.format(r.puntaje)}` : 'Fuera de la comparación'}`).addTo(map);
});
map.on('mouseleave', 'relleno', () => { map.getCanvas().style.cursor = ''; pop.remove(); });
map.on('click', 'relleno', e => seleccionar(e.features[0].properties.id));

function pintarMapa() {
  const validos = RANK.filter(r => r.puntaje != null);
  const n = validos.length;
  const clase = new Map(validos.map((r, i) => [r.id, Math.min(4, Math.floor((n - 1 - i) / n * 5))]));
  for (const m of MUN) map.setFeatureState({ source: 'mun', id: m.id }, { clase: clase.has(m.id) ? clase.get(m.id) : -1, sug: estado.sug.includes(m.id), sel: m.id === estado.sel });
}
function encuadrar(ids) {
  if (!ids.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const id of ids) { const m = POR_ID.get(id); b.extend([m.lon, m.lat]); }
  map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: estado.sel ? 400 : 60 }, maxZoom: 9, duration: 600 });
}

// ---------------------------------------------------------------- tabla
const fmt = (id, x) => x == null ? '—' : (Math.abs(x) >= 100 ? num.format(x) : Math.abs(x) >= 10 ? num1.format(x) : num2.format(x));
const COLS = [
  { id: 'pos', nombre: '#', num: true, val: r => r.pos },
  { id: 'nombre', nombre: 'Municipio', val: r => POR_ID.get(r.id).N },
  { id: 'dpto', nombre: 'Departamento', val: r => r.dpto },
  { id: 'puntaje', nombre: 'Puntaje', num: true, val: r => r.puntaje },
  { id: 'cobertura', nombre: 'Variables con dato', num: true, val: r => r.cobertura },
  { id: 'pob', nombre: 'Población 2026', num: true, val: r => POR_ID.get(r.id).pob },
  { id: 'estab', nombre: 'Estabilidad (top 20)', num: true, val: r => r.estab, fmt: x => x == null ? '—' : `${Math.round(x * 100)} %` },
  { id: 'mmi', nombre: 'MMI sismo', num: true, val: r => POR_ID.get(r.id).v.mmi },
  { id: 'lluvia_post', nombre: 'Lluvia desde el sismo (mm)', num: true, val: r => POR_ID.get(r.id).v.lluvia_post },
  { id: 'ideam_desliz_mod', nombre: 'Días alerta deslizamiento', num: true, val: r => POR_ID.get(r.id).v.ideam_desliz_mod },
  { id: 'ungrd_0', nombre: 'Eventos UNGRD /10.000 hab.', num: true, val: r => valor(POR_ID.get(r.id), 'ungrd_0') },
];
$('thead').innerHTML = `<tr>${COLS.map(c => `<th class="${c.num ? 'num' : ''}" data-col="${c.id}"><button>${c.nombre}</button></th>`).join('')}</tr>`;
$('thead').addEventListener('click', e => {
  const col = e.target.closest('th')?.dataset.col; if (!col) return;
  estado.orden = { col, dir: estado.orden.col === col ? -estado.orden.dir : (col === 'nombre' || col === 'dpto' || col === 'pos' ? 1 : -1) };
  pintarTabla();
});
function filasVisibles() {
  const q = plano(estado.buscar.trim());
  const c = COLS.find(x => x.id === estado.orden.col), d = estado.orden.dir;
  return RANK.filter(r => !q || plano(POR_ID.get(r.id).N + ' ' + r.dpto).includes(q))
    .sort((a, b) => { const x = c.val(a), y = c.val(b); if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y, 'es') : x - y) * d; });
}
function pintarTabla() {
  for (const th of $('thead').querySelectorAll('th')) th.dataset.col === estado.orden.col ? th.setAttribute('aria-sort', estado.orden.dir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort');
  const filas = filasVisibles();
  const nVars = activas().length;
  $('tbody').innerHTML = filas.map(r => {
    const m = POR_ID.get(r.id);
    const chips = (estado.sug.includes(r.id) ? ' <span class="chip sug">sugerido</span>' : '') + (PDF.has(r.id) ? ' <span class="chip pdf">PDF</span>' : '');
    return `<tr data-id="${r.id}" aria-selected="${r.id === estado.sel}"><td class="num">${r.pos}</td><td>${esc(m.N)}${chips}</td><td>${esc(r.dpto)}</td>
      <td class="num punt"><i style="width:${(r.puntaje ?? 0) * 0.6}px"></i><b>${r.puntaje == null ? '—' : num1.format(r.puntaje)}</b></td>
      <td class="num">${r.cobertura} de ${nVars}</td><td class="num">${num.format(m.pob)}</td>${COLS.slice(6).map(c => `<td class="num">${c.fmt ? c.fmt(c.val(r)) : fmt(c.id, c.val(r))}</td>`).join('')}</tr>`;
  }).join('') || `<tr><td colspan="${COLS.length}" style="color:var(--muted);padding:18px 10px">Ningún municipio coincide con la búsqueda o no hay departamentos seleccionados.</td></tr>`;
  $('estado').textContent = filas.length === RANK.length ? `${num.format(RANK.length)} municipios` : `${num.format(filas.length)} de ${num.format(RANK.length)}`;
}
$('tbody').addEventListener('click', e => { const id = e.target.closest('tr')?.dataset.id; if (id) { seleccionar(id); encuadrar([id]); } });
$('buscar').addEventListener('input', e => { estado.buscar = e.target.value; pintarTabla(); });

// ---------------------------------------------------------------- ficha del municipio
function seleccionar(id) {
  estado.sel = id;
  const u = new URL(location); id ? u.searchParams.set('mpio', id) : u.searchParams.delete('mpio'); history.replaceState(null, '', u);
  pintarFicha(); pintarMapa();
  for (const tr of $('tbody').querySelectorAll('tr')) tr.setAttribute('aria-selected', String(tr.dataset.id === id));
}
function pintarFicha() {
  const m = POR_ID.get(estado.sel), f = $('ficha');
  if (!m) { f.hidden = true; return; }
  const r = POR_RANK.get(m.id);
  const fila = (nombre, x, unidad, p, off) => `<div class="dato ${off ? 'off' : ''}"><span>${esc(nombre)}</span><span class="val">${fmt('', x)} <small>${esc(unidad)}</small></span>${p == null ? '' : `<div class="barra" title="Percentil ${Math.round(p * 100)}"><i style="width:${p * 100}%"></i></div>`}</div>`;
  const grupos = Object.entries(META.familias).filter(([fam]) => !fam.startsWith('ungrd_')).map(([fam, nombre]) => {
    const ids = Object.keys(V).filter(k => V[k].familia === fam).sort((a, b) => estado.vars.has(b) - estado.vars.has(a));
    return `<h4>${esc(nombre)}</h4>` + ids.map(k => fila(V[k].nombre, valor(m, k), V[k].porHab ? `${V[k].unidad} /10.000 hab.` : V[k].unidad, r?.pct[k], !estado.vars.has(k))).join('');
  }).join('');
  const tipos = Object.entries(m.ev).sort((a, b) => b[1][0] - a[1][0]);
  const ungrd = META.medidas.map((md, i) => estado.tipos.size ? fila(md.nombre, valor(m, MEDIDA(i)), '/10.000 hab.', r?.pct[MEDIDA(i)], !estado.medidas.has(i)) : '').join('')
    + `<h4>Eventos UNGRD ${META.ungrd.anios[0]}–${META.ungrd.anios.at(-1)} por tipo (todos)</h4>`
    + (tipos.length ? tipos.map(([t, v]) => `<div class="dato ${estado.tipos.has(t) ? '' : 'off'}"><span>${esc(META.tipos[t].nombre)}</span><span class="val">${num.format(v[0])} <small>eventos · ${num.format(v[3])} personas</small></span></div>`).join('') : '<p class="dp">Sin eventos registrados.</p>');
  f.innerHTML = `<button class="cerrar" aria-label="Cerrar ficha"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div><h3>${esc(m.N)}</h3><div class="dp">${esc(m.d)} · DIVIPOLA ${m.id}${PDF.has(m.id) ? ' · <span class="chip pdf">PDF</span>' : ''}${estado.sug.includes(m.id) ? ' <span class="chip sug">sugerido</span>' : ''}</div></div>
    <div class="resumen"><div><b>${r?.puntaje == null ? '—' : num1.format(r.puntaje)}</b><span>Puntaje</span></div><div><b>${r ? `${r.pos} de ${RANK.length}` : '—'}</b><span>Puesto</span></div><div><b>${num.format(m.pob)}</b><span>Habitantes 2026</span></div><div><b>${r ? `${r.cobertura}` : '—'}</b><span>Variables con dato</span></div><div title="En cuántas de 200 combinaciones al azar de las variables encendidas queda entre los 20 primeros"><b>${r?.estab == null ? '—' : Math.round(r.estab * 100) + ' %'}</b><span>Estabilidad top 20</span></div></div>
    ${r ? '' : '<p class="dp">Este municipio está fuera de los departamentos seleccionados.</p>'}
    <h4>UNGRD · afectación con los tipos de evento encendidos</h4>${ungrd}${grupos}`;
  f.hidden = false;
  f.querySelector('.cerrar').onclick = () => seleccionar(null);
}

// ---------------------------------------------------------------- sugerir, CSV, pestañas
function pintarSugeridos() {
  const s = $('sugeridos');
  s.hidden = !estado.sug.length;
  s.innerHTML = '<b>Sugeridos:</b> ' + estado.sug.map(id => { const m = POR_ID.get(id); return `<button class="btn" data-id="${id}" style="padding:3px 9px">${esc(m.N)} <span class="dp" style="color:var(--muted)">${esc(m.d)}</span></button>`; }).join('');
}
$('sugeridos').addEventListener('click', e => { const id = e.target.closest('button')?.dataset.id; if (id) { seleccionar(id); encuadrar([id]); } });
$('sugerir').addEventListener('click', () => {
  estado.sug = sugerir(RANK.filter(r => !fuera(r.id))).map(r => r.id);
  pintarMapa(); pintarTabla(); pintarSugeridos(); pintarFicha(); encuadrar(estado.sug);
});
$('csv').addEventListener('click', () => {
  const vars = activas();
  const nombre = id => id.startsWith('ungrd_') ? `UNGRD ${META.medidas[+id.slice(6)].nombre} (/10.000 hab.)` : `${V[id].nombre} (${V[id].porHab ? V[id].unidad + ' /10.000 hab.' : V[id].unidad})`;
  const cab = ['Puesto', 'DIVIPOLA', 'Municipio', 'Departamento', 'Puntaje', 'Variables con dato', 'Población 2026', 'Estabilidad top 20 (%)', 'Sugerido', 'Municipio del PDF', ...vars.flatMap(v => [nombre(v.id), `Percentil · ${v.id}`])];
  const filas = RANK.map(r => { const m = POR_ID.get(r.id); return [r.pos, m.id, m.N, m.d, r.puntaje?.toFixed(2) ?? '', r.cobertura, m.pob, r.estab == null ? '' : Math.round(r.estab * 100), estado.sug.includes(m.id) ? 'sí' : '', PDF.has(m.id) ? 'sí' : '', ...vars.flatMap(v => [valor(m, v.id)?.toFixed(3) ?? '', r.pct[v.id]?.toFixed(3) ?? ''])]; });
  const csv = [cab, ...filas].map(f => f.map(x => /[",;\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(';')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `ranking_riesgo_conv56_${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
});
document.querySelector('.tabs').addEventListener('click', e => {
  const t = e.target.closest('button')?.dataset.tab; if (!t) return;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  $('vista-ranking').hidden = t !== 'ranking'; $('decision').hidden = t !== 'decision'; $('fuentes').hidden = t !== 'fuentes';
  if (t === 'ranking') map.resize();
});

// ---------------------------------------------------------------- decisión
// Regla fija, independiente del panel: todas las variables relevantes en los 16 departamentos; los 8 de mayor riesgo de cada uno.
function pintarDecision() {
  const vars = [...DEFECTO.vars.map(id => ({ id, inverso: V[id].inverso })), ...DEFECTO.medidas.map(i => ({ id: MEDIDA(i) }))];
  const rank = calcular(MUN.map(m => ({ id: m.id, dpto: m.d, valores: Object.fromEntries(vars.map(v => [v.id, valor(m, v.id, DEFECTO.tipos)])) })), vars);
  rank.forEach((r, i) => { r.pos = i + 1; });
  const filas = DPTOS.map(d => `<tr><th scope="row">${esc(d)}</th>${rank.filter(r => r.dpto === d).slice(0, 8)
    .map(r => `<td>${esc(POR_ID.get(r.id).N)}<small>${r.pos}</small></td>`).join('')}</tr>`).join('');
  $('decision-col').innerHTML = `
    <h2>Los 8 municipios de mayor riesgo por departamento</h2>
    <p>Con las ${vars.length} variables relevantes. El número es el puesto entre ${num.format(rank.length)} municipios.</p>
    <table class="top8"><thead><tr><th>Departamento</th>${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `<th>${i}</th>`).join('')}</tr></thead><tbody>${filas}</tbody></table>`;
}

// ---------------------------------------------------------------- fuentes
const enlace = u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname.replace(/^www\./, ''))}</a>`;
function pintarFuentes() {
  const fila = (grupo, nombre, fuente, periodo, unidad, con, url) => `<tr><td>${esc(grupo)}</td><td>${esc(nombre)}</td><td>${esc(fuente)}</td><td>${esc(periodo)}</td><td>${esc(unidad)}</td><td class="num">${con} de ${MUN.length}</td><td>${enlace(url)}</td></tr>`;
  $('fuentes-col').innerHTML = `
    <h2>Fuentes</h2>
    <table><thead><tr><th>Grupo</th><th>Variable</th><th>Fuente</th><th>Periodo</th><th>Unidad</th><th class="num">Municipios con dato</th><th>Enlace</th></tr></thead><tbody>
    ${Object.entries(V).map(([k, v]) => fila(META.familias[v.familia], v.nombre, v.fuente, v.periodo, v.porHab ? v.unidad + ' por 10.000 hab.' : v.unidad, MUN.filter(m => m.v[k] != null).length, v.url)).join('')}
    ${fila('UNGRD', `${Object.keys(META.tipos).length} tipos de evento × ${META.medidas.length} medidas de afectación`, 'UNGRD, reportes anuales de emergencias', `${META.ungrd.anios[0]}–${META.ungrd.anios.at(-1)}`, 'por 10.000 hab.', MUN.filter(m => Object.keys(m.ev).length).length, META.ungrd.url)}
    ${fila('Base', 'Población 2026 (divide las variables por 10.000 hab.)', META.poblacion.fuente, META.poblacion.periodo, 'habitantes', MUN.length, META.poblacion.url)}
    </tbody></table>`;
}

// ---------------------------------------------------------------- arranque
construirPanel(); pintarDecision(); pintarFuentes(); recalcular();
if (estado.sel && POR_ID.has(estado.sel)) encuadrar([estado.sel]);
else if (estado.dptos.size < DPTOS.length) encuadrar(MUN.filter(m => estado.dptos.has(m.d)).map(m => m.id));
$('cargando').hidden = true;
