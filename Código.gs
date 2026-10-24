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

/** Preferencias de la interfaz. Hoy solo el tema: { tema: 'light' | 'dark' }. */
function getPrefs() {
  const raw = PropertiesService.getUserProperties().getProperty('prefs');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function savePrefs(prefs) {
  const tema = prefs && prefs.tema === 'dark' ? 'dark' : 'light';
  PropertiesService.getUserProperties().setProperty('prefs', JSON.stringify({ tema: tema }));
}

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
