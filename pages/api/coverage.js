import { request } from "undici";
import fs from "node:fs";
import path from "node:path";

// ---- Load your FloLive data ----
const FLOLIVE = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "data", "floLive_US_EU2_US2.json"),
    "utf-8"
  )
);

const MCCMNC_MAP = JSON.parse(
  fs.readFileSync(
    path.join(
      process.cwd(),
      "data",
      "us_mccmnc_to_operator_from_floLive_Aug2025.json"
    ),
    "utf-8"
  )
);

// ---- Helpers ----
function buildAllowedSet() {
  const allowed = new Set();
  for (const row of FLOLIVE) {
    if (row.IMSI_Provider === "EU 2" || row.IMSI_Provider === "US 2") {
      const op = (row.Operator || "").trim();
      if (op) allowed.add(op);
    }
  }
  return allowed;
}

async function geocodeZipOrLatLon(query) {
  if (query.lat && query.lon) {
    const lat = parseFloat(String(query.lat));
    const lon = parseFloat(String(query.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Invalid lat/lon.");
    }
    return { lat, lon, place: "custom point" };
  }

  const zip = String(query.zip || "").trim();
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    throw new Error("Please provide a valid US ZIP (5 digits) or lat/lon.");
  }
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const { body, statusCode } = await request(url);
  if (statusCode !== 200) throw new Error(`ZIP lookup failed (${statusCode})`);
  const json = await body.json();
  const p = json?.places?.[0];
  if (!p) throw new Error("ZIP not found");
  return {
    lat: parseFloat(p.latitude),
    lon: parseFloat(p.longitude),
    place: `${p["place name"]}, ${p["state abbreviation"]}`,
  };
}

function operatorFromMccMnc(mcc, mnc) {
  const key = String(mcc) + String(mnc).padStart(3, "0");
  return MCCMNC_MAP[key];
}
function labelOperator(mcc, mnc) {
  return operatorFromMccMnc(mcc, mnc) || `MCC${mcc}-MNC${String(mnc).padStart(3, "0")}`;
}

// ---- OpenCelliD one-box (adaptive) ----
async function fetchOpenCellIdBox({ lat, lon, radio, key, dStart = 0.008 }) {
  let d = dStart;
  const minD = 0.004; // stay under OCID's 4 km²/request limit
  for (let i = 0; i < 6; i++) {
    const bbox = `${(lat - d).toFixed(6)},${(lon - d).toFixed(6)},${(lat + d).toFixed(6)},${(lon + d).toFixed(6)}`;
    const url = `https://www.opencellid.org/cell/getInArea?key=${encodeURIComponent(
      key
    )}&BBOX=${bbox}&radio=${encodeURIComponent(radio)}&format=json`;

    const { body } = await request(url);
    const text = await body.text();

    let data;
    try { data = JSON.parse(text); } catch { return []; }

    if (data?.error && String(data.error).toLowerCase().includes("bbox too big")) {
      d = Math.max(minD, d / 2);
      continue;
    }

    const cells = Array.isArray(data?.cells) ? data.cells :
                  Array.isArray(data) ? data : [];
    return cells
      .filter(c => c && c.mcc !== undefined && c.mnc !== undefined)
      .map(c => ({ ...c, radio }));
  }
  return [];
}

// ---- OCID full-grid fanout (LTE first) ----
async function ocidFanoutLTE({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error("Server missing OPENCELLID_API_KEY");

  const boxD = 0.008;
  const maxR = 6;       // ~5–6 km radius; keep request count sane
  const hardCap = 80;

  const seen = new Set();
  const all = [];
  let calls = 0;

  // center
  {
    calls++;
    const cells = await fetchOpenCellIdBox({ lat, lon, radio: "LTE", key, dStart: boxD });
    for (const c of cells) {
      const cid = c.cid ?? c.cellid ?? "";
      const id = `${c.mcc}-${String(c.mnc).padStart(3,"0")}-${cid}-LTE`;
      if (!seen.has(id)) { seen.add(id); all.push(c); }
    }
    if (calls >= hardCap || all.length >= 60) return all;
  }

  // ring borders only
  for (let r = 1; r <= maxR; r++) {
    const dxMin = -r, dxMax = r, dyMin = -r, dyMax = r;
    const offsets = [];
    for (let x = dxMin; x <= dxMax; x++) {
      offsets.push([dyMin * boxD, x * boxD]);
      offsets.push([dyMax * boxD, x * boxD]);
    }
    for (let y = dyMin + 1; y <= dyMax - 1; y++) {
      offsets.push([y * boxD, dxMin * boxD]);
      offsets.push([y * boxD, dxMax * boxD]);
    }

    for (const [dy, dx] of offsets) {
      if (calls >= hardCap) break;
      calls++;
      const cells = await fetchOpenCellIdBox({ lat: lat + dy, lon: lon + dx, radio: "LTE", key, dStart: boxD });
      for (const c of cells) {
        const cid = c.cid ?? c.cellid ?? "";
        const id = `${c.mcc}-${String(c.mnc).padStart(3,"0")}-${cid}-LTE`;
        if (!seen.has(id)) { seen.add(id); all.push(c); }
      }
      if (all.length >= 80) break;
    }
    if (calls >= hardCap || all.length >= 80) break;
  }

  return all;
}

// ---- FCC fallback: providers at location ----
async function fccProvidersNear({ lat, lon }) {
  const base = process.env.FCC_PROVIDERS_URL || "https://broadbandmap.fcc.gov/nbm/map/api/mobileProviders";
  const url = `${base}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`;
  try {
    const { body, statusCode } = await request(url);
    if (statusCode >= 400) return [];
    const data = await body.json().catch(() => null);
    if (!data) return [];

    // Normalize into { name, serviceType? }[]
    // FCC responses vary; keep it flexible:
    // - Some payloads have an array like [{providerName: "...", technology: "..."}]
    // - Others might return { results: [...] }
    const arr = Array.isArray(data) ? data :
                Array.isArray(data?.results) ? data.results :
                Array.isArray(data?.providers) ? data.providers : [];
    return arr.map((p) => {
      const name = p.providerName || p.name || p.ProviderName || p.provider || "Unknown Provider";
      const tech = p.technology || p.tech || p.serviceType || p.radio || "";
      return { name: String(name).trim(), radio: String(tech).trim() || undefined };
    });
  } catch {
    return [];
  }
}

// ---- API handler ----
export default async function handler(req, res) {
  try {
    const geo = await geocodeZipOrLatLon(req.query);

    // 1) Try LTE on OCID (strict TG3 logic)
    const lteCells = await ocidFanoutLTE(geo);
    const lteOps = new Set(lteCells.map(c => labelOperator(c.mcc, c.mnc)));
    const lteOperators = Array.from(lteOps);

    const allowed = buildAllowedSet();
    const networks = lteOperators.filter(op => allowed.has(op));
    const connects = networks.length > 0;

    // Always prepare detections for UI (at least LTE detections if any)
    const detected = lteOperators.map(op => ({ radio: "LTE", operator: op }));

    // 2) If we didn’t qualify, fall back to FCC providers near point
    let reason;
    let presentOperators = lteOperators;
    let cellsCount = lteCells.length;
    let fccProviders = [];

    if (!connects) {
      // Ask FCC who is present here (like the site does)
      fccProviders = await fccProvidersNear(geo);

      if (lteOperators.length) {
        reason = `No FloLive EU2/US2 networks near ${geo.place}, but LTE towers were detected for: ${lteOperators.join(", ")}.`;
      } else if (fccProviders.length) {
        // Build readable summary from FCC
        const names = Array.from(new Set(fccProviders.map(p => p.name))).sort();
        reason = `No LTE towers found via OpenCelliD near ${geo.place}. FCC lists providers here: ${names.join(", ")}.`;
        presentOperators = names;
      } else {
        reason = `No LTE towers found via OpenCelliD near ${geo.place}, and FCC provider lookup returned none. Crowd data or FCC listing may be sparse here.`;
        presentOperators = [];
      }
    }

    res.status(200).json({
      connects,                 // TG3 can connect? (LTE + EU2/US2)
      networks,                 // EU2/US2 matches (LTE-only)
      reason,                   // explanation string
      presentOperators,         // LTE ops if LTE found; else FCC providers (names)
      detected,                 // LTE detections [{ radio, operator }]
      fccProviders,             // raw FCC provider list [{ name, radio? }]
      cellsCount,               // number of LTE cells inspected via OCID
      place: geo.place,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || "Lookup failed" });
  }
}
