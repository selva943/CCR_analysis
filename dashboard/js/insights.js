(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});
  const M = NS.metrics;
  const IE = NS.insightEngine;

  function fmtNum(n) { return n === null || n === undefined || !isFinite(n) ? '–' : n.toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
  function pct(n) { return n === null || n === undefined || !isFinite(n) ? '–' : n.toFixed(1) + '%'; }

  function generate(state) {
    const { dseList, team } = state;
    const res = { summary: [], positive: [], risk: [], anomaly: [], opportunity: [], action: [] };
    if (!dseList.length) return res;
    const n = dseList.length;
    const total = state.filteredVisits.length;

    const lateCount = dseList.filter(s => s.startPct !== null && s.startPct < 75).length;
    const highDevCount = dseList.filter(s => s.devPct !== null && s.devPct < 90).length;
    const offRouteCount = dseList.filter(s => s.onRoutePct !== null && s.onRoutePct < 90).length;
    const productive = dseList.filter(s => s.productivityPct !== null && s.productivityPct >= 60).length;
    const lowHours = dseList.filter(s => s.avgWorkingMin !== null && s.avgWorkingMin < 420).length;
    const highStore = dseList.filter(s => s.avgStoreMin !== null && team.medianStoreMin !== null && s.avgStoreMin > team.medianStoreMin * 1.5).length;

    res.summary.push({
      severity: 'medium', title: 'Team at a glance',
      detail: n + ' DSEs · ' + fmtNum(total) + ' visits · discipline ' + (team.disciplineAvg || 0).toFixed(1) +
        '% · productivity ' + (team.productivityAvg || 0).toFixed(1) + '% · avg working time ' + M.fmtHM(team.avgWorkingMin) +
        '. Among them, ' + lateCount + ' start late often, ' + offRouteCount + ' go off route often, ' + highDevCount + ' miss the ' + state.params.devThreshold + 'm rule, and ' + lowHours + ' work under 7 hours a day.'
    });

    const bestOverall = [...dseList].sort((a, b) => b.overallScore - a.overallScore)[0];
    if (bestOverall) res.positive.push({
      severity: 'positive', title: 'Best all-round performer',
      detail: bestOverall.dse_name + ' (' + bestOverall.dse_code + ') tops the overall score at ' + bestOverall.overallScore.toFixed(1) + ' — discipline ' + bestOverall.disciplineScore.toFixed(1) + ', productivity ' + (bestOverall.productivityPct === null ? '–' : bestOverall.productivityPct.toFixed(1) + '%') + '.'
    });

    const bestProd = [...dseList].sort((a, b) => (b.productivityPct || 0) - (a.productivityPct || 0)).filter(s => s.visits >= 5)[0];
    if (bestProd && bestProd.productivityPct >= 60) res.positive.push({
      severity: 'positive', title: 'Highest converter',
      detail: bestProd.dse_name + ' turns ' + pct(bestProd.productivityPct) + ' of on-route calls into productive output across ' + bestProd.visits + ' visits. Good model to learn from.'
    });

    for (const s of dseList) {
      const prod = s.productivityPct === null ? null : s.productivityPct;
      const hrs = s.avgWorkingMin === null ? null : s.avgWorkingMin;
      if (prod !== null && hrs < 420 && (prod || 0) >= 60) {
        res.positive.push({ severity: 'positive', title: 'Fast and productive', detail: s.dse_name + ' converts ' + prod.toFixed(0) + '% of calls in under 7 working hours (' + M.fmtHF(hrs) + '). A strong time usage model.' });
      }
    }
    if (productive) res.positive.push({
      severity: 'positive', title: productive + ' DSEs converting well',
      detail: Math.round(productive / n * 100) + '% of DSEs convert at least 60% of their calls in this view.'
    });

    if (lateCount) res.risk.push({
      severity: lateCount > Math.max(8, n * 0.2) ? 'critical' : 'high',
      title: lateCount + ' DSEs start late on most days',
      detail: 'They start after ' + M.fmtTimeMin(state.params.startThreshold) + ' on most days, missing the best hours for store calls. Names: ' + dseList.filter(s => s.startPct !== null && s.startPct < 75).slice(0, 6).map(s => s.dse_name).join(', ') + (lateCount > 6 ? '…' : '') + '.'
    });
    if (offRouteCount) res.risk.push({
      severity: offRouteCount > Math.max(6, n * 0.15) ? 'high' : 'medium',
      title: offRouteCount + ' DSEs go off route often',
      detail: 'They have fewer than 90% on-route visits. Off-route time may be useful or wasted; compare it against the on-route leaders below.'
    });
    if (highDevCount) res.risk.push({
      severity: 'high', title: highDevCount + ' DSEs are far from the marked stores',
      detail: 'They fail the ' + state.params.devThreshold + 'm rule on more than 10% of calls. Check the store location data before training.'
    });
    const lowProd = dseList.filter(s => s.productivityPct !== null && s.productivityPct < 30).length;
    if (lowProd) res.risk.push({
      severity: lowProd > Math.max(5, n * 0.15) ? 'critical' : 'high',
      title: lowProd + ' DSEs convert less than 30% of calls',
      detail: 'The most urgent problem in this view. Needs coaching, right product range, and a look at their territory.'
    });

    const lowHoursPct = n ? lowHours / n * 100 : 0;
    if (lowHoursPct > 20) res.anomaly.push({
      severity: 'medium', title: 'Many DSEs work under 7 hours',
      detail: lowHoursPct.toFixed(0) + '% of DSEs average under 7 working hours. This looks like a planning or territory problem more than an individual one.'
    });
    const earlyVsLate = compareGroups(dseList, s => s.startPct !== null && s.startPct >= 70, 'On-time starters', 'Late starters');
    if (earlyVsLate) res.anomaly.push({
      severity: 'medium', title: 'Does starting before ' + M.fmtTimeMin(state.params.startThreshold) + ' matter?',
      detail: 'On-time starters convert ' + pct(earlyVsLate[0].prodPct) + ' vs late starters ' + pct(earlyVsLate[1].prodPct) + '. ' + (earlyVsLate[0].prodPct > earlyVsLate[1].prodPct ? 'Starting on time goes with higher output.' : 'Late starters still match output — check what they do differently (or whether start time is captured well).') + ' Average calls: ' + earlyVsLate[0].callsPer + ' vs ' + earlyVsLate[1].callsPer + '.'
    });
    const h7v = compareGroups(dseList, s => s.avgWorkingMin !== null && s.avgWorkingMin >= 420, '7+ hour DSEs', '<7 hour DSEs');
    if (h7v) res.anomaly.push({
      severity: 'medium', title: 'Do longer hours help?',
      detail: '7+ hour DSEs: ' + pct(h7v[0].prodPct) + ' productivity, ' + h7v[0].callsPer + ' calls/day vs under 7h: ' + pct(h7v[1].prodPct) + ' productivity, ' + h7v[1].callsPer + ' calls/day. ' + (h7v[0].prodPct > h7v[1].prodPct ? 'Longer days do bring more output — protect working time.' : 'The difference is small — focus on the quality of hours, not just the count.')
    });

    const channels = channelInsights(state);
    if (channels) {
      if (channels.topShare && channels.topPct) res.opportunity.push({
        severity: 'medium', title: channels.topShare.title,
        detail: channels.topShare.detail
      });
      if (channels.lowEff) res.opportunity.push({
        severity: channels.lowEff.shareRatio > 1.5 ? 'high' : 'medium', title: channels.lowEff.title, detail: channels.lowEff.detail
      });
    }

    const hw = [...dseList].filter(s => s.avgWorkingMin !== null && s.avgWorkingMin >= 420 && s.productivityPct !== null && s.productivityPct < 40);
    if (hw.length) res.opportunity.push({
      severity: hw.length > Math.max(4, n * 0.1) ? 'high' : 'medium',
      title: hw.length + ' DSEs work long but convert little',
      detail: hw.slice(0, 5).map(s => s.dse_name).join(', ') + (hw.length > 5 ? '…' : '') + ' — long hours, low output. Redirect time toward route planning and in-store selling.'
    });
    const efficient = [...dseList].filter(s => s.avgWorkingMin !== null && s.avgWorkingMin < 420 && (s.productivityPct || 0) >= 60).sort((a, b) => (b.prodPerStoreHour || 0) - (a.prodPerStoreHour || 0)).slice(0, 5);
    if (efficient.length) res.opportunity.push({
      severity: 'positive', title: 'DSEs to learn from',
      detail: efficient.map(s => s.dse_name).join(', ') + ' get high output with tight time. Study and copy their daily plan.'
    });

    res.action.push({ severity: 'high', title: 'Start with these DSEs', detail: criticalFirst(dseList, state) });
    res.action.push({ severity: 'medium', title: 'Weekly focus', detail: 'Track the on-route vs productivity split and the start-time split each week to see whether coaching helps.' });

    // De-dup and trim
    const seen = new Set();
    for (const k of Object.keys(res)) {
      const arr = res[k];
      res[k] = arr.filter(x => { const key = x.title; if (seen.has(key)) return false; seen.add(key); return true; });
    }
    return res;
  }

  function compareGroups(dseList, pred, aName, bName) {
    const a = dseList.filter(pred), b = dseList.filter(s => !pred);
    if (!a.length || !b.length) return null;
    const g = list => {
      const visits = list.reduce((x, s) => x + s.visits, 0), prodOn = list.reduce((x, s) => x + s.prodOnRoute, 0), prodAll = list.reduce((x, s) => x + s.onRouteYes, 0);
      return { prodPct: M.pct(prodOn, prodAll) || 0, callsPer: (visits / list.length).toFixed(1) };
    };
    const ga = g(a), gb = g(b);
    return [{ name: aName, ...ga }, { name: bName, ...gb }];
  }

  function channelInsights(state) {
    const visits = state.filteredVisits.filter(v => v.channel !== 'SPECIALITY');
    const chs = ['SMALL', 'WS', 'LARGE', 'SELF SERVICE'];
    const rows = chs.map(ch => {
      const r = visits.filter(v => v.channel === ch);
      const store = r.reduce((a, v) => a + (v.duration_min || 0), 0);
      const prodOn = r.filter(v => v.productivity === 'YES' && v.on_route === 'YES').length;
      const prodAll = r.filter(v => v.on_route === 'YES').length;
      return { ch, n: r.length, store, prodPct: M.pct(prodOn, prodAll) || 0 };
    });
    const totalStore = rows.reduce((a, r) => a + r.store, 0) || 1;
    const top = [...rows].sort((a, b) => b.store - a.store)[0];
    const low = [...rows].sort((a, b) => a.prodPct - b.prodPct)[0];
    const out = [];
    if (top) out.topShare = { title: top.ch + ' takes the most store time', detail: top.ch + ' uses ' + Math.round(top.store / totalStore * 100) + '% of total store time across ' + top.n + ' visits at ' + pct(top.prodPct) + ' productivity. If it is also the lowest-converting channel, move time to better ones.' };
    if (low && low.n) {
      const lowCostHigh = low.prodPct < 50 && rows.every(r => r.prodPct >= low.prodPct);
      out.lowEff = { title: low.ch + ' is the least productive channel', detail: low.ch + ' converts only ' + pct(low.prodPct) + ' against an average of ' + pct(M.meanArr(rows.map(r => r.prodPct))) + '. Shift visiting time toward ' + [...rows].sort((a, b) => b.prodPct - a.prodPct)[0].ch + '.' };
    }
    return out;
  }

  function criticalFirst(dseList, state) {
    const critical = dseList.filter(s => s.riskClass === 'CRITICAL').sort((a, b) => b.riskScore - a.riskScore);
    const high = dseList.filter(s => s.riskClass === 'HIGH').sort((a, b) => b.riskScore - a.riskScore);
    const list = critical.concat(high).slice(0, 8);
    if (!list.length) return 'No DSE at high or critical risk in the current view.';
    return list.map(s => s.dse_name + ' (risk ' + s.riskScore + ': ' + s.riskFlags.map(f => f.key).join(', ') + ')').join('; ');
  }

  NS.insights = { generate };
})();