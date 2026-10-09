(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});
  const M = NS.metrics;
  const P = NS.charts.palette;

  /* ─────────────────────────────────────────────────────────────────
     INSIGHT DATA MODEL
     Every insight is a structured object with:
       id, level, type, title, summary, metric, baseline, currentValue,
       gap, direction, where, when, affectedCount, frequency, evidence,
       likelyDrivers, rootCauseCandidates, impact, confidence, severity,
       priorityScore, recommendedAction, expectedOutcome,
       supportingEntities, supportingDays, supportingVisits
     ───────────────────────────────────────────────────────────────── */

  const TYPES = {
    PERFORMANCE_DROP: 'PERFORMANCE_DROP',
    PERFORMANCE_IMPROVEMENT: 'PERFORMANCE_IMPROVEMENT',
    DISCIPLINE_BREAK: 'DISCIPLINE_BREAK',
    PRODUCTIVITY_BREAK: 'PRODUCTIVITY_BREAK',
    ROUTE_BREAK: 'ROUTE_BREAK',
    DEVIATION_BREAK: 'DEVIATION_BREAK',
    STORE_TIME_BREAK: 'STORE_TIME_BREAK',
    CALL_COMPLIANCE_BREAK: 'CALL_COMPLIANCE_BREAK',
    ORDER_VALUE_BREAK: 'ORDER_VALUE_BREAK',
    ANOMALY: 'ANOMALY',
    RECURRING_PATTERN: 'RECURRING_PATTERN',
    ROOT_CAUSE: 'ROOT_CAUSE',
    OPPORTUNITY: 'OPPORTUNITY',
    BEST_PRACTICE: 'BEST_PRACTICE',
    RISK: 'RISK',
    ACTION: 'ACTION'
  };

  const LEVELS = {
    VISIT: 0, DAY: 1, DSE_MTD: 2, STORE: 3, ROUTE: 4, CHANNEL: 5,
    ASO: 6, ASM: 7, ZSM: 8, BRANCH: 9, EXECUTIVE: 10
  };

  function makeInsight(overrides) {
    return Object.assign({
      id: '', level: LEVELS.EXECUTIVE, type: TYPES.PERFORMANCE_DROP,
      title: '', summary: '', metric: '',
      baseline: null, currentValue: null, gap: null, direction: '',
      where: '', when: '',
      affectedCount: 0, frequency: 0, totalPossible: 0,
      evidence: [], likelyDrivers: [], rootCauseCandidates: [],
      impact: { summary: '', quantified: null, unit: '' },
      confidence: 'LOW', severity: 'MEDIUM',
      priorityScore: 0,
      recommendedAction: '', expectedOutcome: '',
      supportingEntities: [], supportingDays: [], supportingVisits: [],
      drillable: false
    }, overrides);
  }

  /* ─────────────────────────────────────────────────────────────────
     UTILITY FUNCTIONS
     ───────────────────────────────────────────────────────────────── */

  function pct(n, d) { return d > 0 ? (n / d) * 100 : null; }
  function avg(arr) { const f = arr.filter(x => x !== null && isFinite(x)); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null; }
  function med(arr) { const f = arr.filter(x => x !== null && isFinite(x)); if (!f.length) return null; const s = [...f].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function std(arr) { const m = avg(arr); if (m === null) return null; const f = arr.filter(x => x !== null && isFinite(x)); if (f.length < 2) return 0; const sq = f.reduce((s, x) => s + Math.pow(x - m, 2), 0); return Math.sqrt(sq / (f.length - 1)); }
  function fmtPct(v) { return v === null || v === undefined ? '–' : v.toFixed(1) + '%'; }
  function fmtNum(v) { return v === null || v === undefined ? '–' : v.toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
  function fmtHM(v) { return M.fmtHM(v); }
  function fmtMin(v) { return v === null || v === undefined ? '–' : Math.round(v) + 'm'; }
  function fmtMoney(v) { return v === null || v === undefined ? '–' : '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  function fmtTimeMin(v) { return M.fmtTimeMin(v); }
  function fmtClock(m) { if (m === null || m === undefined) return '–'; const h = Math.floor(m / 60), mi = Math.round(m % 60); return (h % 12 === 0 ? 12 : h % 12) + ':' + String(mi).padStart(2, '0') + (h >= 12 ? 'PM' : 'AM'); }

  function directionOf(gap) { return gap > 0 ? 'UP' : gap < 0 ? 'DOWN' : 'FLAT'; }
  function absGap(gap) { return gap === null ? null : Math.abs(gap); }

  function severityOf(gap, thresholds) {
    const ag = absGap(gap);
    if (ag === null) return 'LOW';
    if (ag >= thresholds.critical) return 'CRITICAL';
    if (ag >= thresholds.high) return 'HIGH';
    if (ag >= thresholds.medium) return 'MEDIUM';
    return 'LOW';
  }

  function confidenceOf(sampleSize, frequency, totalPossible) {
    if (totalPossible <= 0) return 'LOW';
    const ratio = frequency / totalPossible;
    if (sampleSize >= 8 && ratio >= 0.6) return 'HIGH';
    if (sampleSize >= 4 && ratio >= 0.4) return 'MEDIUM';
    return 'LOW';
  }

  function priorityScore(severity, affectedCount, gap, frequency, confidence) {
    const sv = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }[severity] || 1;
    const cv = { HIGH: 3, MEDIUM: 2, LOW: 1 }[confidence] || 1;
    const ag = absGap(gap) || 0;
    return sv * 100 + cv * 30 + Math.min(affectedCount, 50) * 2 + Math.min(ag, 50) * 1.5 + (frequency || 0) * 5;
  }

  function countNon(arr) { return arr.filter(x => x !== null && isFinite(x)).length; }

  function groupBy(arr, fn) {
    const m = {};
    for (const o of arr) {
      const k = fn(o);
      (m[k] = m[k] || []).push(o);
    }
    return m;
  }

  function groupByField(arr, field) {
    return groupBy(arr, o => {
      const v = o[field];
      return (v === '' || v === null || v === undefined) ? '(blank)' : String(v);
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     LEVEL 0: VISIT ANALYSIS
     For each visit, derive diagnostic attributes.
     ───────────────────────────────────────────────────────────────── */

  function analyzeVisits(visits, params) {
    const durations = visits.filter(v => v.duration_min !== null && v.duration_min >= 0).map(v => v.duration_min);
    const devs = visits.filter(v => v.deviation_m !== null && v.deviation_m >= 0).map(v => v.deviation_m);
    const orders = visits.filter(v => v.order_value !== null).map(v => v.order_value);

    const medDur = med(durations);
    const medDev = med(devs);
    const madDur = med(durations.map(d => Math.abs(d - (medDur || 0))));
    const durUpper = medDur + 3 * Math.max(madDur || 1, 5);
    const durLower = Math.max(0, (medDur || 0) - 3 * Math.max(madDur || 1, 5));
    const medOrder = orders.length >= 10 ? med(orders) : null;

    const result = [];
    for (const v of visits) {
      const attrs = {
        is_long_visit: v.duration_min !== null && v.duration_min > durUpper,
        is_short_visit: v.duration_min !== null && v.duration_min > 0 && v.duration_min < durLower,
        high_deviation: v.deviation_m !== null && v.deviation_m > params.devThreshold,
        off_route: v.on_route === 'NO',
        non_productive: v.productivity === 'NO' && v.on_route === 'YES',
        productive: v.productivity === 'YES' && v.on_route === 'YES',
        low_order: v.order_value !== null && medOrder !== null && v.order_value < medOrder * 0.3,
        high_order: v.order_value !== null && medOrder !== null && v.order_value > medOrder * 2.5,
        call_compliance_fail: v.call_compliance === 'NO',
        late_start_visit: v.start_min !== null && v.start_min > params.startThreshold,
        is_anomaly: false
      };
      attrs.visit_score = (attrs.productive ? 2 : 0) - (attrs.off_route ? 2 : 0) - (attrs.high_deviation ? 1 : 0) - (attrs.is_long_visit ? 1 : 0) - (attrs.non_productive ? 1 : 0);
      result.push(Object.assign({ _attrs: attrs }, v));
    }
    return result;
  }

  /* ─────────────────────────────────────────────────────────────────
     LEVEL 1: DSE-DAY ANALYSIS
     Analyze one DSE's complete day in segments.
     ───────────────────────────────────────────────────────────────── */

  function analyzeDayVisits(dayVisits, dayData, params) {
    if (!dayVisits.length) return null;

    const sorted = dayVisits.slice().sort((a, b) => (a.start_min || Infinity) - (b.start_min || Infinity));
    const n = sorted.length;

    // Visit sequence buckets
    const buckets = { '1-5': [], '6-10': [], '11-15': [], '16+': [] };
    for (let i = 0; i < n; i++) {
      const seq = i + 1;
      if (seq <= 5) buckets['1-5'].push(sorted[i]);
      else if (seq <= 10) buckets['6-10'].push(sorted[i]);
      else if (seq <= 15) buckets['11-15'].push(sorted[i]);
      else buckets['16+'].push(sorted[i]);
    }

    // Time segments
    const timeSegs = { morning: [], midday: [], afternoon: [] };
    for (const v of sorted) {
      const t = v.start_min;
      if (t === null) continue;
      if (t < 720) timeSegs.morning.push(v);      // before 12:00
      else if (t < 840) timeSegs.midday.push(v);    // 12:00–14:00
      else timeSegs.afternoon.push(v);                // after 14:00
    }

    function segMetrics(arr) {
      if (!arr.length) return { visits: 0, productivity: null, avgStoreMin: null, avgDeviation: null, offRoutePct: null, totalOrders: 0 };
      const onRoute = arr.filter(v => v.on_route === 'YES');
      const prodYes = arr.filter(v => v.productivity === 'YES' && v.on_route === 'YES');
      const durations = arr.filter(v => v.duration_min !== null && v.duration_min >= 0).map(v => v.duration_min);
      const devs = arr.filter(v => v.deviation_m !== null).map(v => v.deviation_m);
      return {
        visits: arr.length,
        productivity: pct(prodYes.length, onRoute.length),
        avgStoreMin: avg(durations),
        avgDeviation: avg(devs),
        offRoutePct: pct(arr.filter(v => v.on_route === 'NO').length, arr.length),
        totalOrders: arr.reduce((s, v) => s + (v.order_value || 0), 0),
        prodCalls: prodYes.length,
        onRouteYes: onRoute.length
      };
    }

    const bucketMetrics = {};
    for (const [k, arr] of Object.entries(buckets)) bucketMetrics[k] = segMetrics(arr);
    const timeMetrics = {};
    for (const [k, arr] of Object.entries(timeSegs)) timeMetrics[k] = segMetrics(arr);

    // Find productivity break: where productivity drops significantly
    let breakPoint = null;
    const cumProd = [];
    let cumOnRoute = 0, cumProdYes = 0;
    for (let i = 0; i < n; i++) {
      const v = sorted[i];
      if (v.on_route === 'YES') cumOnRoute++;
      if (v.productivity === 'YES' && v.on_route === 'YES') cumProdYes++;
      if (i >= 2) {
        const segStart = Math.max(0, i - 2);
        const segOnRoute = sorted.slice(segStart, i + 1).filter(vv => vv.on_route === 'YES').length;
        const segProdYes = sorted.slice(segStart, i + 1).filter(vv => vv.productivity === 'YES' && vv.on_route === 'YES').length;
        cumProd.push({ seq: i + 1, segProd: pct(segProdYes, segOnRoute), cumProd: pct(cumProdYes, cumOnRoute) });
      }
    }

    // Detect where store time changes
    const storeTimes = sorted.filter(v => v.duration_min !== null && v.duration_min >= 0).map(v => v.duration_min);
    const medST = med(storeTimes);
    let storeTimeBreakIdx = null;
    if (medST !== null) {
      for (let i = 0; i < Math.floor(n / 2); i++) {
        const later = sorted.slice(n - Math.max(3, Math.floor(n / 3)));
        const laterST = later.filter(v => v.duration_min !== null).map(v => v.duration_min);
        const earlier = sorted.slice(0, Math.max(3, Math.floor(n / 3)));
        const earlierST = earlier.filter(v => v.duration_min !== null).map(v => v.duration_min);
        const avgLater = avg(laterST);
        const avgEarlier = avg(earlierST);
        if (avgLater !== null && avgEarlier !== null && avgLater > avgEarlier * 1.3) {
          storeTimeBreakIdx = Math.floor(n * 0.4);
          break;
        }
      }
    }

    const dayProd = dayData ? dayData.prodPct : (dayVisits.filter(v => v.on_route === 'YES').length > 0 ? pct(dayVisits.filter(v => v.productivity === 'YES' && v.on_route === 'YES').length, dayVisits.filter(v => v.on_route === 'YES').length) : null);

    return {
      totalVisits: n,
      sorted,
      bucketMetrics,
      timeMetrics,
      breakPoint,
      storeTimeBreakIdx,
      dayProductivity: dayProd,
      earlyVisits: bucketMetrics['1-5'],
      lateVisits: n > 10 ? bucketMetrics['11-15'] : (n > 5 ? bucketMetrics['6-10'] : null),
      firstHalf: avg(sorted.slice(0, Math.floor(n / 2)).filter(v => v.productivity === 'YES' && v.on_route === 'YES').length > 0 ? [pct(sorted.slice(0, Math.floor(n / 2)).filter(v => v.productivity === 'YES' && v.on_route === 'YES').length, sorted.slice(0, Math.floor(n / 2)).filter(v => v.on_route === 'YES').length)] : []),
      secondHalf: avg(sorted.slice(Math.floor(n / 2)).filter(v => v.productivity === 'YES' && v.on_route === 'YES').length > 0 ? [pct(sorted.slice(Math.floor(n / 2)).filter(v => v.productivity === 'YES' && v.on_route === 'YES').length, sorted.slice(Math.floor(n / 2)).filter(v => v.on_route === 'YES').length)] : [])
    };
  }

  /* ─────────────────────────────────────────────────────────────────
     LEVEL 2: DSE MTD PATTERN DETECTION
     Analyze across multiple days for repeated patterns.
     ───────────────────────────────────────────────────────────────── */

  function detectDSERepeatingPatterns(dseCode, dailyMap, visits, params, daysByDse, visitsByDse) {
    const days = (daysByDse ? (daysByDse.get(dseCode) || []) : [...dailyMap.values()]).filter(d => d.dse_code === dseCode && d.date).sort((a, b) => a.date.localeCompare(b.date));
    if (!days.length) return [];

    const patterns = [];
    const totalDays = days.length;

    // Late starts
    const lateDays = days.filter(d => d.start_pass === false);
    const lateFreq = lateDays.length;
    if (lateFreq > 0) {
      patterns.push({
        pattern: 'REPEATED_LATE_START',
        frequency: lateFreq,
        totalDays,
        days: lateDays.map(d => d.date),
        severity: lateFreq >= totalDays * 0.5 ? 'HIGH' : lateFreq >= totalDays * 0.3 ? 'MEDIUM' : 'LOW',
        confidence: confidenceOf(lateFreq, lateFreq, totalDays),
        description: 'Late starts occurred on ' + lateFreq + ' of ' + totalDays + ' working days'
      });
    }

    // Off-route days
    const offRouteDays = days.filter(d => d.offRouteYes > 0);
    if (offRouteDays.length > 0) {
      patterns.push({
        pattern: 'REPEATED_OFF_ROUTE',
        frequency: offRouteDays.length,
        totalDays,
        days: offRouteDays.map(d => d.date),
        severity: offRouteDays.length >= totalDays * 0.4 ? 'HIGH' : 'MEDIUM',
        confidence: confidenceOf(offRouteDays.length, offRouteDays.length, totalDays),
        description: 'Off-route activity on ' + offRouteDays.length + ' of ' + totalDays + ' days'
      });
    }

    // High deviation days
    const highDevDays = days.filter(d => d.highDev > 0);
    if (highDevDays.length > 0) {
      patterns.push({
        pattern: 'REPEATED_HIGH_DEVIATION',
        frequency: highDevDays.length,
        totalDays,
        days: highDevDays.map(d => d.date),
        severity: highDevDays.length >= totalDays * 0.4 ? 'HIGH' : 'MEDIUM',
        confidence: confidenceOf(highDevDays.length, highDevDays.length, totalDays),
        description: 'High deviation on ' + highDevDays.length + ' of ' + totalDays + ' days'
      });
    }

    // Productivity deterioration — compare first half of days vs second half
    if (totalDays >= 4) {
      const mid = Math.floor(totalDays / 2);
      const firstHalfProd = days.slice(0, mid).filter(d => d.prodPct !== null).map(d => d.prodPct);
      const secondHalfProd = days.slice(mid).filter(d => d.prodPct !== null).map(d => d.prodPct);
      const avgFirst = avg(firstHalfProd);
      const avgSecond = avg(secondHalfProd);
      if (avgFirst !== null && avgSecond !== null) {
        const change = avgSecond - avgFirst;
        if (change < -10) {
          patterns.push({
            pattern: 'PRODUCTIVITY_DECLINING',
            frequency: totalDays,
            totalDays,
            severity: change < -25 ? 'HIGH' : 'MEDIUM',
            confidence: totalDays >= 6 ? 'HIGH' : 'MEDIUM',
            description: 'Productivity declined from ' + avgFirst.toFixed(1) + '% to ' + avgSecond.toFixed(1) + '% over the period'
          });
        } else if (change > 10) {
          patterns.push({
            pattern: 'PRODUCTIVITY_IMPROVING',
            frequency: totalDays,
            totalDays,
            severity: 'LOW',
            confidence: totalDays >= 6 ? 'HIGH' : 'MEDIUM',
            description: 'Productivity improved from ' + avgFirst.toFixed(1) + '% to ' + avgSecond.toFixed(1) + '%'
          });
        }
      }
    }

    // Consistency check
    const prods = days.filter(d => d.prodPct !== null).map(d => d.prodPct);
    const prodStd = std(prods);
    const prodAvg = avg(prods);
    if (prodStd !== null && prodAvg !== null) {
      const cv = prodAvg > 0 ? (prodStd / prodAvg) * 100 : 0;
      if (cv < 15) {
        patterns.push({
          pattern: 'STRONG_CONSISTENCY',
          frequency: totalDays,
          totalDays,
          severity: 'LOW',
          confidence: 'HIGH',
          description: 'Consistent performance (CV=' + cv.toFixed(0) + '%)'
        });
      } else if (cv > 40) {
        patterns.push({
          pattern: 'INCONSISTENT_PERFORMANCE',
          frequency: totalDays,
          totalDays,
          severity: 'MEDIUM',
          confidence: 'MEDIUM',
          description: 'Highly variable productivity (CV=' + cv.toFixed(0) + '%)'
        });
      }
    }

    // Recurring problematic stores (if visit data available)
    const dseVisits = visitsByDse ? (visitsByDse.get(dseCode) || []) : visits.filter(v => v.dse_code === dseCode);
    const storeVisits = groupByField(dseVisits, 'retailer_code');
    for (const [storeCode, svArr] of Object.entries(storeVisits)) {
      if (svArr.length < 3) continue;
      const longVisits = svArr.filter(v => v._attrs && v._attrs.is_long_visit).length;
      const lowProdVisits = svArr.filter(v => v._attrs && v._attrs.non_productive).length;
      const highDevVisits = svArr.filter(v => v._attrs && v._attrs.high_deviation).length;
      if (longVisits >= svArr.length * 0.6 || lowProdVisits >= svArr.length * 0.7) {
        patterns.push({
          pattern: 'RECURRING_PROBLEM_STORE',
          frequency: Math.max(longVisits, lowProdVisits),
          totalDays: svArr.length,
          severity: 'MEDIUM',
          confidence: 'MEDIUM',
          supportingEntities: [storeCode],
          description: 'Store ' + storeCode + ' had issues in ' + Math.max(longVisits, lowProdVisits) + '/' + svArr.length + ' visits'
        });
      }
    }

    return patterns;
  }

  /* ─────────────────────────────────────────────────────────────────
     LEVEL 3: ROUTE / CHANNEL / STORE ANALYSIS
     ───────────────────────────────────────────────────────────────── */

  function analyzeRoutes(visits, dseList, params) {
    const routeGroups = groupByField(visits, 'route_name');
    const routeInsights = [];
    const teamMedianProd = med(dseList.map(s => s.productivityPct));
    const teamMedianStore = med(dseList.map(s => s.avgStoreMin));

    for (const [route, rv] of Object.entries(routeGroups)) {
      if (route === '(blank)' || rv.length < 5) continue;

      const onRoute = rv.filter(v => v.on_route === 'YES');
      const prodYes = rv.filter(v => v.productivity === 'YES' && v.on_route === 'YES');
      const durations = rv.filter(v => v.duration_min !== null && v.duration_min >= 0).map(v => v.duration_min);
      const devs = rv.filter(v => v.deviation_m !== null).map(v => v.deviation_m);
      const orders = rv.filter(v => v.order_value !== null).map(v => v.order_value);
      const dses = new Set(rv.map(v => v.dse_code));

      const routeProd = pct(prodYes.length, onRoute.length);
      const routeAvgStore = avg(durations);
      const routeAvgDev = avg(devs);
      const routeAvgOrder = avg(orders);

      // Check if multiple DSEs on this route show similar problems
      const dseDayProducts = {};
      for (const v of rv) {
        const key = v.dse_code + '|' + v.date;
        if (!dseDayProducts[key]) dseDayProducts[key] = { onRoute: 0, prod: 0 };
        if (v.on_route === 'YES') dseDayProducts[key].onRoute++;
        if (v.productivity === 'YES' && v.on_route === 'YES') dseDayProducts[key].prod++;
      }
      const dseProds = {};
      for (const [k, v] of Object.entries(dseDayProducts)) {
        const dse = k.split('|')[0];
        if (!dseProds[dse]) dseProds[dse] = { onRoute: 0, prod: 0 };
        dseProds[dse].onRoute += v.onRoute;
        dseProds[dse].prod += v.prod;
      }
      const dseProdPcts = Object.entries(dseProds).map(([d, v]) => ({ dse: d, prod: pct(v.prod, v.onRoute) })).filter(x => x.prod !== null);
      const belowMedianDses = dseProdPcts.filter(x => teamMedianProd !== null && x.prod < teamMedianProd);

      routeInsights.push({
        route,
        visits: rv.length,
        dseCount: dses.size,
        productivity: routeProd,
        avgStoreMin: routeAvgStore,
        avgDeviation: routeAvgDev,
        avgOrder: routeAvgOrder,
        multiDseIssue: belowMedianDses.length >= Math.min(2, dses.size) && dses.size >= 2,
        belowMedianDseCount: belowMedianDses.length,
        belowMedianDses: belowMedianDses.map(x => x.dse),
        totalOrders: orders.reduce((s, x) => s + x, 0)
      });
    }
    return routeInsights;
  }

  function analyzeChannels(state) {
    const visits = state.filteredVisits.filter(v => v.channel !== 'SPECIALITY');
    const channels = ['SMALL', 'WS', 'LARGE', 'SELF SERVICE'];
    const totalDur = visits.reduce((s, v) => s + (v.duration_min || 0), 0) || 1;
    const totalProd = visits.filter(v => v.on_route === 'YES').length || 1;

    return channels.map(ch => {
      const cv = visits.filter(v => v.channel === ch);
      const onRoute = cv.filter(v => v.on_route === 'YES');
      const prodYes = cv.filter(v => v.productivity === 'YES' && v.on_route === 'YES');
      const dur = cv.reduce((s, v) => s + (v.duration_min || 0), 0);
      const devs = cv.filter(v => v.deviation_m !== null).map(v => v.deviation_m);
      const orders = cv.filter(v => v.order_value !== null).map(v => v.order_value);

      return {
        channel: ch,
        visits: cv.length,
        storeTime: dur,
        storeTimeShare: pct(dur, totalDur),
        productivity: pct(prodYes.length, onRoute.length),
        avgStoreMin: avg(cv.filter(v => v.duration_min !== null).map(v => v.duration_min)),
        avgDeviation: avg(devs),
        avgOrder: avg(orders),
        totalOrders: orders.reduce((s, v) => s + v, 0),
        prodCalls: prodYes.length,
        onRouteCount: onRoute.length
      };
    });
  }

  function analyzeStores(visits, params) {
    const storeGroups = groupByField(visits, 'retailer_code');
    const storeInsights = [];

    for (const [store, sv] of Object.entries(storeGroups)) {
      if (sv.length < 3 || store === '(blank)') continue;

      const onRoute = sv.filter(v => v.on_route === 'YES');
      const prodYes = sv.filter(v => v.productivity === 'YES' && v.on_route === 'YES');
      const durations = sv.filter(v => v.duration_min !== null && v.duration_min >= 0).map(v => v.duration_min);
      const devs = sv.filter(v => v.deviation_m !== null).map(v => v.deviation_m);
      const longVisits = sv.filter(v => v._attrs && v._attrs.is_long_visit).length;
      const lowProdVisits = sv.filter(v => v._attrs && v._attrs.non_productive).length;

      storeInsights.push({
        retailer: store,
        retailerName: sv[0].retailer_name || store,
        visits: sv.length,
        productivity: pct(prodYes.length, onRoute.length),
        avgStoreMin: avg(durations),
        avgDeviation: avg(devs),
        longVisitCount: longVisits,
        nonProductiveCount: lowProdVisits,
        dses: new Set(sv.map(v => v.dse_code)).size,
        channels: [...new Set(sv.map(v => v.channel))],
        totalOrders: sv.reduce((s, v) => s + (v.order_value || 0), 0)
      });
    }
    return storeInsights.sort((a, b) => b.visits - a.visits);
  }

  /* ─────────────────────────────────────────────────────────────────
     BREAK DETECTION ENGINE
     ───────────────────────────────────────────────────────────────── */

  function detectBreaks(state) {
    const { dseList, team, dailyMap, filteredVisits, params } = state;
    const breaks = [];
    let idCounter = 0;
    function nextId() { return 'brk-' + (++idCounter); }

    const daysByDse = new Map();
    const visitsByDseDate = new Map();
    for (const [key, d] of dailyMap.entries()) {
      if (!daysByDse.has(d.dse_code)) daysByDse.set(d.dse_code, []);
      daysByDse.get(d.dse_code).push(d);
    }
    for (const v of filteredVisits) {
      const k = v.dse_code + '|' + (v.date || '');
      if (!visitsByDseDate.has(k)) visitsByDseDate.set(k, []);
      visitsByDseDate.get(k).push(v);
    }

    // 1. PRODUCTIVITY BREAK — overall
    const prodValues = dseList.map(s => s.productivityPct).filter(x => x !== null);
    if (prodValues.length) {
      const teamProd = avg(prodValues);
      const teamMedProd = med(prodValues);
      const belowMedian = dseList.filter(s => s.productivityPct !== null && teamMedProd !== null && s.productivityPct < teamMedProd);
      if (belowMedian.length > 0 && teamProd !== null) {
        const gap = teamProd - teamMedProd;
        breaks.push(makeInsight({
          id: nextId(), level: LEVELS.EXECUTIVE, type: TYPES.PRODUCTIVITY_BREAK,
          title: belowMedian.length + ' DSEs convert below the team average',
          summary: 'Team productivity is ' + fmtPct(teamProd) + ' on average, but ' + belowMedian.length + ' DSEs are below the middle mark of ' + fmtPct(teamMedProd) + '.',
          metric: 'productivity', baseline: teamMedProd, currentValue: teamProd,
          gap: gap, direction: directionOf(-gap),
          affectedCount: belowMedian.length,
          evidence: [belowMedian.length + ' DSEs below the team middle mark of ' + fmtPct(teamMedProd)],
          likelyDrivers: ['Too much time in stores', 'Off-route visits', 'Late starts'],
          impact: { summary: belowMedian.length + ' DSEs possibly underperforming', quantified: null, unit: '' },
          confidence: belowMedian.length >= 5 ? 'HIGH' : 'MEDIUM',
          severity: severityOf(-gap, { critical: 20, high: 10, medium: 5 }),
          recommendedAction: 'Look at each DSE below the team average to find the cause',
          drillable: true, supportingEntities: belowMedian.map(s => s.dse_code)
        }));
      }
    }

    // 2. STORE TIME BREAK — excessive
    const storeTimes = dseList.map(s => s.avgStoreMin).filter(x => x !== null);
    if (storeTimes.length > 3) {
      const teamMedStore = med(storeTimes);
      const teamAvgStore = avg(storeTimes);
      const excessive = dseList.filter(s => s.avgStoreMin !== null && teamMedStore !== null && s.avgStoreMin > teamMedStore * 1.5);
      if (excessive.length > 0) {
        breaks.push(makeInsight({
          id: nextId(), level: LEVELS.EXECUTIVE, type: TYPES.STORE_TIME_BREAK,
          title: 'Too much time in stores — ' + excessive.length + ' DSEs',
          summary: 'The team averages ' + Math.round(teamAvgStore) + ' min per store visit, while most DSEs spend about ' + Math.round(teamMedStore) + ' min. These ' + excessive.length + ' DSEs go well above that.',
          metric: 'avgStoreMin', baseline: teamMedStore, currentValue: teamAvgStore,
          gap: teamAvgStore - teamMedStore, direction: 'UP',
          affectedCount: excessive.length,
          evidence: [Math.round(teamAvgStore) + ' min average vs ' + Math.round(teamMedStore) + ' min typical'],
          likelyDrivers: ['Very long visits at some stores', 'No visit-time limit'],
          impact: { summary: excessive.length + ' DSEs spending extra time in stores', quantified: Math.round((teamAvgStore - teamMedStore) * excessive.reduce((s, d) => s + (d.visits || 0), 0)), unit: 'excess minutes' },
          confidence: excessive.length >= 5 ? 'HIGH' : 'MEDIUM',
          severity: severityOf(teamAvgStore - teamMedStore, { critical: 15, high: 8, medium: 4 }),
          recommendedAction: 'Coach the DSEs with the longest store visits to keep them short and focused',
          drillable: true, supportingEntities: excessive.map(s => s.dse_code)
        }));
      }
    }

    // 3. DISCIPLINE BREAK — late starts
    const lateStarters = dseList.filter(s => s.startPct !== null && s.startPct < 75);
    if (lateStarters.length > 0) {
      breaks.push(makeInsight({
        id: nextId(), level: LEVELS.EXECUTIVE, type: TYPES.DISCIPLINE_BREAK,
        title: lateStarters.length + ' DSEs start late on most days',
        summary: 'They start after ' + fmtTimeMin(params.startThreshold) + ' on most days, missing the best hours for store calls.',
        metric: 'startPct', baseline: 75, currentValue: avg(lateStarters.map(s => s.startPct)),
        gap: -(75 - avg(lateStarters.map(s => s.startPct))), direction: 'DOWN',
        affectedCount: lateStarters.length,
        evidence: [lateStarters.length + ' DSEs start on time less than 75% of the time'],
        likelyDrivers: ['Late check-in', 'Poor route start plan'],
        impact: { summary: 'Morning hours lost for store calls', quantified: lateStarters.length, unit: 'DSEs' },
        confidence: lateStarters.length >= 5 ? 'HIGH' : 'MEDIUM',
        severity: lateStarters.length > Math.max(8, dseList.length * 0.2) ? 'CRITICAL' : 'HIGH',
        recommendedAction: 'Enforce the morning check-in rule for these DSEs',
        drillable: true, supportingEntities: lateStarters.map(s => s.dse_code)
      }));
    }

    // 4. ROUTE ADHERENCE BREAK
    const offRoute = dseList.filter(s => s.onRoutePct !== null && s.onRoutePct < 90);
    if (offRoute.length > 0) {
      breaks.push(makeInsight({
        id: nextId(), level: LEVELS.EXECUTIVE, type: TYPES.ROUTE_BREAK,
        title: offRoute.length + ' DSEs go off route often',
        summary: 'More than 10% of their visits are away from the assigned route.',
        metric: 'onRoutePct', baseline: 90, currentValue: avg(offRoute.map(s => s.onRoutePct)),
        gap: -(90 - avg(offRoute.map(s => s.onRoutePct))), direction: 'DOWN',
        affectedCount: offRoute.length,
        evidence: [offRoute.length + ' DSEs with less than 90% on-route visits'],
        likelyDrivers: ['Route plan not followed', 'Extra unplanned visits'],
        impact: { summary: 'Route discipline slippage', quantified: offRoute.length, unit: 'DSEs' },
        confidence: offRoute.length >= 4 ? 'HIGH' : 'MEDIUM',
        severity: offRoute.length > Math.max(6, dseList.length * 0.15) ? 'HIGH' : 'MEDIUM',
        recommendedAction: 'Review each DSE\'s route plan and coach route discipline',
        drillable: true, supportingEntities: offRoute.map(s => s.dse_code)
      }));
    }

    // 5. LATE-DAY DETERIORATION — DSE-level
    for (const dse of dseList) {
      const dseDays = daysByDse.get(dse.dse_code) || [];
      if (dseDays.length < 3) continue;

      // Collect all visits per day, analyze early vs late
      let earlyProdSum = 0, earlyOnRoute = 0, lateProdSum = 0, lateOnRoute = 0;
      let earlyDays = 0, lateDays = 0;

      for (const day of dseDays) {
        const dayVisits = (visitsByDseDate.get(dse.dse_code + '|' + day.date) || [])
          .slice().sort((a, b) => (a.start_min || Infinity) - (b.start_min || Infinity));
        const n = dayVisits.length;
        if (n < 4) continue;

        const mid = Math.floor(n / 2);
        const early = dayVisits.slice(0, mid);
        const late = dayVisits.slice(mid);

        const eOnR = early.filter(v => v.on_route === 'YES');
        const eProd = early.filter(v => v.productivity === 'YES' && v.on_route === 'YES');
        const lOnR = late.filter(v => v.on_route === 'YES');
        const lProd = late.filter(v => v.productivity === 'YES' && v.on_route === 'YES');

        if (eOnR.length) { earlyProdSum += eProd.length; earlyOnRoute += eOnR.length; earlyDays++; }
        if (lOnR.length) { lateProdSum += lProd.length; lateOnRoute += lOnR.length; lateDays++; }
      }

      const earlyProd = pct(earlyProdSum, earlyOnRoute);
      const lateProd = pct(lateProdSum, lateOnRoute);

      if (earlyProd !== null && lateProd !== null && earlyProd - lateProd > 15) {
        breaks.push(makeInsight({
          id: nextId(), level: LEVELS.DSE_MTD, type: TYPES.PRODUCTIVITY_BREAK,
          title: 'Output falls after mid-day: ' + dse.dse_name,
          summary: 'Converts ' + fmtPct(earlyProd) + ' of morning calls but only ' + fmtPct(lateProd) + ' after mid-day — a ' + Math.round(earlyProd - lateProd) + ' point drop.',
          metric: 'productivity', baseline: earlyProd, currentValue: lateProd,
          gap: lateProd - earlyProd, direction: 'DOWN',
          when: 'After mid-day',
          affectedCount: 1,
          evidence: ['Morning visits: ' + fmtPct(earlyProd) + ' vs afternoon visits: ' + fmtPct(lateProd)],
          likelyDrivers: ['Fatigue after mid-day', 'Too long in stores'],
          impact: { summary: 'Lost output in the second half of the day', quantified: Math.round(earlyProd - lateProd), unit: 'points' },
          confidence: earlyDays >= 4 ? 'HIGH' : 'MEDIUM',
          severity: severityOf(lateProd - earlyProd, { critical: 25, high: 15, medium: 8 }),
          recommendedAction: 'See what is different in ' + dse.dse_name + '\'s afternoon visits',
          drillable: true, supportingEntities: [dse.dse_code]
        }));
      }
    }

    // 6. ROUTE-LEVEL ISSUES — if multiple DSEs show same problem
    const routeInsights = analyzeRoutes(filteredVisits, dseList, params);
    for (const ri of routeInsights) {
      if (ri.multiDseIssue && ri.dseCount >= 2) {
        const belowProd = dseList.filter(s => ri.belowMedianDses.includes(s.dse_code));
        breaks.push(makeInsight({
          id: nextId(), level: LEVELS.ROUTE, type: TYPES.ROUTE_BREAK,
          title: 'Route ' + ri.route + ' needs attention',
          summary: ri.belowMedianDseCount + ' of ' + ri.dseCount + ' DSEs on this route convert below the team average. Average store visit is ' + Math.round(ri.avgStoreMin) + ' min.',
          metric: 'productivity', baseline: team.medianProductivity, currentValue: ri.productivity,
          gap: ri.productivity - (team.medianProductivity || 0), direction: directionOf(ri.productivity - (team.medianProductivity || 0)),
          where: 'Route ' + ri.route,
          affectedCount: ri.belowMedianDseCount,
          evidence: [ri.belowMedianDseCount + '/' + ri.dseCount + ' DSEs below team average on this route', 'Average store visit: ' + Math.round(ri.avgStoreMin) + ' min'],
          likelyDrivers: ['Route store mix', 'Long store visits on the route'],
          impact: { summary: 'Route-level performance gap', quantified: null, unit: '' },
          confidence: ri.belowMedianDseCount >= 3 ? 'HIGH' : 'MEDIUM',
          severity: 'HIGH',
          recommendedAction: 'Check the store mix and channel types on this route',
          drillable: true, supportingEntities: ri.belowMedianDses
        }));
      }
    }

    // 7. CHANNEL-LEVEL ISSUES
    const channelData = analyzeChannels(state);
    for (const ch of channelData) {
      if (ch.visits < 20) continue;
      const otherCh = channelData.filter(c => c.channel !== ch.channel && c.visits >= 20);
      const highTimeLowProd = ch.storeTimeShare > 30 && ch.productivity < avg(otherCh.map(c => c.productivity));
      if (highTimeLowProd) {
        breaks.push(makeInsight({
          id: nextId(), level: LEVELS.CHANNEL, type: TYPES.STORE_TIME_BREAK,
          title: 'Too much time on the ' + ch.channel + ' channel',
          summary: ch.channel + ' takes ' + Math.round(ch.storeTimeShare) + '% of store time but converts only ' + fmtPct(ch.productivity) + ' of calls. Other channels convert better.',
          metric: 'storeTimeShare', baseline: avg(otherCh.map(c => c.storeTimeShare)), currentValue: ch.storeTimeShare,
          gap: ch.storeTimeShare - avg(otherCh.map(c => c.storeTimeShare)), direction: 'UP',
          where: ch.channel + ' channel',
          affectedCount: ch.visits,
          evidence: [ch.channel + ': ' + Math.round(ch.storeTimeShare) + '% of store time, ' + fmtPct(ch.productivity) + ' productivity', 'Average store visit: ' + Math.round(ch.avgStoreMin) + ' min'],
          likelyDrivers: ['Lopsided time allocation', 'Low-converting channel mix'],
          impact: { summary: 'Time spent inefficiently on ' + ch.channel, quantified: Math.round(ch.storeTime * (1 - (ch.productivity || 0) / 100)), unit: 'store minutes' },
          confidence: 'MEDIUM',
          severity: 'MEDIUM',
          recommendedAction: 'Move some visiting time to the higher-converting channels',
          drillable: true
        }));
      }
    }

    // 8. LOW PRODUCTIVITY CLUSTER
    const lowProd = dseList.filter(s => s.productivityPct !== null && s.productivityPct < 30);
    if (lowProd.length >= 3) {
      breaks.push(makeInsight({
        id: nextId(), level: LEVELS.EXECUTIVE, type: TYPES.PRODUCTIVITY_BREAK,
        title: lowProd.length + ' DSEs convert less than 30% of calls',
        summary: 'Their average is ' + fmtPct(avg(lowProd.map(s => s.productivityPct))) + '. This is the biggest conversion problem in this view.',
        metric: 'productivityPct', baseline: 30, currentValue: avg(lowProd.map(s => s.productivityPct)),
        gap: -(30 - avg(lowProd.map(s => s.productivityPct))), direction: 'DOWN',
        affectedCount: lowProd.length,
        evidence: [lowProd.length + ' DSEs below 30% productivity'],
        likelyDrivers: ['Selling technique', 'Store mix', 'Route planning'],
        impact: { summary: 'Critical conversion problem', quantified: lowProd.length, unit: 'DSEs' },
        confidence: lowProd.length >= 5 ? 'HIGH' : 'MEDIUM',
        severity: 'CRITICAL',
        recommendedAction: 'Coach these DSEs on in-store selling and support with assortment',
        drillable: true, supportingEntities: lowProd.map(s => s.dse_code)
      }));
    }

    return breaks;
  }

  /* ─────────────────────────────────────────────────────────────────
     HIERARCHICAL AGGREGATION
     ───────────────────────────────────────────────────────────────── */

  function aggregateHierarchy(dseList) {
    const levels = { asms: {}, zsms: {}, branches: {}, asos: {} };

    for (const s of dseList) {
      const asm = s.asm || '(blank)';
      const zsm = s.zsm || '(blank)';
      const branch = s.branch_location || '(blank)';

      if (!levels.asms[asm]) levels.asms[asm] = { dses: [], prodSum: 0, prodCount: 0, discSum: 0, workingMinSum: 0, workingDays: 0, storeMin: 0, visits: 0, orderSum: 0, onRouteSum: 0, onRouteValid: 0, devSum: 0, devValid: 0 };
      const a = levels.asms[asm];
      a.dses.push(s);
      if (s.productivityPct !== null) { a.prodSum += s.productivityPct; a.prodCount++; }
      a.discSum += s.disciplineScore;
      a.workingMinSum += s.workingMinSum || 0;
      a.workingDays += s.workingDays || 0;
      a.storeMin += s.storeMin || 0;
      a.visits += s.visits || 0;
      a.orderSum += s.orderSum || 0;
      a.onRouteSum += s.onRouteYes || 0;
      a.onRouteValid += s.onRouteValid || 0;
      a.devSum += s.devPass || 0;
      a.devValid += s.devValid || 0;

      if (!levels.zsms[zsm]) levels.zsms[zsm] = { dses: [], prodSum: 0, prodCount: 0, discSum: 0, workingMinSum: 0, workingDays: 0, storeMin: 0, visits: 0, orderSum: 0, onRouteSum: 0, onRouteValid: 0, devSum: 0, devValid: 0 };
      const z = levels.zsms[zsm];
      z.dses.push(s);
      if (s.productivityPct !== null) { z.prodSum += s.productivityPct; z.prodCount++; }
      z.discSum += s.disciplineScore;
      z.workingMinSum += s.workingMinSum || 0;
      z.workingDays += s.workingDays || 0;
      z.storeMin += s.storeMin || 0;
      z.visits += s.visits || 0;
      z.orderSum += s.orderSum || 0;
      z.onRouteSum += s.onRouteYes || 0;
      z.onRouteValid += s.onRouteValid || 0;
      z.devSum += s.devPass || 0;
      z.devValid += s.devValid || 0;

      if (!levels.branches[branch]) levels.branches[branch] = { dses: [], prodSum: 0, prodCount: 0, discSum: 0, workingMinSum: 0, workingDays: 0, storeMin: 0, visits: 0, orderSum: 0, onRouteSum: 0, onRouteValid: 0, devSum: 0, devValid: 0 };
      const b = levels.branches[branch];
      b.dses.push(s);
      if (s.productivityPct !== null) { b.prodSum += s.productivityPct; b.prodCount++; }
      b.discSum += s.disciplineScore;
      b.workingMinSum += s.workingMinSum || 0;
      b.workingDays += s.workingDays || 0;
      b.storeMin += s.storeMin || 0;
      b.visits += s.visits || 0;
      b.orderSum += s.orderSum || 0;
      b.onRouteSum += s.onRouteYes || 0;
      b.onRouteValid += s.onRouteValid || 0;
      b.devSum += s.devPass || 0;
      b.devValid += s.devValid || 0;

      const aso = s.aso || '(blank)';
      if (!levels.asos[aso]) levels.asos[aso] = { dses: [], prodSum: 0, prodCount: 0, discSum: 0, workingMinSum: 0, workingDays: 0, storeMin: 0, visits: 0, orderSum: 0, onRouteSum: 0, onRouteValid: 0, devSum: 0, devValid: 0 };
      const o = levels.asos[aso];
      o.dses.push(s);
      if (s.productivityPct !== null) { o.prodSum += s.productivityPct; o.prodCount++; }
      o.discSum += s.disciplineScore;
      o.workingMinSum += s.workingMinSum || 0;
      o.workingDays += s.workingDays || 0;
      o.storeMin += s.storeMin || 0;
      o.visits += s.visits || 0;
      o.orderSum += s.orderSum || 0;
      o.onRouteSum += s.onRouteYes || 0;
      o.onRouteValid += s.onRouteValid || 0;
      o.devSum += s.devPass || 0;
      o.devValid += s.devValid || 0;
    }

    function finalizeGroup(g) {
      g.productivity = g.prodCount ? g.prodSum / g.prodCount : null;
      g.discipline = g.dses.length ? g.discSum / g.dses.length : null;
      g.avgWorkingMin = g.workingDays ? g.workingMinSum / g.workingDays : null;
      g.avgStoreMin = g.visits ? g.storeMin / g.visits : null;
      g.onRoutePct = pct(g.onRouteSum, g.onRouteValid);
      g.devPct = pct(g.devSum, g.devValid);
      g.dseCount = g.dses.length;
      g.lowProdCount = g.dses.filter(s => s.productivityPct !== null && s.productivityPct < (med(dseList.map(x => x.productivityPct)) || 50)).length;
      g.lateStartCount = g.dses.filter(s => s.startPct !== null && s.startPct < 75).length;
      g.offRouteCount = g.dses.filter(s => s.onRoutePct !== null && s.onRoutePct < 90).length;
    }

    for (const g of Object.values(levels.asms)) finalizeGroup(g);
    for (const g of Object.values(levels.zsms)) finalizeGroup(g);
    for (const g of Object.values(levels.branches)) finalizeGroup(g);
    for (const g of Object.values(levels.asos)) finalizeGroup(g);

    return levels;
  }

  /* ─────────────────────────────────────────────────────────────────
     HIERARCHY INSIGHTS
     ───────────────────────────────────────────────────────────────── */

  function generateHierarchyInsights(dseList, team) {
    const insights = [];
    let idCounter = 100;
    const h = aggregateHierarchy(dseList);
    const teamProd = team.productivityAvg;
    const teamDisc = team.disciplineAvg;
    const teamMedProd = team.medianProductivity;

    // ASM-level insights
    for (const [asmName, asmData] of Object.entries(h.asms)) {
      if (asmName === '(blank)' || asmData.dseCount < 2) continue;
      const prodGap = asmData.productivity !== null && teamProd !== null ? asmData.productivity - teamProd : null;
      const discGap = asmData.discipline !== null && teamDisc !== null ? asmData.discipline - teamDisc : null;

      if (prodGap !== null && prodGap < -5) {
        const affected = asmData.dses.filter(s => s.productivityPct !== null && s.productivityPct < (teamMedProd || 50));
        insights.push(makeInsight({
          id: 'h-asm-' + (++idCounter), level: LEVELS.ASM, type: TYPES.PERFORMANCE_DROP,
          title: 'ASM ' + asmName + ' is below team average',
          summary: asmData.dseCount + ' DSEs under ' + asmName + ' average ' + fmtPct(Math.abs(prodGap)) + ' below the team in productivity. ' + affected.length + ' are below the middle mark.',
          metric: 'productivity', baseline: teamProd, currentValue: asmData.productivity,
          gap: prodGap, direction: 'DOWN',
          where: 'ASM ' + asmName,
          affectedCount: affected.length,
          evidence: ['ASM ' + asmName + ' average: ' + fmtPct(asmData.productivity) + ' vs team: ' + fmtPct(teamProd)],
          likelyDrivers: ['Route-level issues', 'Individual performance', 'Store/channel mix'],
          impact: { summary: affected.length + ' DSEs underperforming under ' + asmName, quantified: null, unit: '' },
          confidence: affected.length >= 3 ? 'HIGH' : 'MEDIUM',
          severity: prodGap < -15 ? 'CRITICAL' : 'HIGH',
          recommendedAction: 'Meet ' + affected.length + ' underperforming DSEs under ASM ' + asmName,
          drillable: true, supportingEntities: affected.map(s => s.dse_code)
        }));
      }

      if (asmData.lateStartCount > 0 && asmData.lateStartCount >= asmData.dseCount * 0.3) {
        const lateStartDses = asmData.dses.filter(s => s.startPct !== null && s.startPct < 75);
        insights.push(makeInsight({
          id: 'h-asm-disc-' + (++idCounter), level: LEVELS.ASM, type: TYPES.DISCIPLINE_BREAK,
          title: 'ASM ' + asmName + ' — ' + asmData.lateStartCount + ' DSE' + (asmData.lateStartCount === 1 ? '' : 's') + ' start late',
          summary: asmData.lateStartCount + ' of ' + asmData.dseCount + ' DSEs under ' + asmName + ' often start late.',
          metric: 'startPct', baseline: 75, currentValue: null,
          gap: -10, direction: 'DOWN',
          where: 'ASM ' + asmName,
          affectedCount: asmData.lateStartCount,
          evidence: [asmData.lateStartCount + '/' + asmData.dseCount + ' DSEs start on time less than 75% of the time'],
          likelyDrivers: ['Zone check-in habit', 'Route start planning'],
          impact: { summary: 'Morning hours lost for ' + asmData.lateStartCount + ' DSEs', quantified: asmData.lateStartCount, unit: 'DSEs' },
          confidence: 'MEDIUM',
          severity: 'MEDIUM',
          recommendedAction: 'Coach morning start discipline under ASM ' + asmName,
          drillable: true,
          supportingEntities: lateStartDses.map(s => s.dse_code)
        }));
      }
    }

    // ZSM-level insights
    for (const [zsmName, zsmData] of Object.entries(h.zsms)) {
      if (zsmName === '(blank)' || zsmData.dseCount < 3) continue;
      const prodGap = zsmData.productivity !== null && teamProd !== null ? zsmData.productivity - teamProd : null;
      if (prodGap !== null && prodGap < -8) {
        insights.push(makeInsight({
          id: 'h-zsm-' + (++idCounter), level: LEVELS.ZSM, type: TYPES.PERFORMANCE_DROP,
          title: 'ZSM ' + zsmName + ' is below team average',
          summary: zsmData.dseCount + ' DSEs under ' + zsmName + ' average ' + fmtPct(Math.abs(prodGap)) + ' below the team in productivity.',
          metric: 'productivity', baseline: teamProd, currentValue: zsmData.productivity,
          gap: prodGap, direction: 'DOWN',
          where: 'ZSM ' + zsmName,
          affectedCount: zsmData.dseCount,
          evidence: ['ZSM ' + zsmName + ' average: ' + fmtPct(zsmData.productivity) + ' vs team: ' + fmtPct(teamProd)],
          impact: { summary: 'Regional performance gap', quantified: null, unit: '' },
          confidence: zsmData.dseCount >= 5 ? 'HIGH' : 'MEDIUM',
          severity: prodGap < -15 ? 'CRITICAL' : 'HIGH',
          recommendedAction: 'Review performance with ZSM ' + zsmName,
          drillable: true,
          supportingEntities: zsmData.dses.map(s => s.dse_code)
        }));
      }
    }

    return insights;
  }

  /* ─────────────────────────────────────────────────────────────────
     IMPACT ESTIMATION
     ───────────────────────────────────────────────────────────────── */

  function estimateImpacts(breaks, dseList) {
    return breaks.map(b => {
      const impact = Object.assign({}, b.impact);
      if (b.metric === 'productivity' && b.affectedCount > 0) {
        const lostCalls = Math.round(b.affectedCount * (absGap(b.gap) / 100) * 5);
        if (lostCalls > 0) {
          impact.summary += (impact.summary ? ' | ' : '') + '~' + lostCalls + ' productive calls potentially recoverable/day';
          impact.quantified = lostCalls;
          impact.unit = 'calls/day';
        }
      }
      if (b.type === TYPES.STORE_TIME_BREAK && b.affectedCount > 0) {
        const excessMin = Math.round(b.affectedCount * (absGap(b.gap) || 0) * 3);
        if (excessMin > 0) {
          impact.summary += (impact.summary ? ' | ' : '') + '~' + excessMin + ' excess store minutes/day';
          impact.quantified = excessMin;
          impact.unit = 'store-minutes/day';
        }
      }
      b.impact = impact;
      return b;
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     MAIN ENGINE: RUN ALL ANALYSES
     ───────────────────────────────────────────────────────────────── */

  function run(state) {
    const startTime = performance.now();
    const { filteredVisits, dailyMap, dseList, team, params } = state;
    if (!dseList.length || !filteredVisits.length) {
      return { breaks: [], patterns: [], hierarchies: {}, routes: [], channels: [], stores: [], allInsights: [], meta: { durationMs: 0, insightCount: 0 } };
    }

    // Annotate visits with diagnostic attributes
    const annotatedVisits = analyzeVisits(filteredVisits, params);

    // Build fast lookups (avoid O(n) rescans per day / per DSE)
    const visitsByDseDate = new Map();
    const visitsByDse = new Map();
    const daysByDse = new Map();
    for (const v of annotatedVisits) {
      const k = v.dse_code + '|' + (v.date || '');
      if (!visitsByDseDate.has(k)) visitsByDseDate.set(k, []);
      visitsByDseDate.get(k).push(v);
      if (!visitsByDse.has(v.dse_code)) visitsByDse.set(v.dse_code, []);
      visitsByDse.get(v.dse_code).push(v);
    }
    for (const d of dailyMap.values()) {
      if (!daysByDse.has(d.dse_code)) daysByDse.set(d.dse_code, []);
      daysByDse.get(d.dse_code).push(d);
    }

    // Day-level analysis per DSE
    const dayAnalyses = new Map();
    for (const [key, dayData] of dailyMap.entries()) {
      const dayVisits = visitsByDseDate.get(dayData.dse_code + '|' + dayData.date) || [];
      if (dayVisits.length) dayAnalyses.set(key, analyzeDayVisits(dayVisits, dayData, params));
    }

    // DSE-level pattern detection
    const patterns = [];
    for (const dse of dseList) {
      const pats = detectDSERepeatingPatterns(dse.dse_code, dailyMap, annotatedVisits, params, daysByDse, visitsByDse);
      if (pats.length) patterns.push({ dse_code: dse.dse_code, dse_name: dse.dse_name, patterns: pats });
    }

    // Route analysis
    const routeInsights = analyzeRoutes(annotatedVisits, dseList, params);

    // Channel analysis
    const channelInsights = analyzeChannels(state);

    // Store analysis
    const storeInsights = analyzeStores(annotatedVisits, params);

    // Break detection
    const breaks = detectBreaks(state);

    // Hierarchy insights
    const hierarchies = aggregateHierarchy(dseList);
    const hierarchyInsights = generateHierarchyInsights(dseList, team);

    // Impact estimation
    const allBreaks = estimateImpacts(breaks.concat(hierarchyInsights), dseList);

    // Priority scoring
    for (const b of allBreaks) {
      b.priorityScore = priorityScore(b.severity, b.affectedCount || 0, b.gap || 0, b.frequency || 0, b.confidence);
    }
    allBreaks.sort((a, b) => b.priorityScore - a.priorityScore);

    const durationMs = performance.now() - startTime;

    return {
      breaks: allBreaks,
      patterns,
      hierarchies,
      routes: routeInsights,
      channels: channelInsights,
      stores: storeInsights,
      dayAnalyses,
      allInsights: allBreaks,
      meta: { durationMs: Math.round(durationMs), insightCount: allBreaks.length, visitCount: filteredVisits.length, dseCount: dseList.length }
    };
  }

  /* ─────────────────────────────────────────────────────────────────
     EXPORTS
     ───────────────────────────────────────────────────────────────── */

  NS.insightEngine = {
    TYPES, LEVELS, makeInsight,
    run, analyzeVisits, analyzeDayVisits, detectDSERepeatingPatterns,
    analyzeRoutes, analyzeChannels, analyzeStores,
    detectBreaks, aggregateHierarchy, generateHierarchyInsights,
    estimateImpacts, pct, avg, med, std,
    fmtPct, fmtNum, fmtHM, fmtMin, fmtMoney, fmtTimeMin, fmtClock,
    directionOf, severityOf, confidenceOf, priorityScore
  };
})();
