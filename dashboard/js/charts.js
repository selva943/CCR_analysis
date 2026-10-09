(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});
  const M = NS.metrics;

  const PALETTE = {
    green: '#16a34a', greenSoft: '#bbf7d0',
    amber: '#f59e0b', amberSoft: '#fde68a',
    red: '#ef4444', redSoft: '#fecaca',
    blue: '#3b82f6', blueSoft: '#bfdbfe',
    navy: '#1e293b', ink: '#0f172a', muted: '#64748b', grid: '#e2e8f0',
    channel: { SMALL: '#16a34a', WS: '#3b82f6', LARGE: '#f59e0b', 'SELF SERVICE': '#8b5cf6' }
  };

  const BASE = {
    color: [PALETTE.green, PALETTE.blue, PALETTE.amber, PALETTE.red, '#8b5cf6', '#06b6d4', '#f43f5e', '#84cc16', '#0ea5e9', '#a855f7'],
    tooltip: { trigger: 'axis', backgroundColor: '#0f172a', borderColor: '#1e293b', textStyle: { color: '#f1f5f9', fontSize: 12 }, padding: [8, 12], axisPointer: { type: 'line', lineStyle: { color: '#94a3b8' } } },
    textStyle: { fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", color: '#334155' },
    animationDuration: 500
  };

  const _chartCache = new Map();
  function getEchart(el) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!_chartCache.has(el)) _chartCache.set(el, echarts.init(el, null, { renderer: 'canvas' }));
    return _chartCache.get(el);
  }
  function resizeAll() {
    for (const el of _chartCache.keys()) { try { el.resize(); } catch (e) {} }
  }
  function render(el, option) {
    const ch = getEchart(el);
    ch.setOption(option, true);
    ch.resize();
    return ch;
  }
  function renderPlotly(el, data, layout, config) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (typeof Plotly === 'undefined') { el.innerHTML = '<div class="ec-empty"><div>Plotly not loaded</div></div>'; return; }
    Plotly.newPlot(el, data, layout, Object.assign({ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] }, config || {}));
  }
  function empty(el, msg) {
    if (typeof el === 'string') el = document.getElementById(el);
    el.innerHTML = '<div class="ec-empty"><div class="ec-empty-title">No data available for the selected filters</div><div class="ec-empty-sub">' + (msg || 'Try widening the date range or clearing filters.') + '</div></div>';
  }

  function axisBase() {
    return {
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b', fontSize: 11 },
      splitLine: { lineStyle: { color: '#f1f5f9' } },
      axisTick: { show: false }
    };
  }

  function refLine(value, label, style) {
    const st = Object.assign({ color: PALETTE.red, type: 'dashed', width: 1.2, dim: 'x' }, style || {});
    const dataItem = st.dim === 'y' ? { yAxis: value } : { xAxis: value };
    return { markLine: { symbol: 'none', label: { formatter: label, position: 'end', color: st.color, fontSize: 11, fontWeight: 700 }, lineStyle: st, data: [dataItem] } };
  }

  function kpiSparkline(el, values, color) {
    const ch = getEchart(el);
    const o = {
      grid: { left: 2, right: 2, top: 2, bottom: 2 },
      xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
      yAxis: { type: 'value', show: false, scale: true },
      series: [{ type: 'line', data: values, smooth: true, symbol: 'none', lineStyle: { color, width: 2 }, areaStyle: { color: color, opacity: 0.08 }, connectNulls: true }]
    };
    ch.setOption(o, true);
  }

  function lineTrendChart(container, xLabels, values, name, opts) {
    opts = opts || {};
    const vf = opts.valueFormatter || (v => fmtVal(v));
    const data = xLabels.map((x, i) => [x, values[i]]);
    const seriesDef = [{
      name, type: 'line', data, smooth: true, symbol: 'circle', symbolSize: 5, connectNulls: true,
      lineStyle: { width: 2.5, color: opts.color || PALETTE.blue }, itemStyle: { color: opts.color || PALETTE.blue },
      areaStyle: { color: opts.color || PALETTE.blue, opacity: 0.07 },
      markLine: opts.markLine
    }];
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'axis', formatter: ps => {
        const row = ps[0];
        let html = '<b>' + row.axisValue + '</b><br/>' + name + ': <b>' + (row.data[1] === null || row.data[1] === undefined ? '–' : vf(row.data[1])) + '</b>';
        return html;
      } },
      legend: opts.legend === undefined ? false : opts.legend,
      grid: { left: 56, right: 20, top: opts.legend ? 34 : 30, bottom: 36, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: xLabels, boundaryGap: false }, axisBase('category')),
      series: seriesDef
    });
    const yAxisDef = Object.assign({ type: 'value', scale: opts.scale === true, min: opts.min, max: opts.max }, axisBase('value'));
    if (opts.valueFormatter) {
      yAxisDef.axisLabel = Object.assign({}, yAxisDef.axisLabel, { formatter: opts.valueFormatter });
    }
    o.yAxis = yAxisDef;
    render(container, o);
  }

  function stackedBar(container, categories, seriesArr, opts) {
    opts = opts || {};
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => {
        let html = '<b>' + ps[0].axisValue + '</b>';
        let total = 0;
        for (const s of ps) { html += '<br/><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + s.color + ';margin-right:4px"></span>' + s.seriesName + ': <b>' + fmtVal(s.value) + '</b>'; total += Number(s.value) || 0; }
        if (opts.showTotal !== false) html += '<br/>Total: <b>' + fmtVal(total) + '</b>';
        return html;
      } },
      legend: { top: 0, textStyle: { color: '#475569', fontSize: 11 }, type: 'scroll' },
      grid: { left: 56, right: 24, top: 34, bottom: opts.rotate ? 90 : 40 },
      xAxis: Object.assign({ type: 'category', data: categories, axisLabel: { color: '#64748b', fontSize: 11, rotate: opts.rotate || 0 } }, axisBase('category')),
      yAxis: Object.assign({ type: 'value', scale: opts.scale === true }, axisBase('value')),
      series: seriesArr.map(s => ({ type: 'bar', stack: opts.stack === false ? undefined : 'total', name: s.name, data: s.data, itemStyle: { color: s.color } }))
    });
    render(container, o);
  }

  function groupBar(container, categories, seriesArr, opts) {
    opts = opts || {};
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => {
        let html = '<b>' + ps[0].axisValue + '</b>';
        for (const s of ps) html += '<br/><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + s.color + ';margin-right:4px"></span>' + s.seriesName + ': <b>' + fmtVal(s.value) + '</b>';
        return html;
      } },
      legend: { top: 0, textStyle: { color: '#475569', fontSize: 11 }, type: 'scroll' },
      grid: { left: 56, right: 24, top: 34, bottom: opts.rotate ? 90 : 40 },
      xAxis: Object.assign({ type: 'category', data: categories, axisLabel: { color: '#64748b', fontSize: 11, rotate: opts.rotate || 0 } }, axisBase('category')),
      yAxis: Object.assign({ type: 'value', scale: opts.scale === true }, axisBase('value')),
      series: seriesArr.map(s => ({ type: 'bar', name: s.name, data: s.data.map(v => typeof v === 'string' ? (isNaN(parseFloat(v)) ? 0 : parseFloat(v)) : v), barMaxWidth: 26, itemStyle: { color: s.color, borderRadius: [3, 3, 0, 0] } }))
    });
    render(container, o);
  }

  function donut(container, data, opts) {
    if (!data.some(d => d.value > 0)) { empty(container); return; }
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'item', formatter: '{b}: <b>{c}</b> ({d}%)' },
      legend: { orient: 'vertical', right: 8, top: 'middle', textStyle: { color: '#475569', fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['52%', '74%'], center: ['42%', '50%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 }, label: { show: false }, emphasis: { label: { show: true, fontWeight: 600, fontSize: 13 } },
        data
      }]
    });
    render(container, o);
  }

  function radarChart(container, indicators, seriesArr, opts) {
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: '#475569', fontSize: 11 }, type: 'scroll' },
      radar: {
        indicator: indicators, radius: '65%', center: ['50%', '50%'], axisName: { color: '#475569', fontSize: 11 },
        splitArea: { areaStyle: { color: ['#f8fafc', '#f1f5f9'] } }, splitLine: { lineStyle: { color: '#e2e8f0' } }, axisLine: { lineStyle: { color: '#e2e8f0' } }
      },
      series: [{
        type: 'radar', symbol: 'circle', symbolSize: 5,
        data: seriesArr.map(s => ({ value: s.value.map(v => v === null || v === undefined ? 0 : v), name: s.name, areaStyle: { color: s.color, opacity: 0.12 }, lineStyle: { color: s.color, width: 2 }, itemStyle: { color: s.color } }))
      }]
    });
    render(container, o);
  }

  function gauge(container, value, max, opts) {
    opts = opts || {};
    const o = Object.assign({}, BASE, {
      series: [{
        type: 'gauge', min: 0, max: max || 100, startAngle: 210, endAngle: -30, radius: '92%', center: ['50%', '58%'],
        progress: { show: true, width: 14, itemStyle: { color: opts.color || PALETTE.green } },
        axisLine: { lineStyle: { width: 14, color: [[1, '#e2e8f0']] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        pointer: { show: false }, anchor: { show: false },
        title: { show: true, offsetCenter: [0, '42%'], color: '#475569', fontSize: 13, formatter: opts.title || '' },
        detail: { valueAnimation: true, formatter: v => (opts.formatter ? opts.formatter(v) : (v === null ? '–' : Math.round(v) + '%')), color: opts.color || PALETTE.ink, fontSize: 34, offsetCenter: [0, '8%'], fontWeight: 700 },
        data: [{ value: value === null || value === undefined ? 0 : value }]
      }]
    });
    render(container, o);
  }

  function scatterQuadrant(container, data, opts) {
    if (!data || !data.length) { empty(container); return; }
    const lineData = (opts.markLines || []).map(r => r.markLine.data[0]);
    const rows = data.map(pt => [Number(pt.x), Number(pt.y), pt]);
    const tooltipName = opts.nameOf || 'name';
    const o = {
      tooltip: {
        ...BASE.tooltip, trigger: 'item', formatter: p => {
          const d = p.data && (p.data.length ? p.data[2] : p.data);
          if (!d) return '';
          const lines = ['<b>' + d[tooltipName] + '</b>', '<span style="color:#94a3b8">' + d.branch + ' · ' + (d.asm || '—') + '</span>', opts.xName + ': <b>' + d.x + '</b>', opts.yName + ': <b>' + d.y + '</b>', d.sub1 || '', d.sub2 || ''];
          return lines.filter(Boolean).join('<br/>');
        }
      },
      grid: { left: 60, right: 24, top: 24, bottom: 44, containLabel: true },
      xAxis: Object.assign({ type: 'value', name: opts.xName, nameTextStyle: { color: '#64748b', fontSize: 11 }, min: opts.xMin, max: opts.xMax, scale: true }, axisBase('value')),
      yAxis: Object.assign({ type: 'value', name: opts.yName, nameTextStyle: { color: '#64748b', fontSize: 11 }, min: opts.yMin, max: opts.yMax, scale: true }, axisBase('value')),
      series: [{
        type: 'scatter', data: rows, encode: { x: 0, y: 1 },
        symbolSize: d => { const pt = d && !Array.isArray(d) ? d : (d && d[2]) || {}; return Math.max(8, Math.min(34, parseFloat(pt.size) || 12)); },
        itemStyle: { color: p => { const pt = p.data && p.data[2] ? p.data[2] : {}; return pt.color || PALETTE.blue; }, opacity: 0.85, borderColor: '#fff', borderWidth: 1 },
        emphasis: { scale: 1.4, itemStyle: { borderColor: '#0f172a', borderWidth: 2 } },
        markLine: { symbol: 'none', label: { show: true, fontSize: 11, color: '#64748b', formatter: l => l.value }, lineStyle: { color: '#94a3b8', type: 'dashed' }, data: lineData }
      }]
    };
    render(container, o);
  }

  function buildCalendarHeatmap(container, dailyMap, dseOrder, dates, tooltipFn) {
    if (dseOrder.length <= 25 && dates.length <= 62) {
      const cellData = [];
      for (let r = 0; r < dseOrder.length; r++) {
        for (let c = 0; c < dates.length; c++) {
          const key = dseOrder[r] + '|' + dates[c];
          const d = dailyMap.get(key);
          cellData.push([r, c, d ? (d.dayScore === null || d.dayScore === undefined ? -1 : d.dayScore) : -1]);
        }
      }
      const o = Object.assign({}, BASE, {
        tooltip: { ...BASE.tooltip, trigger: 'item', formatter: p => {
          const d = dailyMap.get(dseOrder[p.value[0]] + '|' + dates[p.value[1]]);
          if (!d) return '<b>No activity</b>';
          return tooltipFn(d);
        } },
        grid: { left: 150, right: 20, top: 20, bottom: 50 },
        xAxis: Object.assign({ type: 'category', data: dates.map(dt => { const x = new Date(dt + 'T00:00:00'); return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); }), splitArea: { show: true }, axisLabel: { color: '#64748b', fontSize: 11, rotate: 40 } }, axisBase('category')),
        yAxis: Object.assign({ type: 'category', data: dseOrder.map(code => (dseMeta[code] ? dseMeta[code].short : code)), splitArea: { show: true }, axisLabel: { color: '#334155', fontSize: 11 } }, axisBase('category')),
        visualMap: { min: 0, max: 100, calculable: false, orient: 'horizontal', left: 'center', bottom: 6, inRange: { color: ['#ef4444', '#f59e0b', '#fde68a', '#bbf7d0', '#16a34a'] }, textStyle: { color: '#64748b', fontSize: 11 }, formatter: v => v < 0 ? 'No data' : v.toFixed(0) },
        series: [{ type: 'heatmap', data: cellData, itemStyle: { borderColor: '#fff', borderWidth: 1.5 }, label: { show: false } }]
      });
      render(container, o);
      return;
    }
    dailyClassTrend(container, dailyMap, dates, tooltipFn);
  }

  function dailyClassTrend(container, dailyMap, dates, tooltipFn) {
    const datesArr = dates;
    const goodData = [], modData = [], riskData = [];
    for (const dt of datesArr) {
      const els = [...dailyMap.values()].filter(d => d.date === dt);
      goodData.push(els.filter(d => d.dayClass === 'GOOD').length);
      modData.push(els.filter(d => d.dayClass === 'MODERATE').length);
      riskData.push(els.filter(d => d.dayClass === 'RISK').length);
    }
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => {
        let html = '<b>' + ps[0].axisValue + '</b>';
        let tot = 0;
        for (const s of ps) { html += '<br/><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + s.color + ';margin-right:4px"></span>' + s.seriesName + ': <b>' + s.value + '</b>'; tot += Number(s.value) || 0; }
        html += '<br/>Total: <b>' + tot + '</b>';
        return html;
      } },
      legend: { top: 0, textStyle: { color: '#475569', fontSize: 11 }, type: 'scroll' },
      grid: { left: 46, right: 16, top: 34, bottom: 40, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: datesArr.map(dt => { const x = new Date(dt + 'T00:00:00'); return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); }), axisLabel: { color: '#64748b', fontSize: 11, rotate: 40 } }, axisBase('category')),
      yAxis: Object.assign({ type: 'value', minInterval: 1 }, axisBase('value')),
      series: [
        { name: 'Good', type: 'bar', stack: 'class', data: goodData, itemStyle: { color: PALETTE.green } },
        { name: 'Moderate', type: 'bar', stack: 'class', data: modData, itemStyle: { color: PALETTE.amber } },
        { name: 'Risk', type: 'bar', stack: 'class', data: riskData, itemStyle: { color: PALETTE.red } }
      ]
    });
    render(container, o);
  }

  function buildExecutiveHeatmap(containerElementId, dseList, opts) {
    opts = opts || {};
    const team = opts.team || {};
    const items = [];
    const push = (name, v, fmt) => { if (v === null || v === undefined || !isFinite(v)) return; items.push({ name, value: v, fmt }); };
    push('On-time start', team.startAvg, v => v.toFixed(1) + '%');
    push('On route', team.onRouteAvg, v => v.toFixed(1) + '%');
    push('Deviation compliant', team.devAvg, v => v.toFixed(1) + '%');
    push('Working hours', team.avgWorkingMin, v => M.fmtHM(Math.round(v)));
    push('Productivity', team.productivityAvg, v => v.toFixed(1) + '%');
    push('Call compliance', team.callCompAvg, v => v.toFixed(1) + '%');
    push('Good discipline DSE', team.dseCount ? (dseList.filter(s => s.disciplineClass === 'GOOD').length) : null, v => v + ' DSE');
    if (!items.length) { empty(containerElementId); return; }
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => {
        let html = '<b>Team benchmark</b>';
        for (const s of ps) { const it = items.find(i => i.name === s.seriesName); html += '<br/><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + s.color + ';margin-right:4px"></span>' + it.name + ': <b>' + (it.fmt ? it.fmt(it.value) : fmtVal(it.value)) + '</b>'; }
        return html;
      } },
      grid: { left: 10, right: 66, top: 10, bottom: 10, containLabel: true },
      xAxis: Object.assign({ type: 'value', min: 0, max: 100, axisLabel: { color: '#64748b', fontSize: 11, formatter: '{value}%' } }, axisBase('value')),
      yAxis: Object.assign({ type: 'category', data: items.map(i => i.name), axisLabel: { color: '#334155', fontSize: 12, width: 130, overflow: 'truncate' } }, axisBase('category')),
      series: [{
        type: 'bar', data: items.map(i => i.value), barWidth: '55%', label: { show: true, position: 'right', color: '#334155', fontSize: 12, formatter: p => items[p.dataIndex].fmt ? items[p.dataIndex].fmt(items[p.dataIndex].value) : fmtVal(items[p.dataIndex].value) },
        itemStyle: { color: p => { const v = items[p.dataIndex].value; const n = items[p.dataIndex].name;
          return (n === 'On-time start' && v >= 90) || (n === 'On route' && v >= 90) || (n === 'Deviation compliant' && v >= 90) || (n === 'Working hours' && v >= 420) || (n === 'Productivity' && v >= 60) || (n === 'Call compliance' && v >= 80) ? PALETTE.green : PALETTE.amber; },
          borderRadius: [0, 4, 4, 0] }
      }]
    });
    render(containerElementId, o);
  }

  function prodPctBars(container, data, opts) {
    opts = opts || {};
    const o = Object.assign({}, BASE, {
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => {
        const i = ps[0].dataIndex;
        const d = data[i];
        let html = '<b>' + d.name + '</b>';
        html += '<br/>Productivity: <b>' + (d.value === null || d.value === undefined ? '–' : fmtVal(d.value) + '%') + '</b>';
        if (d.sub) html += '<br/><span style="color:#94a3b8">' + d.sub + '</span>';
        return html;
      } },
      grid: { left: 16, right: 20, top: 24, bottom: 28, containLabel: true },
      xAxis: Object.assign({ type: 'category', data: data.map(d => d.name), axisLabel: { color: '#334155', fontSize: 12, fontWeight: 600 } }, axisBase('category')),
      yAxis: Object.assign({ type: 'value', min: 0, max: 100, axisLabel: { color: '#64748b', fontSize: 11, formatter: '{value}%' } }, axisBase('value')),
      series: [{
        type: 'bar', barMaxWidth: 90, barCategoryGap: '35%',
        data: data.map(d => ({ value: d.value === null || d.value === undefined ? 0 : Math.round(d.value * 10) / 10, itemStyle: { color: d.color } })),
        itemStyle: { borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: 'top', fontWeight: 700, fontSize: 15, color: '#0f172a', formatter: p => (data[p.dataIndex].value === null || data[p.dataIndex].value === undefined ? '–' : fmtVal(data[p.dataIndex].value) + '%') }
      }]
    });
    render(container, o);
  }

  let dseMeta = {};

  function fmtVal(v) {
    if (v === null || v === undefined) return '–';
    return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  }

  function baseOption() { return BASE; }

  NS.charts = {
    palette: PALETTE, base: BASE, baseOption, getEchart, render, renderPlotly, empty,
    kpiSparkline, lineTrendChart, stackedBar, groupBar, donut, radarChart, gauge,
    scatterQuadrant, buildCalendarHeatmap, buildExecutiveHeatmap, axisBase, refLine, fmtVal, resizeAll, prodPctBars,
    setDseMeta: m => { dseMeta = m; }
  };
})();