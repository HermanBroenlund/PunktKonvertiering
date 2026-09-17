'use strict';

const $ = (id) => document.getElementById(id);

const eastingInput = $('easting');
const northingInput = $('northing');
const convertBtn = $('convertBtn');
const locateBtn = $('locateBtn');
const locatePanelBtn = $('locatePanelBtn');
const gpsBadge = $('gpsBadge');
const wgsResult = $('wgsResult');
const utmResult = $('utmResult');
const epsgResult = $('epsgResult');
const sourceBadge = $('sourceBadge');
const accuracyRow = $('accuracyRow');
const statusEl = $('status');
const zoneModeSelect = $('zoneMode');

const excelFileInput = $('excelFile');
const excelBadge = $('excelBadge');
const excelMapping = $('excelMapping');
const excelFileName = $('excelFileName');
const excelSheetInfo = $('excelSheetInfo');
const sheetSelect = $('sheetSelect');
const eastColumnSelect = $('eastColumn');
const northColumnSelect = $('northColumn');
const zoneColumnSelect = $('zoneColumn');
const processExcelBtn = $('processExcelBtn');
const downloadExcelBtn = $('downloadExcelBtn');
const excelStatus = $('excelStatus');
const previewWrap = $('previewWrap');
const previewCount = $('previewCount');
const excelPreview = $('excelPreview');

const NORWAY_ZONES = [32, 33, 35];
const KARTVERKET_POINT_API = 'https://api.kartverket.no/kommuneinfo/v1/punkt';
let lastResolvedZone = 33;

function selectedZoneOverride() {
  const value = zoneModeSelect?.value ?? 'auto';
  if (value === 'auto') return null;
  const zone = Number.parseInt(value, 10);
  return NORWAY_ZONES.includes(zone) ? zone : null;
}

function zoneAreaLabel(zone) {
  if (zone === 32) return 'Sør-Norge og Trøndelag';
  if (zone === 33) return 'Nordland og Troms';
  if (zone === 35) return 'Finnmark';
  return `UTM ${zone}N`;
}
const OUTPUT_HEADERS = {
  lat: 'WGS84_Latitude',
  lon: 'WGS84_Longitude',
  zone: 'UTM_Sone_Brukt',
  status: 'Konvertering_Status'
};

let marker = null;
let accuracyCircle = null;
let workbook = null;
let originalFileName = '';
let activeSheetMeta = null;
let processedRows = [];
let excelProcessed = false;

const excelLayer = L.layerGroup();

const map = L.map('map', { zoomControl: true }).setView([64.5, 11.5], 5);

const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17,
  attribution: 'Kartdata © OpenStreetMap-bidragsytere, SRTM | Kart © OpenTopoMap'
});

const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 20,
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics m.fl.'
  }
);

const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap-bidragsytere'
});

topo.addTo(map);
excelLayer.addTo(map);

const compactMapQuery = window.matchMedia('(max-width: 760px)');
const layerControl = L.control.layers(
  {
    'Terrengkart': topo,
    'Satellitt': satellite,
    'Detaljkart': street
  },
  {
    'Excel-punkter': excelLayer
  },
  {
    // På mobil vises kun det kompakte lag-ikonet. På PC er laglisten åpen.
    collapsed: compactMapQuery.matches,
    position: 'topright'
  }
).addTo(map);

function syncLayerControlForScreen() {
  if (compactMapQuery.matches && typeof layerControl.collapse === 'function') {
    layerControl.collapse();
  } else if (!compactMapQuery.matches && typeof layerControl.expand === 'function') {
    layerControl.expand();
  }
}

if (typeof compactMapQuery.addEventListener === 'function') {
  compactMapQuery.addEventListener('change', syncLayerControlForScreen);
}

L.control.scale({ metric: true, imperial: false }).addTo(map);

function zoneFromCountyName(name) {
  const county = normalizeHeader(name);
  if (county.includes('finnmark')) return 35;
  if (county.includes('nordland') || county.includes('troms')) return 33;
  if (county) return 32;
  return null;
}

function fallbackZoneFromPosition(lat, lon) {
  // Fallback hvis Kartverkets områdeoppslag ikke svarer. Grensene følger nærmeste
  // av de tre norske UTM-sonenes sentralmeridianer (9°, 15° og 27° øst).
  // På norsk fastland vil Kartverket-oppslaget normalt gi fylkesbasert sone først.
  if (lon >= 21) return 35;
  if (lon >= 12) return 33;
  return 32;
}

async function fetchAdministrativeArea(lat, lon) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  const params = new URLSearchParams({
    nord: String(lat),
    ost: String(lon),
    koordsys: '4258',
    filtrer: 'fylkesnavn,fylkesnummer,kommunenavn,kommunenummer'
  });

  try {
    const response = await fetch(`${KARTVERKET_POINT_API}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Kartverket svarte ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveZoneForPosition(lat, lon, forcedZone = null) {
  if (NORWAY_ZONES.includes(forcedZone)) {
    return { zone: forcedZone, automatic: false, admin: null, fallback: false };
  }

  try {
    const admin = await fetchAdministrativeArea(lat, lon);
    const zone = zoneFromCountyName(admin?.fylkesnavn);
    if (zone) return { zone, automatic: true, admin, fallback: false };
  } catch (error) {
    console.warn('Kunne ikke hente fylke fra Kartverket, bruker geografisk fallback.', error);
  }

  return {
    zone: fallbackZoneFromPosition(lat, lon),
    automatic: true,
    admin: null,
    fallback: true
  };
}

async function detectZoneFromEN(easting, northing, preferredZone = null) {
  const order = preferredZone && NORWAY_ZONES.includes(preferredZone)
    ? [preferredZone, ...NORWAY_ZONES.filter((zone) => zone !== preferredZone)]
    : [...NORWAY_ZONES];

  const candidates = [];
  let apiWorked = false;

  for (const zone of order) {
    try {
      const point = utmToWgs(easting, northing, zone);
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      if (point.lat < 57 || point.lat > 72.5 || point.lon < 3 || point.lon > 33.5) continue;

      try {
        const admin = await fetchAdministrativeArea(point.lat, point.lon);
        apiWorked = true;
        const expectedZone = zoneFromCountyName(admin?.fylkesnavn);
        if (expectedZone === zone) {
          candidates.push({ zone, ...point, admin, validated: true });
          if (zone === preferredZone) return candidates[0];
        }
      } catch (error) {
        console.warn(`Sonevalidering feilet for ${zone}N`, error);
      }
    } catch (error) {
      console.warn(`Kunne ikke teste UTM ${zone}N`, error);
    }
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error('Flere norske UTM-soner gir mulige treff.');
  }

  if (!apiWorked) {
    throw new Error('Kartverket kunne ikke nås for automatisk sonevalg.');
  }
  throw new Error('Fant ikke en entydig norsk UTM-sone for koordinatet.');
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;

  let cleaned = String(value).trim().replace(/\u00a0/g, '');
  if (!cleaned) return NaN;

  // Norske tall: 1 234 567,89. Også støtte for vanlig 1234567.89.
  cleaned = cleaned.replace(/\s+/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // Anta at siste skilletegn er desimalskillet.
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else {
    cleaned = cleaned.replace(',', '.');
  }

  return Number(cleaned);
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isNorwayZone(value) {
  return NORWAY_ZONES.includes(Number.parseInt(value, 10));
}

function utmProjString(zone) {
  // EUREF89 bruker GRS80. For praktisk norsk kartbruk er dette direkte kompatibelt
  // med WGS84-lat/lon på den nøyaktigheten denne nettleserløsningen er ment for.
  return `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs +type=crs`;
}

function wgsToUtm(lat, lon, zone) {
  const [easting, northing] = proj4('EPSG:4326', utmProjString(zone), [lon, lat]);
  return { zone, easting, northing };
}

function utmToWgs(easting, northing, zone) {
  const [lon, lat] = proj4(utmProjString(zone), 'EPSG:4326', [easting, northing]);
  return { lat, lon };
}

function formatNum(n, decimals = 2) {
  return Number(n).toLocaleString('nb-NO', {
    useGrouping: false,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function setStatus(message = '', type = '') {
  statusEl.textContent = message;
  statusEl.className = `status${type ? ` ${type}` : ''}`;
}

function setExcelStatus(message = '', type = '') {
  excelStatus.textContent = message;
  excelStatus.className = `status${type ? ` ${type}` : ''}`;
}

async function setPosition(lat, lon, source = 'Kart', options = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    setStatus('Ugyldig posisjon.', 'error');
    return;
  }

  const requestedZone = options.forceZone ?? selectedZoneOverride();
  setStatus(requestedZone ? `Bruker ${zoneAreaLabel(requestedZone)} / UTM ${requestedZone}N…` : 'Finner riktig norsk UTM-sone…');

  const zoneInfo = await resolveZoneForPosition(lat, lon, requestedZone);
  const zone = zoneInfo.zone;
  lastResolvedZone = zone;
  const utm = wgsToUtm(lat, lon, zone);

  eastingInput.value = utm.easting.toFixed(2);
  northingInput.value = utm.northing.toFixed(2);

  wgsResult.textContent = `${lat.toFixed(7)}, ${lon.toFixed(7)}`;
  utmResult.textContent = `E ${formatNum(utm.easting, 2)}  N ${formatNum(utm.northing, 2)}  • sone ${zone}N`;

  const placeParts = [];
  if (zoneInfo.admin?.kommunenavn) placeParts.push(zoneInfo.admin.kommunenavn);
  if (zoneInfo.admin?.fylkesnavn) placeParts.push(zoneInfo.admin.fylkesnavn);
  const placeText = placeParts.length ? ` • ${placeParts.join(', ')}` : '';
  const autoText = zoneInfo.automatic
    ? (zoneInfo.fallback ? ' • automatisk (geografisk)' : ' • automatisk')
    : '';
  epsgResult.textContent = `EUREF89 / UTM sone ${zone}N → WGS84${autoText}${placeText}`;
  sourceBadge.textContent = zoneInfo.automatic ? `${source} • auto ${zone}N` : source;

  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.marker([lat, lon]).addTo(map);

  marker.bindPopup(
    `<strong>WGS84</strong><br>${lat.toFixed(7)}, ${lon.toFixed(7)}` +
    `<br><br><strong>UTM ${zone}N</strong><br>E ${utm.easting.toFixed(2)}<br>N ${utm.northing.toFixed(2)}` +
    (placeParts.length ? `<br><br>${placeParts.join(', ')}` : '')
  );

  if (accuracyCircle) {
    map.removeLayer(accuracyCircle);
    accuracyCircle = null;
  }

  if (Number.isFinite(options.accuracy)) {
    accuracyCircle = L.circle([lat, lon], {
      radius: options.accuracy,
      weight: 1,
      fillOpacity: 0.08
    }).addTo(map);
    accuracyRow.hidden = false;
    accuracyRow.textContent = `Oppgitt GPS-nøyaktighet: ±${Math.round(options.accuracy)} m`;
  } else {
    accuracyRow.hidden = true;
  }

  if (options.zoom !== false) {
    map.setView([lat, lon], options.zoomLevel ?? 16);
  }

  if (zoneInfo.automatic && zoneInfo.admin?.fylkesnavn) {
    setStatus(`UTM ${zone}N ble valgt automatisk ut fra ${zoneInfo.admin.fylkesnavn}.`, 'ok');
  } else if (zoneInfo.automatic && zoneInfo.fallback) {
    setStatus(`UTM ${zone}N ble valgt automatisk ut fra posisjonen.`, 'ok');
  } else {
    setStatus(`${zoneAreaLabel(zone)} / UTM ${zone}N er valgt manuelt.`, 'ok');
  }
}

async function convertSinglePoint() {
  const easting = parseNumber(eastingInput.value);
  const northing = parseNumber(northingInput.value);

  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    setStatus('Skriv inn gyldige tall for E og N.', 'error');
    return;
  }

  if (easting < 10000 || easting > 1000000 || northing < 0 || northing > 10000000) {
    setStatus('E/N-verdiene ser uvanlige ut. Kontroller koordinatene.', 'error');
    return;
  }

  try {
    convertBtn.disabled = true;
    const forcedZone = selectedZoneOverride();

    if (forcedZone) {
      convertBtn.textContent = 'Konverterer…';
      setStatus(`Bruker ${zoneAreaLabel(forcedZone)} / UTM ${forcedZone}N…`);
      const point = utmToWgs(easting, northing, forcedZone);
      lastResolvedZone = forcedZone;
      await setPosition(point.lat, point.lon, 'E/N-konvertering', { forceZone: forcedZone });
    } else {
      convertBtn.textContent = 'Finner riktig UTM-sone…';
      setStatus('Tester norske UTM-soner og validerer punktet mot Kartverket…');
      const detected = await detectZoneFromEN(easting, northing, lastResolvedZone);
      lastResolvedZone = detected.zone;
      await setPosition(detected.lat, detected.lon, 'E/N-konvertering', { forceZone: detected.zone });
      setStatus(`UTM ${detected.zone}N ble funnet automatisk${detected.admin?.fylkesnavn ? ` (${detected.admin.fylkesnavn})` : ''}.`, 'ok');
    }
  } catch (error) {
    console.error(error);
    if (selectedZoneOverride()) {
      setStatus('Kunne ikke konvertere koordinatet med valgt UTM-område. Kontroller E/N og områdevalget.', 'error');
    } else {
      setStatus('Kunne ikke bestemme UTM-sone automatisk. Kontroller at E/N er norske koordinater og at du har nettilgang.', 'error');
    }
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Konverter og vis i kart';
  }
}

convertBtn.addEventListener('click', convertSinglePoint);
[eastingInput, northingInput].forEach((element) => {
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') convertSinglePoint();
  });
});

function setLocateButtonsLoading(loading) {
  [locateBtn, locatePanelBtn].forEach((button) => {
    if (button) button.disabled = loading;
  });
  if (locateBtn) {
    locateBtn.innerHTML = loading
      ? '<span>Finner…</span>'
      : '<span aria-hidden="true">◎</span><span>Min posisjon</span>';
  }
  if (locatePanelBtn) {
    locatePanelBtn.textContent = loading ? 'Finner posisjon…' : '◎ Hent posisjon fra telefon';
  }
}

function updateGpsBadge(text, state = '') {
  gpsBadge.textContent = text;
  gpsBadge.className = `badge${state ? ` ${state}` : ''}`;
}

function locateDevice() {
  if (!window.isSecureContext) {
    updateGpsBadge('Krever HTTPS', 'error');
    setStatus('Telefonens posisjon krever HTTPS. GitHub Pages bruker HTTPS automatisk.', 'error');
    return;
  }

  if (!('geolocation' in navigator)) {
    updateGpsBadge('Ikke støttet', 'error');
    setStatus('Denne nettleseren støtter ikke posisjonstjenester.', 'error');
    return;
  }

  setLocateButtonsLoading(true);
  updateGpsBadge('Henter…');
  setStatus('Ber telefonen eller nettleseren om posisjon…');

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      setLocateButtonsLoading(false);
      const accuracy = position.coords.accuracy;
      updateGpsBadge(Number.isFinite(accuracy) ? `±${Math.round(accuracy)} m` : 'Funnet', 'live');
      await setPosition(position.coords.latitude, position.coords.longitude, 'Telefonens GPS', {
        accuracy,
        zoomLevel: Number.isFinite(accuracy) && accuracy <= 20 ? 18 : 17
      });
      marker?.openPopup();
    },
    (error) => {
      setLocateButtonsLoading(false);
      updateGpsBadge('Ingen posisjon', 'error');
      const messages = {
        1: 'Posisjonstilgang ble avslått. Tillat posisjon for nettsiden i nettleserens innstillinger og prøv igjen.',
        2: 'Enheten klarte ikke å finne posisjonen. Kontroller at posisjonstjenester er slått på.',
        3: 'Det tok for lang tid å hente posisjonen. Prøv igjen.'
      };
      setStatus(messages[error.code] || 'Kunne ikke hente enhetens posisjon.', 'error');
    },
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0
    }
  );
}

locateBtn.addEventListener('click', locateDevice);
locatePanelBtn.addEventListener('click', locateDevice);

zoneModeSelect?.addEventListener('change', () => {
  const zone = selectedZoneOverride();
  if (zone) {
    setStatus(`${zoneAreaLabel(zone)} / UTM ${zone}N er valgt som manuell overstyring.`, 'ok');
  } else {
    setStatus('Automatisk UTM-valg er aktivt. GPS, kartklikk og E/N kan finne riktig sone for deg.', 'ok');
  }
});

map.on('click', async (event) => {
  await setPosition(event.latlng.lat, event.latlng.lng, 'Kartklikk', { zoom: false });
  marker?.openPopup();
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = $(button.dataset.copy);
    const value = target?.textContent?.trim();
    if (!value || value === '–') return;

    try {
      await navigator.clipboard.writeText(value);
      const oldText = button.textContent;
      button.textContent = 'Kopiert';
      setTimeout(() => { button.textContent = oldText; }, 1200);
    } catch {
      setStatus('Kunne ikke kopiere automatisk. Marker teksten og kopier manuelt.', 'error');
    }
  });
});

/* --------------------------- Excel --------------------------- */

function excelLibraryReady() {
  return typeof window.XLSX !== 'undefined' && window.XLSX?.read && window.XLSX?.utils;
}

function readFileAsArrayBuffer(file) {
  if (file && typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Kunne ikke lese filen.'));
    reader.readAsArrayBuffer(file);
  });
}

function setExcelControlsEnabled(enabled) {
  [sheetSelect, eastColumnSelect, northColumnSelect, zoneColumnSelect, processExcelBtn].forEach((el) => {
    if (el) el.disabled = !enabled;
  });
}

function columnLetter(index) {
  return window.XLSX.utils.encode_col(index);
}

function cellValue(sheet, row, col) {
  return sheet[window.XLSX.utils.encode_cell({ r: row, c: col })]?.v ?? '';
}

function findHeaderRow(sheet) {
  const range = window.XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const maxRow = Math.min(range.e.r, range.s.r + 30);

  let bestKnownRow = null;
  let bestKnownScore = 0;
  let genericHeaderRow = null;

  for (let row = range.s.r; row <= maxRow; row += 1) {
    let knownScore = 0;
    let nonEmpty = 0;
    let textCells = 0;
    let numericCells = 0;

    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const raw = cellValue(sheet, row, col);
      if (!String(raw).trim()) continue;
      nonEmpty += 1;

      const h = normalizeHeader(raw);
      if (isEastHeader(h)) knownScore += 4;
      if (isNorthHeader(h)) knownScore += 4;
      if (isZoneHeader(h)) knownScore += 2;

      if (Number.isFinite(parseNumber(raw))) numericCells += 1;
      else textCells += 1;
    }

    if (knownScore > bestKnownScore) {
      bestKnownScore = knownScore;
      bestKnownRow = row;
    }

    // Reservegjenkjenning for overskrifter med ukjente navn: raden må i hovedsak
    // bestå av tekst, og raden under må se tydelig mer ut som data.
    if (genericHeaderRow === null && nonEmpty >= 2 && textCells / nonEmpty >= 0.75 && row < range.e.r) {
      let nextNonEmpty = 0;
      let nextNumeric = 0;
      for (let col = range.s.c; col <= range.e.c; col += 1) {
        const nextRaw = cellValue(sheet, row + 1, col);
        if (!String(nextRaw).trim()) continue;
        nextNonEmpty += 1;
        if (Number.isFinite(parseNumber(nextRaw))) nextNumeric += 1;
      }
      if (nextNonEmpty >= 2 && nextNumeric >= 2 && nextNumeric > numericCells) {
        genericHeaderRow = row;
      }
    }
  }

  // Ikke gjett at første datarad er en overskrift. Minst én tydelig E/N/sone-
  // overskrift må finnes, ellers brukes bare den generiske teksttesten over.
  if (bestKnownRow !== null && bestKnownScore >= 4) return bestKnownRow;
  return genericHeaderRow;
}

function isEastHeader(header) {
  const exact = new Set(['e', 'east', 'easting', 'ost', 'ostlig', 'x', 'utm e', 'utm east', 'utm easting']);
  return exact.has(header) || header.includes('easting') || header.includes('ost koordinat');
}

function isNorthHeader(header) {
  const exact = new Set(['n', 'north', 'northing', 'nord', 'nordlig', 'y', 'utm n', 'utm north', 'utm northing']);
  return exact.has(header) || header.includes('northing') || header.includes('nord koordinat');
}

function isZoneHeader(header) {
  return ['sone', 'zone', 'utm sone', 'utm zone', 'utmsone', 'utmzone'].includes(header) || header.includes('utm sone');
}

function sampleValueForColumn(sheet, col, startRow, endRow) {
  const last = Math.min(endRow, startRow + 20);
  for (let row = startRow; row <= last; row += 1) {
    const raw = cellValue(sheet, row, col);
    if (String(raw ?? '').trim() !== '') return raw;
  }
  return '';
}

function sheetMetadata(sheetName) {
  const sheet = workbook.Sheets[sheetName];
  const range = window.XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const headerRow = findHeaderRow(sheet);
  const dataStartRow = headerRow === null ? range.s.r : headerRow + 1;
  const columns = [];

  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const rawHeader = headerRow === null ? '' : cellValue(sheet, headerRow, col);
    const sample = sampleValueForColumn(sheet, col, dataStartRow, range.e.r);
    const sampleText = String(sample ?? '').trim();
    const title = headerRow === null
      ? `uten overskrift${sampleText ? ` • eksempel: ${sampleText.slice(0, 28)}` : ''}`
      : (String(rawHeader).trim() || `uten overskrift${sampleText ? ` • eksempel: ${sampleText.slice(0, 28)}` : ''}`);

    columns.push({
      index: col,
      title,
      normalized: normalizeHeader(rawHeader)
    });
  }

  return {
    sheetName,
    sheet,
    range,
    headerRow,
    dataStartRow,
    syntheticHeader: false,
    columns
  };
}

function populateColumnSelect(select, columns, includeDefaultZone = false) {
  select.innerHTML = '';

  if (includeDefaultZone) {
    const option = document.createElement('option');
    option.value = '__auto_zone__';
    option.textContent = 'Ingen sonekolonne – bruk UTM-valget øverst';
    select.appendChild(option);
  }

  columns.forEach((column) => {
    const option = document.createElement('option');
    option.value = String(column.index);
    option.textContent = `${columnLetter(column.index)} – ${column.title}`;
    select.appendChild(option);
  });
}

function coordinateColumnStats(meta, columnIndex) {
  const maxRow = Math.min(meta.range.e.r, meta.dataStartRow + 39);
  let nonEmpty = 0;
  let numeric = 0;
  let eastMatches = 0;
  let northMatches = 0;
  let zoneMatches = 0;

  for (let row = meta.dataStartRow; row <= maxRow; row += 1) {
    const raw = cellValue(meta.sheet, row, columnIndex);
    if (String(raw ?? '').trim() === '') continue;
    nonEmpty += 1;
    const value = parseNumber(raw);
    if (!Number.isFinite(value)) continue;
    numeric += 1;

    // Norske UTM-koordinater ligger normalt godt innenfor disse intervallene.
    if (value >= 10000 && value <= 1000000) eastMatches += 1;
    if (value >= 5000000 && value <= 9000000) northMatches += 1;
    if (NORWAY_ZONES.includes(Number.parseInt(value, 10)) && Math.abs(value - Math.round(value)) < 1e-9) zoneMatches += 1;
  }

  const denom = Math.max(nonEmpty, 1);
  return {
    index: columnIndex,
    nonEmpty,
    numeric,
    eastScore: eastMatches / denom,
    northScore: northMatches / denom,
    zoneScore: zoneMatches / denom
  };
}

function inferCoordinateColumns(meta) {
  const stats = meta.columns.map((column) => coordinateColumnStats(meta, column.index));

  const north = [...stats]
    .filter((item) => item.nonEmpty > 0 && item.northScore >= 0.6)
    .sort((a, b) => b.northScore - a.northScore || b.numeric - a.numeric)[0] || null;

  const east = [...stats]
    .filter((item) => item.index !== north?.index && item.nonEmpty > 0 && item.eastScore >= 0.6)
    .sort((a, b) => b.eastScore - a.eastScore || b.numeric - a.numeric)[0] || null;

  const zone = [...stats]
    .filter((item) => item.index !== east?.index && item.index !== north?.index && item.zoneScore >= 0.8)
    .sort((a, b) => b.zoneScore - a.zoneScore)[0] || null;

  return { east, north, zone };
}

function autoSelectColumns(meta) {
  let east = meta.columns.find((column) => isEastHeader(column.normalized));
  let north = meta.columns.find((column) => isNorthHeader(column.normalized));
  let zone = meta.columns.find((column) => isZoneHeader(column.normalized));

  if (!east || !north) {
    const inferred = inferCoordinateColumns(meta);
    if (!east && inferred.east) east = meta.columns.find((column) => column.index === inferred.east.index);
    if (!north && inferred.north) north = meta.columns.find((column) => column.index === inferred.north.index);
    if (!zone && inferred.zone) zone = meta.columns.find((column) => column.index === inferred.zone.index);
  }

  if (east) eastColumnSelect.value = String(east.index);
  if (north) northColumnSelect.value = String(north.index);
  if (zone) zoneColumnSelect.value = String(zone.index);
  else zoneColumnSelect.value = '__auto_zone__';
}

function refreshSheetMapping() {
  if (!workbook || !sheetSelect.value) return;

  activeSheetMeta = sheetMetadata(sheetSelect.value);
  populateColumnSelect(eastColumnSelect, activeSheetMeta.columns);
  populateColumnSelect(northColumnSelect, activeSheetMeta.columns);
  populateColumnSelect(zoneColumnSelect, activeSheetMeta.columns, true);
  autoSelectColumns(activeSheetMeta);

  const dataRows = Math.max(0, activeSheetMeta.range.e.r - activeSheetMeta.dataStartRow + 1);
  const headerInfo = activeSheetMeta.headerRow === null
    ? 'ingen overskriftsrad funnet – første rad beholdes som data'
    : `overskriftsrad ${activeSheetMeta.headerRow + 1}`;
  excelSheetInfo.textContent = `${activeSheetMeta.sheetName} • ${headerInfo} • opptil ${dataRows} datarader`;
  processedRows = [];
  excelProcessed = false;
  downloadExcelBtn.disabled = true;
  previewWrap.hidden = true;
  setExcelStatus(
    activeSheetMeta.headerRow === null
      ? 'Ingen sikker overskriftsrad ble funnet. Første rad behandles som data. Kontroller at E- og N-kolonnene er valgt riktig.'
      : 'Kontroller at E- og N-kolonnene er valgt riktig. Andre kolonner påvirkes ikke.'
  );
}

async function loadExcelFile(file) {
  try {
    excelFileName.textContent = file?.name || '–';
    excelBadge.textContent = 'Leser…';
    excelBadge.className = 'badge';
    setExcelControlsEnabled(false);
    downloadExcelBtn.disabled = true;
    previewWrap.hidden = true;
    setExcelStatus('Leser filen…');

    if (!excelLibraryReady()) {
      throw new Error('Excel-biblioteket kunne ikke lastes. Oppdater siden og prøv igjen.');
    }

    const data = await readFileAsArrayBuffer(file);
    workbook = window.XLSX.read(data, { type: 'array', cellDates: true });
    originalFileName = file.name;

    if (!workbook.SheetNames.length) throw new Error('Filen inneholder ingen ark.');

    sheetSelect.innerHTML = '';
    workbook.SheetNames.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      sheetSelect.appendChild(option);
    });

    excelBadge.textContent = 'Klar';
    excelBadge.className = 'badge live';
    setExcelControlsEnabled(true);
    refreshSheetMapping();
  } catch (error) {
    console.error(error);
    workbook = null;
    activeSheetMeta = null;
    setExcelControlsEnabled(false);
    excelBadge.textContent = 'Feil';
    excelBadge.className = 'badge error';
    const message = String(error?.message || 'Ukjent feil');
    setExcelStatus(
      message.includes('Excel-biblioteket')
        ? message
        : `Kunne ikke lese filen: ${message}`,
      'error'
    );
  }
}

excelFileInput.addEventListener('change', () => {
  const file = excelFileInput.files?.[0];
  if (file) {
    loadExcelFile(file);
  } else {
    workbook = null;
    activeSheetMeta = null;
    setExcelControlsEnabled(false);
    excelBadge.textContent = 'Ingen fil';
    excelBadge.className = 'badge';
    setExcelStatus('Velg en Excel- eller CSV-fil for å starte.');
  }
});

sheetSelect.addEventListener('change', refreshSheetMapping);

function insertSyntheticHeaderRow(meta, eastCol, northCol, zoneSetting) {
  if (meta.headerRow !== null) return;

  const sheet = meta.sheet;
  const insertAt = meta.range.s.r;
  const oldEndRow = meta.range.e.r;
  const zoneCol = zoneSetting === '__auto_zone__' ? null : Number.parseInt(zoneSetting, 10);

  // Flytt hele det brukte området én rad ned. Vi flytter selve celleobjektene,
  // slik at verdier, tallformat og enkel celleformatering beholdes.
  for (let row = oldEndRow; row >= insertAt; row -= 1) {
    for (let col = meta.range.s.c; col <= meta.range.e.c; col += 1) {
      const from = window.XLSX.utils.encode_cell({ r: row, c: col });
      const to = window.XLSX.utils.encode_cell({ r: row + 1, c: col });
      if (sheet[from] !== undefined) sheet[to] = sheet[from];
      else delete sheet[to];
    }
  }

  for (let col = meta.range.s.c; col <= meta.range.e.c; col += 1) {
    delete sheet[window.XLSX.utils.encode_cell({ r: insertAt, c: col })];
  }

  if (Array.isArray(sheet['!rows'])) {
    sheet['!rows'].splice(insertAt, 0, {});
  }

  if (Array.isArray(sheet['!merges'])) {
    sheet['!merges'] = sheet['!merges'].map((merge) => ({
      s: { r: merge.s.r >= insertAt ? merge.s.r + 1 : merge.s.r, c: merge.s.c },
      e: { r: merge.e.r >= insertAt ? merge.e.r + 1 : merge.e.r, c: merge.e.c }
    }));
  }

  meta.range.e.r = oldEndRow + 1;
  meta.headerRow = insertAt;
  meta.dataStartRow = insertAt + 1;
  meta.syntheticHeader = true;

  // Lag tydelige, nøytrale overskrifter uten å gjette betydningen av andre kolonner.
  for (let col = meta.range.s.c; col <= meta.range.e.c; col += 1) {
    let header = `Original_${columnLetter(col)}`;
    if (col === eastCol) header = 'E';
    else if (col === northCol) header = 'N';
    else if (Number.isInteger(zoneCol) && col === zoneCol) header = 'UTM_Sone';
    writeCell(sheet, meta.headerRow, col, header);
  }

  sheet['!ref'] = window.XLSX.utils.encode_range({
    s: meta.range.s,
    e: meta.range.e
  });

  excelSheetInfo.textContent = `${meta.sheetName} • ny overskriftsrad lagt til • ${meta.range.e.r - meta.dataStartRow + 1} datarader`;
}

function findOrCreateOutputColumns(meta) {
  const headers = new Map();
  for (let col = meta.range.s.c; col <= meta.range.e.c; col += 1) {
    headers.set(normalizeHeader(cellValue(meta.sheet, meta.headerRow, col)), col);
  }

  let nextCol = meta.range.e.c + 1;
  const result = {};

  Object.entries(OUTPUT_HEADERS).forEach(([key, header]) => {
    const existing = headers.get(normalizeHeader(header));
    if (existing !== undefined) {
      result[key] = existing;
    } else {
      result[key] = nextCol;
      nextCol += 1;
    }
  });

  return result;
}

function writeCell(sheet, row, col, value) {
  const address = window.XLSX.utils.encode_cell({ r: row, c: col });
  const cell = { v: value };
  if (typeof value === 'number') cell.t = 'n';
  else cell.t = 's';
  sheet[address] = cell;
}

function isBlankCoordinatePair(eRaw, nRaw) {
  return String(eRaw ?? '').trim() === '' && String(nRaw ?? '').trim() === '';
}

async function processExcel() {
  if (!workbook || !activeSheetMeta) {
    setExcelStatus('Velg en Excel-fil først.', 'error');
    return;
  }

  const eastCol = Number.parseInt(eastColumnSelect.value, 10);
  const northCol = Number.parseInt(northColumnSelect.value, 10);
  const zoneSetting = zoneColumnSelect.value;

  if (!Number.isInteger(eastCol) || !Number.isInteger(northCol)) {
    setExcelStatus('Velg hvilke kolonner som inneholder E og N.', 'error');
    return;
  }
  if (eastCol === northCol) {
    setExcelStatus('E og N kan ikke bruke samme kolonne.', 'error');
    return;
  }

  const meta = activeSheetMeta;

  // Hvis filen ikke har overskriftsrad, legger vi inn en ny rad i toppen i stedet
  // for å bruke første koordinat som overskrift. Dermed beholdes absolutt første punkt.
  insertSyntheticHeaderRow(meta, eastCol, northCol, zoneSetting);

  const outputCols = findOrCreateOutputColumns(meta);

  writeCell(meta.sheet, meta.headerRow, outputCols.lat, OUTPUT_HEADERS.lat);
  writeCell(meta.sheet, meta.headerRow, outputCols.lon, OUTPUT_HEADERS.lon);
  writeCell(meta.sheet, meta.headerRow, outputCols.zone, OUTPUT_HEADERS.zone);
  writeCell(meta.sheet, meta.headerRow, outputCols.status, OUTPUT_HEADERS.status);

  processedRows = [];
  excelProcessed = false;
  excelLayer.clearLayers();
  processExcelBtn.disabled = true;
  downloadExcelBtn.disabled = true;

  let converted = 0;
  let errors = 0;
  let skipped = 0;
  let coordinateRows = 0;
  let zoneHint = lastResolvedZone;
  const totalRows = Math.max(0, meta.range.e.r - meta.dataStartRow + 1);

  for (let row = meta.dataStartRow; row <= meta.range.e.r; row += 1) {
    const eRaw = cellValue(meta.sheet, row, eastCol);
    const nRaw = cellValue(meta.sheet, row, northCol);

    const rowNumberInData = row - meta.dataStartRow + 1;
    if (rowNumberInData % 10 === 0 || row === meta.dataStartRow) {
      setExcelStatus(`Behandler rad ${rowNumberInData} av ${totalRows}…`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (isBlankCoordinatePair(eRaw, nRaw)) {
      skipped += 1;
      writeCell(meta.sheet, row, outputCols.lat, '');
      writeCell(meta.sheet, row, outputCols.lon, '');
      writeCell(meta.sheet, row, outputCols.zone, '');
      writeCell(meta.sheet, row, outputCols.status, '');
      continue;
    }

    coordinateRows += 1;
    const easting = parseNumber(eRaw);
    const northing = parseNumber(nRaw);
    let zone = null;
    let resultStatus = 'OK';
    let lat = '';
    let lon = '';

    if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
      resultStatus = 'Feil: E eller N er ikke et gyldig tall';
    } else if (easting < 10000 || easting > 1000000 || northing < 0 || northing > 10000000) {
      resultStatus = 'Feil: E/N-verdiene er utenfor forventet UTM-område';
    } else {
      try {
        if (zoneSetting !== '__auto_zone__') {
          zone = Number.parseInt(cellValue(meta.sheet, row, Number.parseInt(zoneSetting, 10)), 10);
          if (!isNorwayZone(zone)) throw new Error('UTM-sone må være 32, 33 eller 35');
          const convertedPoint = utmToWgs(easting, northing, zone);
          lat = Number(convertedPoint.lat.toFixed(7));
          lon = Number(convertedPoint.lon.toFixed(7));
        } else {
          const forcedZone = selectedZoneOverride();
          if (forcedZone) {
            zone = forcedZone;
            const convertedPoint = utmToWgs(easting, northing, zone);
            lat = Number(convertedPoint.lat.toFixed(7));
            lon = Number(convertedPoint.lon.toFixed(7));
          } else {
            const detected = await detectZoneFromEN(easting, northing, zoneHint);
            zone = detected.zone;
            zoneHint = zone;
            lastResolvedZone = zone;
            lat = Number(detected.lat.toFixed(7));
            lon = Number(detected.lon.toFixed(7));
          }
        }

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Ugyldig resultat');

        converted += 1;
        processedRows.push({ excelRow: row + 1, easting, northing, zone, lat, lon, status: resultStatus });

        L.circleMarker([lat, lon], { radius: 5, weight: 2, fillOpacity: 0.72 })
          .bindPopup(
            `<strong>Excel-rad ${row + 1}</strong>` +
            `<br>WGS84: ${lat.toFixed(7)}, ${lon.toFixed(7)}` +
            `<br>UTM ${zone}N: E ${easting}, N ${northing}`
          )
          .addTo(excelLayer);
      } catch (error) {
        console.error(`Feil på Excel-rad ${row + 1}`, error);
        resultStatus = zoneSetting === '__auto_zone__'
          ? (selectedZoneOverride()
              ? `Feil: kunne ikke konvertere med UTM ${selectedZoneOverride()}N`
              : 'Feil: kunne ikke bestemme norsk UTM-sone automatisk')
          : `Feil: ${error.message || 'koordinatet kunne ikke konverteres'}`;
      }
    }

    if (resultStatus !== 'OK') errors += 1;
    writeCell(meta.sheet, row, outputCols.lat, lat);
    writeCell(meta.sheet, row, outputCols.lon, lon);
    writeCell(meta.sheet, row, outputCols.zone, isNorwayZone(zone) ? zone : '');
    writeCell(meta.sheet, row, outputCols.status, resultStatus);
  }

  const endCol = Math.max(meta.range.e.c, ...Object.values(outputCols));
  meta.sheet['!ref'] = window.XLSX.utils.encode_range({ s: meta.range.s, e: { r: meta.range.e.r, c: endCol } });
  meta.range.e.c = endCol;

  renderExcelPreview();
  excelProcessed = true;
  processExcelBtn.disabled = false;
  downloadExcelBtn.disabled = false;

  if (processedRows.length) {
    const bounds = L.latLngBounds(processedRows.map((row) => [row.lat, row.lon]));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 15 });
  }

  excelBadge.textContent = `${converted}/${coordinateRows} OK`;
  excelBadge.className = errors ? 'badge' : 'badge live';

  const allPointsOk = coordinateRows > 0 && errors === 0 && converted === coordinateRows;
  const integrityText = allPointsOk
    ? `Alle ${converted} punkt${converted === 1 ? '' : 'er'} ble konvertert og tatt med i resultatfilen og kartet.`
    : `${converted} av ${coordinateRows} rader med E/N ble konvertert. ${errors} rad${errors === 1 ? '' : 'er'} har feilstatus i resultatfilen.`;

  setExcelStatus(
    `${integrityText} ${skipped} tomme rad${skipped === 1 ? '' : 'er'} hoppet over. Alle originale rader og øvrige kolonner er beholdt.`,
    allPointsOk ? 'ok' : ''
  );
}

function renderExcelPreview() {
  const rows = processedRows.slice(0, 8);
  excelPreview.innerHTML = '';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Excel-rad', 'E', 'N', 'Sone', 'WGS84 lat', 'WGS84 lon'].forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  excelPreview.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    [row.excelRow, row.easting, row.northing, row.zone, row.lat, row.lon].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  excelPreview.appendChild(tbody);

  previewCount.textContent = processedRows.length > 8
    ? `viser 8 av ${processedRows.length}`
    : `${processedRows.length} punkt${processedRows.length === 1 ? '' : 'er'}`;
  previewWrap.hidden = processedRows.length === 0;
}

processExcelBtn.addEventListener('click', processExcel);

downloadExcelBtn.addEventListener('click', () => {
  if (!workbook || !excelProcessed) {
    setExcelStatus('Konverter Excel-filen før du laster ned resultatet.', 'error');
    return;
  }

  const baseName = originalFileName.replace(/\.[^.]+$/, '') || 'koordinater';
  const outputName = `${baseName}_med_WGS84.xlsx`;
  window.XLSX.writeFile(workbook, outputName, { compression: true });
  setExcelStatus(`Resultatfilen «${outputName}» er laget.`, 'ok');
});

// Vis tydelig om Excel-motoren er klar.
setExcelControlsEnabled(false);
if (!excelLibraryReady()) {
  excelBadge.textContent = 'Excel ikke lastet';
  excelBadge.className = 'badge error';
  setExcelStatus('Excel-funksjonen kunne ikke laste biblioteket. Prøv å oppdatere siden. Hvis feilen fortsetter, kontroller at nettleseren ikke blokkerer cdn.jsdelivr.net/cdnjs.cloudflare.com.', 'error');
}

// Valgfri delbar lenke: ?lat=..&lon=..
const params = new URLSearchParams(window.location.search);
const initialLat = Number(params.get('lat'));
const initialLon = Number(params.get('lon'));
if (Number.isFinite(initialLat) && Number.isFinite(initialLon)) {
  setPosition(initialLat, initialLon, 'Lenke');
}
