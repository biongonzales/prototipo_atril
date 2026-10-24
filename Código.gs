/**
 * Ensayo Coral: aplicación web de práctica coral.
 * El estado por canción (tramos guardados, tempo y voz) y las preferencias
 * (tema) se guardan en UserProperties.
 */

// Las propiedades admiten hasta 9 KB por valor.
const MAX_VALUE_CHARS = 8500;
const MAX_SAVED_RANGES = 100;

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Ensayo Coral')
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
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if (!bytes.length || bytes.length > MAX_MIDI_BYTES) throw new Error('El archivo está vacío o supera los 5 MB.');
  if (bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 104 || bytes[3] !== 100) throw new Error('El archivo no es un MIDI válido.');

  const m = meta || {};
  const limpio = {
    compas: String(m.compas || '').slice(0, 10),
    bpm: isFinite(m.bpm) ? Number(m.bpm) : null,
    compases: isFinite(m.compases) ? Number(m.compases) : null,
    voces: (Array.isArray(m.voces) ? m.voces : []).slice(0, 32).map(function (v) { return String(v).slice(0, 60); })
  };

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
  const carpeta = carpetaMidis_(false);
  if (!carpeta) throw new Error('La carpeta MIDIS no existe todavía.');
  const archivo = DriveApp.getFileById(String(id));
  let dentro = false;
  const padres = archivo.getParents();
  while (padres.hasNext()) { if (padres.next().getId() === carpeta.getId()) { dentro = true; break; } }
  if (!dentro) throw new Error('Ese archivo no está en la biblioteca.');
  return { titulo: archivo.getName().replace(/\.midi?$/i, ''), base64: Utilities.base64Encode(archivo.getBlob().getBytes()) };
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
