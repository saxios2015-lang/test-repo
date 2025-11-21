import { request } from "undici";
import fs from "node:fs";
import path from "node:path";

// ---- Load your data ----
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

async function geocodeZip(zip) {
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const { body, statusCode } = await request(url, { method: "GET" });
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

// If we don’t have a friendly operator name, still surface the tower.
function labelOperator(mcc, mnc) {
  return operatorFromMccMnc(mcc, mnc) || `MCC${mcc}-MNC${String(mnc).padStart(3, "0")}`;
}

// ---- One OCID box (adaptive shrink if they say bbox too big) ----
async function fetchOpenCellIdBox({ lat, lon, radio, key, dStart = 0.008 }) {
  let d = dStart;               // ~1.5–2 km half-side per request (<= 4 km²)
  const minD = 0.004;           // ~0.8–1 km
  for (let i = 0; i < 6; i++) {
    const bbox = `${(lat - d).toFixed(6)},${(lon - d).toFixed(6)},${(lat + d).toFixed(6)},${(lon + d).toFixed(6)}`;
    const url = `https://www.opencellid.org/cell/getInArea?key=${encodeURIComponent(
      key
    )}&BBOX=${bbox}&radio=${encodeURIComponent(radio)}&format=json`;
    const { body } = await request(url, { method: "GET" });
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

// ---- Multi-ring fan-out (wider rural reach) for one radio ----
// Up to 8 rings (~0.064° ~= 7–8 km radius) around the ZIP centroid.
async function fanoutForRadio({ lat, lon, radio, key }) {
  const boxD = 0.008;
  const rings = 8;      // 0..8 rings (81 boxes max); rural-friendly
  const hardCap = 72;   // safety guard per radio

  function ringOffsets(r) {
    if (r === 0) return [[0, 0]];
    const vals = [-r, 0, r];
    const out = [];
    for (const dy of vals) for (const dx of vals) {
      if (dy === 0 && dx === 0) continue;
      out.push([dy * boxD, dx * boxD]);
    }
    return out;
  }

  const seen = new Set(); // dedupe by mcc-mnc-cid-radio
  const all = [];
  let calls = 0;

  for (let r = 0; r <= rings; r++) {
    for (const [dy, dx] of ringOffsets(r)) {
      if (calls >= hardCap) break;
      calls++;
      const cells = await fetchOpenCellIdBox({ lat: lat + dy, lon: lon + dx, radio, key, dStart: boxD });
      for (const c of cells) {
        const cid = c.cid ?? c.cellid ?? "";
        const id = `${c.mcc}-${String(c.mnc).padStart(3,"0")}-${cid}-${radio}`;
        if (!seen.has(id)) { seen.add(id); all.push(c); }
      }
      if (all.length >= 80) break;
    }
    if (calls >= hardCap || all.length >= 80) break;
  }
  return all;
}

// ---- High-level queries ----
async function queryLTE({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error("Server missing OPENCELLID_API_KEY");
  return fanoutForRadio({ lat, lon, radio: "LTE", key });
}

async function queryAnyRadios({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error("Server missing OPENCELLID_API_KEY");

  // Include both UMTS and WCDMA (some users label one or the other)
  const radios = ["NR", "LTE", "UMTS", "WCDMA", "GSM", "CDMA"];
  const all = [];
  for (const r of radios) {
    const cells = await fanoutForRadio({ lat, lon, radio: r, key });
    all.push(...cells);
  }
  return all;
}

// ---- API handler ----
export default async function handler(req, res) {
  try {
    const zip = String(req.query.zip || "").trim();
    if (!/^\d{5}(-\d{4})?$/.test(zip)) {
      res.status(400).json({ error: "Please provide a valid US ZIP (5 digits)." });
      return;
    }

    const geo = await geocodeZip(zip);

    // 1) LTE first (TG3 is LTE-only)
    const lteCells = await queryLTE(geo);
    const lteOpsSet = new Set();
    for (const c of lteCells) lteOpsSet.add(labelOperator(c.mcc, c.mnc));
    const lteOperators = Array.from(lteOpsSet);

    // EU2/US2 decision (LTE-only)
    const allowed = buildAllowedSet();
    const networks = lteOperators.filter(op => allowed.has(op));
    const connects = networks.length > 0;

    // Always build a structured detection list for UI: [{radio, operator}]
    const detected = [];
    for (const op of lteOperators) detected.push({ radio: "LTE", operator: op });

    let reason;
    let presentOperators = lteOperators; // default to LTE-only list
    let cellsCount = lteCells.length;

    if (!connects) {
      if (lteOperators.length > 0) {
        reason = `No FloLive EU2/US2 networks in ${zip} (${geo.place}), but LTE towers were detected for: ${lteOperators.join(", ")}.`;
      } else {
        // 2) No LTE at all → look for ANY radio and list providers with radio types
        const anyCells = await queryAnyRadios(geo);
        cellsCount = anyCells.length;

        const byRadio = new Map();  // radio -> Set(operators)
        const seenPairs = new Set();

        for (const c of anyCells) {
          const op = labelOperator(c.mcc, c.mnc); // never drop unknowns
          const r = (c.radio || "").toUpperCase();
          if (!r) continue;

          if (!byRadio.has(r)) byRadio.set(r, new Set());
          byRadio.get(r).add(op);

          const k = `${r}::${op}`;
          if (!seenPairs.has(k)) { seenPairs.add(k); detected.push({ radio: r, operator: op }); }
        }

        if (byRadio.size > 0) {
          const parts = [];
          for (const [r, ops] of byRadio.entries()) {
            parts.push(`${r}: ${Array.from(ops).join(", ")}`);
          }
          parts.sort();
          reason = `No LTE towers found near ${zip} (${geo.place}). Detected other towers: ${parts.join("; ")}.`;
          presentOperators = Array.from(new Set(detected.map(d => d.operator)));
        } else {
          reason = `No towers of any radio type found near ${zip} (${geo.place}). Crowd data may be sparse in this area.`;
          presentOperators = [];
        }
      }
    }

    res.status(200).json({
      connects,                 // TG3 can connect?
      networks,                 // EU2/US2 matches (LTE-only)
      reason,                   // explanation
      presentOperators,         // LTE ops if LTE exists; else union of all detected ops
      detected,                 // [{ radio, operator }] list for UI
      cellsCount,
      place: geo.place,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || "Lookup failed" });
  }
}
