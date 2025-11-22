import { request } from "undici";
import fs from "node:fs";
import path from "node:path";

/* ---------------------------
   CSV parsing + FCC providers
----------------------------*/

// Minimal CSV parser that handles quotes and commas-in-fields
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          // Escaped quote
          field += '"';
          i++;
        } else {
          // End of quoted field
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch === "\r") {
        // ignore \r (we'll catch \n)
      } else {
        field += ch;
      }
    }
  }
  // last field/row
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function findHeaderIndex(headers, patterns) {
  const lower = headers.map((h) => (h || "").toString().trim().toLowerCase());
  for (const p of patterns) {
    const idx = lower.findIndex((h) => h.includes(p));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Load and parse FCC provider CSV
const fccCSVText = fs.readFileSync(
  path.join(process.cwd(), "data", "fcc_providers.csv"),
  "utf-8"
);
const fccRows = parseCSV(fccCSVText);
const fccHeaders = fccRows.shift() || [];

// Try to detect provider name column by header
let nameIdx = findHeaderIndex(fccHeaders, [
  "provider name",
  "entity name",
  "name",
  "brand"
]);

// As a safety fallback, try to auto-pick a likely name column:
// prefer the first column that has at least one non-numeric value.
if (nameIdx === -1 && fccRows.length) {
  const numeric = (s) => /^[\d\s]+$/.test((s || "").toString().trim());
  for (let c = 0; c < fccHeaders.length; c++) {
    const sample = fccRows.find((r) => (r[c] || "").trim().length > 0)?.[c] || "";
    if (!numeric(sample)) {
      nameIdx = c;
      break;
    }
  }
  if (nameIdx === -1) nameIdx = 0; // absolute fallback
}

// Build a deduped list of names
const FCC_PROVIDERS = Array.from(
  new Set(
    fccRows
      .map((r) => (r[nameIdx] || "").toString().trim())
      .filter(Boolean)
  )
).sort((a, b) => a.localeCompare(b));

/* ---------------------------
   FloLive data + helpers
----------------------------*/

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

/* ---------------------------
   OpenCelliD LTE lookup (POC)
----------------------------*/

async function queryOpenCellIdLTE({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error("Missing OPENCELLID_API_KEY");

  const d = 0.008; // ~2 km half-side; small POC bbox
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

/* ---------------------------
   API handler
----------------------------*/

export default async function handler(req, res) {
  try {
    const zip = String(req.query.zip || "").trim();
    if (!/^\d{5}(-\d{4})?$/.test(zip)) {
      res.status(400).json({ error: "Please provide a valid US ZIP (5 digits)." });
      return;
    }

    const geo = await geocodeZip(zip);
    const cells = await queryOpenCellIdLTE(geo);

    const presentOps = new Set();
    for (const c of cells) {
      const op = operatorFromMccMnc(c.mcc, c.mnc);
      if (op) presentOps.add(op);
    }
    const presentOperators = Array.from(presentOps);

    const allowed = buildAllowedSet();
    const networks = presentOperators.filter((op) => allowed.has(op));
    const connects = networks.length > 0;

    let reason;
    if (connects) {
      reason = `LTE towers for FloLive EU2/US2 networks found in ${geo.place}.`;
    } else {
      // Show a human list (names, not numeric IDs)
      const sample = FCC_PROVIDERS.slice(0, 15).join(", ");
      reason = `No LTE towers on FloLive EU2/US2 networks in ${geo.place}. FCC provider catalog (sample): ${sample}...`;
    }

    res.status(200).json({
      connects,
      networks,               // EU2/US2 matches (by name)
      reason,                 // human explanation
      presentOperators,       // operators detected via OCID LTE (by name)
      place: geo.place,
      fccNameColumn: fccHeaders[nameIdx] || null,
      totalFCCProviders: FCC_PROVIDERS.length,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || "Lookup failed" });
  }
}
