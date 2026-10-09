# MTD CCR Dashboard — Two-Deploy Workflow

This guide covers your exact daily routine: one static dashboard app (deployed **once**), and a
daily exported HTML file (deployed **every day**).

| # | Deploy | Frequency | Contents | Purpose |
|---|--------|-----------|----------|---------|
| **1** | Dashboard app (`dist/`) | **Once** | Static UI only (HTML/JS/CSS/vendor) — **no data, no `Input/MTD_CCR.xlsx`** | You visit it each day, load the day's `.xlsx`, view, and **export** the standalone HTML |
| **2** | Exported HTML file | **Every day** | A single self-contained `.html` with that day's real data embedded | Shareable snapshot, deployed to Netlify each day |

---

## Deploy 1 — Dashboard app (one-time)

The app is a **static tool only**. It intentionally ships **without** `Input/MTD_CCR.xlsx` — you
load the data manually in the browser each day. This keeps the deployed app tiny (~6.5 MB) and
means you never need to redeploy the app when data changes.

### Build (once)

```powershell
cd G:\Selva\CCR_analysis
node netlify_build.cjs
```

Produces `dist/`:
- `dist/dashboard/` — all dashboard assets
- `dist/_redirects` (`/` → `/dashboard/`), `dist/_headers`
- **No `Input/MTD_CCR.xlsx`** — data is loaded by the user in the browser

> The build script now skips the data file by default. To embed data too (optional), run instead:
> ```powershell
> $env:EMBED_DATA="1"; node netlify_build.cjs
> ```
> (Not needed for your daily workflow.)

### Deploy (once)

**Drag & drop:** https://app.netlify.com/drop → drag the `dist` folder.

**or CLI:**
```powershell
npm install -g netlify-cli
netlify login
netlify deploy --dir dist --prod
```

**or Git CI:** `netlify.toml` sets `command = "node netlify_build.cjs"` + `publish = "dist"`, so a
push auto-deploys.

> Live at e.g. `https://dashboard-app.netlify.app` → `/` redirects to `/dashboard/`.

---

## Your daily flow (on the Deploy-1 app)

1. **Visit** `https://dashboard-app.netlify.app` (goes to `/dashboard/`).
2. The app finds **no** data/Input file, so it shows the **Choose .xlsx file…** loader.
3. **Click Load MTD Data → Choose .xlsx file…** and pick that day's `MTD_CCR.xlsx` from your
   machine. Data is read locally in the browser (never uploaded).
4. **View** the dashboard (Executive / Discipline / Productivity / Geography, filters, DSE
   profiles) computed from that day's real data.
5. Click **HTML** (top-right) to **export** the standalone file
   (e.g. `MTD_CCR_Dashboard_2026-09-03_2026-09-03.html`). This inlines all assets + the loaded data
   into one self-contained file.

> The app itself never needs redeploying — only Deploy 2 changes each day.

---

## Deploy 2 — Exported HTML (every day, separate site)

The exported file is a single static `.html` with everything embedded — **no build, no other
files**. Publish it to its **own** Netlify site (e.g. `https://daily-export.netlify.app`).

> **Fast-loading export:** since the last update, the exported HTML no longer embeds the raw
> (23.5 MB) workbook. Instead it embeds a **compact columnar + gzipped** representation of the
> parsed visits (dictionary-encoded strings, numeric columns). The export shrank from **37.8 MB to
> ~11.4 MB**, and it loads much faster because the browser skips re-parsing the workbook entirely
> (data is pre-parsed at export time).

### Option A — Netlify Drop (fastest, daily)

1. Save the exported `.html` from your browser.
2. Go to https://app.netlify.com/drop
3. Drag the `.html` file (or a folder containing it) onto the page.
4. It goes live instantly. If you drag a bare `.html`, it's served as the site root.

### Option B — Netlify CLI (repeatable daily)

```powershell
# one-time: create the export site
netlify sites:create --name <your-export-site>

# every day: put the exported .html in a folder (e.g. C:\export) and deploy
netlify deploy --dir C:\export --prod
```

### Option C — Drag into the existing export site (Netlify UI)

1. Open your export site in the Netlify Dashboard → **Deploys → Drag and drop**.
2. Drag the new exported `.html` onto the page and confirm.
3. `/` serves the latest daily snapshot.

> No `netlify.toml`, no `npm install` — Netlify serves the single static file as-is.

---

## One-time setup for Deploy 2 (do this once)

1. Home → **Add new site** → create a site named e.g. `daily-export` (or use Drag & drop once).
2. Note its URL: `https://daily-export.netlify.app`.
3. From then on, every day just drag the new `.html` onto **Deploys → Drag and drop** (or re-run
   the CLI deploy).

---

## Daily checklist

| Step | Action | Tool |
|------|--------|------|
| 1 | Visit Deploy-1 app | browser |
| 2 | Load MTD data (Choose .xlsx) | dashboard UI |
| 3 | Review the dashboard | dashboard UI |
| 4 | Export standalone HTML (**HTML** button) | dashboard UI |
| 5 | Deploy that `.html` to Deploy-2 site | netlify.com/drop / CLI / UI drag |
| 6 | Share the Deploy-2 URL ([daily-export].netlify.app) | — |

---

## Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| Deploy-1 shows no loader, only an error | Hard-refresh (Ctrl+F5). The app tries to fetch `Input/MTD_CCR.xlsx`, gets 404 (not shipped), then shows the file loader. |
| Deploy-1 "No data loaded" after loading | You didn't pick a file yet — use **Load MTD Data → Choose .xlsx file…**. |
| HTML button exports but file looks empty | Ensure data is loaded first (bottom-left shows source + row counts), then export. |
| Exported file blank on Deploy-2 | The upload folder root had no `.html` — put the `.html` at the upload root. |
| Deploy-2 shows old data | You deployed the old file — re-drag the newest `.html`. |
| Exported file still large (~11 MB) | Expected — assets (Plotly ~4.3 MB) + compact data (~4.8 MB) are inlined; still ~3x smaller than the old 37.8 MB export. |
| `netlify` command not found | `npm install -g netlify-cli`. |

---

## Key files

- `G:\Selva\CCR_analysis\netlify.toml` — Deploy-1 build/publish config.
- `G:\Selva\CCR_analysis\netlify_build.cjs` — Deploy-1 build (skips data by default; `EMBED_DATA=1`
  to include it).
- `G:\Selva\CCR_analysis\dashboard\build_single.cjs` — offline builder for the standalone export
  (same as the UI's HTML button).
- `G:\Selva\CCR_analysis\Input\MTD_CCR.xlsx` — your daily data source (loaded manually in the app).
- `G:\Selva\CCR_analysis\output\MTD_CCR_Dashboard.html` — the generated export file.
- `G:\Selva\CCR_analysis\dist\` — Deploy-1's generated site (one-time).
