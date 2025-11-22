import { request } from "undici";
import fs from "node:fs";
import path from "node:path";

// ---- Load FCC provider names from CSV ----
const fccProvidersCSV = fs.readFileSync(
  path.join(process.cwd(), "data", "fcc_providers.csv"),
  "utf-8"
);
const FCC_PROVIDERS = fccProvidersCSV
  .split("\n")
  .slice(1)
  .map((line) => line.split(",")[1]) // column 1 = provider name
  .filter(Boolean);

// ---- Load FloLive data ----
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

// ---- OpenCelliD LTE lookup ----
async function queryOpenCellIdLTE({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error("Missing OPENCELLID_API_KEY");

  const d = 0.008; // ~2 km half-side
  const bbox = `${(lat - d).toFixed(6)},${(lon - d).toFixed(6)},${(lat + d).toFixed(6)},${(lon + d).toFixed(6)}`;
  const url = `https://www.opencellid.org/cell/getInArea?key=${encodeURIComponent(
    key
  )}&BBOX=${bbox}&radio=LTE&format=json`;

  const { body, statusCode } = await request(url);
  if (statusCode >= 400) return [];
  const data = await body.json().catch(() => ({}));
  const cells = Array.isArray(data?.cells) ? data.cells : [];
  return cells.filter((c) => c && c.mcc && c.mnc);
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
    if (connects) {
      reason = `LTE towers for FloLive EU2/US2 networks found in ${geo.place}.`;
    } else {
      // Fallback: list all FCC providers for context
      reason = `No LTE towers on FloLive EU2/US2 networks in ${geo.place}. FCC lists these providers in the U.S.: ${FCC_PROVIDERS.slice(0, 15).join(", ")}...`;
    }

    res.status(200).json({
      connects,
      networks: matches,
      reason,
      presentOperators,
      place: geo.place,
      totalFCCProviders: FCC_PROVIDERS.length,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || "Lookup failed" });
  }
}
