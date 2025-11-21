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

// ---- OpenCelliD query (adaptive + fan-out) ----
async function queryOpenCellIdLTE({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error("Server missing OPENCELLID_API_KEY");

  const boxD = 0.008; // ~1.5–2 km half-side; under free limit
  const offsets = [
    [0, 0],
    [ boxD, 0], [-boxD, 0],
    [0,  boxD], [0, -boxD],
    [ boxD,  boxD], [ boxD, -boxD], [-boxD,  boxD], [-boxD, -boxD],
  ];

  async function fetchBox(centerLat, centerLon, dStart = boxD) {
    let d = dStart;
    const minD = 0.004;
    for (let i = 0; i < 6; i++) {
      const bbox = `${(centerLat - d).toFixed(6)},${(centerLon - d).toFixed(6)},${(centerLat + d).toFixed(6)},${(centerLon + d).toFixed(6)}`;
      const url = `https://www.opencellid.org/cell/getInArea?key=${encodeURIComponent(
        key
      )}&BBOX=${bbox}&radio=LTE&format=json`;
      const { body } = await request(url, { method: "GET" });
      const text = await body.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return [];
      }
      if (
        data?.error &&
        String(data.error).toLowerCase().includes("bbox too big")
      ) {
        d = Math.max(minD, d / 2);
        continue;
      }
      const cells = Array.isArray(data?.cells)
        ? data.cells
        : Array.isArray(data)
        ? data
        : [];
      return cells.filter(
        (c) => c && c.mcc !== undefined && c.mnc !== undefined
      );
    }
    return [];
  }

  const seen = new Set();
  const all = [];

  for (const [dy, dx] of offsets) {
    const cells = await fetchBox(lat + dy, lon + dx);
    for (const c of cells) {
      const cid = c.cid ?? c.cellid ?? "";
      const id = `${c.mcc}-${String(c.mnc).padStart(3, "0")}-${cid}`;
      if (!seen.has(id)) {
        seen.add(id);
        all.push(c);
      }
    }
    if (all.length >= 30) break;
  }

  return all;
}

// ---- API handler ----
export default async function handler(req, res) {
  try {
    const zip = String(req.query.zip || "").trim();
    if (!/^\d{5}(-\d{4})?$/.test(zip)) {
      res
        .status(400)
        .json({ error: "Please provide a valid US ZIP (5 digits)." });
      return;
    }

    const geo = await geocodeZip(zip);
    const cells = await queryOpenCellIdLTE(geo);

    const present = new Set();
    for (const c of cells) {
      const op = operatorFromMccMnc(c.mcc, c.mnc);
      if (op) present.add(op);
    }

    const presentOperators = Array.from(present);
    const allowed = buildAllowedSet();
    const matches = presentOperators.filter((op) => allowed.has(op));
    const connects = matches.length > 0;

    let reason;
    if (!connects) {
      if (presentOperators.length) {
        reason = `No FloLive EU2/US2 networks in ${zip} (${geo.place}), but LTE towers were detected for: ${presentOperators.join(
          ", "
        )}.`;
      } else {
        reason = `No LTE towers found near ${zip} (${geo.place}). Crowd data may be sparse in this area.`;
      }
    }

    res.status(200).json({
      connects,
      networks: matches,
      reason,
      presentOperators,
      cellsCount: cells.length,
      place: geo.place,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || "Lookup failed" });
  }
}
