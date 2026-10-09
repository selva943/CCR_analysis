(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});

  const DEFAULTS = {
    startThreshold: 570,
    devThreshold: 100,
    hoursThreshold: 420,
    storeOutlierMinutes: 240,
    disciplineWeights: { start: 0.4, route: 0.3, dev: 0.3 },
    riskWeights: {
      lateStart: 20, offRoute: 20, highDeviation: 20, lowProductivity: 20,
      lowHours: 10, lowCallCompliance: 10, excessStoreTime: 10, lowOrderValue: 10
    },
    rankingWeights: { discipline: 0.4, productivity: 0.35, efficiency: 0.25 },
    riskThresh: { late: 75, route: 90, dev: 90, callComp: 80, storeMult: 1.5, orderMult: 0.5, lowHours: 420 }
  };

  function pct(n, d) {
    return d > 0 ? (n / d) * 100 : null;
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function percentile(arr, p) {
    if (!arr || !arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const idx = ((a.length - 1) * p) / 100;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
  }

  function round1(v) { return v === null || v === undefined ? null : Math.round(v * 10) / 10; }
  function round2(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }

  function buildDaily(visits) {
    const map = new Map();
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const key = v.dse_code + '|' + v.date;
      let d = map.get(key);
      if (!d) {
        d = {
          dse_code: v.dse_code, dse_name: v.dse_name, date: v.date,
          branch_code: v.branch_code, branch_location: v.branch_location, zsm: v.zsm, asm: v.asm, aso: v.aso,
          day_start_min: v.day_start_min, start_has: v.day_start_min !== null,
          visits: 0, callsMade: 0, callCompValid: 0, callCompYes: 0, below5: 0,
          prodCalls: 0, prodOnRoute: 0, offRouteProdYes: 0,
          onRouteValid: 0, onRouteYes: 0, offRouteYes: 0, onRouteDevPass: 0,
          devValid: 0, devPass: 0, devSum: 0, devMax: 0, highDev: 0,
          intimeSum: 0, intimeCount: 0,
          orderSum: 0, orderCount: 0, storeMin: 0, storeCount: 0, storeDurations: [],
          minStart: null, maxEnd: null, workingMin: null,
          firstVisitStart: null, lastVisitEnd: null,
          retailers: new Set(), routes: new Set()
        };
        map.set(key, d);
      }
      d.visits++;
      if (v.calls_made === 1) d.callsMade++;
      if (v.below_5 === 'YES') d.below5++;
      if (v.productivity === 'YES') { d.prodCalls++; if (v.on_route === 'YES') d.prodOnRoute++; else if (v.on_route === 'NO') d.offRouteProdYes++; }
      if (v.on_route !== 'UNKNOWN') { d.onRouteValid++; if (v.on_route === 'YES') d.onRouteYes++; else d.offRouteYes++; }
      if (v.on_route === 'YES' && v.deviation_m !== null && v.deviation_m <= DEFAULTS.devThreshold) d.onRouteDevPass++;
      if (v.intime_min !== null && isFinite(v.intime_min)) { d.intimeSum += v.intime_min; d.intimeCount++; }
      if (v.deviation_m !== null) {
        d.devValid++;
        d.devSum += v.deviation_m;
        if (v.deviation_m > d.devMax) d.devMax = v.deviation_m;
        if (v.deviation_m <= DEFAULTS.devThreshold) d.devPass++;
        else d.highDev++;
      }
      if (v.order_value !== null) { d.orderSum += v.order_value; d.orderCount++; }
      if (v.duration_min !== null && v.duration_min >= 0) { d.storeMin += v.duration_min; d.storeCount++; d.storeDurations.push(v.duration_min); }
      if (v.call_compliance !== null) { d.callCompValid++; if (v.call_compliance === 'YES') d.callCompYes++; }
      if (v.start_min !== null && (d.minStart === null || v.start_min < d.minStart)) d.minStart = v.start_min;
      if (v.end_min !== null && v.end_min > d.maxEnd) d.maxEnd = v.end_min;
      if (v.start_min !== null && (d.firstVisitStart === null || v.start_min < d.firstVisitStart)) d.firstVisitStart = v.start_min;
      if (v.end_min !== null && v.end_min > d.lastVisitEnd) d.lastVisitEnd = v.end_min;
      d.retailers.add(v.retailer_code);
      if (v.route_name != null && v.route_name !== '') d.routes.add(v.route_name);
    }
    for (const d of map.values()) finalizeDaily(d);
    return map;
  }

  function finalizeDaily(d) {
    // Effective start = day's earliest store visit Start Time (same rule as Discipline);
    // falls back to the reported Day Start Time only when no visit start exists.
    if (d.firstVisitStart !== null && d.firstVisitStart !== undefined) { d.day_start_min = d.firstVisitStart; d.start_has = true; }
    d.start_pass = d.start_has ? (d.day_start_min <= DEFAULTS.startThreshold) : null;
    d.start_status = d.start_pass === null ? null : (d.start_pass ? 'ON TIME' : 'LATE');
    d.onRouteRate = pct(d.onRouteYes, d.onRouteValid);
    d.devRate = pct(d.devPass, d.devValid);
    d.avgDev = d.devValid ? d.devSum / d.devValid : null;
    d.callCompliancePct = pct(d.callCompYes, d.callCompValid);
    d.prodPct = pct(d.prodOnRoute, d.onRouteYes);
    if (d.minStart !== null && d.maxEnd !== null) {
      const wh = d.maxEnd - d.minStart;
      if (wh >= 0 && wh <= 18 * 60) d.workingMin = wh;
    }
    d.hoursOk = d.workingMin !== null && d.workingMin >= DEFAULTS.hoursThreshold;
    const ws = d.start_has ? DEFAULTS.disciplineWeights.start : 0;
    const wr = DEFAULTS.disciplineWeights.route;
    const wd = DEFAULTS.disciplineWeights.dev;
    const totalW = ws + wr + wd || 1;
    let sc = 0;
    if (d.start_pass !== null) sc += ws * (d.start_pass ? 100 : 0);
    if (d.onRouteRate !== null) sc += wr * d.onRouteRate;
    if (d.devRate !== null) sc += wd * d.devRate;
    d.dayScore = sc / totalW;
    d.dayClass = classifyScore(d.dayScore);
    d.storeMedian = (d.storeDurations && d.storeDurations.length)
      ? median(d.storeDurations)
      : (d.storeMedian === undefined ? null : d.storeMedian);
    return d;
  }

  function hydrateDailyRows(rows) {
    const map = new Map();
    for (const r of rows) {
      const d = Object.assign({}, r);
      d.firstVisitStart = (r.minStart === undefined ? null : r.minStart);
      d.lastVisitEnd = (r.maxEnd === undefined ? null : r.maxEnd);
      d.day_start_min = (r.firstRowDayStart === undefined || r.firstRowDayStart === null) ? null : r.firstRowDayStart;
      d.start_has = d.day_start_min !== null;
      d.workingMin = r.workingMin === undefined ? null : r.workingMin;
      d.retailers = new Set();
      d.routes = new Set();
      d.storeDurations = null;
      finalizeDaily(d);
      map.set(d.dse_code + '|' + d.date, d);
    }
    return map;
  }

  function classifyScore(score) {
    if (score === null || score === undefined) return 'N/A';
    if (score >= 80) return 'GOOD';
    if (score >= 60) return 'MODERATE';
    return 'RISK';
  }

  function buildDSE(dailyMap, visits) {
    const byDse = new Map();
    for (const d of dailyMap.values()) {
      let s = byDse.get(d.dse_code);
      if (!s) {
        s = {
          dse_code: d.dse_code, dse_name: d.dse_name, branch_code: d.branch_code, branch_location: d.branch_location,
          zsm: d.zsm, asm: d.asm, aso: d.aso,
          days: 0, startDays: 0, startPassDays: 0,
          visits: 0, callsMade: 0, callCompValid: 0, callCompYes: 0,
          prodCalls: 0, prodOnRoute: 0, onRouteValid: 0, onRouteYes: 0, ccrPlan: 0, ccrComp: 0,
          devValid: 0, devPass: 0, devSum: 0, devMax: 0, highDevDays: 0,
          intimeSum: 0, intimeCount: 0, startMinSum: 0, startDayCount: 0, endMinSum: 0, endDayCount: 0,
          orderSum: 0, orderCount: 0, storeMin: 0, storeCount: 0, workingDays: 0, workingMinSum: 0,
          lateDays: 0, offRouteDays: 0, routeCount: 0, dailyStoreMedians: [],
          daysWithDev: 0
        };
        byDse.set(d.dse_code, s);
      }
      s.days++;
      if (d.start_has) { s.startDays++; if (d.start_pass) s.startPassDays++; else s.lateDays++; }
      if (d.workingMin !== null) { s.workingDays++; s.workingMinSum += d.workingMin; }
      s.visits += d.visits;
      s.callsMade += d.callsMade;
      s.callCompValid += d.callCompValid;
      s.callCompYes += d.callCompYes;
      s.prodCalls += d.prodCalls;
      s.prodOnRoute += d.prodOnRoute;
      s.onRouteValid += d.onRouteValid;
      s.onRouteYes += d.onRouteYes;
      s.devValid += d.devValid;
      s.devPass += d.devPass;
      s.devSum += d.devSum;
      if (d.devMax > s.devMax) s.devMax = d.devMax;
      s.orderSum += d.orderSum;
      s.orderCount += d.orderCount;
      s.storeMin += d.storeMin;
      s.storeCount += d.storeCount;
      if (d.offRouteYes > 0) { s.offRouteDays++; s.routeCount++; }
      if (d.highDev > 0) { s.highDevDays++; s.daysWithDev++; }
      s.ccrPlan += d.onRouteYes;
      s.ccrComp += d.onRouteDevPass;
      s.intimeSum += d.intimeSum;
      s.intimeCount += d.intimeCount;
      if (d.minStart !== null) { s.startMinSum += d.minStart; s.startDayCount++; }
      if (d.maxEnd !== null) { s.endMinSum += d.maxEnd; s.endDayCount++; }
      if (d.storeMedian !== null) s.dailyStoreMedians.push(d.storeMedian);
    }
    const out = [];
    for (const s of byDse.values()) {
      s.startPct = pct(s.startPassDays, s.startDays);
      s.onRoutePct = pct(s.onRouteYes, s.onRouteValid);
      s.devPct = pct(s.devPass, s.devValid);
      s.avgDev = s.devValid ? s.devSum / s.devValid : null;
      s.avgWorkingMin = s.workingDays ? s.workingMinSum / s.workingDays : null;
      s.hours7Count = 0;
      let h7 = 0;
      for (const d of dailyMap.values()) {
        if (d.dse_code !== s.dse_code) continue;
        if (d.workingMin !== null && d.workingMin >= DEFAULTS.hoursThreshold) h7++;
      }
      s.hours7Count = h7;
      s.hours7Pct = pct(h7, s.workingDays);
      s.callCompliancePct = pct(s.callCompYes, s.callCompValid);
      s.productivityPct = pct(s.prodOnRoute, s.onRouteYes);
      s.prodRawPct = pct(s.prodCalls, s.visits);
      s.avgStoreMin = s.storeCount ? s.storeMin / s.storeCount : null;
      s.avgInTimeMin = s.intimeCount ? s.intimeSum / s.intimeCount : null;
      s.medianStoreMin = median(s.dailyStoreMedians);
      s.avgOrder = s.orderCount ? s.orderSum / s.orderCount : null;
      s.avgOrderPerVisit = s.visits ? s.orderSum / s.visits : null;
      s.avgOrderPerStoreHour = s.storeMin ? (s.orderSum / (s.storeMin / 60)) : null;
      s.prodPerStoreHour = s.storeMin ? (s.prodCalls / (s.storeMin / 60)) : null;
      s.lateRate = pct(s.lateDays, s.startDays);
      s.offRouteRate = 100 - (s.onRoutePct === null ? 0 : s.onRoutePct);
      s.highDevRate = 100 - (s.devPct === null ? 0 : s.devPct);
      s.avgStartMin = s.startDayCount ? s.startMinSum / s.startDayCount : null;

      const w = DEFAULTS.disciplineWeights;
      const totalW = w.start + w.route + w.dev || 1;
      s.disciplineScore = ((s.startPct === null ? 0 : s.startPct) * w.start
        + (s.onRoutePct === null ? 0 : s.onRoutePct) * w.route
        + (s.devPct === null ? 0 : s.devPct) * w.dev) / totalW;
      s.disciplineClass = classifyScore(s.disciplineScore);
      s.strictGood = s.startPct === 100 && s.onRoutePct === 100 && s.devPct === 100;
      out.push(s);
    }
    return out;
  }

  function avgStorePerDay(visits) {
    const byDate = new Map();
    for (const v of visits) {
      if (v.duration_min === null || v.duration_min < 0) continue;
      const a = byDate.get(v.date);
      if (a) a.push(v.duration_min); else byDate.set(v.date, [v.duration_min]);
    }
    if (!byDate.size) return null;
    let sum = 0;
    for (const a of byDate.values()) sum += a.reduce((x, y) => x + y, 0) / a.length;
    return sum / byDate.size;
  }

  function avgStorePerDayFromDaily(dailyMap) {
    const byDate = new Map();
    for (const d of dailyMap.values()) {
      if (!d.storeCount) continue;
      const e = byDate.get(d.date);
      if (e) { e.sum += d.storeMin; e.n += d.storeCount; } else byDate.set(d.date, { sum: d.storeMin, n: d.storeCount });
    }
    if (!byDate.size) return null;
    let sum = 0;
    for (const e of byDate.values()) sum += e.sum / e.n;
    return sum / byDate.size;
  }

  function computeBenchmarks(dseList, allVisits, dailyMap) {
    const useVisits = !!(allVisits && allVisits.length);
    const team = {
      dseCount: dseList.length,
      activeDseCount: dseList.filter(s => s.days >= 1).length,
      disciplineAvg: meanArr(dseList.map(s => s.disciplineScore)),
      productivityAvg: meanArr(dseList.map(s => s.productivityPct)),
      onRouteAvg: meanArr(dseList.map(s => s.onRoutePct)),
      startAvg: meanArr(dseList.map(s => s.startPct)),
      devAvg: meanArr(dseList.map(s => s.devPct)),
      callCompAvg: meanArr(dseList.map(s => s.callCompliancePct)),
      avgWorkingMin: (() => { const totMin = sumArr(dseList.map(s => s.workingMinSum || 0)); const totDays = sumArr(dseList.map(s => s.workingDays || 0)); return totDays ? totMin / totDays : null; })(),
      avgStoreMin: meanArr(dseList.map(s => s.avgStoreMin)),
      avgOrder: meanArr(dseList.map(s => s.avgOrder)),
      visits: useVisits ? allVisits.length : sumArr(dseList.map(s => s.visits)),
      totalOrder: sumArr(dseList.map(s => s.orderSum)),
      storeHours: sumArr(dseList.map(s => s.storeMin)) / 60,
      callsMade: sumArr(dseList.map(s => s.callsMade)),
      prodCalls: sumArr(dseList.map(s => s.prodCalls)),
      prodOnRoute: sumArr(dseList.map(s => s.prodOnRoute)),
      onRouteYes: sumArr(dseList.map(s => s.onRouteYes)),
      medianDiscipline: median(dseList.map(s => s.disciplineScore)),
      medianProductivity: median(dseList.map(s => s.productivityPct)),
      medianStoreMin: median(dseList.map(s => s.avgStoreMin)),
      medianOrder: median(dseList.map(s => s.avgOrder)),
      medianWorkingMin: median(dseList.map(s => s.avgWorkingMin)),
      ccrPlan: sumArr(dseList.map(s => s.ccrPlan)),
      ccrCompliance: sumArr(dseList.map(s => s.ccrComp)),
      avgStorePerDayMin: useVisits ? avgStorePerDay(allVisits) : avgStorePerDayFromDaily(dailyMap || new Map())
    };
    team.ccrCompliancePct = pct(team.ccrCompliance, team.ccrPlan);
    const startDaysTotal = sumArr(dseList.map(s => s.startDayCount));
    const endDaysTotal = sumArr(dseList.map(s => s.endDayCount));
    const intimeTotal = sumArr(dseList.map(s => s.intimeCount));
    team.avgStartMin = startDaysTotal ? sumArr(dseList.map(s => s.startMinSum)) / startDaysTotal : null;
    team.avgEndMin = endDaysTotal ? sumArr(dseList.map(s => s.endMinSum)) / endDaysTotal : null;
    team.avgInTimeMin = intimeTotal ? sumArr(dseList.map(s => s.intimeSum)) / intimeTotal : null;
    const byBranch = groupBy(dseList, 'branch_code');
    const byAsm = groupBy(dseList, 'asm');
    const byZsm = groupBy(dseList, 'zsm');
    function grpAvg(map, key, fn) {
      const arr = [];
      for (const k in map) if (map[k]) arr.push({ key: k, value: fn(map[k]) });
      return arr;
    }
    team.branches = grpAvg(byBranch, 'branch_code', g => g.reduce((a, s) => a + s.disciplineScore, 0) / g.length);
    team.asmList = grpAvg(byAsm, 'asm', g => g.reduce((a, s) => a + s.disciplineScore, 0) / g.length);
    team.zsmList = grpAvg(byZsm, 'zsm', g => g.reduce((a, s) => a + s.disciplineScore, 0) / g.length);
    return team;
  }

  function meanArr(arr) {
    const a = arr.filter(x => x !== null && x !== undefined && isFinite(x));
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  }
  function sumArr(arr) {
    return arr.reduce((x, y) => x + (y || 0), 0);
  }
  function groupBy(arr, key) {
    const m = {};
    for (const o of arr) {
      const k = o[key] === '' || o[key] === null || o[key] === undefined ? '(blank)' : String(o[key]);
      (m[k] = m[k] || []).push(o);
    }
    return m;
  }

  function computeRisk(dseList, team) {
    const R = DEFAULTS.riskWeights, T = DEFAULTS.riskThresh;
    for (const s of dseList) {
      const flags = [];
      let score = 0;
      if (s.startPct !== null && s.startPct < T.late) { flags.push({ key: 'Late Start', weight: R.lateStart, detail: s.startPct.toFixed(0) + '% on-time starts' }); score += R.lateStart; }
      if (s.onRoutePct !== null && s.onRoutePct < T.route) { flags.push({ key: 'Off Route', weight: R.offRoute, detail: s.onRoutePct.toFixed(0) + '% on route' }); score += R.offRoute; }
      if (s.devPct !== null && s.devPct < T.dev) { flags.push({ key: 'High Deviation', weight: R.highDeviation, detail: s.devPct.toFixed(0) + '% deviation-compliant' }); score += R.highDeviation; }
      if (s.productivityPct !== null && team.medianProductivity !== null && s.productivityPct < team.medianProductivity) { flags.push({ key: 'Low Productivity', weight: R.lowProductivity, detail: 'Productivity ' + s.productivityPct.toFixed(0) + '% vs team median ' + team.medianProductivity.toFixed(0) + '%' }); score += R.lowProductivity; }
      if (s.avgWorkingMin !== null && s.avgWorkingMin < T.lowHours) { flags.push({ key: 'Low Work Hours', weight: R.lowHours, detail: 'Avg ' + fmtHM(Math.round(s.avgWorkingMin)) }); score += R.lowHours; }
      if (s.callCompliancePct !== null && s.callCompliancePct < T.callComp) { flags.push({ key: 'Low Call Compliance', weight: R.lowCallCompliance, detail: s.callCompliancePct.toFixed(0) + '% compliant calls' }); score += R.lowCallCompliance; }
      if (s.avgStoreMin !== null && team.medianStoreMin !== null && s.avgStoreMin > team.medianStoreMin * T.storeMult) { flags.push({ key: 'Excessive Store Time', weight: R.excessStoreTime, detail: 'Avg ' + Math.round(s.avgStoreMin) + ' min vs team median ' + Math.round(team.medianStoreMin) + ' min' }); score += R.excessStoreTime; }
      if (s.avgOrder !== null && team.medianOrder !== null && s.avgOrder < team.medianOrder * T.orderMult) { flags.push({ key: 'Low Order Value', weight: R.lowOrderValue, detail: 'Avg ₹' + fmtNum(s.avgOrder) + ' vs team median ₹' + fmtNum(team.medianOrder) }); score += R.lowOrderValue; }
      s.riskScore = score;
      s.riskFlags = flags;
      s.riskClass = score <= 20 ? 'LOW' : score <= 40 ? 'MODERATE' : score <= 60 ? 'HIGH' : 'CRITICAL';
    }
  }

  function computeRanking(dseList, team) {
    const W = DEFAULTS.rankingWeights;
    const maxProd = Math.max.apply(null, dseList.map(s => s.productivityPct || 0));
    const maxEff = Math.max.apply(null, dseList.map(s => s.prodPerStoreHour || 0));
    for (const s of dseList) {
      const prodScore = maxProd > 0 ? Math.min(100, ((s.productivityPct || 0) / maxProd) * 100) : 0;
      const effScore = maxEff > 0 ? Math.min(100, ((s.prodPerStoreHour || 0) / maxEff) * 100) : 0;
      s.prodScore = prodScore;
      s.effScore = effScore;
      s.overallScore = W.discipline * s.disciplineScore + W.productivity * prodScore + W.efficiency * effScore;
    }
  }

  // ---------- Discipline (route + deviation + start-time) ----------
  function isDisciplineEligible(v) {
    return v.on_route === 'YES'
      && v.deviation_m !== null && v.deviation_m <= DEFAULTS.devThreshold
      && v.start_min !== null && v.start_min <= DEFAULTS.startThreshold;
  }

  function computeDiscipline(visits) {
    const groups = new Map();
    for (const v of visits) {
      if (!v.dse_code || !v.date) continue;
      const key = v.dse_code + '|' + v.date;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(v);
    }
    const byDse = new Map(), byDate = new Map();
    for (const [key, rows] of groups.entries()) {
      rows.sort((a, b) => (a.start_min === null ? Infinity : a.start_min) - (b.start_min === null ? Infinity : b.start_min));
      const sep = key.indexOf('|');
      const code = key.slice(0, sep), date = key.slice(sep + 1);
      // One hit per DSE-day: the day's FIRST store visit (earliest start) must satisfy all parameters
      const firstVisit = rows[0];
      const hit = firstVisit && isDisciplineEligible(firstVisit) ? 1 : 0;
      let d = byDse.get(code);
      if (!d) { d = { dse_code: code, eligible: 0, days: 0 }; byDse.set(code, d); }
      d.eligible += hit; d.days++;
      let dt = byDate.get(date);
      if (!dt) { dt = { date: date, eligible: 0, dseCount: 0 }; byDate.set(date, dt); }
      dt.eligible += hit; dt.dseCount++;
    }
    return { byDse, byDate };
  }

  function computeDisciplineFromDaily(dailyMap) {
    // Same one-hit-per-DSE-day rule as computeDiscipline, using the day's FIRST visit
    // fields accumulated by buildDaily / the SQL RPC (firstOnRoute/firstDevM/firstStartMin).
    const byDse = new Map(), byDate = new Map();
    for (const d of dailyMap.values()) {
      if (!d.dse_code || !d.date) continue;
      const firstVisit = { on_route: d.firstOnRoute, deviation_m: d.firstDevM, start_min: d.firstStartMin };
      const hit = isDisciplineEligible(firstVisit) ? 1 : 0;
      let e = byDse.get(d.dse_code);
      if (!e) { e = { dse_code: d.dse_code, eligible: 0, days: 0 }; byDse.set(d.dse_code, e); }
      e.eligible += hit; e.days++;
      let dt = byDate.get(d.date);
      if (!dt) { dt = { date: d.date, eligible: 0, dseCount: 0 }; byDate.set(d.date, dt); }
      dt.eligible += hit; dt.dseCount++;
    }
    return { byDse, byDate };
  }

  function classifyDiscipline(pct) {
    if (pct === null || pct === undefined || !isFinite(pct)) return null;
    if (pct > 90) return 'GOOD';
    if (pct >= 85) return 'MODERATE';
    return 'RISK';
  }

  function applyDiscipline(dseList, disc) {
    const summary = { total: dseList.length, good: 0, moderate: 0, risk: 0, pctGood: 0, pctRisk: 0 };
    for (const s of dseList) {
      const d = disc ? disc.byDse.get(s.dse_code) : null;
      s.eligibleCount = d ? d.eligible : 0;
      s.discDays = d ? d.days : s.days;
      s.discPct = s.discDays > 0 ? (s.eligibleCount / s.discDays) * 100 : 0;
      s.discStatus = classifyDiscipline(s.discPct);
      if (s.discStatus === 'GOOD') summary.good++;
      else if (s.discStatus === 'MODERATE') summary.moderate++;
      else if (s.discStatus === 'RISK') summary.risk++;
    }
    summary.pctGood = summary.total ? (summary.good / summary.total) * 100 : 0;
    summary.pctRisk = summary.total ? (summary.risk / summary.total) * 100 : 0;
    return summary;
  }

  // ---------- Productivity (centralized layer for the Productivity page) ----------
  // Reuses existing conventions only:
  //   On Route / Productivity Y-N fields from processSheet (missing → 'UNKNOWN', never counted as YES)
  //   dailyMap from buildDaily: d.minStart = daily MIN(Start Time), d.workingMin = MAX(End Time) − MIN(Start Time)
  //   thresholds from app params (defaults 09:30 / 7h)
  function computeProductivity(visits, dailyMap, params) {
    const p = params || DEFAULTS;
    const startTh = typeof p.startThreshold === 'number' && isFinite(p.startThreshold) ? p.startThreshold : DEFAULTS.startThreshold;
    const hoursTh = typeof p.hoursThreshold === 'number' && isFinite(p.hoursThreshold) ? p.hoursThreshold : DEFAULTS.hoursThreshold;

    let onRouteYes = 0, onRouteProdYes = 0, offRouteYes = 0, offRouteProdYes = 0, prodYes = 0;
    let totalVisits;
    if (visits && visits.length) {
      for (let i = 0; i < visits.length; i++) {
        const v = visits[i];
        const isProd = v.productivity === 'YES';
        if (v.on_route === 'YES') { onRouteYes++; if (isProd) onRouteProdYes++; }
        else if (v.on_route === 'NO') { offRouteYes++; if (isProd) offRouteProdYes++; }
        if (isProd) prodYes++;
      }
      totalVisits = visits.length;
    } else {
      // Row-level visits not loaded (Supabase fast path): derive the same counts from daily accumulators.
      for (const d of dailyMap.values()) {
        onRouteYes += d.onRouteYes;
        onRouteProdYes += d.prodOnRoute;
        offRouteYes += d.offRouteYes;
        offRouteProdYes += d.offRouteProdYes || 0;
        prodYes += d.prodCalls;
      }
      totalVisits = sumArr([...dailyMap.values()].map(d => d.visits));
    }

    let startOnTime = 0, startLate = 0, mhDays = 0, mhTargetMet = 0, mhBelow = 0, mhSum = 0;
    // Per-segment productivity accumulators (numerator = on-route productive calls,
    // denominator = on-route calls) for DSE-days falling in each segment.
    let sOnOnR = 0, sOnProd = 0, sLateOnR = 0, sLateProd = 0;
    let mMetOnR = 0, mMetProd = 0, mBlwOnR = 0, mBlwProd = 0;
    for (const d of dailyMap.values()) {
      if (d.minStart !== null && isFinite(d.minStart)) {
        const onTime = d.minStart <= startTh;
        if (onTime) { startOnTime++; sOnOnR += d.onRouteYes; sOnProd += d.prodOnRoute; }
        else { startLate++; sLateOnR += d.onRouteYes; sLateProd += d.prodOnRoute; }
      }
      if (d.workingMin !== null && isFinite(d.workingMin)) {
        mhDays++;
        mhSum += d.workingMin;
        if (d.workingMin >= hoursTh) { mhTargetMet++; mMetOnR += d.onRouteYes; mMetProd += d.prodOnRoute; }
        else { mhBelow++; mBlwOnR += d.onRouteYes; mBlwProd += d.prodOnRoute; }
      }
    }

    return {
      totalVisits: totalVisits,
      onRouteYes: onRouteYes, onRouteProdYes: onRouteProdYes,
      offRouteYes: offRouteYes, offRouteProdYes: offRouteProdYes,
      prodYes: prodYes,
      primaryPct: pct(onRouteProdYes, onRouteYes),
      onRouteProdPct: pct(onRouteProdYes, prodYes),
      offRouteProdPct: pct(offRouteProdYes, prodYes),
      startOnTime: startOnTime, startLate: startLate,
      startOnTimePct: pct(sOnProd, sOnOnR), startLatePct: pct(sLateProd, sLateOnR),
      mhDays: mhDays, mhTargetMet: mhTargetMet, mhBelow: mhBelow,
      mhMetPct: pct(mMetProd, mMetOnR), mhBelowPct: pct(mBlwProd, mBlwOnR),
      avgMarketMin: mhDays ? mhSum / mhDays : null,
      startThreshold: startTh, hoursThreshold: hoursTh
    };
  }

  function buildAll(filteredVisits) {
    const dailyMap = buildDaily(filteredVisits);
    const dseList = buildDSE(dailyMap, filteredVisits);
    const team = computeBenchmarks(dseList, filteredVisits, dailyMap);
    computeRisk(dseList, team);
    computeRanking(dseList, team);
    const discipline = computeDiscipline(filteredVisits);
    return { dailyMap, dseList, team, discipline };
  }

  function fmtHM(min) {
    if (min === null || min === undefined || !isFinite(min)) return '–';
    const neg = min < 0;
    min = Math.abs(min);
    let h = Math.floor(min / 60), m = Math.round(min % 60);
    if (m === 60) { h++; m = 0; }
    const out = h === 0 ? m + 'm' : (m ? h + 'h ' + m + 'm' : h + 'h');
    return (neg ? '-' : '') + out;
  }
  function fmtHF(min) {
    if (min === null || min === undefined || !isFinite(min)) return '–';
    return (min / 60).toFixed(1) + 'h';
  }
  function fmtNum(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const d = digits === undefined ? 0 : digits;
    return n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  function fmtMoney(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const d = digits === undefined ? 0 : digits;
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  function fmtMin(m) {
    if (m === null || m === undefined || !isFinite(m)) return '–';
    return Math.round(m) + 'm';
  }
  function fmtTimeMin(m, withSeconds) {
    if (m === null || m === undefined || !isFinite(m)) return '–';
    let mm = Math.round(m);
    const h = Math.floor(mm / 60), mi = h > 0 ? mm % 60 : mm;
    const ap = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    if (h === 0) return mi + 'm';
    return hr + ':' + String(mi).padStart(2, '0') + ' ' + ap;
  }
  function fmtPct(v) {
    return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(1) + '%';
  }

  NS.metrics = { buildAll, buildDaily, buildDSE, computeRisk, computeRanking, computeBenchmarks, computeProductivity, classifyScore, isDisciplineEligible, computeDiscipline, computeDisciplineFromDaily, classifyDiscipline, applyDiscipline, finalizeDaily, hydrateDailyRows, DEFAULTS, fmtHM, fmtHF, fmtNum, fmtMoney, fmtMin, fmtTimeMin, fmtPct, median, percentile, meanArr, sumArr, groupBy, pct, round1, round2 };
})();