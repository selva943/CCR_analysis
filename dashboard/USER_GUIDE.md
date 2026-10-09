# MTD CCR — DSE Performance Analytics · User Guide & Calculation Logics

A single-file, offline dashboard (`output/dashboard.html`) that analyses the MTD CCR call-logging
data (`Input/MTD_CCR.xlsx` — 85,071 rows, 80,055 valid) down to DSE level. It works by opening the
HTML directly in a browser (`file://`) — the workbook is embedded inside the file, so no server or
internet is needed. Everything is computed client-side in the browser.

> **Getting started:** open `G:\Selva\DGP_analysis\output\dashboard.html` in any modern browser
> (Chrome / Edge recommended). Data loads automatically. Use the **filters** (left) to narrow by
> date, branch, ZSM/ASM/ASO, **single DSE**, route, channel, on-route status, productivity,
> discipline class, or productivity range. Click **Reset** to clear all filters.

---

## 1. Navigation

| Tab | What it answers |
|---|---|
| **◧ Executive** | The whole team at a glance — KPIs, discipline & productivity trends, performance matrix, team scorecard, efficiency scatters, overall ranking. |
| **◈ Discipline** | Start-time / route / deviation discipline; daily discipline mix; distribution charts; per-DSE matrix & calendar (small teams). |
| **◉ Productivity** | Productivity %, call compliance, working-hours split, productivity quadrant, productivity ranking. |
| **◔ Store Time** | Store time by channel, channel time share, store-time distribution (box plot), store-efficiency scatter, channel table. |
| **✜ Geography** | Interactive Leaflet visit map with on-route / off-route / high-deviation layers; DSE movement sequence trace. |
| **⚠ Risk & Insights** | Risk radar, deterministic AI insights, management action table. |
| **◪ Data Quality** | Data-quality report — what was rejected and why (bad rows are never silently used). |

Click any **scatter bubble**, **calendar cell**, or **ranking row** to open a DSE profile modal
(daily movement map, per-visit log, CSV export of that DSE's visits).

---

## 2. Filters

Set in the left panel. All are **multi-select** (hold Ctrl / ⌘ to pick several) except the
single-value ones marked *. Filters combine with AND logic:

- **Date from / to** * — ISO `YYYY-MM-DD` inclusive bounds.
- **Branch, Branch location** — retail branch and location.
- **ZSM / ASM / ASO** — management hierarchy.
- **DSE** — pick one or more DSEs. Selecting a **single DSE** re-computes every metric and chart for
  that DSE alone (individual analysis), so the whole dashboard becomes that DSE's personal view.
- **Route, Channel, Sub-channel** — route name and channel category (SMALL / WS / LARGE /
  SELF SERVICE). *Speciality is excluded from the channel list and from store-time logic.*
- **On-route** * — All / On assigned route / Off route.
- **Productivity** * — All / Productive / Not productive.
- **Discipline class** * — All / Good / Moderate / Risk (post-classification filter on DSE list).
- **Min / Max productivity %** * — numeric range on the DSE-level productivity %.

**Reset** clears every filter control (and any open DSE selection), restores the full date range,
and re-renders.

---

## 3. Core metrics & their formulas

### 3.1 Data cleaning (applied on load)
Rows are dropped (and counted in the Quality tab) when any of the following is true — they are
**excluded from every KPI**, never silently included:

- Missing / unparseable **date**, **DSE**, start time or end time
- Negative duration (end < start)
- Invalid or out-of-bounds coordinates (lat/lon)
- Null or negative deviation
- On-route or productivity value unparsed (`UNKNOWN`)
- Duplicate rows (same DSE + date + retailer + start/end)

Duplicates are flagged additionally but kept if the primary key repeats (see Quality tab).

### 3.2 Daily aggregation (`buildDaily`)
Visits are grouped by **DSE + date** into a daily record:

- `start_pass` = `day_start_time ≤ startThreshold` (default **09:30**)
- `onRouteRate` = on-route `YES` ÷ visits with a known route
- `devRate` = deviation ≤ threshold (**100 m** default) ÷ visits with deviation
- `prodPct` = (on-route `YES` **and** productive `YES`) ÷ on-route `YES`
- `workingMin` = last visit end − first visit start (upper-capped at 18 h)
- `dayScore` = weighted discipline score for the day (see 3.3)

### 3.3 Discipline score (per DSE, 0–100)
```
Discipline = startWeight × start%  +  routeWeight × on-route%  +  devWeight × deviation%
```
Default weights (editable in Settings): **Start 40% · On-route 30% · Deviation 30%**.

Cut-offs: **GOOD ≥ 80**, **MODERATE 60–80**, **RISK < 60**.
*Strict compliant* = 100% on all three conditions on every worked day.

### 3.4 Productivity (%)
```
Productivity % =  (on_route = YES AND productivity = YES) ÷ (on_route = YES) × 100
```
Kept deliberately separate from *Call compliance*, *Productive calls* and *Total calls*.

### 3.5 Working hours & store time
- **Working hours** = first-visit start → last-visit end, per day (max 18 h), averaged over worked
  days. **7 h** threshold (420 min) is the default working-hours target.
- **Store time** = `end_time − start_time` per visit, per **DSE-day median** then across days.
  Outliers > 240 min are excluded from the box plot but noted in Quality.

### 3.6 Call compliance
`call_compliance = YES` ÷ visits with a call-compliance value (numeric ≥ 1 counts as YES). Default
target **80%**.

### 3.7 Risk score (per DSE)
Independent thresholds (Settings → list weights); a DSE accumulates points per failing condition:

| Flag | Weight | Trigger |
|---|---|---|
| Late Start | 20 | on-time start % < 75 |
| Off Route | 20 | on-route % < 90 |
| High Deviation | 20 | deviation-compliant % < 90 |
| Low Productivity | 20 | productivity < team median |
| Low Work Hours | 10 | avg working < 7 h |
| Low Call Compliance | 10 | call compliance < 80 |
| Excess Store Time | 10 | avg store time > 1.5 × team median |
| Low Order Value | 10 | avg order < 0.5 × team median |

Class: **LOW ≤ 20 · MODERATE 21–40 · HIGH 41–60 · CRITICAL 61+**.

### 3.8 Overall / ranking score
```
prodScore  = min(100, productivity% ÷ maxTeamProductivity × 100)
effScore   = min(100, prod-calls-per-store-hour ÷ team max × 100)
Overall    = 40% × Discipline + 35% × prodScore + 25% × effScore
```
Used to rank DSEs in the Executive overall table and calendar ordering.

---

## 4. Charts and what each shows

### ◧ Executive
- **Management summary** — team discipline %, productivity %, avg hours, on-route %, DSEs at risk,
  best performer, plus an automatically picked "most pressing concern".
- **KPI grids** — Total/Active/On-route/Off-route DSE, Good/Moderate/Risk discipline DSEs,
  productivity %, 7+ h vs <7 h share, intime / on-route / deviation compliance, calls, store time,
  working hours.
- **Discipline trend** *(line)* — daily team weighted discipline score.
- **Productivity trend** *(line)* — daily productive ÷ productive-call %.
- **DSE performance matrix** *(scatter)* — each bubble a DSE: start time (x) vs avg deviation (y),
  bubble size = call volume, colour = discipline class; threshold lines mark 09:30 and 100 m.
- **Discipline distribution** *(donut)* — Good / Moderate / Risk counts.
- **Team scorecard** *(horizontal bars)* — team benchmarks vs targets across the seven key metrics
  (green = meeting/passing target, amber = below).
- **Working hours vs productivity** and **Store time vs productivity** *(scatter)* — efficiency
  views; bubble size = order value / productive calls.
- **Overall ranking table** — sortable; click a row to open the DSE profile.

### ◈ Discipline
- **KPIs** — total DSE, overall/start/route/location discipline, Good/Moderate/Risk counts, strict
  compliant count.
- **Discipline trend** *(multi-line, daily/weekly)* — Start, On-route, Deviation, Discipline.
- **Start-time distribution** *(bar histogram)* — DSE-days by hour of start; red marker = threshold.
- **Deviation distribution** *(log-scale bar)* — visits by deviation bucket; marker at threshold.
- **Discipline matrix** *(scatter)* — start time vs deviation per DSE.
- **Daily discipline trend** *(area chart)* — Discipline **hit count** per day: max one hit per
  DSE-day. For each DSE-day only the **first store visit** (earliest Start Time) is checked; it
  scores a hit when it meets all conditions (On route = YES AND deviation ≤ 100 m AND start ≤ 09:30).
  Integer Y-axis; no percentage. The DSE table's Discipline % (= Hit Days ÷ Working Days × 100) and
  Good/Moderate/Risk classification use the same hit definition.

### ◉ Productivity
- **KPI** — productivity %, numerator/denominator, total calls, calls made, 7+ h / <7 h DSE counts,
  call compliance.
- **Productivity trend** *(line)* — daily productivity.
- **On-time vs late start** & **7+ h vs <7 h** *(grouped bars)* — productivity %, call compliance,
  avg hours per group.
- **Productivity vs working hours** *(scatter)* — bubble size = order value.
- **Productivity quadrant** *(scatter)* — split by 7 h and team-median productivity into Star /
  Efficient / Hard-worker / Risk; threshold lines and region labels.
- **Productivity ranking table** — sorted by productivity %; click to open a DSE.

### ◔ Store Time
- **Store time by channel** *(stacked bars, top-30 DSEs)* — toggle Hours / % / Visits / Avg min.
- **Channel time share** *(donut)* — where DSE store time goes (SMALL / WS / LARGE / SELF SERVICE).
- **Store time distribution** *(box plot)* — minutes per channel, outliers plotted.
- **Store time vs productivity** *(scatter)* — team-median marker; bubble = productive calls.
- **Channel performance table** and **store-efficiency ranking** (productive calls per store hour).

### ✜ Geography
- **Visit map** *(Leaflet)* — interactive; toggle On-route / Off-route / High-deviation layers with
  circle markers sized by call volume.
- **Selected DSE movement** — click a marker → draws a sequenced path for that DSE's chosen day
  (calls a DSE profile / movement trace).

### ⚠ Risk & Insights
- **Risk radar** *(radar)* — top-5 risk DSEs scored across the 8 risk components.
- **AI Insights** — deterministic rule output: summary, positives, risks, anomalies, opportunities,
  recommended actions.
- **Management action table** — DSE × issue × evidence × severity × recommended action, sorted by
  severity; click a row for the DSE profile.

### ◪ Data Quality
- Counts of every rejection class (duplicates, missing fields, invalid values, long visits) with
  pass/fail colouring, plus a **rejected-rows detail table** (top issues only) under the modal.

---

## 5. Settings / thresholds

In the **Settings** panel you can change (applies on *Apply*):

- **Start threshold** — punctuality cut-off (default `09:30`).
- **Deviation limit (m)** — location tolerance (default `100`).
- **Hours threshold** — working-hours target (default `7h`/420 min).
- **Weights** — discipline Start/Route/Deviation shares (40/30/30) and risk flag weights.

Changed thresholds re-compute discipline scores, risk, rankings and every affected chart.

---

## 6. Export

- **CSV** — exports the current DSE list (all KPIs + risk flags) to a `;`-free CSV.
- **DSE report** — inside a DSE profile: per-visit detail CSV for that DSE.
- **PDF** — use the print button → *Save as PDF*.

---

## 7. Rebuilding the single file (for distributors)

The standalone file is produced from the source dashboard folder:

```bash
node dashboard/build_single.cjs
```

This inlines every CSS/JS asset and embeds `Input/MTD_CCR.xlsx` (base64) into
`G:\Selva\DGP_analysis\output\dashboard.html`, so a fresh copy can be regenerated whenever the
source workbook changes.