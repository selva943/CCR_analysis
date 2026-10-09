(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});
  const M = NS.metrics;
  const C = NS.charts;
  const P = C.palette;

  const TILE_PROVIDERS = [
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attr: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
    { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors' }
  ];
  const MAP_TILES = { key: '' };
  function tileUrl(prov) {
    if (MAP_TILES.key && prov.keyParam) return prov.url + '?' + prov.keyParam + '=' + encodeURIComponent(MAP_TILES.key);
    return prov.url;
  }
  function tileLayerFor(state, map) {
    const providers = MAP_TILES.key
      ? [{ url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors &copy; CARTO', keyParam: 'key' }].concat(TILE_PROVIDERS)
      : TILE_PROVIDERS;
    const used = state.__tileIdx || 0;
    const prov = providers[used % providers.length];
    const layer = L.tileLayer(tileUrl(prov), { attribution: prov.attr, maxZoom: 18 });
    layer.on('tileerror', () => {
      state.__tileFails = (state.__tileFails || 0) + 1;
      if (state.__tileFails <= providers.length) {
        state.__tileIdx = (state.__tileIdx || 0) + 1;
        map.removeLayer(layer);
        map.addLayer(tileLayerFor(state, map));
      }
    });
    return layer;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function qs(id) { return document.getElementById(id); }

  function kpi(v, label, sub, opts) {
    opts = opts || {};
    const color = opts.color || P.mut;
    let spark = '';
    if (opts.spark && opts.spark.length) {
      spark = '<div class="k-spark" data-kpi-spark="' + (opts.sparkId || '') + '"></div>';
    }
    return '<div class="kpi" ' + (opts.id ? 'id="' + opts.id + '"' : '') + '>' +
      '<div class="k-label"><span class="k-dot" style="background:' + color + '"></span>' + esc(label) + '</div>' +
      '<div class="k-val" style="color:' + (opts.valColor || 'inherit') + '">' + v + '</div>' +
      (sub ? '<div class="k-sub">' + sub + '</div>' : '') + spark + '</div>';
  }

  function renderFilterOptions(state) {
    const f = state.filters;
    const base = state.hierarchyBase();
    function opts(id, items, labelFn, sel, multiple, valueFn) {
      const selName = qs(id);
      if (!selName) return;
      const current = new Set(sel || []);
      const isAll = current.size === 0;
      let html = '<option value="ALL"' + (isAll ? ' selected' : '') + '>All</option>';
      items.sort((a, b) => String(valueFn ? valueFn(a) : a).localeCompare(String(valueFn ? valueFn(b) : b)));
      for (const it of items) {
        const val = String(valueFn ? valueFn(it) : it);
        const lab = labelFn ? labelFn(it) : val;
        html += '<option value="' + esc(val) + '"' + (current.has(val) ? ' selected' : '') + '>' + esc(lab) + '</option>';
      }
      selName.innerHTML = html;
    }
    opts('fBranchLoc', base.branchLocs, null, f.branchLocs, true);
    opts('fZsm', base.zsms, null, f.zsms, true);
    opts('fAsm', base.asms, null, f.asms, true);
    opts('fAso', base.asos, null, f.asos, true);
    opts('fDse', base.dses, it => it.dse_name + ' (' + it.dse_code + ')', f.dseCodes, true, it => it.dse_code);
    opts('fChannel', base.channels, null, f.channels, true);
    qs('fDateFrom').value = f.dateFrom || '';
    qs('fDateTo').value = f.dateTo || '';
    qs('fOnRoute').value = f.onRoute;
    qs('filterCount').textContent = state.activeFilterCount();
  }

  function readFilters(state) {
    const f = state.filters;
    function vals(id) { const el = qs(id); return Array.from(el.selectedOptions || []).map(o => o.value).filter(v => v !== 'ALL'); }
    f.branchLocs = vals('fBranchLoc');
    f.zsms = vals('fZsm');
    f.asms = vals('fAsm');
    f.asos = vals('fAso');
    f.dseCodes = vals('fDse');
    f.channels = vals('fChannel');
    f.dateFrom = qs('fDateFrom').value || null;
    f.dateTo = qs('fDateTo').value || null;
    f.onRoute = qs('fOnRoute').value;
  }

  function renderManagementSummary(state) {
    const t = state.team, d = state.dseList, f = state.filters;
    if (!d.length) return;
    const bestOverall = [...d].sort((a, b) => b.overallScore - a.overallScore)[0];
    const bestProd = [...d].sort((a, b) => (b.productivityPct || 0) - (a.productivityPct || 0))[0];
    const atRisk = d.filter(s => s.riskClass === 'HIGH' || s.riskClass === 'CRITICAL').length;
    const mostImproved = mostImprovedDSE(d);
    const concern = majorConcern(d, t);
    qs('mgmtArea').innerHTML = `
      <div class="mgmt-items">
        <div class="mgmt-item"><div class="mi-k">Team discipline</div><div class="mi-v">${(t.disciplineAvg || 0).toFixed(1)}%</div></div>
        <div class="mgmt-item"><div class="mi-k">Productivity</div><div class="mi-v">${(t.productivityAvg || 0).toFixed(1)}%</div></div>
        <div class="mgmt-item"><div class="mi-k">Avg working hours</div><div class="mi-v">${M.fmtHM(t.avgWorkingMin)}</div></div>
        <div class="mgmt-item"><div class="mi-k">On-route compliance</div><div class="mi-v">${(t.onRouteAvg || 0).toFixed(1)}%</div></div>
        <div class="mgmt-item"><div class="mi-k">DSEs at risk</div><div class="mi-v" style="color:${atRisk ? P.red : P.green}">${atRisk}</div></div>
        <div class="mgmt-item"><div class="mi-k">Best performer</div><div class="mi-v"><span style="font-size:13px">${bestOverall ? esc(bestOverall.dse_name) : '–'}<br><small>Overall ${(bestOverall ? bestOverall.overallScore : 0).toFixed(0)}</small></span></div></div>
        <div class="mgmt-item"><div class="mi-k">Highest productivity</div><div class="mi-v"><span style="font-size:13px">${bestProd ? esc(bestProd.dse_name) : '–'} (${bestProd ? (bestProd.productivityPct || 0).toFixed(1) : 0}%)</span></div></div>
        <div class="mgmt-item"><div class="mi-k">Most improved</div><div class="mi-v"><span style="font-size:13px">${mostImproved ? esc(mostImproved.dse_name) : '–'}</span></div></div>
      </div>
      <div class="mgmt-col" style="grid-column:1/-1;margin-top:8px">
        <span class="chip ${concern.level}">Major concern: <b>${concern.text}</b></span>
        <span class="chip chip-mut">Period: <b>${f.dateFrom || 'start'} → ${f.dateTo || 'end'}</b></span>
      </div>`;
  }

  function mostImprovedDSE(dseList) {
    const withTrend = dseList.filter(s => s.days >= 6);
    if (!withTrend.length) return null;
    const sorted = withTrend.map(s => ({ s, v: (s.disciplineScore || 0) * 0.5 + (s.productivityPct || 0) * 0.5 })).sort((a, b) => b.v - a.v);
    return sorted.length ? sorted[0].s : null;
  }

  function majorConcern(dseList, t) {
    const lateCount = dseList.filter(s => s.startPct !== null && s.startPct < 50).length;
    const offRouteCount = dseList.filter(s => s.onRoutePct !== null && s.onRoutePct < 80).length;
    const riskCount = dseList.filter(s => s.riskClass === 'HIGH' || s.riskClass === 'CRITICAL').length;
    const total = dseList.length || 1;
    const candidates = [];
    if (lateCount / total > 0.15 || lateCount >= 8) candidates.push({ txt: lateCount + ' DSEs frequently start late', level: 'chip-risk', score: lateCount * 2 });
    if (offRouteCount / total > 0.12) candidates.push({ txt: offRouteCount + ' DSEs have poor on-route compliance', level: 'chip-warn', score: offRouteCount * 1.6 });
    if (riskCount) candidates.push({ txt: riskCount + ' DSEs flagged high/critical risk', level: 'chip-risk', score: riskCount * 2.4 });
    const lowHrs = dseList.filter(s => s.avgWorkingMin !== null && s.avgWorkingMin < 420).length;
    if (lowHrs / total > 0.15) candidates.push({ txt: lowHrs + ' DSEs work under 7 hours on average', level: 'chip-warn', score: lowHrs * 1.2 });
    if (!candidates.length) return { text: 'No pressing concern in the current view', level: 'chip-good' };
    candidates.sort((a, b) => b.score - a.score);
    return { text: candidates[0].txt, level: candidates[0].level };
  }

  function renderExec(state) {
    const section = qs('section-exec');
    const { dseList, team } = state;
    const n = dseList.length;
    const devLimit = M.DEFAULTS.devThreshold;

    let html = '<div class="kpi-grid">' +
      kpi(M.fmtNum(n), 'Total DSE', 'Distinct DSE codes in view') +
      kpi(M.fmtNum(team.ccrPlan), 'CCR Plan', 'Visits with on_route = YES', { color: P.blue }) +
      kpi(M.fmtNum(team.ccrCompliance), 'CCR Compliance', 'On route = YES and deviation ≤ ' + devLimit + 'm', { color: P.green }) +
      kpi(M.fmtPct(team.ccrCompliancePct), 'CCR Compliance %', 'CCR Compliance ÷ CCR Plan × 100', { color: team.ccrCompliancePct !== null && team.ccrCompliancePct >= 90 ? P.green : P.amber }) +
      kpi(M.fmtHM(team.avgWorkingMin), 'Avg Market Hours', 'Average of daily Max(End Time) − Min(Start Time) per DSE-day', { color: P.green }) +
      kpi(M.fmtTimeMin(team.avgStartMin), 'Avg Start', 'Average of daily Min(Start Time)', { color: P.blue }) +
      kpi(M.fmtTimeMin(team.avgEndMin), 'Avg End', 'Average of daily Max(End Time)', { color: P.blue }) +
      kpi(M.fmtHM(team.avgInTimeMin), 'Avg In-Time', 'Average of visit In_Time', { color: P.blue }) +
      '</div>';

    section.innerHTML = html;
  }

  function donut(state, id, data) {
    if (!data.some(d => d.value > 0)) { C.empty(document.getElementById(id), 'No data for the selected filters.'); return; }
    C.donut(id, data);
  }

  function execMatrix(state) {
    const el = document.getElementById('execMatrix');
    const pts = state.dseList.filter(s => s.days >= 1).map(s => ({
      name: s.dse_name, branch: s.branch_code, asm: s.asm, x: Math.floor(effStart(s, state)), y: s.avgDev === null ? 0 : s.avgDev,
      size: (s.visits || 0) / 2 + 6,
      color: s.disciplineClass === 'GOOD' ? P.green : s.disciplineClass === 'MODERATE' ? P.amber : P.red,
      sub1: 'Prod: ' + (s.productivityPct === null ? '–' : s.productivityPct.toFixed(0) + '%'),
      sub2: 'Score: ' + s.disciplineScore.toFixed(0)
    }));
    C.scatterQuadrant(el, pts, {
      xName: 'Start time', yName: 'Avg deviation (m)',
      markLines: [C.refLine(state.params.startThreshold, M.fmtTimeMin(state.params.startThreshold).replace(' ', ''), { color: P.red, dim: 'x' }), C.refLine(state.params.devThreshold, state.params.devThreshold + 'm', { color: P.red, dim: 'y' })],
      xMax: 12 * 60, yMax: state.dseList.length ? Math.max(500, Math.ceil(Math.max(...state.dseList.map(s => s.avgDev || 0)) / 100) * 100) : 500,
      xMin: 7 * 60
    });
    wireMatrixClick(el, state);
  }

  function effStart(s, state) {
    const days = state.dailyMap;
    const arr = [];
    for (const d of days.values()) if (d.dse_code === s.dse_code) arr.push(d.day_start_min);
    const valid = arr.filter(x => x !== null);
    return valid.length ? M.meanArr(valid) : (7 * 60);
  }

  function wireMatrixClick(el, state) {
    const inst = C.getEchart(el);
    const off = (val) => { const dsep = state.dseList.find(s => s.dse_name === val); if (dsep) state.selectDse(dsep.dse_code); };
    inst.on('click', p => { if (!p.data) return; const pt = Array.isArray(p.data) ? p.data[2] : p.data; off(pt && pt.name); });
  }

  function execWhProd(state) {
    const el = document.getElementById('execWhProd');
    const pts = state.dseList.filter(s => s.avgWorkingMin !== null).map(s => ({
      name: s.dse_name, branch: s.branch_code, asm: s.asm,
      x: Math.round(s.avgWorkingMin / 60 * 10) / 10, y: s.productivityPct === null ? 0 : s.productivityPct,
      size: (s.orderSum || 0) > 0 ? Math.min(40, 8 + Math.log10(s.orderSum || 1) * 3) : 8,
      color: s.disciplineClass === 'GOOD' ? P.green : s.disciplineClass === 'MODERATE' ? P.amber : P.red,
      sub1: 'Discipline ' + s.disciplineScore.toFixed(0), sub2: 'Risk: ' + s.riskClass
    }));
    C.scatterQuadrant(el, pts, {
      xName: 'Working hours', yName: 'Productivity %',
      markLines: [C.refLine(7, '7h', { color: P.amber, dim: 'x' })],
      xMin: 0, xMax: 16, yMin: 0, yMax: 100
    });
    wireMatrixClick(el, state);
  }

  function execStoreProd(state) {
    const el = document.getElementById('execStoreProd');
    const pts = state.dseList.filter(s => s.avgStoreMin !== null).map(s => ({
      name: s.dse_name, branch: s.branch_code, asm: s.asm,
      x: Math.round(s.avgStoreMin), y: s.productivityPct === null ? 0 : s.productivityPct,
      size: (s.prodCalls || 0) + 4,
      color: s.riskClass === 'LOW' ? P.green : s.riskClass === 'MODERATE' ? P.blue : P.amber,
      sub1: 'Calls: ' + s.visits, sub2: 'Avg ₹' + (s.avgOrder ? s.avgOrder.toFixed(0) : '–')
    }));
    const xmax = Math.max(240, Math.ceil(Math.max(...state.dseList.map(s => s.avgStoreMin || 0))));
    C.scatterQuadrant(el, pts, {
      xName: 'Avg store time (min)', yName: 'Productivity %', xMin: 0, xMax: xmax, yMin: 0, yMax: 100,
      markLines: [C.refLine(M.median(state.dseList.map(s => s.avgStoreMin)), 'team median', { color: P.amber, dim: 'x' })]
    });
    wireMatrixClick(el, state);
  }

  function sortedDates(dailyMap) {
    return [...new Set([...dailyMap.values()].map(d => d.date))].sort();
  }

  function renderRankingCard(state, title, metric, fmt, subtitle) {
    const sorted = [...state.dseList].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    let rows = '';
    sorted.slice(0, 40).forEach((s, idx) => {
      const cls = s.disciplineClass === 'GOOD' ? 'row-good' : s.disciplineClass === 'MODERATE' ? 'row-moderate' : 'row-risk';
      rows += `<tr class="clickable ${cls}" data-dse="${esc(s.dse_code)}">
        <td class="num">${idx + 1}</td>
        <td><b>${esc(s.dse_name)}</b><br><small style="color:var(--mut)">${esc(s.dse_code)}</small></td>
        <td>${esc(s.branch_code)}</td>
        <td>${esc(s.asm || '–')}</td>
        <td class="num">${s.days}</td>
        <td class="num">${M.fmtPct(s.startPct)}</td>
        <td class="num">${M.fmtPct(s.onRoutePct)}</td>
        <td class="num">${M.fmtPct(s.devPct)}</td>
        <td class="num"><b>${s.disciplineScore.toFixed(0)}</b></td>
        <td><span class="pill pill-${s.disciplineClass === 'GOOD' ? 'good' : s.disciplineClass === 'MODERATE' ? 'moderate' : 'risk'}">${s.disciplineClass}</span></td>
        <td class="num">${M.fmtPct(s.productivityPct)}</td>
        <td class="num">${M.fmtHM(s.avgWorkingMin)}</td>
        <td class="num">${M.fmtPct(s.hours7Pct)}</td>
        <td class="num">${M.fmtMin(s.avgStoreMin)}</td>
        <td class="num">${s.visits}</td>
        <td class="num">${M.fmtPct(s.callCompliancePct)}</td>
        <td class="num">${M.fmtMoney(s.orderSum)}</td>
        <td class="num"><b>${(s.overallScore || 0).toFixed(1)}</b></td>
      </tr>`;
    });
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>DSE ranking — ${esc(title)}</h3><span class="card-sub">${subtitle || 'Click a row to open the DSE profile'} · ${sorted.length} DSEs</span></div>
      <div class="card-b" style="padding:0">
        <div class="tbl-wrap tbl-sortable" data-title="${esc(title)}" data-metric="${metric}">
        <table class="data">
        <thead><tr>
          <th data-k="rank">#</th><th data-k="dse">DSE</th><th data-k="branch">Branch</th><th data-k="asm">ASM</th>
          <th data-k="days" class="num">Days</th><th data-k="startPct" class="num">Start%</th><th data-k="onRoutePct" class="num">OnRoute%</th><th data-k="devPct" class="num">Dev100%</th>
          <th data-k="disciplineScore" class="num">Disc.Score</th><th>Status</th><th data-k="productivityPct" class="num">Prod%</th>
          <th data-k="avgWorkingMin" class="num">WorkHrs</th><th data-k="hours7Pct" class="num">7h%</th><th data-k="avgStoreMin" class="num">StoreT</th>
          <th data-k="visits" class="num">Calls</th><th data-k="callCompliancePct" class="num">CallComp</th><th data-k="orderSum" class="num">Order ₹</th><th data-k="overallScore" class="num">Overall</th>
        </tr></thead>
        <tbody>${rows}</tbody></table></div>
      </div></div>`;
  }

  // ---------- Discipline module ----------
  function renderDiscipline(state) {
    const section = qs('section-discipline');
    const { dseList } = state;
    const n = dseList.length;
    const sum = state.discSummary || M.applyDiscipline(dseList, state.discipline);
    const devLimit = M.DEFAULTS.devThreshold;
    const startLim = M.fmtTimeMin(M.DEFAULTS.startThreshold);

    let html = '<div class="kpi-grid">' +
      kpi(M.fmtNum(sum.good) + ' <small>/ ' + M.fmtNum(n) + '</small>', 'Good DSE', 'Discipline % > 90%', { color: P.green }) +
      kpi(M.fmtNum(sum.moderate) + ' <small>/ ' + M.fmtNum(n) + '</small>', 'Moderate DSE', 'Discipline % 85–90%', { color: P.amber }) +
      kpi(M.fmtNum(sum.risk) + ' <small>/ ' + M.fmtNum(n) + '</small>', 'Risk DSE', 'Discipline % < 85%', { color: P.red }) +
      kpi(M.fmtPct(sum.pctGood), '% Good DSE', 'Good ÷ distinct DSE × 100', { color: P.green }) +
      kpi(M.fmtPct(sum.pctRisk), '% Risk DSE', 'Risk ÷ distinct DSE × 100', { color: P.red }) +
      '</div>';

    html += '<div class="legend-note" style="margin-bottom:14px"><b>Discipline eligibility:</b> <span class="chip chip-info">On route = YES</span> AND <span class="chip chip-info">Deviation ≤ ' + devLimit + 'm</span> AND <span class="chip chip-info">Start ≤ ' + startLim + '</span> · <b>1 hit per DSE-day</b>: only the day\'s first store visit (earliest Start Time) is checked · <b>Discipline %</b> = Hit Days ÷ Working Days × 100 · Status: <span class="pill pill-good">GOOD &gt; 90%</span> <span class="pill pill-moderate">MODERATE 85–90%</span> <span class="pill pill-risk">RISK &lt; 85%</span></div>';

    html += '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Daily Discipline Trend</h3><span class="card-sub">Discipline Hits per day — DSEs whose first store visit meets all conditions</span></div><div class="card-b"><div id="discTrendArea" class="chart-box h"></div></div></div>';

    html += renderDisciplineTable(state);

    section.innerHTML = html;

    renderDiscAreaChart(state);
    rowWire(section, '.tbl-sortable thead th', sortTable);
    rowWire(section, 'tr.clickable', (tr) => state.selectDse(tr.getAttribute('data-dse')));
  }

  function discStatusLabel(st) {
    return st === 'GOOD' ? 'Good' : st === 'MODERATE' ? 'Moderate' : st === 'RISK' ? 'Risk' : '–';
  }

  function renderDiscAreaChart(state) {
    const el = document.getElementById('discTrendArea');
    const disc = state.discipline;
    if (!disc || !disc.byDate.size) { C.empty(el); return; }
    const dates = [...disc.byDate.keys()].sort();
    const fmtDay = dt => { const x = new Date(dt + 'T00:00:00'); return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); };
    const rows = dates.map(dt => ({ date: dt, label: fmtDay(dt), hits: disc.byDate.get(dt).eligible }));
    const o = Object.assign({}, C.baseOption(), {
      tooltip: { ...C.baseOption().tooltip, trigger: 'axis', formatter: ps => {
        const r = rows[ps[0].dataIndex];
        if (!r) return '';
        return '<b>' + r.label + '</b><br/>Discipline Hits: <b>' + M.fmtNum(r.hits) + '</b>';
      } },
      grid: { left: 56, right: 24, top: 36, bottom: 40, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: rows.map(r => r.label), boundaryGap: false }, C.axisBase('category')),
      yAxis: Object.assign({}, C.axisBase('value'), { type: 'value', min: 0, minInterval: 1, name: 'Discipline Hits', nameTextStyle: { color: '#64748b', fontSize: 11, align: 'left' } }),
      series: [{
        name: 'Discipline Hits', type: 'line', data: rows.map(r => r.hits), smooth: true, symbol: 'circle', symbolSize: 6,
        connectNulls: true, lineStyle: { width: 2.5, color: P.blue }, itemStyle: { color: P.blue, borderColor: '#fff', borderWidth: 1 },
        areaStyle: { color: P.blue, opacity: 0.15 }
      }]
    });
    C.render(el, o);
  }

  function renderDisciplineTable(state) {
    const sorted = [...state.dseList].sort((a, b) => (a.discPct || 0) - (b.discPct || 0));
    let rows = '';
    sorted.forEach(s => {
      const st = s.discStatus;
      const cls = st === 'GOOD' ? 'row-good' : st === 'MODERATE' ? 'row-moderate' : 'row-risk';
      const pill = st === 'GOOD' ? 'pill-good' : st === 'MODERATE' ? 'pill-moderate' : 'pill-risk';
      const stRank = st === 'RISK' ? 0 : st === 'MODERATE' ? 1 : 2;
      rows += `<tr class="clickable ${cls}" data-dse="${esc(s.dse_code)}">
        <td><b>${esc(s.dse_name)}</b><br><small style="color:var(--mut)">${esc(s.dse_code)}</small></td>
        <td class="num">${s.days}</td>
        <td class="num" data-sort="${s.avgStartMin === null ? '' : s.avgStartMin}">${M.fmtTimeMin(s.avgStartMin)}</td>
        <td class="num" data-sort="${s.avgWorkingMin === null ? '' : s.avgWorkingMin}">${M.fmtHM(s.avgWorkingMin === null ? null : Math.round(s.avgWorkingMin))}</td>
        <td class="num">${s.eligibleCount}</td>
        <td class="num"><b>${s.discPct.toFixed(1)}%</b></td>
        <td data-sort="${stRank}"><span class="pill ${pill}">${discStatusLabel(st)}</span></td>
      </tr>`;
    });
    if (!sorted.length) rows = '<tr><td colspan="7"><div class="ec-empty"><div class="ec-empty-title">No DSEs in the current view</div></div></td></tr>';
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>DSE Discipline Table</h3><span class="card-sub">Sorted by Discipline % ascending — click a row to open the profile · ${sorted.length} DSEs</span></div>
      <div class="card-b" style="padding:0">
        <div class="tbl-wrap tbl-sortable" data-title="Discipline" data-metric="discPct">
        <table class="data">
        <thead><tr>
          <th data-k="dse">DSE</th>
          <th data-k="days" class="num">Working Days</th>
          <th data-k="avgStart" class="num">Avg Start</th>
          <th data-k="marketHrs" class="num">Avg Market Hours</th>
          <th data-k="eligible" class="num">Hit Days</th>
          <th data-k="discPct" class="num">Discipline %</th>
          <th data-k="status">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody></table></div>
      </div></div>`;
  }

  function renderDisciplineTrend(state, which, win) {
    const days = sortedDates(state.dailyMap);
    let labels, mapDays;
    if (win === 'week') {
      const weeks = {};
      for (const d of state.dailyMap.values()) { const w = isoweek(d.date); (weeks[w] = weeks[w] || []).push(d); }
      labels = Object.keys(weeks).sort(); mapDays = weeks;
    } else {
      labels = days; mapDays = {};
      for (const d of state.dailyMap.values()) (mapDays[d.date] = mapDays[d.date] || []).push(d);
    }
    function series(fn) {
      return labels.map(l => { const ds = mapDays[l]; const v = M.meanArr(ds.map(d => fn(d))); return [l, v === null ? null : Math.round(v * 10) / 10]; });
    }
    const o = Object.assign({}, C.baseOption(), {
      tooltip: { ...C.baseOption().tooltip, trigger: 'axis' },
      legend: { top: 0, textStyle: { color: '#475569', fontSize: 11 } },
      grid: { left: 50, right: 20, top: 34, bottom: 36, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: labels, boundaryGap: false }, C.axisBase('category')),
      yAxis: Object.assign({ type: 'value', min: 0, max: 100 }, C.axisBase('value')),
      series: [
        { name: 'Start', type: 'line', data: series(d => d.day_start_min !== null ? (d.start_pass ? 100 : 0) : null), smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { color: P.green, width: 2 }, itemStyle: { color: P.green }, connectNulls: true },
        { name: 'On Route', type: 'line', data: series(d => d.onRouteRate), smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { color: P.blue, width: 2 }, itemStyle: { color: P.blue }, connectNulls: true },
        { name: 'Deviation', type: 'line', data: series(d => d.devRate), smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { color: P.amber, width: 2 }, itemStyle: { color: P.amber }, connectNulls: true },
        { name: 'Discipline', type: 'line', data: series(d => d.dayScore), smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#8b5cf6', width: 2.5 }, itemStyle: { color: '#8b5cf6' }, connectNulls: true }
      ]
    });
    C.render(document.getElementById('discTrend'), o);
  }

  function isoweek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const d2 = new Date(d.getTime()); d2.setHours(0, 0, 0, 0); d2.setDate(d2.getDate() + 3 - ((d2.getDay() + 6) % 7));
    const wx = new Date(d2.getFullYear(), 0, 4); const week1 = new Date(wx.getFullYear(), 0, 4); week1.setDate(week1.getDate() - ((week1.getDay() + 6) % 7));
    const w = 1 + Math.round((d2 - week1) / (7 * 86400000));
    return d.getFullYear() + '-W' + String(w).padStart(2, '0');
  }

  function renderStartDist(state) {
    const values = [...state.dailyMap.values()].map(d => d.day_start_min).filter(x => x !== null);
    const el = document.getElementById('startDist');
    if (!values.length) { C.empty(el); return; }
    const th = state.params.startThreshold;
    const bins = [];
    for (let h = 0; h < 24; h++) bins.push({ from: h * 60, to: h * 60 + 59.999, n: 0 });
    for (const v of values) { if (v >= 0 && v < 1440) bins[Math.floor(v / 60)].n++; }
    const data = bins.map(b => b.n);
    const under = values.filter(v => v <= th).length / values.length * 100;
    const o = Object.assign({}, C.baseOption(), {
      tooltip: { ...C.baseOption().tooltip, trigger: 'axis', formatter: ps => { const b = bins[ps[0].dataIndex]; return '<b>' + Math.floor(b.from / 60) + ':00' + (Math.floor(b.from / 60) >= 12 ? ' PM' : ' AM') + '</b><br/>DSE-days: <b>' + b.n + '</b>'; } },
      grid: { left: 46, right: 16, top: 24, bottom: 36, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: bins.map((b, i) => (i === 0 ? '12a' : (i < 12 ? i + 'a' : (i - 12) + 'p'))) }, C.axisBase('category')),
      yAxis: Object.assign({ type: 'value' }, C.axisBase('value')),
      series: [{
        type: 'bar', data, barWidth: '80%', itemStyle: { color: p => p.dataIndex >= Math.floor(th / 60) ? P.amber : P.green, opacity: 0.9 },
        markLine: { symbol: 'none', label: { formatter: M.fmtTimeMin(th).replace(' ', ''), color: P.red, fontSize: 11, fontWeight: 700, position: 'end' }, lineStyle: { color: P.red, type: 'dashed', width: 1.5 }, data: [{ xAxis: Math.floor(th / 60) }] }
      }]
    });
    el.insertAdjacentHTML('afterbegin', '<div class="card-sub" style="margin-bottom:6px;color:var(--mut);font-size:11.5px">On-time starts <b style="color:' + (under >= 70 ? P.green : P.red) + '">' + under.toFixed(1) + '%</b></div>');
    C.render(el, o);
  }

  function renderDevDist(state) {
    const values = [...state.dailyMap.values()].map(d => d.avgDev).filter(x => x !== null);
    const el = document.getElementById('devDist');
    if (!values.length) { C.empty(el); return; }
    const th = state.params.devThreshold;
    const logVals = values.map(Math.log10).filter(v => isFinite(v) && v > -3);
    const binCount = Math.min(40, 10 + Math.floor(logVals.length / 500));
    const mn = Math.min(...logVals), mx = Math.max(...logVals), step = (mx - mn) / binCount || 1;
    const bins = new Array(binCount).fill(0);
    for (const v of logVals) { const i = Math.min(binCount - 1, Math.floor((v - mn) / step)); bins[i]++; }
    const labels = bins.map((_, i) => Math.pow(10, mn + i * step).toFixed(0));
    const thIdx = logVals.every(v => v < Math.log10(th)) ? binCount - 1 : logVals.findIndex(v => v >= Math.log10(th));
    const o = Object.assign({}, C.baseOption(), {
      tooltip: { ...C.baseOption().tooltip, trigger: 'axis', formatter: ps => { const b = bins[ps[0].dataIndex]; return '<b>' + labels[ps[0].dataIndex] + ' m</b><br/>Visits: <b>' + b + '</b>'; } },
      grid: { left: 46, right: 16, top: 24, bottom: 36, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: labels }, C.axisBase('category')),
      yAxis: Object.assign({ type: 'value' }, C.axisBase('value')),
      series: [{ type: 'bar', data: bins, barWidth: '80%', itemStyle: { color: p => p.dataIndex >= thIdx ? P.amber : P.green, opacity: 0.9 },
        markLine: { symbol: 'none', label: { formatter: th + 'm', color: P.red, fontSize: 11, fontWeight: 700, position: 'end' }, lineStyle: { color: P.red, type: 'dashed', width: 1.5 }, data: [{ xAxis: thIdx }] } }]
    });
    C.render(el, o);
  }

  function renderDiscMatrix(state) {
    const el = document.getElementById('discMatrix');
    const pts = state.dseList.filter(s => s.days >= 1).map(s => ({
      name: s.dse_name, branch: s.branch_code, asm: s.asm,
      x: Math.floor(effStart(s, state)), y: s.avgDev === null ? 0 : s.avgDev,
      size: (s.prodCalls || 0) + 4,
      color: s.disciplineClass === 'GOOD' ? P.green : s.disciplineClass === 'MODERATE' ? P.amber : P.red,
      sub1: 'Prod: ' + (s.productivityPct === null ? '–' : s.productivityPct.toFixed(0) + '%'),
      sub2: 'Score: ' + s.disciplineScore.toFixed(0) + ' · ' + s.riskClass
    }));
    C.scatterQuadrant(el, pts, {
      xName: 'Start time', yName: 'Deviation (m)',
      markLines: [C.refLine(state.params.startThreshold, M.fmtTimeMin(state.params.startThreshold).replace(' ', ''), { color: P.red, dim: 'x' }), C.refLine(state.params.devThreshold, state.params.devThreshold + 'm', { color: P.red, dim: 'y' })],
      xMin: 7 * 60, xMax: 12 * 60, yMax: Math.max(200, Math.ceil(Math.max(0, ...state.dseList.map(s => s.avgDev || 0)) / 100) * 100), yMin: 0
    });
    wireMatrixClick(el, state);
  }

  function renderCalendar(state) {
    const dates = sortedDates(state.dailyMap);
    const dseCodes = [...state.dseList].sort((a, b) => a.disciplineScore - b.disciplineScore).map(s => s.dse_code);
    const cols = dates.map(dt => new Date(dt + 'T00:00:00'));
    const top = [...state.dseList].slice().sort((a, b) => b.disciplineScore - a.disciplineScore).slice(0, 60).map(s => s.dse_code);
    const useCodes = dseCodes.length > 60 ? top : dseCodes;
    C.setDseMeta(Object.fromEntries(state.dseList.map(s => [s.dse_code, { short: s.dse_name.length > 12 ? s.dse_name.slice(0, 12) + '…' : s.dse_name }])));
    const heatmapMode = useCodes.length <= 25 && dates.length <= 62;
    C.buildCalendarHeatmap('discCalendar', state.dailyMap, useCodes, dates, d => {
      const w = d.dayScore >= 80 ? P.green : d.dayScore >= 60 ? P.amber : d.dayScore >= 0 && d.dayScore < 60 ? P.red : 'transparent';
      return '<b>' + esc(d.dse_name) + '</b> · ' + d.date +
        '<br/>Start: ' + (d.day_start_min === null ? '–' : M.fmtTimeMin(d.day_start_min)) +
        '<br/>On route: ' + (d.onRouteRate === null ? '–' : d.onRouteRate.toFixed(0) + '%') +
        '<br/>Deviation: ' + (d.devRate === null ? '–' : d.devRate.toFixed(0) + '%') +
        '<br/>Productivity: ' + (d.prodPct === null ? '–' : d.prodPct.toFixed(0) + '%') +
        '<br/>Score: <b style="color:' + w.replace('transparent', '#94a3b8') + '">' + d.dayScore.toFixed(0) + '</b>';
    });
    if (heatmapMode) wireCalendarClick(state.dailyMap, dates, useCodes, state);
  }

  function wireCalendarClick(dailyMap, dates, dseCodes, state) {
    const inst = C.getEchart(document.getElementById('discCalendar'));
    inst.off('click');
    inst.on('click', p => {
      if (p.data && p.data.value && p.value) {
        const dse = dseCodes[p.value[0]]; const date = dates[p.value[1]];
        state.selectDse(dse, date);
      }
    });
  }

  // ---------- Productivity module ----------
  function renderProductivity(state) {
    const section = qs('section-productivity');
    // Centralized calculation layer: every KPI/chart below reads this single pack,
    // so all components share the same filtered dataset and identical logic.
    const pack = M.computeProductivity(state.filteredVisits && state.filteredVisits.length ? state.filteredVisits : null, state.dailyMap, state.params);
    const zeroPct = v => (v === null || v === undefined || !isFinite(v)) ? '0%' : v.toFixed(1) + '%';
    const startLim = M.fmtTimeMin(pack.startThreshold).replace(' ', '');
    const hoursLim = String(Math.round((pack.hoursThreshold / 60) * 10) / 10);

    let html = '<div class="kpi-grid">' +
      kpi(zeroPct(pack.primaryPct), 'Productivity %', M.fmtNum(pack.onRouteProdYes) + ' of ' + M.fmtNum(pack.onRouteYes) + ' on-route calls productive', { color: P.blue }) +
      kpi(zeroPct(pack.onRouteProdPct), 'On Route Productivity %', M.fmtNum(pack.onRouteProdYes) + ' ÷ ' + M.fmtNum(pack.prodYes) + ' productive calls', { color: P.green }) +
      kpi(zeroPct(pack.offRouteProdPct), 'Off Route Productivity %', M.fmtNum(pack.offRouteProdYes) + ' ÷ ' + M.fmtNum(pack.prodYes) + ' productive calls', { color: P.amber }) +
      kpi(pack.avgMarketMin === null ? '–' : M.fmtHM(Math.round(pack.avgMarketMin)), 'Avg Market Hours', 'AVERAGE of daily MAX(End Time) − MIN(Start Time)', { color: P.green }) +
      '</div>';

    html += '<div class="legend-note" style="margin-bottom:14px">' +
      '<b>Productivity %</b> = <span class="chip chip-info">On Route = YES AND Productivity = YES</span> ÷ <span class="chip chip-mut">On Route = YES</span> × 100 · ' +
      '<b>On / Off Route Productivity %</b> share the denominator <span class="chip chip-mut">Productivity = YES</span> · ' +
      '<b>Start Time:</b> daily MIN(Start Time) ≤ ' + startLim + ' → On Time · ' +
      '<b>Market Hours:</b> MAX(End Time) − MIN(Start Time) per DSE-day, ≥ ' + hoursLim + 'h meets target</div>';

    html += '<div class="card-grid">' +
      '<div class="card"><div class="card-h"><h3>Start Time Performance</h3><span class="card-sub">Productivity % by daily MIN(Start Time) vs threshold</span></div><div class="card-b">' +
        '<div class="stat-row" style="margin-bottom:10px">' +
          '<span class="pill pill-good">On Time · ≤ ' + startLim + ' · ' + M.fmtNum(pack.startOnTime) + '</span>' +
          '<span class="pill pill-moderate">Late · &gt; ' + startLim + ' · ' + M.fmtNum(pack.startLate) + '</span>' +
        '</div>' +
        '<div id="prodStartTime" class="chart-box h"></div>' +
      '</div></div>' +
      '<div class="card"><div class="card-h"><h3>Avg Market Hours Performance</h3><span class="card-sub">Productivity % by daily market hours vs target</span></div><div class="card-b">' +
        '<div class="stat-row" style="margin-bottom:10px">' +
          '<span class="pill pill-good">Target met · ≥ ' + hoursLim + 'h · ' + M.fmtNum(pack.mhTargetMet) + '</span>' +
          '<span class="pill pill-moderate">Below target · &lt; ' + hoursLim + 'h · ' + M.fmtNum(pack.mhBelow) + '</span>' +
        '</div>' +
        '<div id="prodHoursSplit" class="chart-box h"></div>' +
      '</div></div>' +
      '</div>';

    html += '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>On-Route vs Off-Route Productivity</h3><span class="card-sub">Both share denominator: Productivity = YES (' + M.fmtNum(pack.prodYes) + ' calls)</span></div><div class="card-b" style="max-width:640px">' +
      compBar('On Route Productivity', pack.onRouteProdPct === null ? 0 : pack.onRouteProdPct, M.fmtNum(pack.onRouteProdYes) + ' productive on-route') +
      compBar('Off Route Productivity', pack.offRouteProdPct === null ? 0 : pack.offRouteProdPct, M.fmtNum(pack.offRouteProdYes) + ' productive off-route') +
      '</div></div>';

    section.innerHTML = html;

    renderProdStartChart(pack);
    renderProdHoursChart(pack);
  }

  function renderProdStartChart(pack) {
    const el = qs('prodStartTime');
    if (!el) return;
    if (!pack.startOnTime && !pack.startLate) { C.empty(el, 'No DSE-day has a valid Start Time in this view.'); return; }
    const lim = M.fmtTimeMin(pack.startThreshold).replace(' ', '');
    const data = [
      { name: 'On Time (≤ ' + lim + ')', value: pack.startOnTimePct, color: P.green, sub: M.fmtNum(pack.startOnTime) + ' DSE-days' },
      { name: 'Late (> ' + lim + ')', value: pack.startLatePct, color: P.amber, sub: M.fmtNum(pack.startLate) + ' DSE-days' }
    ];
    C.prodPctBars(el, data);
  }

  function renderProdHoursChart(pack) {
    const el = qs('prodHoursSplit');
    if (!el) return;
    if (!pack.mhTargetMet && !pack.mhBelow) { C.empty(el, 'No DSE-day has a valid Market Hours calculation in this view.'); return; }
    const hoursLim = Math.round((pack.hoursThreshold / 60) * 10) / 10;
    const data = [
      { name: '≥ ' + hoursLim + 'h (met)', value: pack.mhMetPct, color: P.green, sub: M.fmtNum(pack.mhTargetMet) + ' DSE-days' },
      { name: '< ' + hoursLim + 'h (below)', value: pack.mhBelowPct, color: P.amber, sub: M.fmtNum(pack.mhBelow) + ' DSE-days' }
    ];
    C.prodPctBars(el, data);
  }

  // ---------- Spend module ----------
  function renderSpend(state) {
    const section = qs('section-spend');
    const visits = state.filteredVisits;
    const valid = visits.filter(v => v.duration_min !== null && v.duration_min >= 0 && v.channel !== 'SPECIALITY');
    const channels = ['SMALL', 'WS', 'LARGE', 'SELF SERVICE'];
    const perChannel = channels.map(ch => {
      const rows = valid.filter(v => v.channel === ch);
      const totalStore = rows.reduce((a, v) => a + v.duration_min, 0);
      const prod = rows.filter(v => v.productivity === 'YES').length;
      const onr = rows.filter(v => v.on_route === 'YES').length;
      const prodOnRoute = rows.filter(v => v.productivity === 'YES' && v.on_route === 'YES').length;
      const orderVals = rows.map(v => v.order_value).filter(x => x !== null);
      return {
        ch, rows, n: rows.length, totalStore, prod,
        prodPct: M.pct(prodOnRoute, onr),
        avgStore: M.meanArr(rows.map(v => v.duration_min)),
        avgOrder: M.meanArr(orderVals),
        totalOrder: M.sumArr(orderVals),
        avgDev: M.meanArr(rows.map(v => v.deviation_m)),
        onRoutePct: M.pct(onr, rows.length)
      };
    });
    const totalStoreMin = valid.reduce((a, v) => a + v.duration_min, 0);

    let html = '<div class="kpi-grid">' +
      kpi(M.fmtMin(totalStoreMin), 'Total store time', 'Sum of visit durations (excl. Speciality)', { color: P.blue }) +
      kpi(M.fmtNum(valid.length), 'Visits analyzed', 'With valid start/end times') +
      kpi(M.fmtMin(M.median(valid.map(v => v.duration_min))), 'Median store time', 'Robust central value', { color: P.green }) +
      kpi(M.fmtNum(M.sumArr(perChannel.map(c => c.totalOrder))), 'Total order value', 'In analyzed visits', { color: P.amber }) +
      kpi(M.fmtNum(valid.filter(v => v.productivity === 'YES').length), 'Productive visits', 'Productivity = YES', { color: P.blue }) +
      '</div>';

    html += '<div class="card-grid">' +
      '<div class="card"><div class="card-h"><h3>Store time by channel</h3><span class="card-sub">Per DSE, stacked — <span class="seg" id="spendSeg"><button data-k="total" class="active">Hours</button><button data-k="pct">%</button><button data-k="count">Visits</button><button data-k="avg">Avg min</button></span></span></div><div class="card-b"><div id="spendStack" class="chart-box tall"></div></div></div>' +
      '<div class="card"><div class="card-h"><h3>Channel time share</h3><span class="card-sub">Where DSE store time goes</span></div><div class="card-b"><div id="spendDonut" class="chart-box h"></div></div></div>' +
      '</div>';

    html += '<div class="card-grid">' +
      '<div class="card"><div class="card-h"><h3>Store time distribution</h3><span class="card-sub">Box plot per channel (minutes)</span></div><div class="card-b"><div id="spendBox" class="chart-box h"></div></div></div>' +
      '<div class="card"><div class="card-h"><h3>Store time vs productivity</h3><span class="card-sub">Store efficiency view — bubble = productive calls</span></div><div class="card-b"><div id="spendScatter" class="chart-box h"></div></div></div>' +
      '</div>';

    html += renderChannelTable(perChannel);
    html += renderRankingCard(state, 'DSE store efficiency', 'effScore', M.fmtNum, 'Ranked by productive calls per store hour');
    section.innerHTML = html;

    renderSpendStack(state, 'total');
    renderSpendDonut(state, perChannel, totalStoreMin);
    renderSpendBox(state, perChannel);
    renderSpendScatter(state);
    section.querySelectorAll('#spendSeg button').forEach(b => b.addEventListener('click', () => {
      section.querySelectorAll('#spendSeg button').forEach(x => x.classList.remove('active')); b.classList.add('active');
      renderSpendStack(state, b.getAttribute('data-k'));
    }));
    rowWire(section, '.tbl-sortable thead th', sortTable);
    rowWire(section, 'tr.clickable', (tr) => state.selectDse(tr.getAttribute('data-dse')));
  }

  function renderSpendStack(state, mode) {
    const visits = state.filteredVisits;
    const byDse = new Map();
    for (const v of visits) {
      if (v.channel === 'SPECIALITY' || v.duration_min === null) continue;
      let d = byDse.get(v.dse_name);
      if (!d) { d = { name: v.dse_name, SMALL: 0, WS: 0, LARGE: 0, 'SELF SERVICE': 0, count: 0, perCount: { SMALL: 0, WS: 0, LARGE: 0, 'SELF SERVICE': 0 } }; byDse.set(v.dse_name, d); }
      d[v.channel] += v.duration_min;
      d.perCount[v.channel] += 1;
      d.count++;
    }
    const dseArr = [...byDse.values()].sort((a, b) => (a.SMALL + a.WS + a.LARGE + a['SELF SERVICE']) - (b.SMALL + b.WS + b.LARGE + b['SELF SERVICE'])).reverse().slice(0, 30);
    const cats = dseArr.map(d => d.name.length > 14 ? d.name.slice(0, 14) + '…' : d.name);
    let vals;
    if (mode === 'total') vals = d => d;
    else if (mode === 'pct') {
      vals = d => { const t = d.SMALL + d.WS + d.LARGE + d['SELF SERVICE']; return { SMALL: t ? d.SMALL / t * 100 : 0, WS: t ? d.WS / t * 100 : 0, LARGE: t ? d.LARGE / t * 100 : 0, 'SELF SERVICE': t ? d['SELF SERVICE'] / t * 100 : 0 }; };
    } else if (mode === 'count') {
      vals = d => d.perCount;
    } else {
      vals = d => ({ SMALL: d.perCount.SMALL ? d.SMALL / d.perCount.SMALL : 0, WS: d.perCount.WS ? d.WS / d.perCount.WS : 0, LARGE: d.perCount.LARGE ? d.LARGE / d.perCount.LARGE : 0, 'SELF SERVICE': d.perCount['SELF SERVICE'] ? d['SELF SERVICE'] / d.perCount['SELF SERVICE'] : 0 });
    }
    const chs = ['SMALL', 'WS', 'LARGE', 'SELF SERVICE'];
    C.stackedBar('spendStack', cats, chs.map(ch => ({ name: ch, data: dseArr.map(d => Math.round(vals(d)[ch] * 10) / 10), color: P.channel[ch] })), { rotate: 40, showTotal: mode !== 'pct' });
  }

  function renderSpendDonut(state, perChannel, totalStoreMin) {
    const data = perChannel.filter(c => c.n > 0).map(c => ({ name: c.ch, value: Math.round(c.totalStore / 60 * 10) / 10, itemStyle: { color: P.channel[c.ch] } }));
    donut(state, 'spendDonut', data);
  }

  function renderSpendBox(state, perChannel) {
    const el = document.getElementById('spendBox');
    const data = [], cats = [];
    for (const c of perChannel) {
      const rows = state.filteredVisits.filter(v => v.channel === c.ch && v.duration_min !== null && v.duration_min < 240).map(v => v.duration_min);
      data.push(rows.length ? rows : [0]); cats.push(c.ch + ' (n=' + rows.length + ')');
    }
    C.renderPlotly(el, [{ type: 'box', y: data, boxpoints: 'outliers', jitter: 0.2, pointpos: 0, marker: { color: '#94a3b8', size: 3, opacity: 0.4 }, line: { color: '#0f172a', width: 1 }, fillcolor: 'rgba(59,130,246,0.15)', name: '' }], {
      margin: { l: 45, r: 15, t: 15, b: 50 }, paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      xaxis: { tickfont: { size: 11, color: '#64748b' }, gridcolor: '#f1f5f9', linecolor: '#e2e8f0', zeroline: false },
      yaxis: { title: 'Minutes', titlefont: { size: 11, color: '#64748b' }, tickfont: { size: 11, color: '#64748b' }, gridcolor: '#f1f5f9', linecolor: '#e2e8f0', zeroline: false },
      hovermode: 'closest', showlegend: false
    });
  }

  function renderSpendScatter(state) {
    const el = document.getElementById('spendScatter');
    const pts = state.dseList.filter(s => s.avgStoreMin !== null && s.storeCount >= 3).map(s => ({
      name: s.dse_name, branch: s.branch_code, asm: s.asm, x: Math.round(s.avgStoreMin),
      y: s.productivityPct === null ? 0 : s.productivityPct, size: (s.prodCalls || 0) + 4,
      color: s.productivityPct === null ? P.mut : s.productivityPct >= 60 ? P.green : s.productivityPct >= 30 ? P.amber : P.red,
      sub1: 'Visits: ' + s.visits, sub2: 'Store hrs: ' + M.fmtHF(s.storeMin)
    }));
    const xmax = Math.max(120, Math.ceil(Math.max(...pts.map(p => p.x)) / 30) * 30);
    const bench = M.median(state.dseList.map(s => s.avgStoreMin).filter(x => x !== null));
    C.scatterQuadrant(el, pts, { xName: 'Avg store time (min)', yName: 'Productivity %', xMin: 0, xMax: xmax, yMin: 0, yMax: 100, markLines: [C.refLine(bench, 'team median', { color: P.amber, dim: 'x' })] });
    wireMatrixClick(el, state);
  }

  function renderChannelTable(perChannel) {
    let rows = '';
    perChannel.forEach(c => {
      rows += `<tr>
        <td><b>${c.ch}</b><br><small style="color:var(--mut)">${c.n} visits</small></td>
        <td class="num">${c.n}</td>
        <td class="num">${c.prod}</td>
        <td class="num">${M.fmtPct(c.prodPct)}</td>
        <td class="num">${M.fmtMin(c.avgStore)}</td>
        <td class="num">${M.fmtHF(c.totalStore / 60)}</td>
        <td class="num">${M.fmtMoney(c.avgOrder)}</td>
        <td class="num">${M.fmtMoney(c.totalOrder)}</td>
        <td class="num">${M.fmtMin(c.avgDev)}</td>
        <td class="num">${M.fmtPct(c.onRoutePct)}</td>
        <td class="num">${c.totalStore ? (c.totalOrder / (c.totalStore / 60)).toFixed(0) : '–'}</td>
      </tr>`;
    });
    return `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Channel performance</h3><span class="card-sub">Speciality excluded</span></div>
      <div class="card-b" style="padding:0"><div class="tbl-wrap">
      <table class="data"><thead><tr><th>Channel</th><th class="num">Visits</th><th class="num">Productive</th><th class="num">Prod%</th><th class="num">Avg store</th><th class="num">Total store</th><th class="num">Avg order</th><th class="num">Total order</th><th class="num">Avg dev</th><th class="num">On-route%</th><th class="num">₹/store-hr</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div></div>`;
  }

  // ---------- Geography ----------
  function geoFilterPoints(state) {
    const f = state.filters || {};
    return state.filteredVisits.filter(v => {
      if (v.latitude === null || v.longitude === null) return false;
      if (f.dateFrom && v.date < f.dateFrom) return false;
      if (f.dateTo && v.date > f.dateTo) return false;
      if (f.branchLocs && f.branchLocs.length && !f.branchLocs.includes(v.branch_location)) return false;
      if (f.zsms && f.zsms.length && !f.zsms.includes(v.zsm)) return false;
      if (f.asms && f.asms.length && !f.asms.includes(v.asm)) return false;
      if (f.asos && f.asos.length && !f.asos.includes(v.aso)) return false;
      if (f.dseCodes && f.dseCodes.length && !f.dseCodes.includes(v.dse_code)) return false;
      if (f.channels && f.channels.length && !f.channels.includes(v.channel)) return false;
      if (f.onRoute === 'YES' && v.on_route !== 'YES') return false;
      if (f.onRoute === 'NO' && v.on_route !== 'NO') return false;
      return true;
    });
  }

  function renderGeo(state) {
    const section = qs('section-geo');

    function loadBtnHtml() {
      return '<button id="geoLoadBtn" class="geo-load-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.3-7-11a7 7 0 1 1 14 0c0 4.7-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/></svg> Load map</button>';
    }

    function geoBodyHtml(state, c) {
      const kpiGrid = '<div class="kpi-grid">' +
        kpi(M.fmtNum(c.length), 'Geo-coded visits', 'Valid coordinates in current geo filter', { color: P.blue }) +
        kpi(M.fmtNum(new Set(c.map(v => v.dse_code)).size), 'DSEs mapped', 'DSEs with location', { color: P.blue }) +
        kpi(M.fmtNum(c.filter(v => v.on_route === 'YES').length), 'On-route points', '', { color: P.green }) +
        kpi(M.fmtNum(c.filter(v => v.on_route === 'NO').length), 'Off-route points', '', { color: P.amber }) +
        kpi(M.fmtNum(c.filter(v => v.deviation_m !== null && v.deviation_m > state.params.devThreshold).length), 'High deviation', '>' + state.params.devThreshold + 'm', { color: P.red }) +
        '</div>';
      const mapCard = state.geoLoaded
        ? '<div class="card"><div class="card-h"><h3>Visit map</h3><span class="card-sub"><div class="radio-row" id="geoLayers">' +
            '<label><input type="checkbox" checked data-layer="onroute"> On route</label>' +
            '<label><input type="checkbox" checked data-layer="offroute"> Off route</label>' +
            '<label><input type="checkbox" checked data-layer="highdev"> High deviation</label>' +
            '<label><input type="checkbox" checked data-layer="productive"> Productive</label>' +
            '</div></span>' + loadBtnHtml() + '</div><div class="card-b" style="padding:0"><div id="geoMap" class="map-box"></div></div></div>'
        : '<div class="card"><div class="card-h"><h3>Visit map</h3>' + loadBtnHtml() + '</div><div class="card-b"><div class="ec-empty"><div class="ec-empty-title">Map not loaded</div><div class="ec-empty-sub">Set filters with the <b>Filters</b> button, then click <b>Load map</b> to render ' + M.fmtNum(c.length) + ' geo-coded points for the selected scope.</div></div></div></div>';
      return kpiGrid + mapCard;
    }

    function drawMap(state, c) {
      if (state.__map) { try { state.__map.remove(); } catch (e) {} state.__map = undefined; state.__markers = undefined; }
      if (!state.geoLoaded) return;
      initGeoMap(state, 'geoMap', c, true);
      section.querySelectorAll('#geoLayers input').forEach(i => i.addEventListener('change', () => initGeoMap(state, 'geoMap', c, false)));
    }

    function wireLoadBtn() {
      const loadBtn = qs('geoLoadBtn');
      if (loadBtn) loadBtn.addEventListener('click', () => { state.geoLoaded = true; redrawBody(); });
    }

    const c0 = geoFilterPoints(state);
    section.innerHTML = '<div id="geoBody">' + geoBodyHtml(state, c0) + '</div>';

    if (state.geoLoaded) drawMap(state, c0);
    wireLoadBtn();

    const redrawBody = () => {
      const c = geoFilterPoints(state);
      qs('geoBody').innerHTML = geoBodyHtml(state, c);
      drawMap(state, c);
      wireLoadBtn();
    };
  }

  function initGeoMap(state, id, pts, first) {
    const el = document.getElementById(id);
    if (!el) return;
    const layers = {
      onroute: qs ? document.querySelector('#geoLayers input[data-layer=onroute]') : null,
      offroute: document.querySelector('#geoLayers input[data-layer=offroute]'),
      highdev: document.querySelector('#geoLayers input[data-layer=highdev]'),
      productive: document.querySelector('#geoLayers input[data-layer=productive]')
    };
    if (!state.__map) {
      if (typeof L === 'undefined') { el.innerHTML = '<div class="ec-empty"><div>Leaflet not loaded</div></div>'; return; }
      state.__map = L.map(id).setView([10.5, 78.0], 7);
      tileLayerFor(state, state.__map).addTo(state.__map);
    }
    const map = state.__map;
    if (!state.__markers) state.__markers = L.layerGroup().addTo(map);
    state.__markers.clearLayers();
    const showOn = layers.onroute ? layers.onroute.checked : true;
    const showOff = layers.offroute ? layers.offroute.checked : true;
    const showDev = layers.highdev ? layers.highdev.checked : true;
    const showProd = layers.productive ? layers.productive.checked : true;
    const bounds = [];
    for (const v of pts) {
      let ok = true, isOff = v.on_route === 'NO', isDev = v.deviation_m !== null && v.deviation_m > state.params.devThreshold, isProd = v.productivity === 'YES';
      if ((!showOn && !isOff) || (!showOff && isOff)) ok = false;
      if (showDev && isDev && !isOff) { ok = true; }
      if (isOff && !showOff && !showDev) ok = false;
      if (!showProd && isProd) ok = false;
      if (showProd && isProd && !showDev && !isOff) { ok = false; if (showOn) { ok = false; } }
      const markerColor = isDev ? P.red : isOff ? P.amber : isProd ? P.green : P.blue;
      const radius = isDev ? 9 : isOff ? 7 : 6;
      const circ = L.circleMarker([v.latitude, v.longitude], { radius, color: markerColor === P.green ? '#15803d' : markerColor === P.amber ? '#b45309' : markerColor === P.red ? '#b91c1c' : '#1d4ed8', weight: 1.5, fillColor: markerColor, fillOpacity: 0.6 }).addTo(state.__markers);
      circ.bindPopup(popupHtml(v));
      const sense = isOff ? 1 : isDev ? 2 : isProd ? 3 : 4;
      if (ok || (isOff && showOff)) { if (isOff && !showOff) circ.getElement().style.opacity = '0'; }
      bounds.push([v.latitude, v.longitude]);
    }
    if (bounds.length && first) map.fitBounds(bounds, { padding: [20, 20] });
    if (first) setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 80);
  }

  function popupHtml(v) {
    const t = (v.start_min !== null) ? M.fmtTimeMin(v.start_min) + '–' + M.fmtTimeMin(v.end_min) : '';
    return '<b>' + v.dse_name + '</b> · <span style="color:#94a3b8">' + v.date + '</span><br/>' +
      esc(v.retailer_name.length > 24 ? v.retailer_name.slice(0, 24) + '…' : v.retailer_name) + ' · ' + esc(v.channel_name || '') +
      (v.on_route === 'YES' ? ' · <span style="color:#16a34a">On route</span>' : ' · <span style="color:#f59e0b">Off route</span>') +
      (v.productivity === 'YES' ? ' · <span style="color:#3b82f6">Productive</span>' : '') +
      '<br/>Deviation: <b>' + (v.deviation_m === null ? '–' : Math.round(v.deviation_m) + 'm') + '</b>' +
      ' · Store: ' + (v.duration_min === null ? '–' : Math.round(v.duration_min) + 'm') +
      (v.order_value ? ' · ₹' + v.order_value.toLocaleString('en-IN') : '') +
      (t ? ' · ' + t : '');
  }

  function renderMovementMap(containerId, dse, day, state) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (typeof L === 'undefined') { el.innerHTML = '<div class="ec-empty"><div>Leaflet not loaded</div></div>'; return; }
    if (state.__profSeqMap) { try { state.__profSeqMap.remove(); } catch (e) {} state.__profSeqMap = null; }
    const rows = state.filteredVisits.filter(v => v.dse_code === dse.dse_code && v.date === day && v.latitude !== null && v.longitude !== null).sort((a, b) => (a.start_min || 0) - (b.start_min || 0));
    if (!rows.length) {
      el.innerHTML = '<div class="ec-empty"><div>No geo data for ' + esc(dse.dse_name) + ' on ' + day + '</div></div>';
      return;
    }
    const map = L.map(el).setView([10.5, 78], 7);
    tileLayerFor(state, map).addTo(map);
    const layer = L.layerGroup().addTo(map);
    const path = rows.map(v => [v.latitude, v.longitude]);
    L.polyline(path, { color: '#3b82f6', weight: 3, opacity: 0.7 }).addTo(layer);
    rows.forEach((v, i) => {
      const markerColor = i === 0 ? '#16a34a' : i === rows.length - 1 ? '#ef4444' : '#3b82f6';
      L.circleMarker([v.latitude, v.longitude], { radius: i === 0 || i === rows.length - 1 ? 8 : 6, color: '#fff', weight: 2, fillColor: markerColor, fillOpacity: 0.9 }).addTo(layer).bindPopup(popupHtml(v));
    });
    map.fitBounds(L.latLngBounds(path), { padding: [30, 30] });
    state.__profSeqMap = map;
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 80);
  }

  // ---------- Risk & insights ----------
  const DR_CHAIN = ['zsm', 'asm', 'aso', 'dse'];
  const DR_LABEL = { zsm: 'ZSM', asm: 'ASM', aso: 'ASO', dse: 'DSE' };

  function renderRisk(state) {
    const section = qs('section-risk');
    const scope = buildScope(state);
    const { dseList, team } = scope;
    const high = dseList.filter(s => s.riskClass === 'HIGH');
    const critical = dseList.filter(s => s.riskClass === 'CRITICAL');
    const low = dseList.filter(s => s.riskClass === 'LOW');
    const moderate = dseList.filter(s => s.riskClass === 'MODERATE');
    let html = '<div class="kpi-grid">' +
      kpi(dseList.length, 'DSEs assessed', 'In current view') +
      kpi(low.length, 'Low risk', 'Risk score ≤ 20', { color: P.green }) +
      kpi(moderate.length, 'Moderate risk', '21–40', { color: P.blue }) +
      kpi(high.length, 'High risk', '41–60', { color: P.amber }) +
      kpi(critical.length, 'Critical risk', '61+', { color: P.red }) +
      '</div>';

    html += '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Risk radar</h3><span class="card-sub">Score components — ' +
      Object.entries(state.params.riskWeights).map(([k, v]) => k.replace(/([A-Z])/g, ' $1').replace(/^./, x => x.toUpperCase()) + ' +' + v).join(', ') + '</span></div><div class="card-b"><div id="riskRadar" class="chart-box h"></div></div></div>';

    html += renderDrillPanel(state, scope);
    html += renderExecutiveInsights(state, scope);
    html += renderActionTable(scope.dseList);
    section.innerHTML = html;
    renderRiskRadar(scope);
    wireInsightDrilldown(section, state);
    wireDrillPanel(section, state);
    rowWire(section, '.tbl-sortable thead th', sortTable);
    rowWire(section, 'tr.clickable', (tr) => state.selectDse(tr.getAttribute('data-dse')));
  }

  function renderRiskRadar(state) {
    const el = document.getElementById('riskRadar');
    if (!state.dseList.length) { C.empty(el); return; }
    const team = state.team || {};
    const top = [...state.dseList].sort((a, b) => b.riskScore - a.riskScore).slice(0, 5);
    const ind = [
      { name: 'Late\nstart', max: 40 }, { name: 'Off\nroute', max: 40 }, { name: 'High\ndeviation', max: 40 },
      { name: 'Low\nproductivity', max: 40 }, { name: '<7 hrs', max: 40 }, { name: 'Low\ncall comp', max: 40 },
      { name: 'Excess\nstore', max: 40 }, { name: 'Low\norder', max: 40 }];
    const vals = s => [
      (s.startPct !== null && s.startPct < 75) ? 40 : 0,
      (s.onRoutePct !== null && s.onRoutePct < 90) ? 40 : 0,
      (s.devPct !== null && s.devPct < 90) ? 40 : 0,
      (s.productivityPct !== null && team.medianProductivity !== null && s.productivityPct < team.medianProductivity) ? 40 : 0,
      (s.avgWorkingMin !== null && s.avgWorkingMin < 420) ? 20 : 0,
      (s.callCompliancePct !== null && s.callCompliancePct < 80) ? 20 : 0,
      (s.avgStoreMin !== null && team.medianStoreMin !== null && s.avgStoreMin > team.medianStoreMin * 1.5) ? 20 : 0,
      (s.avgOrder !== null && team.medianOrder !== null && s.avgOrder < team.medianOrder * 0.5) ? 20 : 0];
    const cols = [P.red, P.amber, '#8b5cf6', P.blue, '#06b6d4'];
    C.radarChart(el, ind, top.map((s, i) => ({ name: s.dse_name.length > 14 ? s.dse_name.slice(0, 14) + '…' : s.dse_name, value: vals(s), color: cols[i] })));
    const inst = C.getEchart(el);
    inst.on('click', p => { if (p.name) { const d = state.dseList.find(s => s.dse_name === p.name || s.dse_name.startsWith(p.name)); if (d) state.selectDse(d.dse_code); } });
  }

  function getEngineResult(state, scope) {
    const isScoped = scope && scope !== state;
    const key = isScoped ? drillKey(state) : '';
    if (isScoped) {
      const cache = state._drillEngineCache || (state._drillEngineCache = {});
      if (cache[key]) return cache[key];
      if (!NS.insightEngine || !NS.insightEngine.run) return null;
      const engineResult = NS.insightEngine.run(scope);
      engineResult.recommendations = NS.recommendations.generate(scope, engineResult);
      scope._engineResult = engineResult;
      cache[key] = engineResult;
      return engineResult;
    }
    if (state.engineResult) return state.engineResult;
    if (!NS.insightEngine || !NS.insightEngine.run) return null;
    const engineResult = NS.insightEngine.run(state);
    engineResult.recommendations = NS.recommendations.generate(state, engineResult);
    state.engineResult = engineResult;
    return engineResult;
  }

  function renderExecutiveInsights(state, scope) {
    const engine = getEngineResult(state, scope);
    if (!engine) return insightsBlock(scope);

    const breaks = engine.breaks || [];
    const rec = engine.recommendations || { bestPractices: [], opportunities: [], actions: [] };

    let html = '<div class="ec-insights">';

    // 1. NEEDS ATTENTION — the main problems first
    let flagged = breaks.filter(b => b.severity === 'CRITICAL' || b.severity === 'HIGH' || b.priorityScore >= 250).slice(0, 4);
    if (!flagged.length) flagged = breaks.slice(0, 4);
    if (flagged.length) {
      html += '<div class="ec-sec"><div class="ec-sec-h"><h3>Needs attention</h3><span class="card-sub">The main problems in this view</span></div>';
      html += '<div class="ec-breaks">' + flagged.map(b => insightCardHTML(b)).join('') + '</div></div>';
    }

    // 2. WAYS TO IMPROVE — opportunities + strengths combined
    const improve = (rec.opportunities || []).concat(rec.bestPractices || []);
    if (improve.length) {
      html += '<div class="ec-sec"><div class="ec-sec-h"><h3>Ways to improve</h3><span class="card-sub">Gains the team can still make</span></div>';
      html += '<div class="ec-breaks">' + improve.slice(0, 6).map(b => insightCardHTML(b)).join('') + '</div></div>';
    }

    // 3. RECOMMENDED NEXT STEPS
    if (rec.actions.length) {
      html += '<div class="ec-sec"><div class="ec-sec-h"><h3>Recommended next steps</h3><span class="card-sub">What to do after this review</span></div>';
      html += '<div class="ec-breaks">' + rec.actions.slice(0, 4).map(b => insightCardHTML(b)).join('') + '</div></div>';
    }

    // 4. WHO NEEDS SUPPORT
    html += renderDseDiagnostics(scope);

    // 5. FULL DETAIL — raw findings, kept out of the way
    html += evidenceBlock(scope);

    html += '</div>';
    return html;
  }

  // ---------- Hierarchy drill-down (Risk & Insights) ----------
  function drillKey(state) {
    const d = state.drill || {};
    return (d.zsm || '') + '|' + (d.asm || '') + '|' + (d.aso || '');
  }

  function buildScope(state) {
    const d = state.drill || {};
    if ((!d.zsm || d.zsm === '') && (!d.asm || d.asm === '') && (!d.aso || d.aso === '')) return state;
    const matched = state.dseList.filter(s =>
      (!d.zsm || s.zsm === d.zsm) &&
      (!d.asm || s.asm === d.asm) &&
      (!d.aso || s.aso === d.aso));
    if (!matched.length) return state;
    const codes = new Set(matched.map(s => s.dse_code));
    const dseList = matched.map(s => Object.assign({}, s));
    const filteredVisits = state.filteredVisits.filter(v => codes.has(v.dse_code));
    const dailyMap = new Map([...state.dailyMap].filter(([, dd]) => codes.has(dd.dse_code)));
    const team = M.computeBenchmarks(dseList, filteredVisits && filteredVisits.length ? filteredVisits : null, dailyMap);
    M.computeRisk(dseList, team);
    M.computeRanking(dseList, team);
    return Object.assign({}, state, { dseList, filteredVisits, dailyMap, team });
  }

  function renderDrillPanel(state, scope) {
    const d = state.drill || {};
    const path = [];
    if (d.zsm) path.push({ level: 'zsm', name: d.zsm });
    if (d.asm) path.push({ level: 'asm', name: d.asm });
    if (d.aso) path.push({ level: 'aso', name: d.aso });
    const depth = path.length;
    const childLevel = DR_CHAIN[depth];
    const levelLabel = childLevel ? DR_LABEL[childLevel] : 'DSE';
    const scopeName = depth ? path[depth - 1].name : 'Overall';
    const h = NS.insightEngine ? NS.insightEngine.aggregateHierarchy(scope.dseList) : null;

    let crumb = '<button type="button" class="drl-crumb' + (depth === 0 ? ' active' : '') + '" data-zsm="" data-asm="" data-aso="" title="Up to Overall">Overall</button>';
    if (depth) crumb += '<span class="drl-sep">›</span>';
    path.forEach((p, i) => {
      let attrs = '';
      if (p.level === 'zsm') attrs = ' data-zsm="' + esc(p.name) + '" data-asm="" data-aso=""';
      else if (p.level === 'asm') attrs = ' data-zsm="' + esc(d.zsm) + '" data-asm="' + esc(p.name) + '" data-aso=""';
      else attrs = ' data-zsm="' + esc(d.zsm) + '" data-asm="' + esc(d.asm) + '" data-aso="' + esc(p.name) + '"';
      crumb += (i ? '<span class="drl-sep">›</span>' : '') + '<button type="button" class="drl-crumb' + (i === depth - 1 ? ' active' : '') + '"' + attrs + '>' + esc(p.name) + '</button>';
    });

    let cards = '';
    if (childLevel === 'dse') {
      const list = [...scope.dseList].sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
      cards = list.map(dseCardHtml).join('');
    } else if (h) {
      const map = childLevel === 'zsm' ? h.zsms : childLevel === 'asm' ? h.asms : childLevel === 'aso' ? h.asos : {};
      const entries = Object.entries(map).filter(([k, g]) => k !== '(blank)' && (g.dseCount || 0) > 0);
      entries.sort((a, b) => (b[1].dseCount || 0) - (a[1].dseCount || 0));
      cards = entries.map(([name, g]) => groupCardHtml(d, childLevel, name, g)).join('');
    }

    const hint = childLevel === 'dse'
      ? 'Click a DSE to open the full profile'
      : 'Click a card to drill one level deeper — right down to individual DSEs';
    return '<div class="drl-root">' +
      '<div class="drl-head"><h3>Drill down</h3>' +
      '<span class="card-sub">' + esc(scopeName) + ' · ' + scope.dseList.length + ' DSEs · ' + M.fmtNum(scope.filteredVisits.length) + ' visits</span></div>' +
      '<div class="drl-crumbs">' + crumb + '<span class="drl-crumb-lbl">Viewing ' + levelLabel + 's</span></div>' +
      (cards ? '<div class="drl-cards">' + cards + '</div>' : '<div class="ec-empty" style="padding:14px"><div>No ' + levelLabel.toLowerCase() + ' entities to show at this level</div></div>') +
      '<div class="drl-sub">' + hint + '</div>' +
      '</div>';
  }

  function groupCardHtml(d, level, name, g) {
    const patch = { zsm: null, asm: null, aso: null };
    if (level === 'zsm') patch.zsm = name;
    else if (level === 'asm') { patch.zsm = d.zsm || null; patch.asm = name; }
    else if (level === 'aso') { patch.zsm = d.zsm || null; patch.asm = d.asm || null; patch.aso = name; }
    let attrs = '';
    for (const k of ['zsm', 'asm', 'aso']) if (patch[k]) attrs += ' data-' + k + '="' + esc(patch[k]) + '"';
    const concern = grpConcern(g);
    const riskCount = g.dses.filter(s => s.riskClass === 'HIGH' || s.riskClass === 'CRITICAL').length;
    return '<div class="drl-card"' + attrs + '>' +
      '<div class="drl-name">' + esc(name) + '<small>' + g.dseCount + ' DSE' + (g.dseCount === 1 ? '' : 's') + ' · ' + M.fmtNum(g.visits) + ' visits · ' + M.fmtHM(g.avgWorkingMin) + ' avg</small></div>' +
      '<div class="drl-kpis">' + drlKpi('Prod', M.fmtPct(g.productivity)) + drlKpi('Disc', g.discipline === null ? '–' : g.discipline.toFixed(1)) + drlKpi('Route', M.fmtPct(g.onRoutePct)) + '</div>' +
      '<div class="drl-duty"><span class="k-dot" style="background:' + concern.sev + '"></span>' + esc(concern.text) + (riskCount ? ' <span class="pill pill-risk">' + riskCount + ' at risk</span>' : '') + '</div>' +
      '</div>';
  }

  function dseCardHtml(s) {
    const riskCls = s.riskClass === 'LOW' ? 'pill-good' : s.riskClass === 'MODERATE' ? 'pill-info' : s.riskClass === 'HIGH' ? 'pill-moderate' : 'pill-risk';
    const firstFlag = s.riskFlags && s.riskFlags.length ? s.riskFlags[0].key : 'No risk flags';
    return '<div class="drl-card dse" data-dse="' + esc(s.dse_code) + '">' +
      '<div class="drl-name">' + esc(s.dse_name) + '<small>' + esc(s.dse_code) + ' · ' + esc(s.branch_location || '—') + ' · ' + M.fmtNum(s.visits) + ' visits · ' + M.fmtHM(s.avgWorkingMin) + ' avg</small></div>' +
      '<div class="drl-kpis">' + drlKpi('Prod', M.fmtPct(s.productivityPct)) + drlKpi('Disc', (s.disciplineScore || 0).toFixed(1)) + drlKpi('Start', M.fmtPct(s.startPct)) + '</div>' +
      '<div class="drl-duty"><span class="pill ' + riskCls + '">' + (s.riskClass || '—') + ' · ' + (s.riskScore || 0) + '</span>' + esc(firstFlag) + '</div>' +
      '</div>';
  }

  function grpConcern(g) {
    const n = Math.max(1, Math.ceil(g.dseCount * 0.3));
    if (g.lateStartCount >= n) return { text: g.lateStartCount + ' of ' + g.dseCount + ' DSEs start late', sev: P.red };
    if (g.offRouteCount >= n) return { text: g.offRouteCount + ' of ' + g.dseCount + ' DSEs go off route', sev: P.amber };
    if (g.lowProdCount >= n) return { text: g.lowProdCount + ' of ' + g.dseCount + ' DSEs below team median', sev: P.amber };
    return { text: 'No dominant issue — balanced team', sev: P.green };
  }

  function drlKpi(label, value) {
    return '<span class="drl-kpi"><b>' + (value === null || value === undefined ? '–' : value) + '</b>' + label + '</span>';
  }

  function wireDrillPanel(section, state) {
    for (const el of section.querySelectorAll('.drl-card[data-dse]')) {
      el.addEventListener('click', () => {
        const code = el.getAttribute('data-dse');
        if (code) state.selectDse(code);
      });
    }
    for (const el of section.querySelectorAll('.drl-card[data-zsm], .drl-card[data-asm], .drl-card[data-aso]')) {
      el.addEventListener('click', () => {
        state.setDrill({
          zsm: el.getAttribute('data-zsm'),
          asm: el.getAttribute('data-asm'),
          aso: el.getAttribute('data-aso')
        });
      });
    }
    for (const el of section.querySelectorAll('.drl-crumb')) {
      el.addEventListener('click', () => {
        state.setDrill({
          zsm: el.getAttribute('data-zsm'),
          asm: el.getAttribute('data-asm'),
          aso: el.getAttribute('data-aso')
        });
      });
    }
  }

  function insightCardHTML(b) {
    const sevCls = sevClass(b.severity);
    const dseDrill = (b.supportingEntities && b.supportingEntities.length) ? ' data-dse="' + esc(b.supportingEntities[0]) + '"' : '';
    const why = (b.likelyDrivers && b.likelyDrivers.length) ? '<div class="brk-why"><b>Why:</b> ' + esc(b.likelyDrivers.slice(0, 2).join(' · ')) + '</div>' : '';
    let details = '';
    if ((b.evidence && b.evidence.length) || (b.impact && b.impact.summary) || b.confidence) {
      let items = [];
      if (b.evidence && b.evidence.length) items = items.concat(b.evidence.slice(0, 4));
      if (b.impact && (b.impact.quantified !== null && b.impact.quantified !== undefined)) items.push('Impact: ' + b.impact.quantified + ' ' + (b.impact.unit || ''));
      else if (b.impact && b.impact.summary) items.push('Impact: ' + b.impact.summary);
      if (b.confidence) items.push('Confidence: ' + b.confidence);
      details = '<details class="ec-evidence"><summary>Details</summary>' + items.map(e => '<div class="ec-ev-item">\u2022 ' + esc(e) + '</div>').join('') + '</details>';
    }

    return '<div class="brk-card sev-' + sevCls + '"' + dseDrill + ' data-insight="' + esc(b.id) + '">' +
      '<div class="brk-title">' + esc(b.title) + '</div>' +
      '<div class="brk-summary">' + esc(b.summary) + '</div>' +
      (why ? why : '') +
      (b.recommendedAction ? '<div class="ec-action">' + esc(b.recommendedAction) + '</div>' : '') +
      details +
      '</div>';
  }

  function renderDseDiagnostics(state) {
    const dseList = state.dseList;
    const highRisk = dseList.filter(s => s.riskClass === 'HIGH' || s.riskClass === 'CRITICAL')
      .sort((a, b) => b.riskScore - a.riskScore).slice(0, 10);
    if (!highRisk.length) return '';
    const rows = highRisk.map(s => `<tr class="clickable" data-dse="${esc(s.dse_code)}">
      <td><b>${esc(s.dse_name)}</b><br><small style="color:var(--mut)">${esc(s.dse_code)} · ${esc(s.asm || '—')}</small></td>
      <td class="num"><b>${s.riskScore}</b></td>
      <td>${s.riskFlags.length ? s.riskFlags.map(f => `<span class="pill ${pillForIssue(f.key)}">${esc(f.key)}</span>`).join(' ') : '—'}</td>
      <td class="num">${M.fmtPct(s.productivityPct)}</td>
      <td class="num">${M.fmtPct(s.startPct)}</td>
      <td class="num">${M.fmtMin(s.avgStoreMin)}</td>
    </tr>`).join('');
    return `<div class="ec-sec"><div class="ec-sec-h"><h3>Who needs support</h3><span class="card-sub">Highest-risk DSEs — click a row to open the profile</span></div>
      <div class="card-b" style="padding:0"><div class="tbl-wrap"><table class="data"><thead><tr><th>DSE</th><th class="num">Risk</th><th>Flags</th><th class="num">Prod</th><th class="num">Start</th><th class="num">Store</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
  }

  function evidenceBlock(state) {
    const ins = NS.insights.generate(state);
    const rows = (ins.summary || []).concat(ins.risk || []).concat(ins.opportunity || []).concat(ins.anomaly || []).concat(ins.positive || []).concat(ins.action || [])
      .filter(Boolean)
      .map(i => `<li><b>${esc(i.title)}</b><div>${esc(i.detail)}</div></li>`).join('');
    if (!rows) return '';
    return `<div class="ec-sec"><div class="ec-sec-h"><h3>Full detail</h3><span class="card-sub">Everything the system found in this view</span></div>
      <details class="ec-evidence"><summary>View all findings</summary>
      <ul class="ec-ev-ul">${rows}</ul></details></div>`;
  }

  function sevClass(s) {
    return String(s || 'MEDIUM').toLowerCase();
  }

  function wireInsightDrilldown(scopeEl, state) {
    const cards = scopeEl.querySelectorAll('.brk-card[data-dse]');
    for (const c of cards) {
      c.addEventListener('click', (e) => {
        if (e.target.closest('.ec-evidence')) return;
        const code = c.getAttribute('data-dse');
        if (code) state.selectDse(code);
      });
    }
  }

  function insightsBlock(state) {
    const ins = NS.insights.generate(state);
    const list = (ins.summary || []).concat(ins.risk || []).concat(ins.anomaly || []).concat(ins.opportunity || []).concat(ins.positive || []).concat(ins.action || []);
    const rows = list.filter(Boolean).map(i => `<li><b>${esc(i.title)}</b><div>${esc(i.detail)}</div></li>`).join('');
    return `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Insights</h3><span class="card-sub">Findings for the current view</span></div><div class="card-b">` +
      (rows ? `<ul class="ec-ev-ul">${rows}</ul>` : '<div class="ec-empty"><div class="ec-empty-title">No insights yet</div></div>') +
      `</div></div>`;
  }

  function renderActionTable(dseList) {
    const rows = [];
    for (const s of dseList) {
      if (s.riskFlags.length) {
        for (const f of s.riskFlags.slice(0, 2)) {
          rows.push({ dse: s, issue: f.key, evidence: f.detail, sev: (f.weight >= 20 && (s.riskClass === 'HIGH' || s.riskClass === 'CRITICAL')) ? 'Critical' : f.weight >= 20 ? 'High' : 'Medium', action: actionFor(f.key) });
        }
      } else if (s.riskClass === 'LOW') {
        rows.push({ dse: s, issue: 'Recognize performance', evidence: 'Discipline ' + s.disciplineScore.toFixed(0) + ' · Prod ' + (s.productivityPct === null ? '–' : s.productivityPct.toFixed(0) + '%'), sev: 'Positive', action: 'Recognition / best-practice sharing' });
      }
    }
    const sevRank = s => ({ Critical: 0, High: 1, Medium: 2 }[s] ?? 3);
    rows.sort((a, b) => sevRank(a.sev) - sevRank(b.sev));
    const body = rows.slice(0, 60).map(r => `<tr class="clickable ${r.sev === 'Positive' ? 'row-good' : r.sev === 'Critical' ? 'row-risk' : r.sev === 'High' ? 'row-moderate' : ''}" data-dse="${esc(r.dse.dse_code)}">
      <td><b>${esc(r.dse.dse_name)}</b><br><small style="color:var(--mut)">${esc(r.dse.dse_code)} · ${esc(r.dse.branch_code)}</small></td>
      <td><span class="pill ${pillForIssue(r.issue)}">${esc(r.issue)}</span></td>
      <td>${esc(r.evidence)}</td>
      <td><span class="pill ${r.sev === 'Positive' ? 'pill-good' : r.sev === 'Critical' ? 'pill-risk' : r.sev === 'High' ? 'pill-moderate' : 'pill-info'}">${r.sev}</span></td>
      <td>${esc(r.action)}</td></tr>`).join('');
    return `<div class="card"><div class="card-h"><h3>Action list</h3><span class="card-sub">Who to talk to and what to do</span></div>
      <div class="card-b" style="padding:0"><div class="tbl-wrap"><table class="data"><thead><tr><th>DSE</th><th>Issue</th><th>Evidence</th><th>Severity</th><th>Recommended action</th></tr></thead><tbody>${body}</tbody></table></div></div></div>`;
  }

  function pillForIssue(issue) {
    switch (issue) {
      case 'Late Start': case 'Off Route': case 'High Deviation': return 'pill-risk';
      case 'Low Productivity': case 'Low Work Hours': case 'Low Call Compliance': return 'pill-moderate';
      case 'Excessive Store Time': case 'Low Order Value': return 'pill-info';
      default: return 'pill-mut';
    }
  }

  function actionFor(issue) {
    switch (issue) {
      case 'Late Start': return 'Reinforce 9:30 field-start norm; zone-wise morning check-in';
      case 'Off Route': return 'Route adherence coaching + daily route checklist';
      case 'High Deviation': return 'Investigate route planning; verify geo-marking of retailers';
      case 'Low Productivity': return 'Targeted intervention on conversion technique & store-level planning';
      case 'Low Work Hours': return 'Monitor day length; review field plan completeness';
      case 'Low Call Compliance': return 'Call-logging discipline; supervisor audits';
      case 'Excessive Store Time': return 'Time-box store visits; review visit breadth vs depth';
      case 'Low Order Value': return 'Assortment & upselling support; focus on high-value routes';
      default: return 'Review profile for context';
    }
  }

  // ---------- Data quality ----------
  function renderQuality(state) {
    const r = state.report;
    const section = qs('section-quality');
    const items = [
      ['Total rows', M.fmtNum(r.totalRows), ''],
      ['Valid rows', M.fmtNum(r.validRows), r.validRows >= r.totalRows ? P.green : P.amber],
      ['Duplicate rows', M.fmtNum(r.duplicateRows), r.duplicateRows ? P.amber : P.green],
      ['Missing date', M.fmtNum(r.missingDate), r.missingDate ? P.red : P.green],
      ['Missing DSE', M.fmtNum(r.missingDse), r.missingDse ? P.red : P.green],
      ['Missing day start', M.fmtNum(r.missingDayStart), r.missingDayStart ? P.amber : P.green],
      ['Missing start time', M.fmtNum(r.missingStartTime), r.missingStartTime ? P.amber : P.green],
      ['Missing end time', M.fmtNum(r.missingEndTime), r.missingEndTime ? P.amber : P.green],
      ['Missing intime', M.fmtNum(r.missingIntime), r.missingIntime ? P.amber : P.green],
      ['Missing coordinates', M.fmtNum(r.missingCoordinates), r.missingCoordinates ? P.amber : P.green],
      ['Invalid deviation', M.fmtNum(r.invalidDeviation), r.invalidDeviation ? P.amber : P.green],
      ['Negative duration', M.fmtNum(r.negativeDuration), r.negativeDuration ? P.amber : P.green],
      ['Long visits (>240m)', M.fmtNum(r.longDurations), r.longDurations ? P.amber : P.green],
      ['Invalid productivity', M.fmtNum(r.invalidProductivity), r.invalidProductivity ? P.red : P.green],
      ['Missing order value', M.fmtNum(r.missingOrderValue), r.missingOrderValue ? P.amber : P.green],
      ['Missing on-route', M.fmtNum(r.missingOnRoute), r.missingOnRoute ? P.amber : P.green],
      ['Missing call compliance', M.fmtNum(r.missingCallCompliance), r.missingCallCompliance ? P.amber : P.green],
      ['Invalid distance', M.fmtNum(r.invalidDistance), r.invalidDistance ? P.amber : P.green]
    ];
    let rows = '';
    items.forEach(it => { rows += `<tr><td>${it[0]}</td><td class="num">${it[1]}</td><td><span class="k-dot" style="background:${it[2]};display:inline-block;width:9px;height:9px;border-radius:50%"></span></td><td>${it[0].replace(/^/ , '')}</td></tr>`; });
    section.innerHTML = `<div class="card"><div class="card-h"><h3>Data quality report</h3><span class="card-sub">Bad records are excluded from analytics and never silently skew KPIs.</span></div>
      <div class="card-b" style="padding:0"><div class="tbl-wrap"><table class="data"><thead><tr><th>Check</th><th class="num">Count</th><th>Status</th><th>Impact</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>
      ${r.flags.length ? '<div class="card" style="margin-top:16px"><div class="card-b">' + r.flags.map(f => '<div style="padding:8px 0;border-bottom:1px solid var(--border)">⚠ ' + esc(f) + '</div>').join('') + '</div></div>' : ''}`;
  }

  // ---------- DSE profile ----------
  function openDseModal(state) {
    const dse = state.selectedDse;
    if (!dse) return;
    const body = qs('dseModalBody');
    const days = [...state.dailyMap.values()].filter(d => d.dse_code === dse.dse_code).sort((a, b) => a.date.localeCompare(b.date));
    const lateDays = days.filter(d => d.start_pass === false).length;
    const offRouteDays = days.filter(d => d.offRouteYes > 0).length;
    const highDevDays = days.filter(d => d.highDev > 0).length;
    const avgDev = dse.avgDev;
    const hoursTh = Math.round(state.params.hoursThreshold / 60 * 10) / 10;
    const statusColor = dse.discStatus === 'GOOD' ? P.green : dse.discStatus === 'MODERATE' ? P.amber : P.red;
    const riskFlags = dse.riskFlags;
    const initDay = (state.selectedDate && days.some(d => d.date === state.selectedDate)) ? state.selectedDate : '';
    body.innerHTML = `
      <div class="dse-profile-head">
        <div class="dse-avatar">${esc((dse.dse_name || '?').slice(0, 2).toUpperCase())}</div>
        <div class="dse-meta">
          <h2>${esc(dse.dse_name)}</h2>
          <div class="sub">${esc(dse.dse_code)} · Branch ${esc(dse.branch_code)} · ${esc(dse.branch_location)}</div>
          <div class="sub">ZSM: ${esc(dse.zsm || '—')} · ASM: ${esc(dse.asm || '—')} · ASO: ${esc(dse.aso || '—')}</div>
        </div>
        <div style="margin-left:auto" class="dse-score-ring"><div id="profGauge" style="width:170px;height:150px"></div><div style="text-align:center"><span class="pill pill-${dse.discStatus === 'GOOD' ? 'good' : dse.discStatus === 'MODERATE' ? 'moderate' : 'risk'}">${discStatusLabel(dse.discStatus)}</span> <span class="chip chip-mut">Risk: ${dse.riskClass}</span></div></div>
      </div>
      <div class="grid3" style="margin-bottom:20px">
        <div class="kv"><div class="kv-k">Active days</div><div class="kv-v">${dse.days}</div></div>
        <div class="kv"><div class="kv-k">Visits</div><div class="kv-v">${dse.visits}</div></div>
        <div class="kv"><div class="kv-k">Productive on-route calls</div><div class="kv-v">${dse.prodOnRoute} <small style="color:var(--mut)">(${M.fmtPct(dse.productivityPct)})</small></div></div>
        <div class="kv">        <div class="kv-k">Avg market hours</div><div class="kv-v">${M.fmtHM(dse.avgWorkingMin)}</div></div>
        <div class="kv"><div class="kv-k">Avg In-Time</div><div class="kv-v">${M.fmtHM(dse.avgInTimeMin)}</div></div>
        <div class="kv"><div class="kv-k">Total order value</div><div class="kv-v">${M.fmtMoney(dse.orderSum)}</div></div>
        <div class="kv"><div class="kv-k">Call compliance</div><div class="kv-v">${M.fmtPct(dse.callCompliancePct)}</div></div>
        <div class="kv"><div class="kv-k">Calls / day</div><div class="kv-v">${(dse.visits / Math.max(1, dse.days)).toFixed(1)}</div></div>
        <div class="kv"><div class="kv-k">Order / visit</div><div class="kv-v">${M.fmtMoney(dse.avgOrderPerVisit)}</div></div>
        <div class="kv"><div class="kv-k">On-route %</div><div class="kv-v">${M.fmtPct(dse.onRoutePct)}</div></div>
        <div class="kv"><div class="kv-k">Deviation ≤100m %</div><div class="kv-v">${M.fmtPct(dse.devPct)}</div></div>
        <div class="kv"><div class="kv-k">On-time start %</div><div class="kv-v">${M.fmtPct(dse.startPct)}</div></div>
      </div>

      <div class="grid3" style="margin-bottom:20px">
        <div class="kv"><div class="kv-k">Discipline hits</div><div class="kv-v" style="color:${statusColor}">${dse.eligibleCount} / ${dse.discDays} <small style="color:var(--mut)">(days)</small></div></div>
        <div class="kv"><div class="kv-k">Late start days</div><div class="kv-v" style="color:${lateDays ? P.red : P.green}">${lateDays}</div></div>
        <div class="kv"><div class="kv-k">Off-route days</div><div class="kv-v" style="color:${offRouteDays ? P.amber : P.green}">${offRouteDays}</div></div>
        <div class="kv"><div class="kv-k">High deviation days</div><div class="kv-v" style="color:${highDevDays ? P.red : P.green}">${highDevDays}</div></div>
        <div class="kv"><div class="kv-k">Average deviation</div><div class="kv-v">${avgDev === null ? '–' : Math.round(avgDev) + ' m'}</div></div>
        <div class="kv"><div class="kv-k">${hoursTh}h+ days</div><div class="kv-v">${dse.hours7Count} <small style="color:var(--mut)">(${M.fmtPct(dse.hours7Pct)})</small></div></div>
      </div>

      <div class="card" style="margin-bottom:20px"><div class="card-h"><h3>Day insights</h3><span style="display:inline-flex;align-items:center;gap:8px;margin-left:auto"><span class="card-sub">Pick a date</span><input type="date" id="profDay" min="${days.length ? days[0].date : ''}" max="${days.length ? days[days.length - 1].date : ''}" value="${initDay}" style="background:var(--panel);border:1px solid var(--border2);border-radius:7px;padding:4px 8px;font-size:12px;color:var(--ink)"></span></div><div class="card-b" id="profDayBody"></div></div>

      <div class="card" style="margin-bottom:20px"><div class="card-h"><h3>Discipline compliance</h3><span class="card-sub">Hit = day's first call is on route, within deviation and on time · Good &gt;${'90'}% · Moderate ≥85%</span></div><div class="card-b">${compBar('Discipline %', dse.discPct, 'Hits ÷ working days', { good: 90, mod: 85 })}${compBar('On-time starts', dse.startPct, 'Start ≤ ' + M.fmtTimeMin(state.params.startThreshold))}${compBar('On route', dse.onRoutePct, 'Assigned route')}${compBar('Within deviation', dse.devPct, '≤ ' + state.params.devThreshold + 'm')}</div></div>

      ${riskFlags.length ? `<div class="card" style="margin-bottom:20px"><div class="card-h"><h3>Risk factors</h3></div><div class="card-b">${riskFlags.map(f => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)"><div><b>${esc(f.key)}</b><div style="color:var(--mut);font-size:11.5px">${esc(f.detail)}</div></div><span class="chip chip-${f.weight >= 20 ? 'risk' : 'warn'}">+${f.weight}</span></div>`).join('')}</div></div>` : ''}

      <div class="card" style="margin-bottom:20px"><div class="card-h"><h3>Daily trends</h3><span class="card-sub">Start time · market hours · productivity · in-time</span></div><div class="card-b">
        <div class="grid two" style="margin-bottom:12px"><div><div id="profStart" class="chart-box h"></div></div><div><div id="profHours" class="chart-box h"></div></div></div>
        <div class="grid two"><div><div id="profProd" class="chart-box h"></div></div><div><div id="profStore" class="chart-box h"></div></div></div>
      </div></div>

      <div class="card"><div class="card-h"><h3>AI recommendations</h3></div><div class="card-b">
        <div class="grid3">${dseRecommendations(state, dse, days).map(r => `<div class="insight-card sev-${r.level}"><div class="insight-title">${r.title}</div><div class="insight-detail">${r.detail}</div></div>`).join('')}</div>
      </div></div>`;
    qs('dseModal').hidden = false;
    const dayInput = qs('profDay'), dayBody = qs('profDayBody');
    const refreshDay = () => {
      dayBody.innerHTML = dayInsightsHtml(state, dse, dayInput.value);
      renderMovementMap('profSeqMap', dse, dayInput.value, state);
    };
    dayInput.addEventListener('change', refreshDay);
    refreshDay();
    C.gauge(document.getElementById('profGauge'), dse.discPct, 100, { color: statusColor, title: 'Discipline %', formatter: v => Math.round(v) + '%' });
    renderProfTrend(state, days);
  }

  function dayInsightsHtml(state, dse, date) {
    if (!date) return '<div class="ec-empty"><div class="ec-empty-title">No date selected</div><div class="ec-empty-sub">Pick a date above to see that day\'s visits and scores.</div></div>';
    const day = state.dailyMap.get(dse.dse_code + '|' + date);
    const visits = state.filteredVisits.filter(v => v.dse_code === dse.dse_code && v.date === date)
      .sort((a, b) => (a.start_min === null ? Infinity : a.start_min) - (b.start_min === null ? Infinity : b.start_min));
    if (!visits.length) return '<div class="ec-empty"><div class="ec-empty-title">No data on ' + esc(date) + '</div></div>';
    const p = state.params;
    let prodOnRoute = 0, onRouteYes = 0, offRoute = 0, highDev = 0, devSum = 0, devN = 0;
    for (const v of visits) {
      const isProd = v.productivity === 'YES';
      if (v.on_route === 'YES') { onRouteYes++; if (isProd) prodOnRoute++; }
      else if (v.on_route === 'NO') offRoute++;
      if (v.deviation_m !== null && v.deviation_m >= 0) { devSum += v.deviation_m; devN++; if (v.deviation_m > p.devThreshold) highDev++; }
    }
    const prodPct = onRouteYes ? (prodOnRoute / onRouteYes) * 100 : null;
    const firstV = visits.find(v => v.start_min !== null);
    const hit = firstV && firstV.on_route === 'YES' && firstV.deviation_m !== null && firstV.deviation_m <= p.devThreshold && firstV.start_min <= p.startThreshold ? 1 : 0;
    const startChip = day && day.start_pass !== null ? (day.start_pass ? '<span class="pill pill-good">On time</span>' : '<span class="pill pill-risk">Late</span>') : '';
    const hitChip = hit ? '<span class="pill pill-good">Discipline hit</span>' : '<span class="pill pill-risk">No hit</span>';
    const rows = visits.map(v => `<tr>
        <td class="num">${v.start_min !== null ? fmtClock(v.start_min) + (v.end_min !== null ? ' – ' + fmtClock(v.end_min) : '') : '–'}</td>
        <td>${esc(v.retailer_name)}</td>
        <td>${esc(v.channel_name || v.channel || '')}</td>
        <td class="num">${M.fmtHM(v.duration_min)}</td>
        <td>${v.on_route === 'YES' ? '<span class="pill pill-good">Y</span>' : v.on_route === 'NO' ? '<span class="pill pill-risk">N</span>' : '–'}</td>
        <td>${v.productivity === 'YES' ? '<span class="pill pill-good">Y</span>' : v.productivity === 'NO' ? '<span class="pill pill-risk">N</span>' : '–'}</td>
        <td class="num">${v.deviation_m === null ? '–' : Math.round(v.deviation_m) + 'm'}</td>
        <td class="num">${v.order_value === null ? '–' : M.fmtMoney(v.order_value)}</td>
      </tr>`).join('');
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${startChip}${hitChip}
        <span class="chip chip-mut">Start: <b>&nbsp;${day && day.day_start_min !== null ? fmtClock(day.day_start_min) : '–'}</b></span>
        <span class="chip chip-mut">Market hours: <b>&nbsp;${day && day.workingMin !== null ? M.fmtHM(day.workingMin) : '–'}</b></span>
        <span class="chip chip-mut">Productivity %: <b>&nbsp;${prodPct === null ? '–' : prodPct.toFixed(1) + '%'}</b></span>
      </div>
      <div class="grid3" style="margin-bottom:14px">
        <div class="kv"><div class="kv-k">Visits</div><div class="kv-v">${visits.length}</div></div>
        <div class="kv"><div class="kv-k">On-route / off-route</div><div class="kv-v">${onRouteYes} / ${offRoute}</div></div>
        <div class="kv"><div class="kv-k">Productive on-route</div><div class="kv-v">${prodOnRoute}</div></div>
        <div class="kv"><div class="kv-k">Avg deviation</div><div class="kv-v">${devN ? Math.round(devSum / devN) + ' m' : '–'}</div></div>
        <div class="kv"><div class="kv-k">High deviation calls</div><div class="kv-v" style="color:${highDev ? P.red : P.green}">${highDev}</div></div>
        <div class="kv"><div class="kv-k">Order value</div><div class="kv-v">${M.fmtMoney(visits.reduce((a, v) => a + (v.order_value || 0), 0))}</div></div>
      </div>
      <div class="tbl-wrap" style="max-height:320px">
        <table class="data">
          <thead><tr><th>Time</th><th>Retailer</th><th>Channel</th><th class="num">Store</th><th>Route</th><th>Prod</th><th class="num">Dev</th><th class="num">Order</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:16px;font-size:12px;font-weight:700;color:var(--mut)">Daily movement trace</div>
      <div id="profSeqMap" class="map-box" style="height:300px;margin-top:8px"></div>`;
  }

  function compBar(label, pct, sub, bands) {
    const good = bands && bands.good ? bands.good : 80;
    const mod = bands && bands.mod ? bands.mod : 60;
    const v = pct === null ? 0 : pct;
    const c = pct === null ? P.mut : v >= good ? P.green : v >= mod ? P.amber : P.red;
    return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span><b>${label}</b> <small style="color:var(--mut)">${sub}</small></span><span style="font-weight:700;color:${c}">${pct === null ? 'No data' : v.toFixed(1) + '%'}</span></div>
    <div class="bar-mini" style="width:100%"><i style="width:${pct === null ? 0 : Math.min(100, v)}%;background:${c}"></i></div></div>`;
  }

  function profY(days, fn, fmt) { return days.map(d => [d.date, fn(d)]); }
  function fmtClock(m) {
    if (m === null || m === undefined || !isFinite(m)) return '–';
    const mm = Math.round(m);
    const h = Math.floor(mm / 60), mi = mm % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return hr + ':' + String(mi).padStart(2, '0') + ' ' + ap;
  }

  function renderProfTrend(state, days) {
    const th = state.params.startThreshold;
    const hoursTh = Math.round(state.params.hoursThreshold / 60 * 10) / 10;
    C.lineTrendChart('profStart', days.map(d => d.date), days.map(d => d.day_start_min === null ? null : Math.round(d.day_start_min)), 'Start time', {
      color: P.blue, scale: true, valueFormatter: fmtClock,
      markLine: { symbol: 'none', label: { formatter: M.fmtTimeMin(th).replace(' ', ''), color: P.red, fontSize: 11, fontWeight: 700, position: 'end' }, lineStyle: { color: P.red, type: 'dashed', width: 1.5 }, data: [{ yAxis: th }] }
    });
    C.lineTrendChart('profHours', days.map(d => d.date), days.map(d => d.workingMin === null ? null : Math.round(d.workingMin / 60 * 10) / 10), 'Market hours (h)', {
      color: P.green, scale: true,
      markLine: { symbol: 'none', label: { formatter: hoursTh + 'h', color: P.amber, fontSize: 11, fontWeight: 700, position: 'end' }, lineStyle: { color: P.amber, type: 'dashed', width: 1.5 }, data: [{ yAxis: hoursTh }] }
    });
    C.lineTrendChart('profProd', days.map(d => d.date), days.map(d => d.prodPct === null ? null : Math.round(d.prodPct * 10) / 10), 'Productivity %', { color: '#8b5cf6' });
    C.lineTrendChart('profStore', days.map(d => d.date), days.map(d => d.intimeCount ? Math.round(d.intimeSum / d.intimeCount) : null), 'Avg In-Time', {
      color: P.amber, scale: true, valueFormatter: v => M.fmtHM(v)
    });
  }

  function dseRecommendations(state, dse, days) {
    const r = [];
    const team = state.team;
    const hoursTh = state.params.hoursThreshold;
    if (dse.startPct !== null && dse.startPct < 75) r.push({ level: 'critical', title: 'Repeated late starts', detail: 'Started after ' + M.fmtTimeMin(state.params.startThreshold) + ' on ' + dse.lateDays + ' of ' + (dse.startDays || 0) + ' days. Reinstate a firm morning check-in.' });
    if (dse.discStatus === 'GOOD' && dse.discPct > 90 && (dse.productivityPct || 0) >= 60) r.push({ level: 'positive', title: 'Model performer', detail: 'High discipline and strong productivity. Share as best practice.' });
    if ((dse.productivityPct || 0) >= 60 && dse.avgWorkingMin !== null && dse.avgWorkingMin < hoursTh) r.push({ level: 'high', title: 'Efficient operator', detail: 'High productivity despite under ' + Math.round(hoursTh / 60) + ' market hours. Understand the playbook and scale it.' });
    if ((dse.productivityPct || 0) < 40 && dse.avgWorkingMin !== null && dse.avgWorkingMin >= hoursTh) r.push({ level: 'critical', title: 'Long hours, low conversion', detail: 'Works ' + Math.round(hoursTh / 60) + '+ hours but productivity is only ' + (dse.productivityPct || 0).toFixed(0) + '%. Audit visit planning and store-level technique.' });
    if (dse.avgStoreMin !== null && team.medianStoreMin !== null && dse.avgStoreMin > team.medianStoreMin * 1.5 && (dse.productivityPct || 0) < 50) r.push({ level: 'high', title: 'Over-spending time in stores', detail: 'Avg store time ' + Math.round(dse.avgStoreMin) + 'm vs team median ' + Math.round(team.medianStoreMin) + 'm without matching productivity.' });
    if (dse.avgOrder !== null && team.medianOrder !== null && dse.avgOrder < team.medianOrder * 0.5 && dse.visits >= 10) r.push({ level: 'high', title: 'Low order value', detail: 'Avg order ₹' + dse.avgOrder.toFixed(0) + ' vs team median ₹' + team.medianOrder.toFixed(0) + '. Focus on assortment and upselling.' });
    if (dse.onRoutePct !== null && dse.onRoutePct < 85 && (dse.productivityPct || 0) >= 60) r.push({ level: 'high', title: 'Productive but off route', detail: 'Good conversion but ' + (100 - dse.onRoutePct).toFixed(0) + '% of visits off-route. Re-align route planning.' });
    if (!r.length) r.push({ level: 'medium', title: 'Balanced profile', detail: 'No dominant risk pattern detected; review weekly trend for early signals.' });
    return r;
  }

  // ---------- Utilities ----------
  function rowWire(scopeEl, sel, handler) {
    const els = scopeEl.querySelectorAll(sel);
    for (const el of els) el.addEventListener('click', () => handler(el));
  }

  function sortTable(th) {
    const tableEl = th.closest('table');
    const tbody = tableEl.querySelector('tbody');
    const idx = Array.from(th.parentNode.children).indexOf(th);
    const rows = Array.from(tbody.children);
    const key = th.getAttribute('data-k');
    const isNum = th.classList.contains('num');
    const dir = th.dataset.dir !== 'asc' ? 'asc' : 'desc';
    th.parentNode.querySelectorAll('th').forEach(x => x.dataset.dir = '');
    th.dataset.dir = dir;
    const cellNum = td => td.dataset.sort !== undefined && td.dataset.sort !== '' ? parseFloat(td.dataset.sort) : parseFloat(td.textContent.replace(/[^\d.-]/g, ''));
    rows.sort((a, b) => {
      const atd = a.children[idx], btd = b.children[idx];
      if (isNum) {
        const an = cellNum(atd), bn = cellNum(btd);
        const aOk = isFinite(an), bOk = isFinite(bn);
        if (!aOk && !bOk) return 0;
        if (!aOk) return 1;
        if (!bOk) return -1;
        return dir === 'asc' ? an - bn : bn - an;
      }
      return dir === 'asc' ? atd.textContent.localeCompare(btd.textContent) : btd.textContent.localeCompare(atd.textContent);
    });
    rows.forEach(r => tbody.appendChild(r));
  }

  NS.ui = { esc, kpi, renderFilterOptions, readFilters, renderManagementSummary, renderExec, renderDiscipline, renderProductivity, renderSpend, renderGeo, renderRisk, renderQuality, openDseModal, renderMovementMap, renderRankingCard, sortedDates, sortTable, rowWire, popupHtml, compBar };
})();