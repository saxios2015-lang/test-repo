
import * as cheerio from 'cheerio';
import { request } from 'undici';
import fs from 'node:fs';
import path from 'node:path';

// Load FloLive mapping (US & territories subset) at runtime
const dataPath = path.join(process.cwd(), 'data', 'floLive_US_EU2_US2.json');
const FLOLIVE = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

// Normalize noisy owner strings into canonical carrier names
const NORMALIZE_MAP = {
  "at&t": "AT&T",
  "att": "AT&T",
  "at&t mobility": "AT&T",
  "new cingular": "AT&T",
  "t-mobile": "T-Mobile",
  "tmobile": "T-Mobile",
  "t-mobile usa": "T-Mobile",
  "verizon": "Verizon",
  "verizon wireless": "Verizon",
  "cellco": "Verizon",
  "u.s. cellular": "US Cellular",
  "us cellular": "US Cellular",
  "united states cellular": "US Cellular",
  "united states cellular corporation": "US Cellular",
  "liberty puerto rico": "Liberty Puerto Rico",
  "union wireless": "Union Wireless",
  "union telephone": "Union Wireless",
  "appalachian": "Appalachian",
  "carolina west": "Carolina West",
  "james valley": "James Valley",
  "nex-tech": "Nex-Tech",
  "nex tech": "Nex-Tech",
  "united wireless": "United Wireless",
  "viaero": "Viaero",
  "c-spire": "C-Spire",
  "c spire": "C-Spire",
  "the alaska wireless": "The Alaska Wireless"
};

function normalize(name) {
  const t = (name || '').toLowerCase();
  for (const key of Object.keys(NORMALIZE_MAP)) {
    if (t.includes(key)) return NORMALIZE_MAP[key];
  }
  return (name || '').trim();
}

function buildAllowedSet() {
  const allowed = new Set();
  for (const row of FLOLIVE) {
    if (row.IMSI_Provider === 'EU 2' || row.IMSI_Provider === 'US 2') {
      allowed.add(normalize(row.Operator));
    }
  }
  return allowed;
}

async function fetchTowerOwnersForZip(zip) {
  const url = `https://www.antennasearch.com/HTML/search/search.php?address=${encodeURIComponent(zip)}`;
  const { body, statusCode } = await request(url, { method: 'GET' });
  if (statusCode >= 400) throw new Error(`AntennaSearch error: ${statusCode}`);
  const html = await body.text();
  const $ = cheerio.load(html);

  const candidates = new Set();
  $("table td, table th, .resultTable td, .resultTable th").each((_, el) => {
    const txt = $(el).text().trim();
    if (!txt) return;
    const lower = txt.toLowerCase();
    if (/[a-z]/.test(lower) && txt.length <= 60) candidates.add(txt);
  });

  const HINTS = [
    "verizon","t-mobile","tmobile","at&t","cingular","cellco","us cellular",
    "liberty puerto rico","union","appalachian","carolina west","james valley",
    "nex-tech","viaero","c-spire","united wireless","alaska wireless"
  ];
  const owners = Array.from(candidates).filter((c) => {
    const lc = c.toLowerCase();
    return HINTS.some((h) => lc.includes(h));
  });

  return owners;
}

export default async function handler(req, res) {
  const zip = String(req.query.zip || '').trim();
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    res.status(400).json({ error: 'Please provide a valid US ZIP (5 digits).' });
    return;
  }

  const allowed = buildAllowedSet();
  const rawOwners = await fetchTowerOwnersForZip(zip).catch(e => {
    res.status(502).json({ error: e?.message || 'Lookup failed' });
    return null;
  });
  if (rawOwners == null) return;

  const normalized = rawOwners.map(normalize);
  const matches = normalized.filter(n => allowed.has(n));
  const uniqueMatches = Array.from(new Set(matches));
  const connects = uniqueMatches.length > 0;

  let reason;
  if (!connects) {
    const foundUnique = Array.from(new Set(normalized));
    reason = foundUnique.length
      ? `ZIP ${zip} shows towers for: ${foundUnique.join(', ')}, which are not in FloLive EU2/US2.`
      : `No recognizable carriers found for ZIP ${zip} from tower data.`;
  }

  res.status(200).json({
    connects,
    networks: uniqueMatches,
    reason,
    rawProviders: Array.from(new Set(rawOwners)),
  });
}
