/**
 * ATRIL APP: aplicación web de práctica coral.
 * El estado por canción (tramos guardados, tempo y voz) y las preferencias
 * (tema) se guardan en UserProperties.
 */

// Las propiedades admiten hasta 9 KB por valor.
const MAX_VALUE_CHARS = 8500;
const MAX_SAVED_RANGES = 100;

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('ATRIL APP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inserta el contenido de otro archivo HTML del proyecto (<?!= include('Estilos'); ?>). */
function include(nombre) {
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}

/** Correo de la cuenta que usa la app, o '' si Google no lo expone. */
function getUsuario() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/** Preferencias de la interfaz: { tema: 'light'|'dark', zoom: 0.5–2, controlesOcultos: boolean }. */
function getPrefs() {
  const raw = PropertiesService.getUserProperties().getProperty('prefs');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

/** Actualiza solo las preferencias recibidas y conserva el resto. */
function savePrefs(prefs) {
  const p = prefs || {};
  const actual = getPrefs();
  if (p.tema === 'dark' || p.tema === 'light') actual.tema = p.tema;
  if (isFinite(p.zoom)) actual.zoom = Math.min(2, Math.max(0.5, Number(p.zoom)));
  if (typeof p.controlesOcultos === 'boolean') actual.controlesOcultos = p.controlesOcultos;
  PropertiesService.getUserProperties().setProperty('prefs', JSON.stringify(actual));
}

/* ---------------------------------------------------------------- Biblioteca de MIDIs */

const CARPETA_MIDIS = 'MIDIS';
const MAX_MIDI_BYTES = 5 * 1024 * 1024;
const TITULO_VALIDO = /^[A-ZÁÉÍÓÚÜÑ0-9 \-_().,'#&]{1,80}$/;

// Carpeta de Drive donde vive el proyecto de Apps Script. Si está en «Mi unidad», es la raíz.
function carpetaBase_() {
  const padres = DriveApp.getFileById(ScriptApp.getScriptId()).getParents();
  return padres.hasNext() ? padres.next() : DriveApp.getRootFolder();
}

/** Devuelve la carpeta MIDIS junto al script; con crear=true la crea si no existe. */
function carpetaMidis_(crear) {
  const base = carpetaBase_();
  const it = base.getFoldersByName(CARPETA_MIDIS);
  if (it.hasNext()) return it.next();
  return crear ? base.createFolder(CARPETA_MIDIS) : null;
}

function itemMidi_(file) {
  let meta = null;
  try { meta = JSON.parse(file.getDescription() || 'null'); } catch (e) { meta = null; }
  return {
    id: file.getId(),
    titulo: file.getName().replace(/\.midi?$/i, ''),
    fecha: file.getDateCreated().toISOString(),
    meta: meta
  };
}

/** Lista los MIDIs guardados, los más recientes primero. No crea la carpeta si no existe. */
function listarMidis() {
  const carpeta = carpetaMidis_(false);
  if (!carpeta) return [];
  const out = [];
  const it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (/\.midi?$/i.test(f.getName())) out.push(itemMidi_(f));
  }
  return out.sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; });
}

/**
 * Guarda un MIDI (en base64) como «TÍTULO.mid» dentro de la carpeta MIDIS, creándola si hace falta.
 * meta: lo que la app reconoció { compas, bpm, compases, voces[] }, que queda en la descripción del archivo.
 */
function guardarMidi(titulo, base64, meta) {
  const nombre = String(titulo || '').replace(/\s+/g, ' ').trim();
  if (!TITULO_VALIDO.test(nombre)) throw new Error('El título debe estar en MAYÚSCULAS (letras, números y - _ ( ) . , \' # &).');
  const bytes = bytesMidi_(base64);
  const limpio = metaLimpia_(meta);

  // El candado evita carpetas MIDIS duplicadas si se suben dos archivos a la vez.
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const carpeta = carpetaMidis_(true);
    if (carpeta.getFilesByName(nombre + '.mid').hasNext()) throw new Error('Ya existe un MIDI con el título «' + nombre + '».');
    const archivo = carpeta.createFile(Utilities.newBlob(bytes, 'audio/midi', nombre + '.mid'));
    archivo.setDescription(JSON.stringify(limpio));
    return itemMidi_(archivo);
  } finally {
    lock.releaseLock();
  }
}

/** Devuelve { titulo, base64 } de un MIDI de la biblioteca. Solo atiende archivos de la carpeta MIDIS. */
function obtenerMidi(id) {
  const archivo = archivoEnMidis_(id).archivo;
  return { titulo: archivo.getName().replace(/\.midi?$/i, ''), base64: Utilities.base64Encode(archivo.getBlob().getBytes()) };
}

/**
 * Cambia el compositor y el arreglo de una pieza de la biblioteca (quedan en la descripción del archivo).
 */
function actualizarDatos(id, datos) {
  const d = datos || {};
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const o = archivoEnMidis_(id);
    const archivo = o.archivo;
    if (d.titulo !== undefined && d.titulo !== null) renombrar_(o, String(d.titulo).replace(/\s+/g, ' ').trim());
    let meta = null;
    try { meta = JSON.parse(archivo.getDescription() || 'null'); } catch (e) { meta = null; }
    meta = meta || {};
    meta.compositor = texto80_(d.compositor);
    meta.arreglo = texto80_(d.arreglo);
    archivo.setDescription(JSON.stringify(meta));
    return itemMidi_(archivo);
  } finally { lock.releaseLock(); }
}

// Cambia el título de una pieza. Si es el original (no una versión), sus versiones «TÍTULO Vn» se renombran con él
// y siguen colgando de la misma pieza. Falla, sin cambiar nada, si el título no es válido o ya existe.
function renombrar_(o, nuevo) {
  const archivo = o.archivo, rv = raizYVersion_(archivo), viejo = rv.titulo;
  if (nuevo === viejo) return;
  if (!TITULO_VALIDO.test(nuevo)) throw new Error('El título debe estar en MAYÚSCULAS (letras, números y - _ ( ) . , \' # &) y tener hasta 80 caracteres.');
  const cambios = [{ f: archivo, nombre: nuevo, meta: null }];
  if (rv.version === 0) {
    const re = new RegExp('^' + viejo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' V(\\d+)$');
    const it = o.carpeta.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (f.getId() === archivo.getId() || !/\.midi?$/i.test(f.getName())) continue;
      const r = raizYVersion_(f);
      if (r.raiz !== viejo || r.version < 1) continue;
      const m = re.exec(r.titulo);
      const nom = m ? nombreVersion_(nuevo, m[1]) : r.titulo;
      cambios.push({ f: f, nombre: nom, meta: r.meta });
    }
  }
  cambios.forEach(function (c) {   // primero se comprueba todo
    const ya = o.carpeta.getFilesByName(c.nombre + '.mid');
    while (ya.hasNext()) {
      if (ya.next().getId() !== c.f.getId()) throw new Error('Ya existe un MIDI con el título «' + c.nombre + '».');
    }
  });
  cambios.forEach(function (c) {
    c.f.setName(c.nombre + '.mid');
    if (c.meta) { c.meta.raiz = nuevo; c.f.setDescription(JSON.stringify(c.meta)); }
  });
}

/**
 * Reemplaza el contenido de una pieza de la biblioteca (por ejemplo, al añadir letra) sin crear una versión nueva.
 * Conserva el título, el compositor, el arreglo y los datos de versión. Drive no deja cambiar un archivo binario
 * en el sitio, así que se crea el archivo nuevo con el mismo nombre y el anterior va a la papelera (el id cambia).
 */
function actualizarMidi(id, base64, meta) {
  const bytes = bytesMidi_(base64);
  const nuevo = metaLimpia_(meta);
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const o = archivoEnMidis_(id);
    let previo = null;
    try { previo = JSON.parse(o.archivo.getDescription() || 'null'); } catch (e) { previo = null; }
    previo = previo || {};
    const m = {};
    Object.keys(previo).forEach(function (k) { m[k] = previo[k]; });
    ['compas', 'bpm', 'compases', 'voces'].forEach(function (k) { m[k] = nuevo[k]; });
    const archivo = o.carpeta.createFile(Utilities.newBlob(bytes, 'audio/midi', o.archivo.getName()));
    archivo.setDescription(JSON.stringify(m));
    o.archivo.setTrashed(true);
    return itemMidi_(archivo);
  } finally { lock.releaseLock(); }
}

/** Manda a la papelera de Drive un MIDI de la biblioteca (se puede recuperar desde la papelera). Solo atiende la carpeta MIDIS. */
function eliminarMidi(id) {
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const r = archivoEnMidis_(id);
    r.archivo.setTrashed(true);
    return true;
  } finally { lock.releaseLock(); }
}

// Valida que el contenido (base64) sea un MIDI de tamaño razonable y devuelve sus bytes.
function bytesMidi_(base64) {
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if (!bytes.length || bytes.length > MAX_MIDI_BYTES) throw new Error('El archivo está vacío o supera los 5 MB.');
  if (bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 104 || bytes[3] !== 100) throw new Error('El archivo no es un MIDI válido.');
  return bytes;
}

// Texto libre corto (compositor, arreglo): sin saltos de línea y de hasta 80 caracteres.
function texto80_(x) { return String(x === undefined || x === null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 80); }

// Deja solo los campos esperados de lo que la app reconoció del MIDI.
function metaLimpia_(meta) {
  const m = meta || {};
  return {
    compositor: texto80_(m.compositor),
    arreglo: texto80_(m.arreglo),
    compas: String(m.compas || '').slice(0, 10),
    bpm: isFinite(m.bpm) ? Number(m.bpm) : null,
    compases: isFinite(m.compases) ? Number(m.compases) : null,
    voces: (Array.isArray(m.voces) ? m.voces : []).slice(0, 32).map(function (v) { return String(v).slice(0, 60); })
  };
}

// Devuelve { archivo, carpeta } de un archivo de la biblioteca; falla si el id no pertenece a la carpeta MIDIS.
function archivoEnMidis_(id) {
  const carpeta = carpetaMidis_(false);
  if (!carpeta) throw new Error('La carpeta MIDIS no existe todavía.');
  const archivo = DriveApp.getFileById(String(id));
  let dentro = false;
  const padres = archivo.getParents();
  while (padres.hasNext()) { if (padres.next().getId() === carpeta.getId()) { dentro = true; break; } }
  if (!dentro) throw new Error('Ese archivo no está en la biblioteca.');
  return { archivo: archivo, carpeta: carpeta };
}

/* ---------------------------------------------------------------- Versiones editadas */

// Pieza de la que cuelga un archivo y su número de versión (0 = el original). Se lee de la descripción del archivo,
// no del nombre, para que renombrar un archivo no rompa la cadena de versiones.
function raizYVersion_(archivo) {
  let meta = null;
  try { meta = JSON.parse(archivo.getDescription() || 'null'); } catch (e) { meta = null; }
  const titulo = archivo.getName().replace(/\.midi?$/i, '');
  return { titulo: titulo, meta: meta, raiz: (meta && meta.raiz) || titulo, version: (meta && Number(meta.version)) || 0 };
}

// Siguiente número de versión libre para esa pieza (la mayor existente + 1).
function siguienteVersion_(carpeta, raiz) {
  const re = new RegExp('^' + raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' V(\\d+)$');
  let max = 0;
  const it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.midi?$/i.test(f.getName())) continue;
    const r = raizYVersion_(f);
    if (r.raiz === raiz && r.version > max) max = r.version;
    const m = re.exec(r.titulo);   // por si el archivo perdió su descripción
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function nombreVersion_(raiz, n) {
  const nombre = raiz + ' V' + n;
  if (!TITULO_VALIDO.test(nombre)) throw new Error('El título es demasiado largo para añadirle la versión (máximo 80 caracteres).');
  return nombre;
}

/** Nombre que tendría la próxima versión de una pieza de la biblioteca: { raiz, version, nombre }. */
function proximaVersion(id) {
  const o = archivoEnMidis_(id);
  const r = raizYVersion_(o.archivo);
  const n = siguienteVersion_(o.carpeta, r.raiz);
  return { raiz: r.raiz, version: n, nombre: nombreVersion_(r.raiz, n) };
}

/**
 * Guarda una versión editada (MIDI en base64) como «RAÍZ Vn» en la carpeta MIDIS, sin tocar el original.
 * meta: lo que la app reconoció del archivo editado; resumen: { total, duraciones, alturas, sustituidas }.
 */
function guardarVersion(idOrigen, base64, meta, resumen) {
  const bytes = bytesMidi_(base64);
  const limpio = metaLimpia_(meta);
  const r = resumen || {};
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const o = archivoEnMidis_(idOrigen);
    const rv = raizYVersion_(o.archivo);
    let n = siguienteVersion_(o.carpeta, rv.raiz);
    let nombre = nombreVersion_(rv.raiz, n);
    while (o.carpeta.getFilesByName(nombre + '.mid').hasNext()) { n++; nombre = nombreVersion_(rv.raiz, n); }
    const archivo = o.carpeta.createFile(Utilities.newBlob(bytes, 'audio/midi', nombre + '.mid'));
    limpio.compositor = texto80_(rv.meta && rv.meta.compositor);   // la versión hereda el compositor y el arreglo
    limpio.arreglo = texto80_(rv.meta && rv.meta.arreglo);
    limpio.raiz = rv.raiz;
    limpio.version = n;
    limpio.origen = String(idOrigen);
    const ent = function (x) { return Math.max(0, Math.min(100000, Math.floor(Number(x)) || 0)); };
    limpio.cambios = {
      total: ent(r.total), duraciones: ent(r.duraciones), alturas: ent(r.alturas), agregadas: ent(r.agregadas),
      sustituidas: ent(r.sustituidas), letras: ent(r.letras), compases: ent(r.compases), sincronizadas: ent(r.sincronizadas)
    };
    archivo.setDescription(JSON.stringify(limpio));
    return itemMidi_(archivo);
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------- Estado por canción */

// La clave de la canción incluye el nombre del archivo; se resume en un MD5 para tener claves cortas y seguras.
function propKey_(songKey) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(songKey), Utilities.Charset.UTF_8);
  return 'song_' + bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Devuelve el JSON guardado para la canción, o null si no hay nada. */
function getSongState(songKey) {
  return PropertiesService.getUserProperties().getProperty(propKey_(songKey));
}

/** Guarda { saved: [{a, b}], bpm, voice } de la canción, descartando cualquier otro campo. */
function saveSongState(songKey, json) {
  if (typeof json !== 'string' || json.length > MAX_VALUE_CHARS * 2) throw new Error('Datos no válidos.');
  const o = JSON.parse(json);
  const clean = {
    saved: (Array.isArray(o.saved) ? o.saved : [])
      .filter(function (r) { return r && isFinite(r.a) && isFinite(r.b); })
      .slice(0, MAX_SAVED_RANGES)
      .map(function (r) { return { a: Number(r.a), b: Number(r.b) }; }),
    bpm: isFinite(o.bpm) ? Number(o.bpm) : null,
    voice: typeof o.voice === 'string' ? o.voice.slice(0, 100) : ''
  };
  const out = JSON.stringify(clean);
  if (out.length > MAX_VALUE_CHARS) throw new Error('Demasiados tramos guardados.');
  PropertiesService.getUserProperties().setProperty(propKey_(songKey), out);
}
