'use strict';

const $ = (id) => document.getElementById(id);

const eastingInput = $('easting');
const northingInput = $('northing');
const zoneInput = $('utmZone');
const hemisphereInput = $('hemisphere');
const convertBtn = $('convertBtn');
const locateBtn = $('locateBtn');
const wgsResult = $('wgsResult');
const utmResult = $('utmResult');
const epsgResult = $('epsgResult');
const sourceBadge = $('sourceBadge');
const accuracyRow = $('accuracyRow');
const statusEl = $('status');

let marker = null;
let accuracyCircle = null;

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
L.control.layers(
  {
    'Terrengkart': topo,
    'Satellitt': satellite,
    'Detaljkart': street
  },
  null,
  { collapsed: false, position: 'topright' }
).addTo(map);
L.control.scale({ metric: true, imperial: false }).addTo(map);

function parseNumber(value) {
  if (typeof value !== 'string') return Number(value);
  const cleaned = value.trim().replace(/\s+/g, '').replace(',', '.');
  return Number(cleaned);
}

function clampZone(zone) {
  const z = Number.parseInt(zone, 10);
  return Number.isInteger(z) && z >= 1 && z <= 60 ? z : null;
}

function utmProjString(zone, hemisphere = 'N') {
  const south = hemisphere === 'S' ? ' +south' : '';
  return `+proj=utm +zone=${zone}${south} +datum=WGS84 +units=m +no_defs +type=crs`;
}

// UTM-soner har enkelte offisielle unntak i Norge og på Svalbard.
function zoneForLonLat(lon, lat) {
  let zone = Math.floor((lon + 180) / 6) + 1;

  // Sør-Norge: 56–64°N og 3–12°E ligger i sone 32.
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;

  // Svalbard-unntak.
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }

  return Math.min(60, Math.max(1, zone));
}

function wgsToUtm(lat, lon) {
  const zone = zoneForLonLat(lon, lat);
  const hemisphere = lat < 0 ? 'S' : 'N';
  const [easting, northing] = proj4('EPSG:4326', utmProjString(zone, hemisphere), [lon, lat]);
  return { zone, hemisphere, easting, northing };
}

function utmToWgs(easting, northing, zone, hemisphere) {
  const [lon, lat] = proj4(utmProjString(zone, hemisphere), 'EPSG:4326', [easting, northing]);
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

function setPosition(lat, lon, source = 'Kart', options = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    setStatus('Ugyldig posisjon.', 'error');
    return;
  }

  const utm = wgsToUtm(lat, lon);
  zoneInput.value = utm.zone;
  hemisphereInput.value = utm.hemisphere;
  eastingInput.value = utm.easting.toFixed(2);
  northingInput.value = utm.northing.toFixed(2);

  wgsResult.textContent = `${lat.toFixed(7)}, ${lon.toFixed(7)}`;
  utmResult.textContent = `E ${formatNum(utm.easting, 2)}  N ${formatNum(utm.northing, 2)}  • sone ${utm.zone}${utm.hemisphere}`;
  epsgResult.textContent = `EPSG:${utm.hemisphere === 'N' ? 32600 + utm.zone : 32700 + utm.zone}`;
  sourceBadge.textContent = source;

  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.marker([lat, lon]).addTo(map);

  const popup = `<strong>WGS84</strong><br>${lat.toFixed(7)}, ${lon.toFixed(7)}<br><br><strong>UTM ${utm.zone}${utm.hemisphere}</strong><br>E ${utm.easting.toFixed(2)}<br>N ${utm.northing.toFixed(2)}`;
  marker.bindPopup(popup);

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

convertBtn.addEventListener('click', () => {
  const easting = parseNumber(eastingInput.value);
  const northing = parseNumber(northingInput.value);
  const zone = clampZone(zoneInput.value);
  const hemisphere = hemisphereInput.value;

  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    setStatus('Skriv inn gyldige tall for E og N.', 'error');
    return;
  }
  if (!zone) {
    setStatus('UTM-sone må være et tall fra 1 til 60.', 'error');
    return;
  }
  if (easting < 10000 || easting > 1000000 || northing < 0 || northing > 10000000) {
    setStatus('E/N-verdiene ser uvanlige ut. Kontroller koordinatene og sonen.', 'error');
    return;
  }

  try {
    const { lat, lon } = utmToWgs(easting, northing, zone, hemisphere);
    setPosition(lat, lon, 'E/N-konvertering');
  } catch (err) {
    console.error(err);
    setStatus('Kunne ikke konvertere koordinatene. Kontroller E, N, sone og halvkule.', 'error');
  }
});

[eastingInput, northingInput, zoneInput].forEach((el) => {
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') convertBtn.click();
  });
});

locateBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    setStatus('Denne nettleseren støtter ikke posisjonstjenester.', 'error');
    return;
  }

  locateBtn.disabled = true;
  locateBtn.textContent = 'Finner posisjon…';
  setStatus('Ber telefonen/nettleseren om posisjon…');

  navigator.geolocation.getCurrentPosition(
    (position) => {
      locateBtn.disabled = false;
      locateBtn.textContent = '◎ Min posisjon';
      setPosition(position.coords.latitude, position.coords.longitude, 'Min posisjon', {
        accuracy: position.coords.accuracy,
        zoomLevel: 17
      });
      marker?.openPopup();
    },
    (error) => {
      locateBtn.disabled = false;
      locateBtn.textContent = '◎ Min posisjon';
      const messages = {
        1: 'Posisjonstilgang ble avslått. Tillat posisjon for denne nettsiden i nettleseren.',
        2: 'Telefonen klarte ikke å finne posisjonen.',
        3: 'Tidsavbrudd ved henting av posisjon.'
      };
      setStatus(messages[error.code] || 'Kunne ikke hente posisjon.', 'error');
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 5000
    }
  );
});

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
      const old = button.textContent;
      button.textContent = 'Kopiert';
      setTimeout(() => { button.textContent = old; }, 1200);
    } catch {
      setStatus('Kunne ikke kopiere automatisk. Marker teksten og kopier manuelt.', 'error');
    }
  });
});

// Valgfri delbar lenke: ?lat=..&lon=..
const params = new URLSearchParams(window.location.search);
const initialLat = Number(params.get('lat'));
const initialLon = Number(params.get('lon'));
if (Number.isFinite(initialLat) && Number.isFinite(initialLon)) {
  setPosition(initialLat, initialLon, 'Lenke');
}
