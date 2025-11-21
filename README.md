
# TG3 Coverage Checker (ZIP → EU2/US2)

Minimal Next.js app. Enter a ZIP → server scrapes AntennaSearch → normalizes carrier names → compares to FloLive EU2/US2 → answers:
1) Will TG3 connect? (Y/N)
2) Which network(s)?
3) If not, why not?

## Run locally
```bash
npm i
npm run dev
# open http://localhost:3000
```

## Deploy (Vercel)
- Push this folder to a GitHub repo
- Import in vercel.com → "Deploy"
- No env vars needed
- Make sure the API route is enabled (pages/api/coverage.js)

## Notes
- Uses cheerio + undici to parse public HTML (no official API). Treat as best-effort.
- Update /data/floLive_US_EU2_US2.json when you get new FloLive drops (overwrite file, redeploy).
- Consider swapping AntennaSearch for FCC Broadband Map or carrier tiles for more robust data.
