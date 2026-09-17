'use strict';

const $ = (id) => document.getElementById(id);

const eastingInput = $('easting');
const northingInput = $('northing');
const zoneInput = $('utmZone');
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

L.control.layers(
  {
    'Terrengkart': topo,
    'Satellitt': satellite,
    'Detaljkart': street
  },
  {
    'Excel-punkter': excelLayer
  },
  { collapsed: false, position: 'topright' }
).addTo(map);

L.control.scale({ metric: true, imperial: false }).addTo(map);

function selectedZone() {
  const zone = Number.parseInt(zoneInput.value, 10);
  return NORWAY_ZONES.includes(zone) ? zone : 33;
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

function wgsToUtm(lat, lon, zone = selectedZone()) {
  const [easting, northing] = proj4('EPSG:4326', utmProjString(zone), [lon, lat]);
  return { zone, easting, northing };
}

function utmToWgs(easting, northing, zone = selectedZone()) {
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

function setPosition(lat, lon, source = 'Kart', options = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    setStatus('Ugyldig posisjon.', 'error');
    return;
  }

  const zone = selectedZone();
  const utm = wgsToUtm(lat, lon, zone);

  eastingInput.value = utm.easting.toFixed(2);
  northingInput.value = utm.northing.toFixed(2);

  wgsResult.textContent = `${lat.toFixed(7)}, ${lon.toFixed(7)}`;
  utmResult.textContent = `E ${formatNum(utm.easting, 2)}  N ${formatNum(utm.northing, 2)}  • sone ${zone}N`;
  epsgResult.textContent = `EUREF89 / UTM sone ${zone}N → WGS84`;
  sourceBadge.textContent = source;

  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.marker([lat, lon]).addTo(map);

  marker.bindPopup(
    `<strong>WGS84</strong><br>${lat.toFixed(7)}, ${lon.toFixed(7)}` +
    `<br><br><strong>UTM ${zone}N</strong><br>E ${utm.easting.toFixed(2)}<br>N ${utm.northing.toFixed(2)}`
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

  setStatus('Koordinatene er oppdatert.', 'ok');
}

function convertSinglePoint() {
  const easting = parseNumber(eastingInput.value);
  const northing = parseNumber(northingInput.value);
  const zone = selectedZone();

  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    setStatus('Skriv inn gyldige tall for E og N.', 'error');
    return;
  }

  if (easting < 10000 || easting > 1000000 || northing < 0 || northing > 10000000) {
    setStatus('E/N-verdiene ser uvanlige ut. Kontroller koordinatene og valgt UTM-sone.', 'error');
    return;
  }

  try {
    const { lat, lon } = utmToWgs(easting, northing, zone);
    setPosition(lat, lon, 'E/N-konvertering');
  } catch (error) {
    console.error(error);
    setStatus('Kunne ikke konvertere koordinatene. Kontroller E, N og UTM-sone.', 'error');
  }
}

convertBtn.addEventListener('click', convertSinglePoint);
[eastingInput, northingInput].forEach((element) => {
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') convertSinglePoint();
  });
});

zoneInput.addEventListener('change', () => {
  // Dersom en posisjon allerede finnes som WGS84, regn den om i ny sone.
  const match = wgsResult.textContent.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    setPosition(Number(match[1]), Number(match[2]), sourceBadge.textContent || 'Valgt posisjon', { zoom: false });
  }
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
    (position) => {
      setLocateButtonsLoading(false);
      const accuracy = position.coords.accuracy;
      updateGpsBadge(Number.isFinite(accuracy) ? `±${Math.round(accuracy)} m` : 'Funnet', 'live');
      setPosition(position.coords.latitude, position.coords.longitude, 'Telefonens GPS', {
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

map.on('click', (event) => {
  setPosition(event.latlng.lat, event.latlng.lng, 'Kartklikk', { zoom: false });
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

function columnLetter(index) {
  return XLSX.utils.encode_col(index);
}

function cellValue(sheet, row, col) {
  return sheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v ?? '';
}

function findHeaderRow(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const maxRow = Math.min(range.e.r, range.s.r + 30);

  let bestRow = range.s.r;
  let bestScore = -1;

  for (let row = range.s.r; row <= maxRow; row += 1) {
    let score = 0;
    let nonEmpty = 0;
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const raw = cellValue(sheet, row, col);
      if (String(raw).trim()) nonEmpty += 1;
      const h = normalizeHeader(raw);
      if (isEastHeader(h)) score += 4;
      if (isNorthHeader(h)) score += 4;
      if (isZoneHeader(h)) score += 2;
    }

    // En vanlig overskriftsrad med flere tekstceller får en liten bonus.
    score += Math.min(nonEmpty, 5) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  return bestRow;
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

function sheetMetadata(sheetName) {
  const sheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const headerRow = findHeaderRow(sheet);
  const columns = [];

  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const raw = cellValue(sheet, headerRow, col);
    const title = String(raw).trim() || `Kolonne ${columnLetter(col)} (uten overskrift)`;
    columns.push({
      index: col,
      title,
      normalized: normalizeHeader(raw)
    });
  }

  return { sheetName, sheet, range, headerRow, columns };
}

function populateColumnSelect(select, columns, includeDefaultZone = false) {
  select.innerHTML = '';

  if (includeDefaultZone) {
    const option = document.createElement('option');
    option.value = '__selected_zone__';
    option.textContent = 'Bruk sone valgt på siden';
    select.appendChild(option);
  }

  columns.forEach((column) => {
    const option = document.createElement('option');
    option.value = String(column.index);
    option.textContent = `${columnLetter(column.index)} – ${column.title}`;
    select.appendChild(option);
  });
}

function autoSelectColumns(meta) {
  const east = meta.columns.find((column) => isEastHeader(column.normalized));
  const north = meta.columns.find((column) => isNorthHeader(column.normalized));
  const zone = meta.columns.find((column) => isZoneHeader(column.normalized));

  if (east) eastColumnSelect.value = String(east.index);
  if (north) northColumnSelect.value = String(north.index);
  if (zone) zoneColumnSelect.value = String(zone.index);
  else zoneColumnSelect.value = '__selected_zone__';
}

function refreshSheetMapping() {
  if (!workbook || !sheetSelect.value) return;

  activeSheetMeta = sheetMetadata(sheetSelect.value);
  populateColumnSelect(eastColumnSelect, activeSheetMeta.columns);
  populateColumnSelect(northColumnSelect, activeSheetMeta.columns);
  populateColumnSelect(zoneColumnSelect, activeSheetMeta.columns, true);
  autoSelectColumns(activeSheetMeta);

  const dataRows = Math.max(0, activeSheetMeta.range.e.r - activeSheetMeta.headerRow);
  excelSheetInfo.textContent = `${activeSheetMeta.sheetName} • overskriftsrad ${activeSheetMeta.headerRow + 1} • opptil ${dataRows} datarader`;
  processedRows = [];
  excelProcessed = false;
  downloadExcelBtn.disabled = true;
  previewWrap.hidden = true;
  setExcelStatus('Kontroller at E- og N-kolonnene er valgt riktig. Andre kolonner påvirkes ikke.');
}

async function loadExcelFile(file) {
  try {
    excelBadge.textContent = 'Leser…';
    excelBadge.className = 'badge';
    setExcelStatus('Leser filen…');

    const data = await file.arrayBuffer();
    workbook = XLSX.read(data, { type: 'array', cellStyles: true, cellDates: true });
    originalFileName = file.name;

    if (!workbook.SheetNames.length) throw new Error('Filen inneholder ingen ark.');

    sheetSelect.innerHTML = '';
    workbook.SheetNames.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      sheetSelect.appendChild(option);
    });

    excelFileName.textContent = file.name;
    excelMapping.hidden = false;
    excelBadge.textContent = 'Klar';
    excelBadge.className = 'badge live';
    refreshSheetMapping();
  } catch (error) {
    console.error(error);
    workbook = null;
    activeSheetMeta = null;
    excelMapping.hidden = true;
    excelBadge.textContent = 'Feil';
    excelBadge.className = 'badge error';
    setExcelStatus('Kunne ikke lese Excel-filen. Kontroller at filen er en gyldig Excel- eller CSV-fil.', 'error');
  }
}

excelFileInput.addEventListener('change', () => {
  const file = excelFileInput.files?.[0];
  if (file) loadExcelFile(file);
});

sheetSelect.addEventListener('change', refreshSheetMapping);

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
  const address = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = { v: value };
  if (typeof value === 'number') cell.t = 'n';
  else cell.t = 's';
  sheet[address] = cell;
}

function isBlankCoordinatePair(eRaw, nRaw) {
  return String(eRaw ?? '').trim() === '' && String(nRaw ?? '').trim() === '';
}

function processExcel() {
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
  const outputCols = findOrCreateOutputColumns(meta);

  writeCell(meta.sheet, meta.headerRow, outputCols.lat, OUTPUT_HEADERS.lat);
  writeCell(meta.sheet, meta.headerRow, outputCols.lon, OUTPUT_HEADERS.lon);
  writeCell(meta.sheet, meta.headerRow, outputCols.zone, OUTPUT_HEADERS.zone);
  writeCell(meta.sheet, meta.headerRow, outputCols.status, OUTPUT_HEADERS.status);

  processedRows = [];
  excelProcessed = false;
  excelLayer.clearLayers();

  let converted = 0;
  let errors = 0;
  let skipped = 0;

  for (let row = meta.headerRow + 1; row <= meta.range.e.r; row += 1) {
    const eRaw = cellValue(meta.sheet, row, eastCol);
    const nRaw = cellValue(meta.sheet, row, northCol);

    if (isBlankCoordinatePair(eRaw, nRaw)) {
      skipped += 1;
      writeCell(meta.sheet, row, outputCols.lat, '');
      writeCell(meta.sheet, row, outputCols.lon, '');
      writeCell(meta.sheet, row, outputCols.zone, '');
      writeCell(meta.sheet, row, outputCols.status, '');
      continue;
    }

    const easting = parseNumber(eRaw);
    const northing = parseNumber(nRaw);
    let zone = selectedZone();

    if (zoneSetting !== '__selected_zone__') {
      zone = Number.parseInt(cellValue(meta.sheet, row, Number.parseInt(zoneSetting, 10)), 10);
    }

    let resultStatus = 'OK';
    let lat = '';
    let lon = '';

    if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
      resultStatus = 'Feil: E eller N er ikke et gyldig tall';
    } else if (!isNorwayZone(zone)) {
      resultStatus = 'Feil: UTM-sone må være 32, 33 eller 35';
    } else if (easting < 10000 || easting > 1000000 || northing < 0 || northing > 10000000) {
      resultStatus = 'Feil: E/N-verdiene er utenfor forventet UTM-område';
    } else {
      try {
        const convertedPoint = utmToWgs(easting, northing, zone);
        lat = Number(convertedPoint.lat.toFixed(7));
        lon = Number(convertedPoint.lon.toFixed(7));

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error('Ugyldig resultat');
        }

        converted += 1;
        processedRows.push({
          excelRow: row + 1,
          easting,
          northing,
          zone,
          lat,
          lon,
          status: resultStatus
        });

        L.circleMarker([lat, lon], {
          radius: 5,
          weight: 2,
          fillOpacity: 0.72
        })
          .bindPopup(
            `<strong>Excel-rad ${row + 1}</strong>` +
            `<br>WGS84: ${lat.toFixed(7)}, ${lon.toFixed(7)}` +
            `<br>UTM ${zone}N: E ${easting}, N ${northing}`
          )
          .addTo(excelLayer);
      } catch (error) {
        console.error(`Feil på Excel-rad ${row + 1}`, error);
        resultStatus = 'Feil: koordinatet kunne ikke konverteres';
      }
    }

    if (resultStatus !== 'OK') errors += 1;

    writeCell(meta.sheet, row, outputCols.lat, lat);
    writeCell(meta.sheet, row, outputCols.lon, lon);
    writeCell(meta.sheet, row, outputCols.zone, isNorwayZone(zone) ? zone : String(zone ?? ''));
    writeCell(meta.sheet, row, outputCols.status, resultStatus);
  }

  const endCol = Math.max(meta.range.e.c, ...Object.values(outputCols));
  meta.sheet['!ref'] = XLSX.utils.encode_range({
    s: meta.range.s,
    e: { r: meta.range.e.r, c: endCol }
  });
  meta.range.e.c = endCol;

  renderExcelPreview();
  excelProcessed = true;
  downloadExcelBtn.disabled = false;

  if (processedRows.length) {
    const bounds = L.latLngBounds(processedRows.map((row) => [row.lat, row.lon]));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 15 });
  }

  excelBadge.textContent = `${converted} OK`;
  excelBadge.className = errors ? 'badge' : 'badge live';
  setExcelStatus(
    `${converted} rad${converted === 1 ? '' : 'er'} konvertert. ${errors} rad${errors === 1 ? '' : 'er'} med feil. ${skipped} tomme rad${skipped === 1 ? '' : 'er'} hoppet over. Originale kolonner er beholdt.`,
    errors ? '' : 'ok'
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
  XLSX.writeFile(workbook, outputName, { compression: true });
  setExcelStatus(`Resultatfilen «${outputName}» er laget.`, 'ok');
});

// Valgfri delbar lenke: ?lat=..&lon=..
const params = new URLSearchParams(window.location.search);
const initialLat = Number(params.get('lat'));
const initialLon = Number(params.get('lon'));
const initialZone = Number.parseInt(params.get('zone'), 10);
if (isNorwayZone(initialZone)) zoneInput.value = String(initialZone);
if (Number.isFinite(initialLat) && Number.isFinite(initialLon)) {
  setPosition(initialLat, initialLon, 'Lenke');
}
