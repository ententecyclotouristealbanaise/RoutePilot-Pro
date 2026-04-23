const STORAGE_KEY = "routepilot_store_v3";
const THEME_KEY = "routepilot_theme_v1";

const GEO_BASE = "https://nominatim.openstreetmap.org";
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

class StopModel {
  constructor({ id, name, lat, lng, notes = "" }) {
    this.id = Number(id || Date.now() + Math.random());
    this.name = String(name || "Etape");
    this.lat = Number(lat);
    this.lng = Number(lng);
    this.notes = String(notes || "");
  }

  static fromRaw(raw) {
    if (!raw) return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return new StopModel({
      id: raw.id,
      name: raw.name,
      lat,
      lng,
      notes: raw.notes
    });
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      lat: this.lat,
      lng: this.lng,
      notes: this.notes
    };
  }
}

class TourModel {
  constructor({ id, name, createdAt, updatedAt, departure = null, stops = [], options = {} }) {
    this.id = Number(id || Date.now() + Math.random());
    this.name = String(name || "Nouvelle tournee");
    this.createdAt = String(createdAt || new Date().toISOString());
    this.updatedAt = String(updatedAt || new Date().toISOString());
    this.departure = departure ? StopModel.fromRaw(departure) : null;
    this.stops = Array.isArray(stops) ? stops.map((s) => StopModel.fromRaw(s)).filter(Boolean) : [];
    this.options = {
      returnToStart: Boolean(options.returnToStart),
      avoidMotorways: Boolean(options.avoidMotorways)
    };
  }

  static fromRaw(raw) {
    if (!raw || typeof raw !== "object") return null;
    return new TourModel(raw);
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      departure: this.departure ? this.departure.toJSON() : null,
      stops: this.stops.map((s) => s.toJSON()),
      options: { ...this.options }
    };
  }
}

class TourStore {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this.tours = [];
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey) || "[]");
      this.tours = Array.isArray(raw) ? raw.map((r) => TourModel.fromRaw(r)).filter(Boolean) : [];
    } catch (_e) {
      this.tours = [];
    }
  }

  save() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.tours.map((t) => t.toJSON())));
  }

  upsert(tour) {
    const idx = this.tours.findIndex((t) => t.id === tour.id);
    if (idx >= 0) this.tours[idx] = tour;
    else this.tours.unshift(tour);
    this.save();
  }

  removeById(id) {
    this.tours = this.tours.filter((t) => t.id !== id);
    this.save();
  }

  findById(id) {
    return this.tours.find((t) => t.id === id) || null;
  }

  importTours(rows, mode = "merge") {
    const incoming = rows.map((r) => TourModel.fromRaw(r)).filter(Boolean);
    if (!incoming.length) return 0;

    if (mode === "replace") {
      this.tours = incoming;
      this.save();
      return incoming.length;
    }

    const used = new Set(this.tours.map((t) => t.id));
    incoming.forEach((t) => {
      while (used.has(t.id)) t.id = Date.now() + Math.random();
      used.add(t.id);
    });

    this.tours = [...incoming, ...this.tours];
    this.save();
    return incoming.length;
  }
}

const App = {
  store: new TourStore(STORAGE_KEY),
  selectedTourId: null,
  map: null,
  markers: [],
  polyline: null,
  addMode: false,
  deferredInstallPrompt: null,
  searchTimers: { dep: null, stop: null, map: null }
};

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function showToast(message, ms = 2200) {
  const el = document.getElementById("app-toast");
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => el.classList.remove("show"), ms);
}

function setBusy(buttonId, busy, busyLabel = "Traitement") {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    btn.textContent = busyLabel;
    btn.disabled = true;
    btn.classList.add("is-busy");
    return;
  }
  btn.disabled = false;
  btn.classList.remove("is-busy");
  if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
}

function formatKm(km) {
  return `${Number(km || 0).toFixed(1)} km`;
}

function formatDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes || 0)));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return `${mm} min`;
  return `${h} h ${mm.toString().padStart(2, "0")}`;
}

function distKm(a, b) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function computeStats(tour) {
  if (!tour || !tour.departure || !tour.stops.length) return { distance: 0, duration: 0 };
  let total = 0;
  let prev = tour.departure;
  tour.stops.forEach((s) => {
    total += distKm(prev, s);
    prev = s;
  });
  if (tour.options.returnToStart) total += distKm(prev, tour.departure);
  const duration = (total / 45) * 60 + Math.max(0, tour.stops.length - 1) * 4;
  return { distance: total, duration };
}

function getSelectedTour() {
  if (!App.selectedTourId) return null;
  return App.store.findById(App.selectedTourId);
}

function setSelectedTour(id) {
  App.selectedTourId = id;
  renderTourList();
  renderEditor();
  updateMap();
}

function createNewTour() {
  const t = new TourModel({ name: `Tournee ${new Date().toLocaleDateString("fr-FR")}` });
  App.store.upsert(t);
  setSelectedTour(t.id);
  showToast("Nouvelle tournee creee");
}

function removeTour(id) {
  if (!window.confirm("Supprimer cette tournee ?")) return;
  App.store.removeById(id);
  if (App.selectedTourId === id) App.selectedTourId = null;
  renderTourList();
  renderEditor();
  updateMap();
}

function renderTourList() {
  const root = document.getElementById("tour-list");
  const tmpl = document.getElementById("tpl-tour-card");
  root.innerHTML = "";

  if (!App.store.tours.length) {
    root.innerHTML = '<div class="text-secondary small py-3">Aucune tournee enregistree pour le moment.</div>';
    return;
  }

  App.store.tours.forEach((tour) => {
    const node = tmpl.content.firstElementChild.cloneNode(true);
    node.classList.toggle("active", tour.id === App.selectedTourId);

    const stats = computeStats(tour);
    node.querySelector("[data-role='tour-name']").textContent = tour.name;
    node.querySelector("[data-role='tour-meta']").textContent =
      `${tour.stops.length} etape(s) | ${formatKm(stats.distance)} | ${new Date(tour.updatedAt).toLocaleDateString("fr-FR")}`;
    node.setAttribute("aria-label", `Ouvrir la tournee ${tour.name}`);

    node.querySelector("[data-role='open-tour']").addEventListener("click", () => setSelectedTour(tour.id));
    node.querySelector("[data-role='open-tour']").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setSelectedTour(tour.id);
    });
    node.querySelector("[data-role='delete-tour']").addEventListener("click", (e) => {
      e.stopPropagation();
      removeTour(tour.id);
    });

    root.appendChild(node);
  });
}

function renderEditor() {
  const wrap = document.getElementById("editor-wrap");
  const empty = document.getElementById("empty-editor");
  const tour = getSelectedTour();
  if (!tour) {
    wrap.classList.add("d-none");
    if (empty) empty.classList.remove("d-none");
    return;
  }

  wrap.classList.remove("d-none");
  if (empty) empty.classList.add("d-none");

  document.getElementById("tour-name-input").value = tour.name;
  document.getElementById("departure-preview").textContent = tour.departure ? tour.departure.name : "Depart non defini";
  document.getElementById("opt-return").checked = !!tour.options.returnToStart;
  document.getElementById("opt-avoid").checked = !!tour.options.avoidMotorways;

  const stats = computeStats(tour);
  document.getElementById("stats-distance").textContent = formatKm(stats.distance);
  document.getElementById("stats-duration").textContent = formatDuration(stats.duration);

  renderStops(tour);
}

function renderStops(tour) {
  const root = document.getElementById("stop-list");
  const tmpl = document.getElementById("tpl-stop-item");
  root.innerHTML = "";

  if (!tour.stops.length) {
    root.innerHTML = '<div class="small text-secondary py-2">Ajoute tes etapes pour construire la tournee.</div>';
    return;
  }

  tour.stops.forEach((stop, idx) => {
    const node = tmpl.content.firstElementChild.cloneNode(true);
    node.querySelector("[data-role='order']").textContent = String(idx + 1);
    node.querySelector("[data-role='name']").textContent = stop.name;

    const note = node.querySelector("[data-role='note']");
    note.value = stop.notes || "";
    note.addEventListener("input", () => {
      stop.notes = note.value;
      tour.touch();
      App.store.upsert(tour);
    });

    node.querySelector("[data-role='up']").addEventListener("click", () => moveStop(stop.id, -1));
    node.querySelector("[data-role='down']").addEventListener("click", () => moveStop(stop.id, 1));
    node.querySelector("[data-role='delete']").addEventListener("click", () => deleteStop(stop.id));

    root.appendChild(node);
  });
}

function moveStop(stopId, direction) {
  const tour = getSelectedTour();
  if (!tour) return;
  const i = tour.stops.findIndex((s) => s.id === stopId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= tour.stops.length) return;
  [tour.stops[i], tour.stops[j]] = [tour.stops[j], tour.stops[i]];
  tour.touch();
  App.store.upsert(tour);
  renderEditor();
  updateMap();
}

function deleteStop(stopId) {
  const tour = getSelectedTour();
  if (!tour) return;
  tour.stops = tour.stops.filter((s) => s.id !== stopId);
  tour.touch();
  App.store.upsert(tour);
  renderEditor();
  updateMap();
}

function normalizeQuery(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url, timeoutMs = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctl.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchAddress(query, limit = 6) {
  const q = normalizeQuery(query);
  if (q.length < 2) return [];
  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    addressdetails: "1",
    "accept-language": "fr",
    limit: String(limit),
    countrycodes: "fr,be,ch,lu,mc"
  });
  const rows = await fetchJson(`${GEO_BASE}/search?${params.toString()}`);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      name: String((r.display_name || "").split(",")[0] || r.name || "Lieu"),
      label: String(r.display_name || r.name || "Lieu"),
      lat: Number(r.lat),
      lng: Number(r.lon)
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

async function reverseAddress(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "jsonv2",
    "accept-language": "fr"
  });
  const row = await fetchJson(`${GEO_BASE}/reverse?${params.toString()}`);
  if (!row) return new StopModel({ name: "Lieu selectionne", lat, lng });
  const label = String(row.display_name || "Lieu selectionne");
  const name = String(label.split(",")[0] || "Lieu selectionne");
  return new StopModel({ name, lat, lng });
}

function buildSuggest(containerId, items, onPick) {
  const root = document.getElementById(containerId);
  root.innerHTML = "";
  if (!items.length) {
    root.classList.add("d-none");
    return;
  }
  items.forEach((item) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-label", item.label);
    b.textContent = item.label;
    b.addEventListener("click", () => {
      onPick(item);
      root.classList.add("d-none");
    });
    root.appendChild(b);
  });
  root.classList.remove("d-none");
}

function bindSearchInput(inputId, suggestId, callback) {
  const input = document.getElementById(inputId);
  input.addEventListener("input", () => {
    const token = inputId;
    clearTimeout(App.searchTimers[token]);
    App.searchTimers[token] = setTimeout(async () => {
      const rows = await searchAddress(input.value);
      buildSuggest(suggestId, rows, (picked) => callback(picked, input));
    }, 220);
  });
}

function saveTourName() {
  const tour = getSelectedTour();
  if (!tour) return;
  const value = document.getElementById("tour-name-input").value.trim();
  if (!value) {
    showToast("Le nom est requis");
    return;
  }
  tour.name = value;
  tour.touch();
  App.store.upsert(tour);
  renderTourList();
  showToast("Nom enregistre");
}

async function setDepartureByInput() {
  const tour = getSelectedTour();
  if (!tour) return;
  const val = document.getElementById("departure-input").value.trim();
  if (!val) {
    showToast("Saisis un depart");
    return;
  }
  setBusy("set-departure-btn", true, "Recherche");
  const rows = await searchAddress(val, 1);
  setBusy("set-departure-btn", false);
  if (!rows.length) {
    showToast("Depart introuvable");
    return;
  }
  const p = rows[0];
  tour.departure = new StopModel(p);
  tour.touch();
  App.store.upsert(tour);
  document.getElementById("departure-input").value = "";
  renderEditor();
  updateMap();
}

async function addStopByInput() {
  const tour = getSelectedTour();
  if (!tour) return;
  const val = document.getElementById("stop-input").value.trim();
  if (!val) {
    showToast("Saisis une etape");
    return;
  }
  setBusy("add-stop-btn", true, "Recherche");
  const rows = await searchAddress(val, 1);
  setBusy("add-stop-btn", false);
  if (!rows.length) {
    showToast("Etape introuvable");
    return;
  }
  tour.stops.push(new StopModel(rows[0]));
  tour.touch();
  App.store.upsert(tour);
  document.getElementById("stop-input").value = "";
  renderEditor();
  updateMap();
}

function optimizeRoute() {
  const tour = getSelectedTour();
  if (!tour || !tour.departure || tour.stops.length < 2) {
    showToast("Depart + 2 etapes minimum");
    return;
  }

  setBusy("optimize-btn", true, "Optimisation");
  const remaining = [...tour.stops];
  const ordered = [];
  let current = tour.departure;

  while (remaining.length) {
    let idx = 0;
    let best = Number.POSITIVE_INFINITY;
    remaining.forEach((stop, i) => {
      const d = distKm(current, stop);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    const next = remaining.splice(idx, 1)[0];
    ordered.push(next);
    current = next;
  }

  const loopDistance = (stops) => {
    let d = 0;
    let prev = tour.departure;
    stops.forEach((s) => {
      d += distKm(prev, s);
      prev = s;
    });
    if (tour.options.returnToStart) d += distKm(prev, tour.departure);
    return d;
  };

  let bestRoute = [...ordered];
  let bestDistance = loopDistance(bestRoute);

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < bestRoute.length - 1; i++) {
      for (let k = i + 1; k < bestRoute.length; k++) {
        const cand = bestRoute.slice(0, i).concat(bestRoute.slice(i, k + 1).reverse(), bestRoute.slice(k + 1));
        const candDistance = loopDistance(cand);
        if (candDistance + 0.0001 < bestDistance) {
          bestRoute = cand;
          bestDistance = candDistance;
          changed = true;
        }
      }
    }
  }

  tour.stops = bestRoute;
  tour.touch();
  App.store.upsert(tour);
  renderEditor();
  updateMap();
  setBusy("optimize-btn", false);
  showToast("Ordre des etapes optimise");
}

function updateOptions() {
  const tour = getSelectedTour();
  if (!tour) return;
  tour.options.returnToStart = document.getElementById("opt-return").checked;
  tour.options.avoidMotorways = document.getElementById("opt-avoid").checked;
  tour.touch();
  App.store.upsert(tour);
  renderEditor();
  updateMap();
}

function initMap() {
  if (App.map || typeof window.L === "undefined") return;
  App.map = L.map("map", { zoomControl: true }).setView([48.1, -1.7], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(App.map);

  App.map.on("click", async (e) => {
    if (!App.addMode) return;
    const tour = getSelectedTour();
    if (!tour) return;
    const picked = await reverseAddress(e.latlng.lat, e.latlng.lng);
    tour.stops.push(picked);
    tour.touch();
    App.store.upsert(tour);
    renderEditor();
    updateMap();
  });
}

async function fetchRoadPolyline(points, avoidMotorways) {
  if (points.length < 2) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const params = new URLSearchParams({ overview: "full", geometries: "geojson" });
  if (avoidMotorways) params.set("exclude", "motorway");
  const data = await fetchJson(`${OSRM_BASE}/${coords}?${params.toString()}`, 12000);
  const route = data?.routes?.[0]?.geometry?.coordinates;
  if (!Array.isArray(route) || route.length < 2) return null;
  return route.map((c) => [c[1], c[0]]);
}

async function updateMap() {
  initMap();
  if (!App.map) return;

  App.markers.forEach((m) => App.map.removeLayer(m));
  App.markers = [];
  if (App.polyline) {
    App.map.removeLayer(App.polyline);
    App.polyline = null;
  }

  const tour = getSelectedTour();
  if (!tour) return;

  const points = [];

  if (tour.departure) {
    const m = L.marker([tour.departure.lat, tour.departure.lng]).addTo(App.map).bindPopup(`<b>Depart</b><br>${esc(tour.departure.name)}`);
    App.markers.push(m);
    points.push(tour.departure);
  }

  tour.stops.forEach((s, idx) => {
    const m = L.marker([s.lat, s.lng]).addTo(App.map).bindPopup(`<b>Etape ${idx + 1}</b><br>${esc(s.name)}`);
    App.markers.push(m);
    points.push(s);
  });

  const linePoints = [...points];
  if (tour.options.returnToStart && tour.departure && tour.stops.length) linePoints.push(tour.departure);

  if (linePoints.length > 1) {
    const road = await fetchRoadPolyline(linePoints, tour.options.avoidMotorways);
    const latLngs = Array.isArray(road) && road.length > 1 ? road : linePoints.map((p) => [p.lat, p.lng]);
    App.polyline = L.polyline(latLngs, {
      color: "#0d6efd",
      weight: 4,
      opacity: 0.88,
      dashArray: Array.isArray(road) ? null : "8 7"
    }).addTo(App.map);
    App.map.fitBounds(App.polyline.getBounds(), { padding: [35, 35] });
  } else if (linePoints.length === 1) {
    App.map.setView([linePoints[0].lat, linePoints[0].lng], 12);
  }
}

function toggleAddMode() {
  App.addMode = !App.addMode;
  const btn = document.getElementById("map-add-mode-btn");
  btn.classList.toggle("btn-primary", App.addMode);
  btn.classList.toggle("btn-outline-primary", !App.addMode);
  btn.textContent = App.addMode ? "Ajout actif" : "Mode ajout";
}

function fitMap() {
  updateMap();
}

function buildGoogleMapsUrl(tour) {
  const pts = [];
  if (tour.departure) pts.push(`${tour.departure.lat},${tour.departure.lng}`);
  tour.stops.forEach((s) => pts.push(`${s.lat},${s.lng}`));
  if (!pts.length) return null;
  if (tour.options.returnToStart && tour.departure && tour.stops.length) {
    pts.push(`${tour.departure.lat},${tour.departure.lng}`);
  }
  if (pts.length === 1) return `https://www.google.com/maps/search/?api=1&query=${pts[0]}`;
  const avoid = tour.options.avoidMotorways ? "?avoid=highways" : "";
  return `https://www.google.com/maps/dir/${pts.join("/")}${avoid}`;
}

function openMaps() {
  const tour = getSelectedTour();
  if (!tour) return;
  const url = buildGoogleMapsUrl(tour);
  if (!url) {
    showToast("Aucun point pour ouvrir la navigation");
    return;
  }
  window.open(url, "_blank");
}

async function shareTour() {
  const tour = getSelectedTour();
  if (!tour) return;
  const stats = computeStats(tour);
  const lines = [
    `Tournee: ${tour.name}`,
    `Depart: ${tour.departure ? tour.departure.name : "non defini"}`,
    `Distance: ${formatKm(stats.distance)} | Duree: ${formatDuration(stats.duration)}`,
    "Etapes:"
  ];
  tour.stops.forEach((s, i) => lines.push(`${i + 1}. ${s.name}${s.notes ? ` - ${s.notes}` : ""}`));
  const maps = buildGoogleMapsUrl(tour);
  if (maps) lines.push(`Google Maps: ${maps}`);

  const text = lines.join("\n");

  if (navigator.share) {
    try {
      await navigator.share({ title: tour.name, text });
      return;
    } catch (_e) {
      // No-op when share panel is cancelled.
    }
  }

  await navigator.clipboard.writeText(text);
  showToast("Texte copie dans le presse-papiers");
}

function exportJson() {
  const payload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    tours: App.store.tours.map((t) => t.toJSON())
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `routepilot-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Export JSON termine");
}

function exportCsv() {
  const rows = [["tour", "ordre", "nom", "lat", "lng", "note"]];
  App.store.tours.forEach((tour) => {
    if (tour.departure) rows.push([tour.name, "D", tour.departure.name, tour.departure.lat, tour.departure.lng, ""]);
    tour.stops.forEach((s, i) => rows.push([tour.name, String(i + 1), s.name, s.lat, s.lng, s.notes || ""]));
  });
  const csv = rows
    .map((r) => r.map((v) => `"${String(v).replace(/\"/g, "\"\"")}"`).join(";"))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `routepilot-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Export CSV termine");
}

function triggerImport() {
  document.getElementById("import-file").click();
}

function onImportFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  const mode = window.confirm("OK = Fusionner avec l'existant\nAnnuler = Remplacer tout") ? "merge" : "replace";

  const reader = new FileReader();
  reader.onload = () => {
    try {
      setBusy("import-btn", true, "Import");
      const parsed = JSON.parse(String(reader.result || "{}"));
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tours) ? parsed.tours : [];
      const count = App.store.importTours(rows, mode);
      renderTourList();
      renderEditor();
      updateMap();
      showToast(`${count} tournee(s) importee(s)`);
    } catch (_e) {
      showToast("Fichier import invalide");
    } finally {
      setBusy("import-btn", false);
    }
  };
  reader.readAsText(file, "utf-8");
}

function setTheme(theme) {
  const t = theme === "dark" ? "dark" : "light";
  document.body.classList.toggle("theme-dark", t === "dark");
  localStorage.setItem(THEME_KEY, t);
  const btn = document.getElementById("theme-btn");
  btn.textContent = t === "dark" ? "Mode clair" : "Mode sombre";
  const meta = document.querySelector("meta[name='theme-color']");
  meta.setAttribute("content", t === "dark" ? "#0d1628" : "#0d6efd");
}

function toggleTheme() {
  const isDark = document.body.classList.contains("theme-dark");
  setTheme(isDark ? "light" : "dark");
}

function bindMainEvents() {
  document.getElementById("new-tour-btn").addEventListener("click", createNewTour);
  document.getElementById("empty-new-tour-btn").addEventListener("click", createNewTour);
  document.getElementById("save-tour-btn").addEventListener("click", saveTourName);
  document.getElementById("set-departure-btn").addEventListener("click", setDepartureByInput);
  document.getElementById("add-stop-btn").addEventListener("click", addStopByInput);
  document.getElementById("optimize-btn").addEventListener("click", optimizeRoute);
  document.getElementById("opt-return").addEventListener("change", updateOptions);
  document.getElementById("opt-avoid").addEventListener("change", updateOptions);

  document.getElementById("open-maps-btn").addEventListener("click", openMaps);
  document.getElementById("share-btn").addEventListener("click", shareTour);

  document.getElementById("export-json-btn").addEventListener("click", exportJson);
  document.getElementById("export-csv-btn").addEventListener("click", exportCsv);
  document.getElementById("import-btn").addEventListener("click", triggerImport);
  document.getElementById("import-file").addEventListener("change", onImportFile);

  document.getElementById("map-add-mode-btn").addEventListener("click", toggleAddMode);
  document.getElementById("map-fit-btn").addEventListener("click", fitMap);

  document.getElementById("tab-map").addEventListener("shown.bs.tab", () => {
    initMap();
    window.setTimeout(() => {
      if (App.map) App.map.invalidateSize();
      updateMap();
    }, 80);
  });

  document.getElementById("theme-btn").addEventListener("click", toggleTheme);

  document.getElementById("tour-name-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveTourName();
  });

  document.getElementById("departure-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setDepartureByInput();
  });

  document.getElementById("stop-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addStopByInput();
  });
}

function bindSearches() {
  bindSearchInput("departure-input", "departure-suggest", (picked, input) => {
    input.value = picked.name;
    const tour = getSelectedTour();
    if (!tour) return;
    tour.departure = new StopModel(picked);
    tour.touch();
    App.store.upsert(tour);
    input.value = "";
    renderEditor();
    updateMap();
  });

  bindSearchInput("stop-input", "stop-suggest", (picked, input) => {
    input.value = picked.name;
    const tour = getSelectedTour();
    if (!tour) return;
    tour.stops.push(new StopModel(picked));
    tour.touch();
    App.store.upsert(tour);
    input.value = "";
    renderEditor();
    updateMap();
  });

  bindSearchInput("map-search-input", "map-search-suggest", (picked, input) => {
    input.value = "";
    initMap();
    App.map.setView([picked.lat, picked.lng], 13);
  });

  document.addEventListener("click", (e) => {
    ["departure-suggest", "stop-suggest", "map-search-suggest"].forEach((id) => {
      const s = document.getElementById(id);
      const owner = s.previousElementSibling;
      if (s.contains(e.target) || owner?.contains(e.target)) return;
      s.classList.add("d-none");
    });
  });
}

function setupOnlineStatus() {
  const el = document.getElementById("offline-badge");
  const sync = () => {
    const online = navigator.onLine;
    el.textContent = online ? "En ligne" : "Hors ligne";
    el.className = `badge offline-badge ${online ? "text-bg-success" : "text-bg-warning"}`;
  };
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  sync();
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {
        // Ignore registration errors.
      });
    });
  }

  const installBtn = document.getElementById("install-btn");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    App.deferredInstallPrompt = event;
    installBtn.classList.add("show");
  });

  installBtn.addEventListener("click", async () => {
    if (!App.deferredInstallPrompt) return;
    App.deferredInstallPrompt.prompt();
    await App.deferredInstallPrompt.userChoice;
    App.deferredInstallPrompt = null;
    installBtn.classList.remove("show");
  });
}

function boot() {
  App.store.load();
  App.store.tours.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const savedTheme = localStorage.getItem(THEME_KEY) || "light";
  setTheme(savedTheme);

  bindMainEvents();
  bindSearches();
  setupOnlineStatus();
  registerPwa();

  renderTourList();
  if (App.store.tours.length) setSelectedTour(App.store.tours[0].id);
}

document.addEventListener("DOMContentLoaded", boot);
