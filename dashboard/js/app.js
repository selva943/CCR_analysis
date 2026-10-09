(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});
  const M = NS.metrics;
  const U = NS.ui;

  const _assetCache = {};

  const state = {
    loaded: false,
    filename: '',
    loadedAt: null,
    sourceMode: '',
    report: null,
    allVisits: [],
    filteredVisits: [],
    dailyMap: new Map(),
    dseList: [],
    team: null,
    discipline: null,
    discSummary: null,
    selectedDse: null,
    selectedDate: null,
    selectedDseDays: [],
    hierarchyOptions: null, // Supabase: filter dropdown options from the RPC
    supaMeta: null,         // Supabase: last RPC meta (dates, report, import info)
    visitsReady: false,     // Supabase: row-level visits fetched for current filters
    _visitsLoading: false,
    _visitsError: null,
    accessRows: [],         // Admin: viewer activity report rows
    _accessLogged: false,   // Admin: one access-log write per page load
    _datesSet: false,       // Supabase: initial date range applied from meta
    _computeSeq: 0,         // Supabase: drops stale RPC responses
    params: Object.assign({}, resource('params')),
    drill: { zsm: null, asm: null, aso: null },
    _drillEngineCache: {},
    filters: {
      dateFrom: null, dateTo: null,
      branchLocs: [], zsms: [], asms: [], asos: [], dseCodes: [], channels: [],
      onRoute: 'ALL'
    },
    hierarchyBase() {
      if (this.sourceMode === 'supabase') {
        const o = this.hierarchyOptions;
        if (!o) return { branchLocs: [], zsms: [], asms: [], asos: [], channels: [], dses: [] };
        return {
          branchLocs: o.branchLocs || [], zsms: o.zsms || [], asms: o.asms || [],
          asos: o.asos || [], channels: o.channels || [], dses: o.dses || []
        };
      }
      const v = this.allVisits;
      const f = this.filters;
      const seen = { branchLocs: new Set(), zsms: new Set(), asms: new Set(), asos: new Set(), dses: new Map(), channels: new Set() };
      for (const r of v) {
        if (f.dateFrom && r.date < f.dateFrom) continue;
        if (f.dateTo && r.date > f.dateTo) continue;
        if (f.branchLocs.length && !f.branchLocs.includes(r.branch_location)) continue;
        if (f.zsms.length && !f.zsms.includes(r.zsm)) continue;
        if (f.asms.length && !f.asms.includes(r.asm)) continue;
        if (f.asos.length && !f.asos.includes(r.aso)) continue;
        if (f.channels.length && !f.channels.includes(r.channel)) continue;
        seen.branchLocs.add(r.branch_location);
        seen.zsms.add(r.zsm);
        seen.asms.add(r.asm);
        seen.asos.add(r.aso);
        seen.channels.add(r.channel);
        if (!seen.dses.has(r.dse_code)) seen.dses.set(r.dse_code, { dse_code: r.dse_code, dse_name: r.dse_name });
      }
      return { branchLocs: [...seen.branchLocs], zsms: [...seen.zsms], asms: [...seen.asms], asos: [...seen.asos], channels: [...seen.channels].filter(c => c !== 'SPECIALITY'), dses: [...seen.dses.values()] };
    },
    activeFilterCount() {
      const f = this.filters;
      let c = 0;
      if (f.dateFrom || f.dateTo) c++;
      c += f.branchLocs.length + f.zsms.length + f.asms.length + f.asos.length + f.dseCodes.length + f.channels.length;
      if (f.onRoute !== 'ALL') c++;
      return c;
    },
    selectDse(code, date) {
      const d = this.dseList.find(s => s.dse_code === code) || null;
      this.selectedDse = d;
      this.selectedDate = date || null;
      this.selectedDseDays = [...this.dailyMap.values()].filter(dd => dd.dse_code === code);
      if (d) {
        U.openDseModal(this);
      }
    },
    setDrill(patch) {
      this.drill = {
        zsm: (patch && patch.zsm) || null,
        asm: (patch && patch.asm) || null,
        aso: (patch && patch.aso) || null
      };
      this._drillEngineCache = {};
      const sec = document.getElementById('section-risk');
      if (sec && this.loaded && sec.classList.contains('active')) {
        const rowsOk = this.sourceMode === 'supabase' ? this.visitsReady : !!this.allVisits.length;
        if (rowsOk) U.renderRisk(this); else this.render();
      }
    },
    resetDrill() {
      this.drill = { zsm: null, asm: null, aso: null };
      this._drillEngineCache = {};
    },
    currentDrillDseCount() {
      const d = this.drill;
      if ((!d.zsm || d.zsm === '') && (!d.asm || d.asm === '') && (!d.aso || d.aso === '')) return this.dseList.length;
      return this.dseList.filter(s =>
        (!d.zsm || s.zsm === d.zsm) &&
        (!d.asm || s.asm === d.asm) &&
        (!d.aso || s.aso === d.aso)).length;
    }
  };

  function resource(key) {
    return {
      params: {
        startThreshold: 570,
        devThreshold: 100,
        hoursThreshold: 420,
        disciplineWeights: { start: 0.4, route: 0.3, dev: 0.3 },
        riskWeights: { lateStart: 20, offRoute: 20, highDeviation: 20, lowProductivity: 20, lowHours: 10, lowCallCompliance: 10, excessStoreTime: 10, lowOrderValue: 10 },
        rankingWeights: { discipline: 0.4, productivity: 0.35, efficiency: 0.25 }
      }
    }[key];
  }

  // ---------- Filtering ----------
  function filterVisits(visits, f) {
    return visits.filter(r => {
      if (f.dateFrom && r.date < f.dateFrom) return false;
      if (f.dateTo && r.date > f.dateTo) return false;
      if (f.branchLocs.length && !f.branchLocs.includes(r.branch_location)) return false;
      if (f.zsms.length && !f.zsms.includes(r.zsm)) return false;
      if (f.asms.length && !f.asms.includes(r.asm)) return false;
      if (f.asos.length && !f.asos.includes(r.aso)) return false;
      if (f.dseCodes.length && !f.dseCodes.includes(r.dse_code)) return false;
      if (f.channels.length && !f.channels.includes(r.channel)) return false;
      if (f.onRoute === 'YES' && r.on_route !== 'YES') return false;
      if (f.onRoute === 'NO' && r.on_route !== 'NO') return false;
      return true;
    });
  }

  async function compute() {
    U.readFilters(state);
    setParamsFromUI();
    if (state.sourceMode === 'supabase') {
      await computeSupabase();
      return;
    }
    state.filteredVisits = filterVisits(state.allVisits, state.filters);
    const built = M.buildAll(state.filteredVisits);
    let ds = built.dseList;
    state.dseList = ds;
    checkDrillStillValid(ds);
    state.dailyMap = built.dailyMap;
    state.team = M.computeBenchmarks(ds, state.filteredVisits);
    M.computeRisk(ds, state.team);
    M.computeRanking(ds, state.team);
    state.discipline = built.discipline;
    state.discSummary = M.applyDiscipline(ds, built.discipline);
    state.selectedDse = state.selectedDse ? ds.find(s => s.dse_code === state.selectedDse.dse_code) || null : null;
    state.geoLoaded = false;
    runEngine();
    render();
    refreshSourceInfo();
  }

  function checkDrillStillValid(ds) {
    if (state.drill && (state.drill.zsm || state.drill.asm || state.drill.aso)) {
      const still = ds.some(s =>
        (!state.drill.zsm || s.zsm === state.drill.zsm) &&
        (!state.drill.asm || s.asm === state.drill.asm) &&
        (!state.drill.aso || s.aso === state.drill.aso));
      if (!still) state.resetDrill();
    }
  }

  // ---------- Supabase fast path ----------
  // One RPC fetches per-DSE-day rows + filter options + meta; the same
  // metrics.js modules then run on hydrated daily data (visits stay lazy).
  async function computeSupabase() {
    const seq = (state._computeSeq = (state._computeSeq || 0) + 1);
    let data;
    try {
      data = await NS.ccr.getDashboard(state.filters);
    } catch (e) {
      console.error('Supabase dashboard fetch failed:', e);
      toast('Supabase load failed: ' + (e.message || e), 'error');
      return false;
    }
    if (seq !== state._computeSeq) return true; // a newer request superseded this one
    applySupabaseData(data);
    startVisitsLoad();
    render();
    refreshSourceInfo();
    return true;
  }

  function applySupabaseData(data) {
    const meta = (data && data.meta) || {};
    state.supaMeta = meta;
    if (meta.report) state.report = meta.report;
    state.hierarchyOptions = (data && data.options) || null;
    state.dailyMap = M.hydrateDailyRows((data && data.daily) || []);
    const ds = M.buildDSE(state.dailyMap);
    state.dseList = ds;
    checkDrillStillValid(ds);
    state.team = M.computeBenchmarks(ds, null, state.dailyMap);
    M.computeRisk(ds, state.team);
    M.computeRanking(ds, state.team);
    state.discipline = M.computeDisciplineFromDaily(state.dailyMap);
    state.discSummary = M.applyDiscipline(ds, state.discipline);
    state.selectedDse = state.selectedDse ? ds.find(s => s.dse_code === state.selectedDse.dse_code) || null : null;
    state.geoLoaded = false;
    state.engineResult = null;
    state._drillEngineCache = {};
    // Row-level visits always belong to the current filter selection.
    state.filteredVisits = [];
    state.visitsReady = false;
    state._visitsLoading = false;
    state._visitsError = null;
    if (meta.date_min) setDateBounds(meta.date_min, meta.date_max);
    if (!state._datesSet && meta.date_min) {
      state.filters.dateFrom = meta.date_min;
      state.filters.dateTo = meta.date_max;
      const f1 = document.getElementById('fDateFrom');
      const f2 = document.getElementById('fDateTo');
      if (f1) f1.value = meta.date_min;
      if (f2) f2.value = meta.date_max;
      state._datesSet = true;
    }
    if (meta.import) {
      state.filename = (meta.import.file_name || 'Supabase') + ' (Supabase)';
      state.loadedAt = meta.import.completed_at || state.loadedAt;
    } else {
      state.filename = state.filename || 'Supabase';
    }
    state.loaded = true;
  }

  // Background: fetch row-level visits for the current filters, then build the
  // insight engine output. Spend/Geo/Risk/DSE-profile modules wait on this.
  function startVisitsLoad() {
    if (state.visitsReady || state._visitsLoading) return;
    if (!NS.ccr || !NS.ccr.apiConfigured()) return;
    state._visitsLoading = true;
    state._visitsError = null;
    showProgress();
    const key = NS.ccr.filterKey(state.filters);
    NS.ccr.getVisits(state.filters).then(visits => {
      if (state.sourceMode !== 'supabase') return;
      if (NS.ccr.filterKey(state.filters) !== key) return; // stale — a newer filter set owns the flag
      state._visitsLoading = false;
      state.filteredVisits = visits;
      state.visitsReady = true;
      state._visitsError = null;
      runEngine();
      const active = document.querySelector('.module.active');
      const needsRows = active && (active.id === 'section-spend' || active.id === 'section-geo' || active.id === 'section-risk');
      const modalOpen = !document.getElementById('dseModal').hidden;
      if (modalOpen && state.selectedDse) U.openDseModal(state);
      if (needsRows) render();
    }).catch(e => {
      if (state.sourceMode !== 'supabase') return;
      if (NS.ccr.filterKey(state.filters) !== key) return;
      state._visitsLoading = false;
      console.error('Visit rows fetch failed:', e);
      state._visitsError = e;
      const active = document.querySelector('.module.active');
      if (active && (active.id === 'section-spend' || active.id === 'section-geo' || active.id === 'section-risk')) render();
    }).finally(() => hideProgress());
  }

  function rowsPending() {
    return state.sourceMode === 'supabase' && !state.visitsReady;
  }

  function renderRowsPending(sectionId) {
    const sec = document.getElementById(sectionId);
    if (!sec) return;
    let title = 'Loading visit rows…';
    let sub = 'This module works on individual visits — they are fetched in the background for the current filters.';
    let cls = '';
    if (state._visitsError) {
      title = 'Visit rows failed to load';
      sub = String((state._visitsError && state._visitsError.message) || state._visitsError);
      cls = ' ec-empty-error';
    } else if (!NS.ccr || !NS.ccr.apiConfigured()) {
      title = 'Row-level data not connected';
      sub = 'Set <code>apiBase</code> in <code>config.js</code> and start the FastAPI backend to view this module.';
    }
    sec.innerHTML = '<div class="ec-empty' + cls + '"><div class="ec-empty-title">' + title + '</div><div class="ec-empty-sub">' + sub + '</div></div>';
    if (!state._visitsError) startVisitsLoad();
  }

  function runEngine() {
    state.engineResult = null;
    const ready = state.sourceMode === 'supabase' ? state.visitsReady : true;
    if (!ready || !NS.insightEngine || !NS.insightEngine.run || !state.dseList.length) return;
    try {
      const engineResult = NS.insightEngine.run(state);
      engineResult.recommendations = NS.recommendations.generate(state, engineResult);
      state.engineResult = engineResult;
    } catch (e) {
      console.error('Insight engine error:', e);
      state.engineResult = null;
    }
  }

  function setParamsFromUI() {
    const st = document.getElementById('paramStart').value;
    const dv = parseFloat(document.getElementById('paramDev').value);
    const hr = parseFloat(document.getElementById('paramHours').value);
    const ws = parseFloat(document.getElementById('wStart').value);
    const wr = parseFloat(document.getElementById('wRoute').value);
    const wd = parseFloat(document.getElementById('wDev').value);
    if (st) {
      const m = st.match(/^(\d{1,2}):(\d{2})$/);
      if (m) state.params.startThreshold = parseInt(m[1]) * 60 + parseInt(m[2]);
    }
    if (!isNaN(dv) && dv >= 0) state.params.devThreshold = dv;
    if (!isNaN(hr) && hr > 0) state.params.hoursThreshold = hr * 60;
    if (isFinite(ws) && isFinite(wr) && isFinite(wd)) {
      const t = ws + wr + wd;
      if (t > 0) state.params.disciplineWeights = { start: ws / t, route: wr / t, dev: wd / t };
    }
  }

  // ---------- Rendering ----------
  function render() {
    const section = document.querySelector('.module.active');
    const id = section ? section.id : 'section-exec';
    const hasData = state.loaded && (state.sourceMode === 'supabase'
      ? state.dailyMap.size > 0
      : state.allVisits.length > 0);
    if (!hasData) {
      if (section) section.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">No data loaded</div><div class="ec-empty-sub">Use <b>Load MTD Data</b>, <b>Choose .xlsx file</b> or <b>Load from Supabase</b> to begin. The dashboard reads <code>Input/MTD_CCR.xlsx</code> automatically when served over HTTP.</div></div>';
      U.renderFilterOptions(state);
      return;
    }
    U.renderFilterOptions(state);
    try {
      switch (id) {
        case 'section-exec': U.renderExec(state); break;
        case 'section-discipline': U.renderDiscipline(state); break;
        case 'section-productivity': U.renderProductivity(state); break;
        case 'section-spend':
          if (rowsPending()) { renderRowsPending('section-spend'); break; }
          U.renderSpend(state); break;
        case 'section-geo':
          if (rowsPending()) { renderRowsPending('section-geo'); break; }
          U.renderGeo(state); break;
        case 'section-risk':
          if (rowsPending()) { renderRowsPending('section-risk'); break; }
          U.renderRisk(state); break;
        case 'section-quality': U.renderQuality(state); break;
      }
    } catch (e) {
      console.error(e);
      if (section) section.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">Rendering error in this module</div><div class="ec-empty-sub">' + U.esc((e && e.message) || e) + '</div></div>';
    }
    window.dispatchEvent(new CustomEvent('dse-resize'));
  }
  state.render = render;

  function setActiveSection(id) {
    document.getElementById('filterbar').classList.remove('open');
    document.querySelectorAll('.module').forEach(m => m.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const sec = document.getElementById('section-' + id);
    if (sec) sec.classList.add('active');
    const nav = document.querySelector('.nav-item[data-section="' + id + '"]');
    if (nav) nav.classList.add('active');
    document.getElementById('pageTitle').textContent = sec ? sec.dataset.title : '';
    render();
  }

  function refreshSourceInfo() {
    const el = document.getElementById('srcInfo');
    if (!state.loaded) { el.textContent = 'No data loaded.'; } else {
      const r = state.report || {};
      el.innerHTML = '<b>Source:</b> ' + U.esc(state.filename) + '<br><b>Rows:</b> ' + M.fmtNum(r.totalRows) + ' · <b>Valid:</b> ' + M.fmtNum(r.validRows) + '<br><b>Loaded:</b> ' + (state.loadedAt || '').replace(/T/, ' ').slice(0, 19);
    }
  }

  // ---------- Loading ----------
  const DATA_CANDIDATES = [
    'Input/MTD_CCR.xlsx',
    '../Input/MTD_CCR.xlsx',
    '/Input/MTD_CCR.xlsx'
  ];

  async function fetchFileBytes(candidates) {
    let lastErr;
    for (const p of candidates) {
      try {
        const r = await fetch(p);
        if (r.ok) return await r.arrayBuffer();
        lastErr = new Error('HTTP ' + r.status + ' for ' + p);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Not found');
  }

  const yieldUI = () => new Promise(r => setTimeout(r, 25));

  async function loadFromFile(fileOrPath) {
    try {
      setSlideStatus('Loading MTD CCR data…', '');
      document.getElementById('loadslide').hidden = false;
      await yieldUI();
      let data;
      let fname = 'MTD_CCR.xlsx';
      if (fileOrPath instanceof File) {
        data = await fileOrPath.arrayBuffer();
        fname = fileOrPath.name;
      } else {
        data = await fetchFileBytes(Array.isArray(fileOrPath) ? fileOrPath : [fileOrPath]);
        fname = String((Array.isArray(fileOrPath) ? fileOrPath[0] : fileOrPath) || 'MTD_CCR.xlsx').split('/').pop();
      }
      setSlideStatus('Parsing workbook — this can take up to a minute for large files…', '');
      await yieldUI();
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      setSlideStatus('Building metrics…', '');
      await yieldUI();
      ingest(rows, fname);
    } catch (e) {
      console.error(e);
      document.getElementById('loadslide').hidden = false;
      setSlideStatus('Could not read data: ' + (e.message || e), 'error');
      toast('Could not read data: ' + (e.message || e), 'error');
    }
  }

  async function ingest(rows, name) {
    const res = await (async () => {
      if (rows.length > 20000) {
        setSlideStatus('Validating ' + M.fmtNum(rows.length) + ' rows…', '');
        await yieldUI();
      }
      return NS.processSheet(rows);
    })();
    state.report = res.report;
    state.allVisits = res.visits;
    state.filename = name;
    state.loadedAt = new Date().toISOString();
    state.loaded = true;
    state.sourceMode = 'xlsx';
    state.hierarchyOptions = null;
    state.visitsReady = false;
    state._visitsLoading = false;
    state._visitsError = null;
    state._datesSet = false;
    NS.ccr && NS.ccr.clearCaches && NS.ccr.clearCaches();
    setDefaults();
    document.getElementById('btnLoadMain').textContent = 'Reload data';
    setSlideStatus('Building metrics & rendering dashboard…', '');
    await yieldUI();
    compute();
    document.getElementById('loadslide').hidden = true;
    setSlideStatus('', '');
    toast('MTD CCR xlsx loaded successfully — ' + M.fmtNum(rows.length) + ' rows from ' + name, 'ok');
    if (res.error) { openQuality(); toast('Data issues found: ' + res.error, 'error'); }
  }

  function setDefaults() {
    const dates = [...new Set(state.allVisits.map(v => v.date))].sort();
    if (dates.length) {
      state.filters.dateFrom = dates[0];
      state.filters.dateTo = dates[dates.length - 1];
      document.getElementById('fDateFrom').value = dates[0];
      document.getElementById('fDateTo').value = dates[dates.length - 1];
      setDateBounds(dates[0], dates[dates.length - 1]);
    }
  }

  // Constrain the date pickers so only dates present in the data are selectable.
  function setDateBounds(min, max) {
    ['fDateFrom', 'fDateTo'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (min) el.min = min; else el.removeAttribute('min');
      if (max) el.max = max; else el.removeAttribute('max');
    });
  }

  // ---------- Supabase load ----------
  function resetDateInputs() {
    state.filters.dateFrom = null;
    state.filters.dateTo = null;
    const f1 = document.getElementById('fDateFrom');
    const f2 = document.getElementById('fDateTo');
    if (f1) f1.value = '';
    if (f2) f2.value = '';
  }

  function resetAllFilterInputs() {
    state.filters = {
      dateFrom: null, dateTo: null, branchLocs: [], zsms: [], asms: [], asos: [], dseCodes: [], channels: [],
      onRoute: 'ALL'
    };
    ['fBranchLoc', 'fZsm', 'fAsm', 'fAso', 'fDse', 'fChannel'].forEach(id => {
      const el = document.getElementById(id);
      if (el) for (const o of el.options) o.selected = o.value === 'ALL';
    });
    const onR = document.getElementById('fOnRoute');
    if (onR) onR.value = 'ALL';
    resetDateInputs();
  }

  async function loadSupabase() {
    if (!NS.ccr || !NS.ccr.isConfigured()) {
      setSlideStatus('Supabase is not configured — set supabaseUrl and supabaseAnonKey in config.js.', 'error');
      return;
    }
    if (NS.auth && NS.auth.ensureSession) {
      const s = await NS.auth.ensureSession();
      if (!s) { showLogin(); return; }
      applyRoleUI(s);
    }
    const slide = document.getElementById('loadslide');
    slide.hidden = false;
    document.getElementById('loadslideTitle').textContent = 'Loading from Supabase';
    setSlideStatus('Fetching dashboard summary from Supabase…', '');
    showProgress();
    let ok = false;
    try {
      await yieldUI();
      state.sourceMode = 'supabase';
      state.allVisits = [];   // visits are fetched row-level on demand instead
      state.filteredVisits = [];
      state.visitsReady = false;
      state._visitsError = null;
      if (!state._datesSet) resetDateInputs(); // first fetch is unfiltered; meta supplies the range
      U.readFilters(state);
      ok = await computeSupabase();
    } finally {
      hideProgress();
    }
    if (ok && state.loaded && state.dailyMap.size > 0) {
      document.getElementById('btnLoadMain').textContent = 'Reload data';
      slide.hidden = true;
      setSlideStatus('', '');
      toast('Dashboard loaded from Supabase — ' + M.fmtNum((state.supaMeta && state.supaMeta.total_visits) || 0) + ' visits, ' + state.dseList.length + ' DSEs', 'ok');
    } else if (ok) {
      setSlideStatus('Supabase has no data yet — upload an MTD CCR xlsx first.', 'error');
    } else {
      setSlideStatus('Supabase load failed — check config.js and the console.', 'error');
    }
  }

  async function uploadToSupabase(file) {
    if (!NS.ccr || !NS.ccr.apiConfigured()) {
      setSlideStatus('Backend not configured — set apiBase in config.js and start the FastAPI server.', 'error');
      return;
    }
    if (NS.auth && NS.auth.ensureSession) {
      const s = await NS.auth.ensureSession();
      if (!s) { showLogin(); return; }
      if (!NS.auth.isAdmin(s)) {
        setSlideStatus('Only the admin account can process (import) the data.', 'error');
        return;
      }
      applyRoleUI(s);
    }
    const slide = document.getElementById('loadslide');
    slide.hidden = false;
    document.getElementById('loadslideTitle').textContent = 'Import into Supabase';
    setSlideStatus('Uploading ' + file.name + ' — parsing and validating on the server…', '');
    await yieldUI();
    showProgress();
    try {
      const job = await NS.ccr.importXlsx(file);
      if (job.status === 'FAILED') throw new Error(job.error_message || 'import failed');
      setSlideStatus('Imported ' + M.fmtNum(job.processed_rows || 0) + ' visits — building dashboard…', '');
      await yieldUI();
      NS.ccr.clearCaches();
      // New import = fresh filter set (old selections/dates may not exist in it).
      state._datesSet = false;
      state.sourceMode = 'supabase';
      state.allVisits = [];
      state.filteredVisits = [];
      state.visitsReady = false;
      resetAllFilterInputs();
      U.readFilters(state);
      const ok = await computeSupabase();
      if (ok && state.loaded && state.dailyMap.size > 0) {
        document.getElementById('btnLoadMain').textContent = 'Reload data';
        slide.hidden = true;
        setSlideStatus('', '');
        toast(file.name + ' imported — ' + M.fmtNum(job.processed_rows || 0) + ' visits from ' + (job.total_rows || '?') + ' rows', 'ok');
      } else {
        setSlideStatus('Import finished but the dashboard could not load.', 'error');
      }
    } catch (e) {
      console.error('Upload failed:', e);
      setSlideStatus('Import failed: ' + (e.message || e), 'error');
      toast('Import failed: ' + (e.message || e), 'error');
    } finally {
      hideProgress();
    }
  }

  function toast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (type === 'error' ? ' toast-error' : '');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.className = 'toast', 2600);
  }

  function setSlideStatus(msg, type) {
    const el = document.getElementById('loadslideStatus');
    const bar = document.getElementById('loadBar');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; if (bar) bar.hidden = true; return; }
    el.textContent = msg;
    el.className = 'loadslide-status' + (type ? ' ' + type : '');
    el.hidden = false;
    if (bar) bar.hidden = !!type; // indeterminate bar while loading (no type yet)
  }

  // Ref-counted, eased progress bar for background work (summary/visits fetch,
  // import). Climbs smoothly toward ~92% while active, then snaps to 100%.
  let _progressCount = 0;
  let _progressTimer = null;
  let _progressVal = 0;

  function paintProgress(pct) {
    _progressVal = pct;
    const top = document.querySelector('#progress .progress-bar');
    if (top) top.style.width = pct + '%';
    ['loadBar', 'loginBar'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.hidden) {
        const fill = el.querySelector('.loadbar-fill');
        if (fill) fill.style.width = pct + '%';
      }
    });
  }
  function startProgressTicker() {
    if (_progressTimer) return;
    paintProgress(6);
    _progressTimer = setInterval(() => {
      const remaining = 92 - _progressVal;
      _progressVal += Math.max(0.6, remaining * 0.09);
      paintProgress(Math.min(92, _progressVal));
    }, 220);
  }
  function stopProgressTicker() {
    if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
  }
  function showProgress() {
    _progressCount++;
    const el = document.getElementById('progress');
    if (el) el.hidden = false;
    startProgressTicker();
  }
  function hideProgress() {
    _progressCount = Math.max(0, _progressCount - 1);
    if (_progressCount > 0) return;
    stopProgressTicker();
    paintProgress(100);
    setTimeout(() => {
      if (_progressCount !== 0) return; // a new request started meanwhile
      const el = document.getElementById('progress');
      if (el) el.hidden = true;
      paintProgress(0);
    }, 340);
  }

  // ---------- Auth UI ----------
  function setLoginStatus(msg, type) {
    const el = document.getElementById('loginStatus');
    const bar = document.getElementById('loginBar');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; if (bar) bar.hidden = true; return; }
    el.textContent = msg;
    el.className = 'loadslide-status' + (type ? ' ' + type : '');
    el.hidden = false;
    if (bar) bar.hidden = !!type;
  }

  function showLogin() {
    const slide = document.getElementById('loginSlide');
    if (!slide) return;
    if (!NS.ccr || !NS.ccr.isConfigured()) { slide.hidden = true; return; }
    document.getElementById('loadslide').hidden = true;
    slide.hidden = false;
    const email = document.getElementById('loginEmail');
    if (email) { email.value = ''; email.focus(); }
    setLoginStatus('', '');
  }

  // Show/hide role-dependent controls and render the user chip.
  function applyRoleUI(session) {
    const admin = session && NS.auth.isAdmin(session);
    const authed = !!session;
    const chip = document.getElementById('userChip');
    if (chip) {
      chip.hidden = !authed;
      if (authed) {
        document.getElementById('userEmail').textContent = session.user.email || '(user)';
        const roleEl = document.getElementById('userRole');
        roleEl.textContent = admin ? 'admin' : (session.user.role || 'viewer');
        roleEl.className = admin ? 'role-admin' : '';
      }
    }
    // Only admin can process data: uploading a new workbook to the server.
    const upload = document.getElementById('btnUploadSupa');
    if (upload) upload.hidden = !(admin && NS.ccr && NS.ccr.apiConfigured());
    // Signed-in viewers may not switch/load a different data source, so the
    // whole source-picker is removed for them (title, "Load from Supabase",
    // "Choose .xlsx file…" and the local-file note). Local (unauthenticated)
    // file mode is unaffected because there is no session.
    const viewer = !!(session && !admin);
    const loadBtn = document.getElementById('btnLoadMain');
    if (loadBtn) loadBtn.hidden = viewer;
    ['loadslideTitle', 'btnSupa', 'btnFile', 'loadNote'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = viewer;
    });
    // Admin-only viewer-activity report.
    const activity = document.getElementById('btnActivity');
    if (activity) activity.hidden = !admin;
    if (authed) logAccessOnce();
  }

  // Record one app-open per page load for the usage audit log.
  function logAccessOnce() {
    if (state._accessLogged) return;
    if (!NS.ccr || !NS.ccr.logAccess) return;
    state._accessLogged = true;
    NS.ccr.logAccess();
  }

  function setupLoginForm() {
    const form = document.getElementById('loginForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const pass = document.getElementById('loginPassword').value;
      if (!email || !pass) { setLoginStatus('Enter your email and password.', 'error'); return; }
      setLoginStatus('Signing in…', '');
      showProgress();
      try {
        const session = await NS.auth.signIn(email, pass);
        setLoginStatus('Signed in as ' + (session.user.email || email) + ' (' + (session.user.role || 'role pending') + ')', 'ok');
        applyRoleUI(session);
        document.getElementById('loginSlide').hidden = true;
        if (NS.ccr && NS.ccr.isConfigured()) loadSupabase();
      } catch (err) {
        setLoginStatus(err.message || 'Sign-in failed', 'error');
      } finally {
        hideProgress();
      }
    });
    document.getElementById('btnSignout').addEventListener('click', async () => {
      try { await NS.auth.signOut(); } catch (_) {}
      location.reload();
    });
    window.addEventListener('ccr-auth-required', () => {
      toast('Session expired — please sign in again.', 'error');
      showLogin();
    });
  }

  // ---------- Export ----------
  function exportCSV() {
    if (!state.dseList.length) { toast('Nothing to export', 'error'); return; }
    const rows = state.dseList.map(s => ({
      DSE_Code: s.dse_code, DSE_Name: s.dse_name, Branch: s.branch_code, 'Branch Location': s.branch_location,
      ZSM: s.zsm, ASM: s.asm, ASO: s.aso,
      WorkingDays: s.days, 'OnRoute%': pctS(s.onRoutePct), 'Intime%': pctS(s.startPct), 'Dev100%': pctS(s.devPct),
      DisciplineScore: s.disciplineScore.toFixed(2), DisciplineStatus: s.disciplineClass, RiskClass: s.riskClass, RiskScore: s.riskScore,
      ProductivityPct: pctS(s.productivityPct), AvgWorkingHours: (s.avgWorkingMin === null ? '' : (s.avgWorkingMin / 60).toFixed(2)),
      '7PlusHrPct': pctS(s.hours7Pct), AvgStoreMin: s.avgStoreMin === null ? '' : Math.round(s.avgStoreMin), Calls: s.visits,
      CallCompliancePct: pctS(s.callCompliancePct), OrderValue: s.orderSum, AvgOrder: s.avgOrder, OverallScore: s.overallScore.toFixed(2),
      RiskFlags: s.riskFlags.map(f => f.key).join(';')
    }));
    const csv = '\uFEFF' + Papa.unparse(rows);
    download('mtd_ccr_dse_' + (state.filters.dateFrom || 'all') + '_to_' + (state.filters.dateTo || 'all') + '.csv', csv);
    toast('CSV exported', 'ok');
  }

  function pctS(v) { return v === null || v === undefined ? '' : v.toFixed(1); }

  function download(name, content, type) {
    const blob = type ? new Blob([content], { type }) : new Blob([content]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  // ---------- Viewer activity (admin) ----------
  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    return d.toLocaleString();
  }

  async function openAccessReport() {
    document.getElementById('accessModal').hidden = false;
    await loadAccessReport();
  }

  async function loadAccessReport() {
    const box = document.getElementById('accessTable');
    box.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">Loading activity…</div></div>';
    if (!NS.ccr || !NS.ccr.getAccessReport) {
      box.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">Supabase not configured</div></div>';
      return;
    }
    try {
      const from = document.getElementById('accessFrom').value || null;
      const to = document.getElementById('accessTo').value || null;
      const rows = await NS.ccr.getAccessReport(from, to);
      state.accessRows = Array.isArray(rows) ? rows : [];
      renderAccessTable();
    } catch (e) {
      box.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">Could not load activity</div><div class="ec-empty-sub">' + U.esc((e && e.message) || e) + '</div></div>';
    }
  }

  function renderAccessTable() {
    const rows = state.accessRows || [];
    const box = document.getElementById('accessTable');
    if (!rows.length) {
      box.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">No activity in this range</div><div class="ec-empty-sub">Viewer visits appear here once users open the dashboard.</div></div>';
      return;
    }
    const users = new Set(), days = new Set();
    let total = 0;
    for (const r of rows) { users.add(r.email); days.add(r.day); total += (r.visits || 0); }
    let html = '<div class="toolbar" style="margin:2px 0 12px"><b>' + days.size + '</b> days · <b>' + users.size + '</b> users · <b>' + M.fmtNum(total) + '</b> opens</div>';
    html += '<table class="data"><thead><tr><th>Date</th><th>User</th><th>Role</th><th>Visits</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>';
    for (const r of rows) {
      html += '<tr><td>' + U.esc(r.day) + '</td><td>' + U.esc(r.email) + '</td><td>' + U.esc(r.role) + '</td>'
        + '<td>' + M.fmtNum(r.visits) + '</td><td>' + U.esc(fmtTs(r.first_seen)) + '</td><td>' + U.esc(fmtTs(r.last_seen)) + '</td></tr>';
    }
    box.innerHTML = html + '</tbody></table>';
  }

  function exportAccess(kind) {
    const rows = state.accessRows || [];
    if (!rows.length) { toast('Nothing to export', 'error'); return; }
    const data = rows.map(r => ({
      Date: r.day, User: r.email, Role: r.role, Visits: r.visits,
      'First seen': fmtTs(r.first_seen), 'Last seen': fmtTs(r.last_seen)
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'csv') {
      download('ccr_viewer_activity_' + stamp + '.csv', '\uFEFF' + Papa.unparse(data), 'text/csv;charset=utf-8');
      toast('CSV exported', 'ok');
    } else {
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Activity');
      XLSX.writeFile(wb, 'ccr_viewer_activity_' + stamp + '.xlsx');
      toast('XLSX exported', 'ok');
    }
  }

  async function exportStandaloneHtml() {
    const canExport = state.loaded && (state.allVisits.length > 0 || state.sourceMode === 'supabase');
    if (!canExport) { toast('Load the MTD CCR xlsx first', 'error'); return; }
    try {
      toast('Building standalone HTML…', 'info');
      const embedded = await buildEmbeddedBlock();
      let html;
      try {
        html = await buildHtmlFromAssets(embedded);
      } catch (assetErr) {
        console.warn('Asset inlining failed, falling back to live DOM:', assetErr);
        html = buildHtmlFromLiveDom(embedded);
      }
      download('MTD_CCR_Dashboard_' + (state.filters.dateFrom || 'all') + '_' + (state.filters.dateTo || 'all') + '.html', html, 'text/html;charset=utf-8');
      toast('Standalone dashboard exported — send this HTML file to management', 'ok');
    } catch (e) {
      console.error(e);
      toast('HTML export failed: ' + (e.message || e) + (location.protocol === 'file:' ? ' — double-click start_dashboard.bat and export from there' : ''), 'error');
    }
  }

  async function buildEmbeddedBlock() {
    let visits = state.allVisits;
    if (!visits.length && state.sourceMode === 'supabase') {
      if (!NS.ccr || !NS.ccr.apiConfigured()) {
        throw new Error('Backend not configured (apiBase in config.js) — needed to download the full visit set for export');
      }
      toast('Downloading full visit set for the standalone export…', 'info');
      visits = await NS.ccr.getAllVisits();
    }
    const { b64, meta, N } = await NS.encodeVisitsCompact(visits);
    // Keep the old field name so a single loader path handles it; add meta so the
    // loader knows the payload is compact visits (not a raw XLSX) and how it is encoded.
    return '<script>window.__EMBEDDED_XLSX_B64__ = "' + b64 + '"; window.__EMBEDDED_META__ = ' + JSON.stringify({ kind: 'compact', enc: meta.enc, N: N }) + ';</script>';
  }

  function buildHtmlFromLiveDom(embeddedBlock) {
    const clone = document.documentElement.cloneNode(true);
    const dataScript = Array.from(clone.querySelectorAll('script')).find(s => !s.getAttribute('src') && s.textContent.indexOf('__EMBEDDED_XLSX_B64__') !== -1);
    if (!dataScript) throw new Error('Embedded data block not found');
    // embeddedBlock is '<script>window.__EMBEDDED_XLSX_B64__ = "..."; window.__EMBEDDED_META__ = {...};</script>'
    // Reuse the existing script placeholder so the real payload is the last definition.
    const inner = embeddedBlock.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');
    dataScript.textContent = inner;
    ['loadslide', 'dseModal', 'qualityModal', 'accessModal'].forEach(id => { const el = clone.querySelector('#' + id); if (el) el.hidden = true; });
    const st = clone.querySelector('#loadslideStatus'); if (st) { st.hidden = true; st.textContent = ''; }
    const cssPaths = [...clone.querySelectorAll('link[rel="stylesheet"][href]')].map(l => l.getAttribute('href'));
    for (const href of cssPaths) {
      const css = _assetCache[href];
      if (css) {
        const style = clone.ownerDocument.createElement('style');
        style.textContent = '\n' + css + '\n';
        const link = clone.querySelector('link[href="' + href + '"]');
        if (link) link.parentNode.replaceChild(style, link);
      }
    }
    const jsPaths = [...clone.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
    for (const src of jsPaths) {
      const js = _assetCache[src];
      if (js) {
        const script = clone.ownerDocument.createElement('script');
        script.textContent = '\n' + js.replace(/<\/script>/gi, '\\</script>') + '\n';
        const old = clone.querySelector('script[src="' + src + '"]');
        if (old) old.parentNode.replaceChild(script, old);
      }
    }
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  async function warmAssetCache() {
    try {
      const r = await fetch('index.html');
      if (!r.ok) return;
      const html = await r.text();
      _assetCache['index.html'] = html;
      const refs = [
        ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]),
        ...[...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])
      ];
      for (const p of [...new Set(refs)]) {
        try {
          const res = await fetch(p);
          if (res.ok) _assetCache[p] = await res.text();
        } catch (_) {}
      }
    } catch (_) {}
  }

  async function buildHtmlFromAssets(embeddedBlock) {
    async function text(p) {
      if (_assetCache[p]) return _assetCache[p];
      const r = await fetch(p);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + p);
      return r.text();
    }
    const escScript = s => s.replace(/<\/script/gi, '<\\/script');
    let html = await text('index.html');
    const cssRefs = [...new Set([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]))];
    const jsRefs = [...new Set([...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]))];
    for (const p of cssRefs.concat(jsRefs)) { if (!(p in _assetCache)) _assetCache[p] = await text(p); }
    const missing = cssRefs.concat(jsRefs).filter(p => !_assetCache[p]);
    if (missing.length) throw new Error('Some assets could not be inlined: ' + missing.join(', '));
    for (const p of cssRefs) {
      const tag = '<link rel="stylesheet" href="' + p + '">';
      html = html.split(tag).join('<style>\n' + _assetCache[p] + '\n</style>');
    }
    for (const p of jsRefs) {
      const tag = '<script src="' + p + '"></script>';
      html = html.split(tag).join('<script>\n' + escScript(_assetCache[p]) + '\n</script>');
    }
    const appScript = '<script>\n' + escScript(_assetCache['js/app.js']) + '\n</script>';
    if (!html.includes(appScript)) throw new Error('Could not locate app script block');
    html = html.replace(appScript, () => embeddedBlock + '\n' + appScript);
    return html;
  }

  async function exportDseReport() {
    if (!state.selectedDse) { toast('Open a DSE profile first', 'error'); return; }
    const s = state.selectedDse;
    let visits = state.filteredVisits;
    if (state.sourceMode === 'supabase') {
      if (!state.visitsReady) {
        if (!NS.ccr || !NS.ccr.apiConfigured()) { toast('Backend not configured (apiBase) — cannot export rows', 'error'); return; }
        toast('Downloading visit rows…', 'info');
        try {
          visits = await NS.ccr.getVisits(state.filters);
        } catch (e) {
          toast('Visit rows failed to load: ' + (e.message || e), 'error');
          return;
        }
      } else {
        visits = state.filteredVisits;
      }
    }
    const rows = visits.filter(v => v.dse_code === s.dse_code).map(v => ({
      Date: v.date, Retailer: v.retailer_name, Channel: v.channel_name, ChannelCat: v.channel,
      Start: v.start_min === null ? '' : M.fmtTimeMin(v.start_min), End: v.end_min === null ? '' : M.fmtTimeMin(v.end_min),
      StoreMin: v.duration_min === null ? '' : Math.round(v.duration_min), OnRoute: v.on_route, DeviationM: v.deviation_m === null ? '' : Math.round(v.deviation_m),
      Productivity: v.productivity, OrderValue: v.order_value, CallCompliance: v.call_compliance, Latitude: v.latitude, Longitude: v.longitude
    }));
    const csv = '\uFEFF' + Papa.unparse(rows);
    download('dse_report_' + s.dse_code + '.csv', csv);
    toast('DSE report exported (' + rows.length + ' rows)', 'ok');
  }

  function openQuality() {
    const m = document.getElementById('qualityModal');
    document.getElementById('qualityBody').innerHTML = '';
    m.hidden = false;
  }

  // ---------- Init ----------
  function init() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => setActiveSection(btn.getAttribute('data-section')));
    });
    document.getElementById('btnFilters').addEventListener('click', () => document.getElementById('filterbar').classList.toggle('open'));
    document.getElementById('btnReset').addEventListener('click', () => {
      state.filters = {
        dateFrom: null, dateTo: null, branchLocs: [], zsms: [], asms: [], asos: [], dseCodes: [], channels: [],
        onRoute: 'ALL'
      };
      ['fBranchLoc', 'fZsm', 'fAsm', 'fAso', 'fDse', 'fChannel'].forEach(id => {
        const el = document.getElementById(id);
        for (const o of el.options) o.selected = o.value === 'ALL';
      });
      ['fDateFrom', 'fDateTo'].forEach(id => { document.getElementById(id).value = ''; });
      document.getElementById('fOnRoute').value = 'ALL';
      state.selectedDse = null;
      state.selectedDate = null;
      if (state.sourceMode === 'supabase' && state.supaMeta && state.supaMeta.date_min) {
        state.filters.dateFrom = state.supaMeta.date_min;
        state.filters.dateTo = state.supaMeta.date_max;
        document.getElementById('fDateFrom').value = state.supaMeta.date_min;
        document.getElementById('fDateTo').value = state.supaMeta.date_max;
      } else {
        setDefaults();
      }
      compute();
    });
    document.getElementById('btnCsv').addEventListener('click', exportCSV);
    document.getElementById('btnHtm').addEventListener('click', exportStandaloneHtml);
    document.getElementById('btnDseReport').addEventListener('click', exportDseReport);
    document.getElementById('btnPdf').addEventListener('click', () => { toast('Use print → Save as PDF for a full report', 'info'); window.print(); });
    document.getElementById('btnLoadMain').addEventListener('click', () => {
      if (state.loaded) {
        document.getElementById('loadslideTitle').textContent = 'Change data source';
        setSlideStatus('', '');
        document.getElementById('loadslide').hidden = false;
      } else if (location.protocol === 'file:') {
        setSlideStatus('', '');
        document.getElementById('loadslide').hidden = false;
      } else {
        loadFromFile(DATA_CANDIDATES);
      }
    });
    document.getElementById('btnFile').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', e => { if (e.target.files[0]) loadFromFile(e.target.files[0]); });
    const btnSupa = document.getElementById('btnSupa');
    if (btnSupa) {
      btnSupa.hidden = !(NS.ccr && NS.ccr.isConfigured());
      btnSupa.addEventListener('click', () => loadSupabase());
    }
    const btnUploadSupa = document.getElementById('btnUploadSupa');
    if (btnUploadSupa) {
      btnUploadSupa.addEventListener('click', () => document.getElementById('supaFileInput').click());
    }
    const supaInput = document.getElementById('supaFileInput');
    if (supaInput) supaInput.addEventListener('change', e => { if (e.target.files[0]) uploadToSupabase(e.target.files[0]); });
    document.getElementById('btnCloseLoad').addEventListener('click', () => { document.getElementById('loadslide').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { document.getElementById('dseModal').hidden = true; document.getElementById('qualityModal').hidden = true; document.getElementById('accessModal').hidden = true; document.getElementById('loadslide').hidden = true; }
    });
    document.getElementById('applySettings').addEventListener('click', () => { compute(); toast('Settings applied', 'ok'); });
    document.getElementById('modalClose').addEventListener('click', () => document.getElementById('dseModal').hidden = true);
    document.getElementById('qualityClose').addEventListener('click', () => document.getElementById('qualityModal').hidden = true);
    document.getElementById('dseModal').addEventListener('click', e => { if (e.target.id === 'dseModal') document.getElementById('dseModal').hidden = true; });

    document.getElementById('btnActivity').addEventListener('click', openAccessReport);
    document.getElementById('accessClose').addEventListener('click', () => document.getElementById('accessModal').hidden = true);
    document.getElementById('accessRefresh').addEventListener('click', loadAccessReport);
    document.getElementById('accessCsv').addEventListener('click', () => exportAccess('csv'));
    document.getElementById('accessXlsx').addEventListener('click', () => exportAccess('xlsx'));
    document.getElementById('accessModal').addEventListener('click', e => { if (e.target.id === 'accessModal') document.getElementById('accessModal').hidden = true; });

    const fb = document.getElementById('filterbar');
    ['fDateFrom', 'fDateTo', 'fBranchLoc', 'fZsm', 'fAsm', 'fAso', 'fDse', 'fChannel', 'fOnRoute'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => compute());
    });

    let debounce;
    window.addEventListener('resize', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => NS.charts.resizeAll(), 150);
    });
    window.addEventListener('dse-resize', () => {
      NS.charts.resizeAll();
    });

    U.renderFilterOptions(state);
    refreshSourceInfo();
    warmAssetCache();
    setupLoginForm();
    applyRoleUI(NS.auth && NS.auth.load ? NS.auth.load() : null);
    if (window.__EMBEDDED_XLSX_B64__) {
      loadEmbeddedData();
    } else if (NS.ccr && NS.ccr.isConfigured()) {
      // Live DB mode — require a signed-in session before loading any data.
      NS.auth.ensureSession().then(session => {
        if (!session) { showLogin(); return; }
        applyRoleUI(session);
        loadSupabase();
      }).catch(() => showLogin());
    } else if (location.protocol !== 'file:') {
      loadFromFile(DATA_CANDIDATES);
    } else {
      document.getElementById('loadslide').hidden = false;
    }
  }

  async function loadEmbeddedData() {
    try {
      const b64 = window.__EMBEDDED_XLSX_B64__;
      const meta = window.__EMBEDDED_META__ || { kind: 'xlsx' };
      setSlideStatus('Decoding embedded data… 0%', '');
      document.getElementById('loadslide').hidden = false;
      await yieldUI();

      // Chunked base64 -> bytes so the UI stays responsive and shows progress.
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      const CHUNK = 400000;
      let reported = -10;
      for (let i = 0; i < len; i += CHUNK) {
        const end = Math.min(i + CHUNK, len);
        for (let j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
        const pct = Math.floor((end / len) * 100);
        if (pct - reported >= 10) {
          reported = pct;
          setSlideStatus('Decoding embedded data… ' + pct + '%', '');
          await yieldUI();
        }
      }

      if (meta.kind === 'compact') {
        await loadCompactEmbedded(b64, meta);
        return;
      }

      // Legacy fallback: payload was a raw XLSX workbook (old exports).
      setSlideStatus('Parsing workbook — this can take up to a minute for large files…', '');
      await yieldUI();
      const wb = XLSX.read(bytes.buffer, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      setSlideStatus('Building metrics…', '');
      await yieldUI();
      ingest(rows, 'MTD_CCR.xlsx');
    } catch (e) {
      console.error(e);
      document.getElementById('loadslide').hidden = false;
      setSlideStatus('Could not read embedded data: ' + (e.message || e), 'error');
      toast('Could not read embedded data: ' + (e.message || e), 'error');
    }
  }

  async function loadCompactEmbedded(b64, meta) {
    try {
      setSlideStatus('Decompressing data…', '');
      await yieldUI();
      const visits = await NS.decodeVisitsCompact(b64);
      const report = { totalRows: visits.length, validRows: visits.length };
      state.report = report;
      state.allVisits = visits;
      state.filename = 'MTD_CCR.xlsx';
      state.loadedAt = new Date().toISOString();
      state.loaded = true;
      state.sourceMode = 'xlsx';
      state.hierarchyOptions = null;
      state.visitsReady = false;
      state._datesSet = false;
      setDefaults();
      document.getElementById('btnLoadMain').textContent = 'Reload data';
      await yieldUI();
      compute();
      document.getElementById('loadslide').hidden = true;
      setSlideStatus('', '');
      toast('MTD CCR data loaded — ' + M.fmtNum(visits.length) + ' visits', 'ok');
    } catch (e) {
      console.error(e);
      document.getElementById('loadslide').hidden = false;
      setSlideStatus('Could not decode embedded data: ' + (e.message || e), 'error');
      toast('Could not decode embedded data: ' + (e.message || e), 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  NS.app = { state, compute, loadFromFile, exportCSV };
})();