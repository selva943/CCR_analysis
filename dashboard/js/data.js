(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});

  const LT_LAT = 8.0, GT_LAT = 37.0, LT_LON = 68.0, GT_LON = 97.0;

  function normKey(k) {
    return String(k).toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  }

  const HEADER_MAP = {
    branch_code: 'branch_code', branchlocation: 'branch_location', branch_location: 'branch_location',
    dsecode: 'dse_code', dse_code: 'dse_code', dsename: 'dse_name', dse_name: 'dse_name',
    date: 'date', routename: 'route_name', route_name: 'route_name',
    retailercode: 'retailer_code', retailer_code: 'retailer_code',
    retailername: 'retailer_name', retailer_name: 'retailer_name',
    contactnumber1: 'contact_number_1', contact_number_1: 'contact_number_1',
    contactnumber2: 'contact_number_2', contact_number_2: 'contact_number_2',
    channelname: 'channel_name', channel_name: 'channel_name',
    subchannelname: 'sub_channel_name', sub_channel_name: 'sub_channel_name',
    inmarketstatus: 'in_market_status', in_market_status: 'in_market_status',
    daystarttime: 'day_start_time', day_start_time: 'day_start_time',
    starttime: 'start_time', start_time: 'start_time',
    endtime: 'end_time', end_time: 'end_time',
    intime: 'intime',
    distancetravelled: 'distance_travelled', distance_travelled: 'distance_travelled',
    ordervalue: 'order_value', order_value: 'order_value',
    productivity: 'productivity',
    visitp1mach: 'visit_p1m_ach', visit_p1m_ach: 'visit_p1m_ach', visitp1m_ach: 'visit_p1m_ach',
    visitp3mach: 'visit_p3m_ach', visit_p3m_ach: 'visit_p3m_ach', visitp3m_ach: 'visit_p3m_ach',
    visiipdpach: 'visit_ip_dp_ach', visit_ip_dp_ach: 'visit_ip_dp_ach', visitipdpach: 'visit_ip_dp_ach',
    reason: 'reason',
    visitlatitude: 'visit_latitude', visit_latitude: 'visit_latitude',
    visitlongitude: 'visit_longitude', visit_longitude: 'visit_longitude',
    deviationinmeter: 'deviation_in_meter', deviation_in_meter: 'deviation_in_meter', deviationinmeters: 'deviation_in_meter',
    deviation: 'deviation',
    reasonfordeviation: 'reason_for_deviation', reason_for_deviation: 'reason_for_deviation',
    onroute: 'on_route', on_route: 'on_route',
    remarks: 'remarks',
    zsm: 'zsm', asm: 'asm', aso: 'aso',
    callsmade: 'calls_made', calls_made: 'calls_made', calls: 'calls_made',
    callcompliance: 'call_compliance', call_compliance: 'call_compliance',
    below5mins: 'below_5_mins', below_5_mins: 'below_5_mins',
    'below5mins.1': 'below_5_mins'
  };

  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return !isNaN(v.getTime()) ? v : null;
    if (typeof v === 'number') {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    const s = String(v).trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d.getTime()) ? null : d; }
    const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m2) { const y = m2[3].length === 2 ? 2000 + +m2[3] : +m2[3]; const d = new Date(y, +m2[1] - 1, +m2[2]); return isNaN(d.getTime()) ? null : d; }
    const m3 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
    if (m3) { const y = m3[3].length === 2 ? 2000 + +m3[3] : +m3[3]; const d = new Date(y, +m3[2] - 1, +m3[1]); return isNaN(d.getTime()) ? null : d; }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function toTimeMinutes(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.getHours() * 60 + v.getMinutes() + v.getSeconds() / 60;
    if (typeof v === 'number') return v * 1440;
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/i);
    if (!m) m = s.match(/^(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})$/);
    if (!m) return null;
    let h = +m[1], mi = +m[2], sec = m[3] ? +m[3] : 0, ap = m[4] ? m[4].toLowerCase() : null;
    if (ap) {
      if (ap === 'am' && h === 12) h = 0;
      if (ap === 'pm' && h < 12) h += 12;
    }
    if (h > 23 || mi > 59 || sec > 60) return null;
    return h * 60 + mi + sec / 60;
  }

  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).replace(/[₹,\s]/g, '').trim();
    if (!s) return null;
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function toYN(v) {
    if (v === null || v === undefined) return 'UNKNOWN';
    if (typeof v === 'number') {
      if (v === 1 || v === 1.0) return 'YES';
      if (v === 0 || v === 0.0) return 'NO';
      return 'UNKNOWN';
    }
    const s = String(v).trim().toLowerCase();
    if (s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === 'pass' || s === 'done' || s === 'on') return 'YES';
    if (s === 'no' || s === 'n' || s === 'false' || s === '0' || s === 'fail' || s === 'off') return 'NO';
    return 'UNKNOWN';
  }

  function classifyChannel(raw) {
    const c = String(raw || '').trim().toLowerCase();
    if (!c) return { channel: 'SELF SERVICE', channel_source: raw };
    if (c.indexOf('speciality') !== -1) return { channel: 'SPECIALITY', channel_source: raw };
    if (c.indexOf('small') !== -1) return { channel: 'SMALL', channel_source: raw };
    if (c.indexOf('ws') !== -1) return { channel: 'WS', channel_source: raw };
    if (c.indexOf('large') !== -1) return { channel: 'LARGE', channel_source: raw };
    return { channel: 'SELF SERVICE', channel_source: raw };
  }

  function fmtDateISO(d) {
    return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : null;
  }

  function processSheet(rows) {
    const report = {
      totalRows: rows.length,
      validRows: 0,
      duplicateRows: 0,
      missingDate: 0,
      missingDse: 0,
      missingStartTime: 0,
      missingEndTime: 0,
      missingIntime: 0,
      missingCoordinates: 0,
      invalidDeviation: 0,
      invalidProductivity: 0,
      missingDayStart: 0,
      missingOnRoute: 0,
      negativeDuration: 0,
      missingOrderValue: 0,
      missingChannel: 0,
      longDurations: 0,
      missingCallCompliance: 0,
      invalidDistance: 0,
      missingAsmAso: 0,
      flags: []
    };

    if (!rows || !rows.length) throw new Error('Empty sheet');

const keys = Object.keys(rows[0] || {});
    const mapped = {};
    const missingRequired = [];
    for (let i = 0; i < keys.length; i++) {
      const n = normKey(keys[i]);
      const t = HEADER_MAP[n] || HEADER_MAP[keys[i]] || HEADER_MAP[keys[i].toLowerCase()];
      if (t && !mapped[t]) mapped[t] = keys[i];
    }
    const REQUIRE = ['dse_code', 'dse_name', 'date', 'branch_code', 'branch_location', 'on_route', 'productivity', 'start_time', 'end_time', 'day_start_time', 'deviation_in_meter', 'visit_latitude', 'visit_longitude', 'channel_name', 'order_value', 'zsm', 'asm', 'aso', 'calls_made', 'call_compliance'];
    for (let i = 0; i < REQUIRE.length; i++) {
      if (!mapped[REQUIRE[i]]) missingRequired.push(REQUIRE[i]);
    }
    if (missingRequired.length) {
      report.missingCols = missingRequired;
      return { report, visits: [], error: 'Required columns missing: ' + missingRequired.join(', ') };
    }

    const indexKey = mapped['date'];
    const visits = [];
    const dupSet = new Set();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const dateObj = toDate(r[mapped['date']]);
      const dseCode = String(r[mapped['dse_code']] == null ? '' : String(r[mapped['dse_code']]).trim());
      const dseName = String(r[mapped['dse_name']] == null ? '' : String(r[mapped['dse_name']]).trim());
      const iso = fmtDateISO(dateObj);
      if (!iso) { report.missingDate++; continue; }
      if (!dseCode && !dseName) { report.missingDse++; continue; }

      const onRouteRaw = r[mapped['on_route']];
      const onRoute = toYN(onRouteRaw);
      const productivity = toYN(r[mapped['productivity']]);

      const startM = toTimeMinutes(r[mapped['start_time']]);
      const endM = toTimeMinutes(r[mapped['end_time']]);
      const dayStartM = toTimeMinutes(r[mapped['day_start_time']]);
      const intimeM = toTimeMinutes(r[mapped['intime']]);

      const lat = toNum(r[mapped['visit_latitude']]);
      const lon = toNum(r[mapped['visit_longitude']]);
      const devRaw = r[mapped['deviation_in_meter']];
      const devM = toNum(devRaw);

      const hasStart = startM !== null, hasEnd = endM !== null;
      let durationMin = null;
      if (hasStart && hasEnd) {
        durationMin = endM - startM;
        if (durationMin < 0) { report.negativeDuration++; durationMin = null; }
      }
      if (durationMin !== null && durationMin > 240) report.longDurations++;

      let isValid = true;
      if (!hasStart) { report.missingStartTime++; isValid = false; }
      if (!hasEnd) { report.missingEndTime++; isValid = false; }
      if (r[mapped['intime']] === null || r[mapped['intime']] === undefined || r[mapped['intime']] === '') { report.missingIntime++; }
      if (lat === null || lon === null || lat < LT_LAT || lat > GT_LAT || lon < LT_LON || lon > GT_LON || (lat === 0 && lon === 0)) { report.missingCoordinates++; isValid = false; }
      if (devM === null || devM < 0) { report.invalidDeviation++; isValid = false; }
      if (onRoute === 'UNKNOWN') { report.missingOnRoute++; isValid = false; }
      if (productivity === 'UNKNOWN') { report.invalidProductivity++; isValid = false; }
      if (dayStartM === null) report.missingDayStart++;
      if (r[mapped['channel_name']] == null || String(r[mapped['channel_name']]).trim() === '') report.missingChannel++;

      const orderValue = toNum(r[mapped['order_value']]);
      if (orderValue === null) report.missingOrderValue++;
      const dist = toNum(r[mapped['distance_travelled']]);
      if (dist === null || dist < 0) report.invalidDistance++;

      const callCompRaw = r[mapped['call_compliance']];
      let callComp = null;
      if (callCompRaw !== null && callCompRaw !== undefined && callCompRaw !== '') {
        const cn = toNum(callCompRaw);
        callComp = cn !== null ? (cn >= 1 ? 'YES' : 'NO') : toYN(callCompRaw);
      }
      if (callComp === null) report.missingCallCompliance++;

      const asm = String(r[mapped['asm']] == null ? '' : String(r[mapped['asm']]).trim());
      const aso = String(r[mapped['aso']] == null ? '' : String(r[mapped['aso']]).trim());
      const zsm = String(r[mapped['zsm']] == null ? '' : String(r[mapped['zsm']]).trim());
      if (!asm && !aso) report.missingAsmAso++;

      const ch = classifyChannel(r[mapped['channel_name']]);
      const chName = r[mapped['channel_name']] == null ? '' : String(r[mapped['channel_name']]).trim();

      const prodRaw = String(r[mapped['productivity']] == null ? '' : String(r[mapped['productivity']]).trim());
      const callMade = toNum(r[mapped['calls_made']]);

      const retCode = String(r[mapped['retailer_code']] == null ? '' : String(r[mapped['retailer_code']]).trim());
      const rateName = String(r[mapped['retailer_name']] == null ? '' : String(r[mapped['retailer_name']]).trim());

      const dupKey = dseCode + '|' + iso + '|' + retCode + '|' + (hasStart ? startM.toFixed(2) : '') + '|' + (hasEnd ? endM.toFixed(2) : '');
      const pk = dseCode + '|' + iso + '|' + retCode;
      if (dupSet.has(dupKey) || dupSet.has(pk)) { report.duplicateRows++; isValid = false; }
      else dupSet.add(dupKey);

      const visit = {
        branch_code: String(r[mapped['branch_code']] == null ? '' : String(r[mapped['branch_code']]).trim()),
        branch_location: String(r[mapped['branch_location']] == null ? '' : String(r[mapped['branch_location']]).trim()),
        dse_code: dseCode, dse_name: dseName,
        date: iso, dateObj: dateObj.getTime(),
        route_name: r[mapped['route_name']] == null ? null : String(r[mapped['route_name']]).trim(),
        retailer_code: retCode, retailer_name: rateName,
        contact_1: r[mapped['contact_number_1']] == null ? '' : String(r[mapped['contact_number_1']]).trim(),
        contact_2: r[mapped['contact_number_2']] == null ? '' : String(r[mapped['contact_number_2']]).trim(),
        channel_name: chName, channel: ch.channel, sub_channel: String(r[mapped['sub_channel_name']] == null ? '' : String(r[mapped['sub_channel_name']]).trim()),
        in_market_status: String(r[mapped['in_market_status']] == null ? '' : String(r[mapped['in_market_status']]).trim()),
        day_start_min: dayStartM, start_min: startM, end_min: endM, intime_min: intimeM,
        duration_min: durationMin,
        distance: dist, order_value: orderValue,
        productivity: productivity, productivity_raw: prodRaw,
        calls_made: callMade, call_compliance: callComp,
        below_5: toYN(r[mapped['below_5_mins']]),
        reason: r[mapped['reason']] == null ? '' : String(r[mapped['reason']]).trim(),
        latitude: lat, longitude: lon,
        deviation_m: devM,
        deviation_flag: toYN(r[mapped['deviation']]),
        reason_for_deviation: r[mapped['reason_for_deviation']] == null ? '' : String(r[mapped['reason_for_deviation']]).trim(),
        on_route: onRoute, on_route_raw: String(onRouteRaw == null ? '' : String(onRouteRaw).trim()),
        remarks: r[mapped['remarks']] == null ? '' : String(r[mapped['remarks']]).trim(),
        zsm: zsm, asm: asm, aso: aso,
        visit_p1m: toNum(r[mapped['visit_p1m_ach']]),
        visit_p3m: toNum(r[mapped['visit_p3m_ach']]),
        visit_ipdp: toNum(r[mapped['visit_ip_dp_ach']])
      };
      visits.push(visit);
      if (isValid) report.validRows++;
    }

    report.invalidIntime = report.missingIntime;
    if (!report.flags.length) {
      if (report.missingIntime / Math.max(1, report.totalRows) > 0.05) {
        report.flags.push('The intime column appears to contain non-standard elapsed time values; daily field start time is taken from day_start_time for discipline scoring.');
      }
    }
    visits.sort((a, b) => a.dateObj - b.dateObj);
    return { report, visits, error: null };
  }

  // ---------- Compact columnar encoding (fast load + small exports) ----------
  // Low-cardinality string/enum fields are dictionary-encoded; numeric fields are
  // kept as rounded numbers; high-cardinality strings are stored raw. The whole
  // payload is JSON, then gzip-compressed, then base64 (for embedding in HTML).
  // This is ~10x smaller than embedding the raw XLSX (which is already a ZIP and
  // cannot be compressed further as base64) and lets the standalone file skip
  // re-parsing the workbook entirely.

  const COMPACT_DICT_FIELDS = [
    'branch_code', 'branch_location', 'dse_code', 'dse_name', 'date', 'route_name',
    'channel_name', 'channel', 'sub_channel', 'in_market_status', 'on_route',
    'on_route_raw', 'productivity', 'productivity_raw',
    'call_compliance', 'below_5', 'deviation_flag', 'reason',
    'reason_for_deviation', 'remarks', 'zsm', 'asm', 'aso'
  ];
  const COMPACT_NUM_FIELDS = [
    'dateObj', 'calls_made', 'day_start_min', 'start_min', 'end_min', 'intime_min', 'duration_min',
    'distance', 'order_value', 'latitude', 'longitude', 'deviation_m',
    'visit_p1m', 'visit_p3m', 'visit_ipdp'
  ];
  const COMPACT_STR_FIELDS = ['retailer_code', 'retailer_name', 'contact_1', 'contact_2'];

  function cnorm(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    return String(v);
  }

  function gzipBytes(input) {
    if (typeof DecompressionStream !== 'undefined' && typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('gzip');
      const stream = new Blob([input]).stream().pipeThrough(cs);
      return new Response(stream).arrayBuffer();
    }
    return null; // no native gzip support; caller falls back to raw
  }

  function gunzipBytes(input) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([input]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer();
    }
    return null;
  }

  async function encodeVisitsCompact(visits) {
    const N = visits.length;
    const dicts = {};
    const cols = {};

    function buildDict(field) {
      const map = new Map();
      const order = [];
      for (const v of visits) {
        const val = cnorm(v[field]);
        if (!map.has(val)) { map.set(val, order.length); order.push(val); }
      }
      dicts[field] = order;
      const idx = new Map();
      order.forEach((x, i) => idx.set(x, i));
      const arr = new Array(N);
      for (let i = 0; i < N; i++) {
        const val = cnorm(visits[i][field]);
        arr[i] = val === '' ? null : idx.get(val);
      }
      cols[field] = arr;
    }
    for (const f of COMPACT_DICT_FIELDS) buildDict(f);

    for (const f of COMPACT_NUM_FIELDS) {
      const arr = new Array(N);
      const roundTo = (f === 'latitude' || f === 'longitude') ? 1e6 : 100;
      for (let i = 0; i < N; i++) {
        const v = visits[i][f];
        arr[i] = (v === null || v === undefined) ? null : Math.round(v * roundTo) / roundTo;
      }
      cols[f] = arr;
    }

    for (const f of COMPACT_STR_FIELDS) {
      const arr = new Array(N);
      for (let i = 0; i < N; i++) { const v = visits[i][f]; arr[i] = v || ''; }
      cols[f] = arr;
    }

    const payload = { v: 1, N, dict: dicts, cols };
    let bytes = new TextEncoder().encode(JSON.stringify(payload));
    let gz = await gzipBytes(bytes);
    let meta = { enc: 'gz' };
    let dataBytes = gz;
    if (!gz) { meta = { enc: 'raw' }; dataBytes = bytes; }
    const b64 = await bytesToB64(dataBytes);
    return { b64, meta, N };
  }

  function bytesToB64(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, bytes.length);
      for (let j = i; j < end; j++) bin += String.fromCharCode(bytes[j]);
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function decodeVisitsCompact(b64) {
    let bytes = b64ToBytes(b64);
    let payload;
    // Try gzip first; if it fails, assume raw JSON.
    try {
      const bin = await gunzipBytes(bytes);
      if (bin) bytes = new Uint8Array(bin);
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e2) {
        throw new Error('Could not decode embedded data');
      }
    }
    const N = payload.N;
    const { dict, cols } = payload;
    const visits = new Array(N);
    for (let i = 0; i < N; i++) {
      const v = {};
      for (const f of COMPACT_DICT_FIELDS) {
        const idx = cols[f][i];
        v[f] = (idx === null || idx === undefined) ? '' : dict[f][idx];
      }
      for (const f of COMPACT_NUM_FIELDS) v[f] = cols[f][i];
      for (const f of COMPACT_STR_FIELDS) v[f] = cols[f][i];
      visits[i] = v;
    }
    return visits;
  }

  NS.encodeVisitsCompact = encodeVisitsCompact;
  NS.decodeVisitsCompact = decodeVisitsCompact;
  NS.COMPACT_DICT_FIELDS = COMPACT_DICT_FIELDS;
  NS.COMPACT_NUM_FIELDS = COMPACT_NUM_FIELDS;
  NS.COMPACT_STR_FIELDS = COMPACT_STR_FIELDS;

  NS.processSheet = processSheet;
  NS.normKey = normKey;
  NS.toYN = toYN;
  NS.toTimeMinutes = toTimeMinutes;
  NS.toNum = toNum;
  NS.toDate = toDate;
  NS.fmtDateISO = fmtDateISO;
  NS.classifyChannel = classifyChannel;
})();