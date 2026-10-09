(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});
  const M = NS.metrics;
  const IE = NS.insightEngine;
  const makeInsight = IE.makeInsight;
  const LEVELS = IE.LEVELS;
  const TYPES = IE.TYPES;
  const fmtPct = IE.fmtPct;

  /* ─────────────────────────────────────────────────────────────────
     BEST PRACTICE DISCOVERY
     Identify high-performing DSEs and discover what they do differently.
     ───────────────────────────────────────────────────────────────── */

  function discoverBestPractices(state) {
    const { dseList, team } = state;
    if (!dseList.length) return [];

    const insights = [];
    const teamMedProd = team.medianProductivity;
    const teamAvgProd = team.productivityAvg;
    const teamMedStore = team.medianStoreMin;

    // Find top performers: high productivity + good discipline
    const topPerformers = dseList.filter(s =>
      s.productivityPct !== null && s.productivityPct >= 60 &&
      s.disciplineScore >= 70 && s.visits >= 5
    ).sort((a, b) => (b.productivityPct || 0) - (a.productivityPct || 0));

    // Find bottom performers for comparison
    const bottomPerformers = dseList.filter(s =>
      s.productivityPct !== null && s.productivityPct < teamMedProd &&
      s.visits >= 5
    ).sort((a, b) => (a.productivityPct || 0) - (b.productivityPct || 0));

    if (topPerformers.length >= 2 && bottomPerformers.length >= 2) {
      const topAvg = {
        storeMin: IE.avg(topPerformers.map(s => s.avgStoreMin)),
        onRoutePct: IE.avg(topPerformers.map(s => s.onRoutePct)),
        devPct: IE.avg(topPerformers.map(s => s.devPct)),
        startPct: IE.avg(topPerformers.map(s => s.startPct)),
        avgWorkingMin: IE.avg(topPerformers.map(s => s.avgWorkingMin)),
        visits: IE.avg(topPerformers.map(s => s.visits)),
        prodPerStoreHour: IE.avg(topPerformers.map(s => s.prodPerStoreHour)),
        disciplineScore: IE.avg(topPerformers.map(s => s.disciplineScore))
      };
      const bottomAvg = {
        storeMin: IE.avg(bottomPerformers.map(s => s.avgStoreMin)),
        onRoutePct: IE.avg(bottomPerformers.map(s => s.onRoutePct)),
        devPct: IE.avg(bottomPerformers.map(s => s.devPct)),
        startPct: IE.avg(bottomPerformers.map(s => s.startPct)),
        avgWorkingMin: IE.avg(bottomPerformers.map(s => s.avgWorkingMin)),
        visits: IE.avg(bottomPerformers.map(s => s.visits)),
        prodPerStoreHour: IE.avg(bottomPerformers.map(s => s.prodPerStoreHour)),
        disciplineScore: IE.avg(bottomPerformers.map(s => s.disciplineScore))
      };

      const diffs = [];
      if (topAvg.storeMin !== null && bottomAvg.storeMin !== null) {
        const storeTimeDiff = ((bottomAvg.storeMin - topAvg.storeMin) / bottomAvg.storeMin * 100);
        if (storeTimeDiff > 10) diffs.push('spend ' + Math.round(storeTimeDiff) + '% less store time per visit');
      }
      if (topAvg.onRoutePct !== null && bottomAvg.onRoutePct !== null && topAvg.onRoutePct > bottomAvg.onRoutePct + 5) {
        diffs.push('maintain ' + Math.round(topAvg.onRoutePct) + '% route adherence vs ' + Math.round(bottomAvg.onRoutePct) + '%');
      }
      if (topAvg.startPct !== null && bottomAvg.startPct !== null && topAvg.startPct > bottomAvg.startPct + 10) {
        diffs.push('start on time ' + Math.round(topAvg.startPct) + '% of days vs ' + Math.round(bottomAvg.startPct) + '%');
      }

      if (diffs.length > 0) {
        insights.push(makeInsight({
          id: 'bp-pattern-' + insights.length,
          level: LEVELS.EXECUTIVE,
          type: TYPES.BEST_PRACTICE,
          title: 'What the top ' + topPerformers.length + ' DSEs do differently',
          summary: 'Top performers ' + diffs.join(', ') + '. Doing the same tends to raise output.',
          metric: 'productivityPct',
          baseline: IE.avg(bottomPerformers.map(s => s.productivityPct)),
          currentValue: IE.avg(topPerformers.map(s => s.productivityPct)),
          gap: IE.avg(topPerformers.map(s => s.productivityPct)) - IE.avg(bottomPerformers.map(s => s.productivityPct)),
          direction: 'UP',
          affectedCount: topPerformers.length,
          evidence: diffs.map(d => 'Top performers: ' + d),
          likelyDrivers: ['Better time management', 'Steady discipline', 'Efficient store visits'],
          impact: { summary: 'A habit the other ' + bottomPerformers.length + ' DSEs can copy', quantified: null, unit: '' },
          confidence: topPerformers.length >= 4 ? 'HIGH' : 'MEDIUM',
          severity: 'LOW',
          recommendedAction: 'Use these top ' + topPerformers.length + ' DSEs as coaching examples for the team',
          drillable: true,
          supportingEntities: topPerformers.map(s => s.dse_code)
        }));
      }

      // Individual best practice insights for each top performer
      for (const dse of topPerformers.slice(0, 3)) {
        const strengths = [];
        if (dse.productivityPct >= 60) strengths.push(fmtPct(dse.productivityPct) + ' productivity');
        if (dse.onRoutePct !== null && dse.onRoutePct >= 95) strengths.push(Math.round(dse.onRoutePct) + '% route adherence');
        if (dse.avgStoreMin !== null && teamMedStore !== null && dse.avgStoreMin < teamMedStore) strengths.push(Math.round(dse.avgStoreMin) + ' min avg store time (below median)');
        if (dse.disciplineScore >= 85) strengths.push('discipline score ' + Math.round(dse.disciplineScore));

        if (strengths.length >= 2) {
          insights.push(makeInsight({
            id: 'bp-ind-' + insights.length,
            level: LEVELS.DSE_MTD,
            type: TYPES.BEST_PRACTICE,
            title: dse.dse_name + ' is a model performer',
            summary: dse.dse_name + ' shows: ' + strengths.join(', ') + '.',
            metric: 'overallScore',
            baseline: team.productivityAvg,
            currentValue: dse.productivityPct,
            gap: (dse.productivityPct || 0) - (team.productivityAvg || 0),
            direction: 'UP',
            affectedCount: 1,
            evidence: strengths,
            impact: { summary: 'A good example to share with the team', quantified: null, unit: '' },
            confidence: 'HIGH',
            severity: 'LOW',
            recommendedAction: 'Share ' + dse.dse_name + '\'s approach with the underperforming DSEs',
            drillable: true,
            supportingEntities: [dse.dse_code]
          }));
        }
      }
    }

    return insights;
  }

  /* ─────────────────────────────────────────────────────────────────
     OPPORTUNITY DETECTION
     Find areas for improvement, time reallocation, and efficiency gains.
     ───────────────────────────────────────────────────────────────── */

  function detectOpportunities(state) {
    const { dseList, team, filteredVisits, params } = state;
    if (!dseList.length) return [];

    const insights = [];
    const teamMedProd = team.medianProductivity;
    const teamMedStore = team.medianStoreMin;
    const teamMedOrder = team.medianOrder;

    // 1. Long hours, low conversion — opportunity
    const longLow = dseList.filter(s =>
      s.avgWorkingMin !== null && s.avgWorkingMin >= params.hoursThreshold &&
      s.productivityPct !== null && s.productivityPct < 40 && s.visits >= 10
    );
    if (longLow.length > 0) {
      insights.push(makeInsight({
        id: 'opp-longlow-' + insights.length,
        level: LEVELS.EXECUTIVE,
        type: TYPES.OPPORTUNITY,
        title: longLow.length + ' DSEs work long hours but convert little',
        summary: 'They clock 7+ hours with under 40% productivity. The effort is there, the output is not.',
        metric: 'productivityPct',
        baseline: 40,
        currentValue: IE.avg(longLow.map(s => s.productivityPct)),
        gap: IE.avg(longLow.map(s => s.productivityPct)) - 40,
        direction: 'DOWN',
        affectedCount: longLow.length,
        evidence: longLow.slice(0, 5).map(s => s.dse_name + ': ' + fmtPct(s.productivityPct) + ' in ' + M.fmtHM(s.avgWorkingMin)),
        likelyDrivers: ['Inefficient visit plan', 'Time in low-converting stores'],
        impact: { summary: 'Output they can recover with better planning', quantified: longLow.length, unit: 'DSEs' },
        confidence: longLow.length >= 3 ? 'HIGH' : 'MEDIUM',
        severity: 'HIGH',
        recommendedAction: 'Review the daily plan and in-store technique of ' + longLow.slice(0, 3).map(s => s.dse_name).join(', '),
        drillable: true,
        supportingEntities: longLow.map(s => s.dse_code)
      }));
    }

    // 2. Channel efficiency opportunity
    const channelData = filteredVisits.filter(v => v.channel !== 'SPECIALITY');
    const channels = ['SMALL', 'WS', 'LARGE', 'SELF SERVICE'];
    const chStats = channels.map(ch => {
      const cv = channelData.filter(v => v.channel === ch);
      const onRoute = cv.filter(v => v.on_route === 'YES');
      const prodYes = cv.filter(v => v.productivity === 'YES' && v.on_route === 'YES');
      const dur = cv.reduce((s, v) => s + (v.duration_min || 0), 0);
      return { ch, n: cv.length, dur, prodPct: IE.pct(prodYes.length, onRoute.length) };
    }).filter(c => c.n >= 20);
    const totalDur = chStats.reduce((s, c) => s + c.dur, 0) || 1;

    const highTimeLowProd = chStats.filter(c => (c.dur / totalDur) > 0.3 && c.prodPct < 50);
    for (const ch of highTimeLowProd) {
      const bestCh = chStats.sort((a, b) => (b.prodPct || 0) - (a.prodPct || 0))[0];
      if (bestCh && bestCh.ch !== ch.ch) {
        insights.push(makeInsight({
          id: 'opp-ch-' + insights.length,
          level: LEVELS.CHANNEL,
          type: TYPES.OPPORTUNITY,
          title: ch.ch + ' takes store time but gives little',
          summary: ch.ch + ' uses ' + Math.round(ch.dur / totalDur * 100) + '% of store time but converts only ' + fmtPct(ch.prodPct) + ' of calls. ' + bestCh.ch + ' converts at ' + fmtPct(bestCh.prodPct) + '.',
          metric: 'storeTimeShare',
          baseline: ch.dur / totalDur * 100,
          currentValue: ch.prodPct,
          gap: -(50 - ch.prodPct),
          direction: 'DOWN',
          where: ch.ch + ' channel',
          affectedCount: ch.n,
          evidence: [ch.ch + ': ' + Math.round(ch.dur / totalDur * 100) + '% of store time, ' + fmtPct(ch.prodPct) + ' productivity'],
          impact: { summary: 'Free time to spend on better channels', quantified: null, unit: '' },
          confidence: 'MEDIUM',
          severity: 'MEDIUM',
          recommendedAction: 'Shift some ' + ch.ch + ' visiting time to ' + bestCh.ch + ' stores',
          drillable: true
        }));
      }
    }

    // 3. DSEs with low order value
    const lowOrder = dseList.filter(s => s.avgOrder !== null && teamMedOrder !== null && s.avgOrder < teamMedOrder * 0.5 && s.visits >= 10);
    if (lowOrder.length >= 3) {
      insights.push(makeInsight({
        id: 'opp-ord-' + insights.length,
        level: LEVELS.EXECUTIVE,
        type: TYPES.OPPORTUNITY,
        title: lowOrder.length + ' DSEs bring in low order value',
        summary: 'Their average order is below half the team\'s typical order of ' + M.fmtMoney(teamMedOrder) + '.',
        metric: 'avgOrder',
        baseline: teamMedOrder,
        currentValue: IE.avg(lowOrder.map(s => s.avgOrder)),
        gap: -(teamMedOrder - IE.avg(lowOrder.map(s => s.avgOrder))),
        direction: 'DOWN',
        affectedCount: lowOrder.length,
        evidence: lowOrder.slice(0, 5).map(s => s.dse_name + ': avg ' + M.fmtMoney(s.avgOrder)),
        likelyDrivers: ['Missing assortment', 'Upselling technique', 'Store mix'],
        impact: { summary: 'Order value improvement opportunity', quantified: null, unit: '' },
        confidence: 'MEDIUM',
        severity: 'MEDIUM',
        recommendedAction: 'Give these DSEs assortment and upselling support',
        drillable: true,
        supportingEntities: lowOrder.map(s => s.dse_code)
      }));
    }

    // 4. Efficient workers — short hours, high productivity
    const efficient = dseList.filter(s =>
      s.avgWorkingMin !== null && s.avgWorkingMin < params.hoursThreshold &&
      s.productivityPct !== null && s.productivityPct >= 60
    ).sort((a, b) => (b.prodPerStoreHour || 0) - (a.prodPerStoreHour || 0));
    if (efficient.length >= 2) {
      insights.push(makeInsight({
        id: 'opp-eff-' + insights.length,
        level: LEVELS.EXECUTIVE,
        type: TYPES.OPPORTUNITY,
        title: efficient.length + ' DSEs get more with less time',
        summary: 'They reach ' + fmtPct(IE.avg(efficient.map(s => s.productivityPct))) + ' productivity in under 7 working hours.',
        metric: 'productivityPct',
        baseline: team.productivityAvg,
        currentValue: IE.avg(efficient.map(s => s.productivityPct)),
        gap: IE.avg(efficient.map(s => s.productivityPct)) - (team.productivityAvg || 0),
        direction: 'UP',
        affectedCount: efficient.length,
        evidence: efficient.slice(0, 5).map(s => s.dse_name + ': ' + fmtPct(s.productivityPct) + ' in ' + M.fmtHM(s.avgWorkingMin)),
        impact: { summary: 'A time-saving pattern to copy', quantified: null, unit: '' },
        confidence: efficient.length >= 3 ? 'HIGH' : 'MEDIUM',
        severity: 'LOW',
        recommendedAction: 'Study the daily plan of ' + efficient.slice(0, 3).map(s => s.dse_name).join(', ') + ' and share it team-wide',
        drillable: true,
        supportingEntities: efficient.map(s => s.dse_code)
      }));
    }

    return insights;
  }

  /* ─────────────────────────────────────────────────────────────────
     MANAGEMENT ACTIONS
     Generate actionable recommendations from all analysis.
     ───────────────────────────────────────────────────────────────── */

  function generateActions(state, breaks) {
    const { dseList, team, params } = state;
    if (!dseList.length) return [];

    const actions = [];
    let idCounter = 200;

    // Critical DSE interventions
    const critical = dseList.filter(s => s.riskClass === 'CRITICAL').sort((a, b) => b.riskScore - a.riskScore);
    const high = dseList.filter(s => s.riskClass === 'HIGH').sort((a, b) => b.riskScore - a.riskScore);
    const urgentList = critical.concat(high).slice(0, 8);

    if (urgentList.length) {
      actions.push(makeInsight({
        id: 'act-urgent-' + (++idCounter),
        level: LEVELS.EXECUTIVE,
        type: TYPES.ACTION,
        title: 'Meet these ' + urgentList.length + ' DSEs first',
        summary: urgentList.length + ' DSEs are at HIGH/CRITICAL risk and need a one-on-one review.',
        affectedCount: urgentList.length,
        evidence: urgentList.map(s => s.dse_name + ' (risk ' + s.riskScore + ': ' + s.riskFlags.map(f => f.key).join(', ') + ')'),
        impact: { summary: 'Highest priority for your attention', quantified: null, unit: '' },
        confidence: 'HIGH',
        severity: 'CRITICAL',
        recommendedAction: 'Set up catch-ups with ' + urgentList.slice(0, 5).map(s => s.dse_name).join(', '),
        drillable: true,
        supportingEntities: urgentList.map(s => s.dse_code)
      }));
    }

    // Route-level actions
    const routeBreaks = breaks.filter(b => b.type === TYPES.ROUTE_BREAK);
    if (routeBreaks.length) {
      actions.push(makeInsight({
        id: 'act-route-' + (++idCounter),
        level: LEVELS.ROUTE,
        type: TYPES.ACTION,
        title: 'Fix the flagged routes',
        summary: routeBreaks.length + (routeBreaks.length === 1 ? ' route has' : ' routes have') + ' more than one DSE below the team average at the same time.',
        affectedCount: routeBreaks.reduce((s, b) => s + (b.affectedCount || 0), 0),
        evidence: routeBreaks.map(b => b.title),
        impact: { summary: 'Route planning can be improved', quantified: null, unit: '' },
        confidence: 'MEDIUM',
        severity: 'HIGH',
        recommendedAction: 'Review the store mix and channel types on those routes',
        drillable: true
      }));
    }

    // Store time actions
    const storeTimeBreaks = breaks.filter(b => b.type === TYPES.STORE_TIME_BREAK);
    if (storeTimeBreaks.length) {
      const topStores = (state._engineResult && state._engineResult.stores || []).filter(s => s.longVisitCount >= s.visits * 0.5).slice(0, 10);
      actions.push(makeInsight({
        id: 'act-storetime-' + (++idCounter),
        level: LEVELS.EXECUTIVE,
        type: TYPES.ACTION,
        title: 'Cut down over-long store visits',
        summary: 'Store time is above the normal range in ' + storeTimeBreaks.length + ' areas. Bottom line: long visits mean fewer calls.',
        affectedCount: storeTimeBreaks.reduce((s, b) => s + (b.affectedCount || 0), 0),
        evidence: topStores.length ? topStores.map(s => s.retailerName + ': ' + s.visits + ' visits, ' + Math.round(s.avgStoreMin) + ' min average') : ['Try a visit-time limit'],
        impact: { summary: 'Frees time for more calls', quantified: null, unit: '' },
        confidence: 'MEDIUM',
        severity: 'HIGH',
        recommendedAction: 'Set a visit-time limit and review the longest stores',
        drillable: true
      }));
    }

    // Weekly focus
    actions.push(makeInsight({
      id: 'act-weekly-' + (++idCounter),
      level: LEVELS.EXECUTIVE,
      type: TYPES.ACTION,
      title: 'Weekly focus',
      summary: 'Track start time, route discipline and store time in the weekly review to see if coaching helps.',
      affectedCount: 0,
      evidence: ['Compare on-route vs off-route output', 'Review start-time distribution', 'Watch store-time trends'],
      impact: { summary: 'Keeps improvement on track', quantified: null, unit: '' },
      confidence: 'HIGH',
      severity: 'MEDIUM',
      recommendedAction: 'Add these three topics to the weekly meeting agenda',
      drillable: false
    }));

    return actions;
  }

  /* ─────────────────────────────────────────────────────────────────
     COMBINED RECOMMENDATIONS ENGINE
     ───────────────────────────────────────────────────────────────── */

  function generate(state, engineResult) {
    const bestPractices = discoverBestPractices(state);
    const opportunities = detectOpportunities(state);
    const actions = generateActions(state, engineResult ? engineResult.breaks : []);

    return {
      bestPractices,
      opportunities,
      actions,
      all: bestPractices.concat(opportunities).concat(actions).sort((a, b) => b.priorityScore - a.priorityScore)
    };
  }

  NS.recommendations = {
    generate,
    discoverBestPractices,
    detectOpportunities,
    generateActions
  };
})();
