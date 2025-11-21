
import { request } from 'undici';
import fs from 'node:fs';
import path from 'node:path';

// Load FloLive EU2/US2 operator list (already in your repo from earlier steps)
const FLOLIVE = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'floLive_US_EU2_US2.json'), 'utf-8')
);

// Load MCCMNC -> Operator mapping derived from your FloLive workbook (US & territories)
const MCCMNC_MAP = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'us_mccmnc_to_operator_from_floLive_Aug2025.json'), 'utf-8')
);

// Build allowed EU2/US2 operator set from your FloLive list
function buildAllowedSet() {
  const allowed = new Set();
  for (const row of FLOLIVE) {
    if (row.IMSI_Provider === 'EU 2' || row.IMSI_Provider === 'US 2') {
      const op = (row.Operator || '').trim();
      if (op) allowed.add(op);
    }
  }
  return allowed;
}

// 1) Geocode a ZIP using Zippopotam.us
async function geocodeZip(zip) {
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const { body, statusCode } = await request(url, { method: 'GET' });
  if (statusCode !== 200) throw new Error(`ZIP lookup failed (${statusCode})`);
  const json = await body.json();
  const p = json?.places?.[0];
  if (!p) throw new Error('ZIP not found');
  return {
    lat: parseFloat(p.latitude),
    lon: parseFloat(p.longitude),
    place: `${p['place name']}, ${p['state abbreviation']}`
  };
}

// 2) Query OpenCelliD in a small bounding box around ZIP centroid
async function queryOpenCellIdLTE({ lat, lon }) {
  const key = process.env.OPENCELLID_API_KEY;
  if (!key) throw new Error('Server missing OPENCELLID_API_KEY');

  // ~5km bbox (~0.045 deg). You can tweak this.
  const d = 0.045;
  const bbox = `${(lat - d).toFixed(6)},${(lon - d).toFixed(6)},${(lat + d).toFixed(6)},${(lon + d).toFixed(6)}`;

  const url = `https://www.opencellid.org/cell/getInArea?key=${encodeURIComponent(
    key
  )}&BBOX=${bbox}&radio=LTE&format=json`;

  const { body, statusCode } = await request(url, {
    method: 'GET',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'accept': 'application/json,text/html;q=0.9'
    }
  });

  if (statusCode >= 400) throw new Error(`OpenCelliD error: ${statusCode}`);
  const data = await body.json().catch(async () => {
    const txt = await body.text();
    throw new Error(`Unexpected OpenCelliD response: ${txt.slice(0, 200)}…`);
  });

  const cells = Array.isArray(data?.cells) ? data.cells : Array.isArray(data) ? data : [];
  return cells.filter(c => c && typeof c.mcc !== 'undefined' && typeof c.mnc !== 'undefined');
}

// 3) Map MCC+MNC to operator using your FloLive-derived mapping
function operatorFromMccMnc(mcc, mnc) {
  const key = String(mcc) + String(mnc).padStart(3, '0'); // zero-pad MNC to 3
  return MCCMNC_MAP[key];
}

export default async function handler(req, res) {
  try {
    const zip = String(req.query.zip || '').trim();
    if (!/^\d{5}(-\d{4})?$/.test(zip)) {
      res.status(400).json({ error: 'Please provide a valid US ZIP (5 digits).' });
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
    const matches = presentOperators.filter(op => allowed.has(op));
    const connects = matches.length > 0;

    let reason;
    if (!connects) {
      if (presentOperators.length) {
        reason = `ZIP ${zip} (${geo.place}) shows LTE cells for: ${presentOperators.join(', ')}, which are not in FloLive EU2/US2.`;
      } else {
        reason = `No LTE cells returned by OpenCelliD for ZIP ${zip} (${geo.place}).`;
      }
    }

    res.status(200).json({
      connects,
      networks: matches,
      reason,
      presentOperators,
      cellsCount: cells.length,
      place: geo.place
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || 'Lookup failed' });
  }
}
