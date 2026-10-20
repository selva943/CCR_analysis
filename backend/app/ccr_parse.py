"""Exact Python port of dashboard/js/data.js processSheet (+ its helpers).

The JavaScript file is the SOURCE OF TRUTH. Every function below mirrors its
JS counterpart line-by-line, including the deliberately quirky edge cases
(parseFloat leniency, Math.round half-up, toFixed half-up, rollover dates,
String(number) formatting). tests/parity_local.py runs both implementations
on Input/MTD_CCR.xlsx and asserts byte-identical reports and values.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from collections.abc import Callable, Iterable
from decimal import Decimal, ROUND_HALF_DOWN, ROUND_HALF_UP, localcontext
from itertools import chain
from typing import Any

LT_LAT, GT_LAT, LT_LON, GT_LON = 8.0, 37.0, 68.0, 97.0

# Verbatim from data.js (normKey-mapped header aliases).
HEADER_MAP: dict[str, str] = {
    'branch_code': 'branch_code', 'branchlocation': 'branch_location', 'branch_location': 'branch_location',
    'dsecode': 'dse_code', 'dse_code': 'dse_code', 'dsename': 'dse_name', 'dse_name': 'dse_name',
    'date': 'date', 'routename': 'route_name', 'route_name': 'route_name',
    'retailercode': 'retailer_code', 'retailer_code': 'retailer_code',
    'retailername': 'retailer_name', 'retailer_name': 'retailer_name',
    'contactnumber1': 'contact_number_1', 'contact_number_1': 'contact_number_1',
    'contactnumber2': 'contact_number_2', 'contact_number_2': 'contact_number_2',
    'channelname': 'channel_name', 'channel_name': 'channel_name',
    'subchannelname': 'sub_channel_name', 'sub_channel_name': 'sub_channel_name',
    'inmarketstatus': 'in_market_status', 'in_market_status': 'in_market_status',
    'daystarttime': 'day_start_time', 'day_start_time': 'day_start_time',
    'starttime': 'start_time', 'start_time': 'start_time',
    'endtime': 'end_time', 'end_time': 'end_time',
    'intime': 'intime',
    'distancetravelled': 'distance_travelled', 'distance_travelled': 'distance_travelled',
    'ordervalue': 'order_value', 'order_value': 'order_value',
    'productivity': 'productivity',
    'visitp1mach': 'visit_p1m_ach', 'visit_p1m_ach': 'visit_p1m_ach', 'visitp1m_ach': 'visit_p1m_ach',
    'visitp3mach': 'visit_p3m_ach', 'visit_p3m_ach': 'visit_p3m_ach', 'visitp3m_ach': 'visit_p3m_ach',
    'visiipdpach': 'visit_ip_dp_ach', 'visit_ip_dp_ach': 'visit_ip_dp_ach', 'visitipdpach': 'visit_ip_dp_ach',
    'reason': 'reason',
    'visitlatitude': 'visit_latitude', 'visit_latitude': 'visit_latitude',
    'visitlongitude': 'visit_longitude', 'visit_longitude': 'visit_longitude',
    'deviationinmeter': 'deviation_in_meter', 'deviation_in_meter': 'deviation_in_meter', 'deviationinmeters': 'deviation_in_meter',
    'deviation': 'deviation',
    'reasonfordeviation': 'reason_for_deviation', 'reason_for_deviation': 'reason_for_deviation',
    'onroute': 'on_route', 'on_route': 'on_route',
    'remarks': 'remarks',
    'zsm': 'zsm', 'asm': 'asm', 'aso': 'aso',
    'callsmade': 'calls_made', 'calls_made': 'calls_made', 'calls': 'calls_made',
    'callcompliance': 'call_compliance', 'call_compliance': 'call_compliance',
    'below5mins': 'below_5_mins', 'below_5_mins': 'below_5_mins',
    'below5mins.1': 'below_5_mins',
}

REQUIRE = ['dse_code', 'dse_name', 'date', 'branch_code', 'branch_location', 'on_route',
           'productivity', 'start_time', 'end_time', 'day_start_time', 'deviation_in_meter',
           'visit_latitude', 'visit_longitude', 'channel_name', 'order_value', 'zsm', 'asm',
           'aso', 'calls_made', 'call_compliance']


def norm_key(k: Any) -> str:
    return re.sub(r'[^a-z0-9]', '', str(k).lower())


def js_string(v: Any) -> str:
    """JS String(v) for the value shapes that reach it (numbers/bools/strings)."""
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float):
        if math.isnan(v):
            return 'NaN'
        if math.isinf(v):
            return 'Infinity' if v > 0 else '-Infinity'
        if v == 0:
            return '0'
        s = repr(v)
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        if 'e' in s:
            mant, exp = s.split('e')
            ei = int(exp)
            if 1e-6 <= abs(v) < 1e21:
                return format(Decimal(s), 'f')
            return mant + 'e' + ('+' if ei > 0 else '-') + str(abs(ei))
        return s
    if isinstance(v, int):
        return str(v)
    return str(v)


def js_number_string(v: float) -> str:
    """String(number) — same as js_string but only for numeric input."""
    return js_string(v)


def js_round(x: float) -> float:
    """JS Math.round: half up (toward +Infinity)."""
    return math.floor(x + 0.5)


def js_date(year: int, month0: int, day: int) -> dt.date:
    """new Date(year, month0, day) — out-of-range components roll over."""
    if 0 <= year <= 99:
        year += 1900  # JS Date two-digit-year mapping
    idx = year * 12 + month0
    ny, nm = divmod(idx, 12)
    return dt.date(ny, nm + 1, 1) + dt.timedelta(days=day - 1)


def to_date(v: Any):
    """Port of data.js toDate(). Returns datetime.date or None."""
    if v is None or v == '':
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, bool):
        s = 'true' if v else 'false'  # JS String(true) path
        return _parse_date_string(s)
    if isinstance(v, (int, float)):
        x = float(v)
        if not math.isfinite(x):
            return None  # new Date(NaN) → Invalid Date
        try:
            ms = js_round((x - 25569) * 86400 * 1000)
            base = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(milliseconds=ms)
        except (OverflowError, OSError, ValueError):
            return None
        return dt.date(base.year, base.month, base.day)
    return _parse_date_string(str(v).strip())


def _parse_date_string(s: str):
    if not s:
        return None
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m:
        return js_date(int(m.group(1)), int(m.group(2)) - 1, int(m.group(3)))
    m2 = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})', s)
    if m2:
        y = 2000 + int(m2.group(3)) if len(m2.group(3)) == 2 else int(m2.group(3))
        return js_date(y, int(m2.group(1)) - 1, int(m2.group(2)))
    m3 = re.match(r'^(\d{1,2})-(\d{1,2})-(\d{2,4})', s)
    if m3:
        y = 2000 + int(m3.group(3)) if len(m3.group(3)) == 2 else int(m3.group(3))
        return js_date(y, int(m3.group(2)) - 1, int(m3.group(1)))
    # JS: new Date(s) — lenient implementation-specific parse. The real dataset
    # never reaches here (serial numbers / regex paths); keep a small equivalent.
    for fmt in ('%Y/%m/%d', '%Y%m%d', '%b %d %Y', '%B %d %Y', '%d %b %Y', '%d %B %Y',
                '%d/%m/%Y', '%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def fmt_date_iso(d):
    if d is None:
        return None
    return d.strftime('%Y-%m-%d')


def to_time_minutes(v: Any):
    """Port of data.js toTimeMinutes(). Returns float minutes or None (NaN propagates)."""
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v.hour * 60 + v.minute + v.second / 60
    if isinstance(v, dt.time):
        return v.hour * 60 + v.minute + v.second / 60
    if not isinstance(v, bool) and isinstance(v, (int, float)):
        return float(v) * 1440  # NaN propagates exactly like JS
    s = js_string(v).strip()
    if not s:
        return None
    m1 = re.match(r'^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$', s, re.IGNORECASE)
    if m1:
        h = int(m1.group(1))
        mi = int(m1.group(2))
        sec = int(m1.group(3)) if m1.group(3) else 0
        ap = m1.group(4).lower() if m1.group(4) else None
    else:
        m2 = re.match(r'^(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})$', s)
        if not m2:
            return None
        h = int(m2.group(1))
        mi = int(m2.group(2))
        sec = int(m2.group(3))
        ap = None
    if ap:
        if ap == 'am' and h == 12:
            h = 0
        if ap == 'pm' and h < 12:
            h += 12
    if h > 23 or mi > 59 or sec > 60:
        return None
    return h * 60 + mi + sec / 60


_JS_FLOAT_PREFIX = re.compile(r'^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?')


def to_num(v: Any):
    """Port of data.js toNum() — JS parseFloat semantics."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None  # String('true') → parseFloat NaN → null
    if isinstance(v, (int, float)):
        x = float(v)
        return x if math.isfinite(x) else None
    s = re.sub(r'[₹,\s]', '', str(v))
    if not s:
        return None
    if s in ('Infinity', '+Infinity', '-Infinity'):
        return None
    m = _JS_FLOAT_PREFIX.match(s)
    if not m:
        return None
    try:
        x = float(m.group(0))
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def to_yn(v: Any) -> str:
    """Port of data.js toYN()."""
    if v is None:
        return 'UNKNOWN'
    if isinstance(v, bool):
        s = 'true' if v else 'false'
        s2 = s.strip().lower()
        if s2 in ('yes', 'y', 'true', '1', 'pass', 'done', 'on'):
            return 'YES'
        if s2 in ('no', 'n', 'false', '0', 'fail', 'off'):
            return 'NO'
        return 'UNKNOWN'
    if isinstance(v, (int, float)):
        if v == 1:
            return 'YES'
        if v == 0:
            return 'NO'
        return 'UNKNOWN'
    s = str(v).strip().lower()
    if s in ('yes', 'y', 'true', '1', 'pass', 'done', 'on'):
        return 'YES'
    if s in ('no', 'n', 'false', '0', 'fail', 'off'):
        return 'NO'
    return 'UNKNOWN'


def classify_channel(raw: Any) -> str:
    """Port of data.js classifyChannel() — returns only the channel label."""
    val = raw if raw else ''  # JS truthiness: raw || '' (0/False/NaN → '')
    c = js_string(val).strip().lower()
    if not c:
        return 'SELF SERVICE'
    if 'speciality' in c:
        return 'SPECIALITY'
    if 'small' in c:
        return 'SMALL'
    if 'ws' in c:
        return 'WS'
    if 'large' in c:
        return 'LARGE'
    return 'SELF SERVICE'


def js_to_fixed(x: float, f: int) -> str:
    """JS Number.toFixed(f): exact binary value, round to nearest, ties → larger n."""
    with localcontext() as ctx:
        ctx.prec = 60
        d = Decimal(x)
        rounding = ROUND_HALF_UP if x >= 0 else ROUND_HALF_DOWN  # ties toward +Infinity
        return format(d.quantize(Decimal(1).scaleb(-f), rounding=rounding), 'f')


def js_string_trim(v: Any) -> str:
    """`x == null ? '' : String(x).trim()` guard used throughout processSheet."""
    if v is None:
        return ''
    return js_string(v).strip()


def process_sheet(rows: Iterable[dict], sink: Callable[[dict], None] | None = None) -> dict:
    """Port of data.js processSheet(rows). Returns {report, visits, error, count}.

    `rows` may be a list or any iterator of row dicts (streaming import — the
    sheet is never materialized). When `sink` is given each visit is handed to
    it as soon as it is built instead of being collected, so `visits` comes back
    empty and `count` carries the number emitted; the caller then owns ordering
    (the report/COPY path does not depend on the pre-sort — see db.visit_writer).
    """
    report: dict[str, Any] = {
        'totalRows': 0,
        'validRows': 0,
        'duplicateRows': 0,
        'missingDate': 0,
        'missingDse': 0,
        'missingStartTime': 0,
        'missingEndTime': 0,
        'missingIntime': 0,
        'missingCoordinates': 0,
        'invalidDeviation': 0,
        'invalidProductivity': 0,
        'missingDayStart': 0,
        'missingOnRoute': 0,
        'negativeDuration': 0,
        'missingOrderValue': 0,
        'missingChannel': 0,
        'longDurations': 0,
        'missingCallCompliance': 0,
        'invalidDistance': 0,
        'missingAsmAso': 0,
        'flags': [],
    }

    it = iter(rows)
    first = next(it, None)
    if first is None:
        raise ValueError('Empty sheet')

    keys = list(first.keys())
    mapped: dict[str, str] = {}
    for k in keys:
        n = norm_key(k)
        t = HEADER_MAP.get(n) or HEADER_MAP.get(k) or HEADER_MAP.get(str(k).lower())
        if t and t not in mapped:
            mapped[t] = k
    missing_required = [t for t in REQUIRE if t not in mapped]
    if missing_required:
        report['missingCols'] = missing_required
        # Nothing was emitted; count the rest so the failed job still reports
        # the true sheet size (rows are dropped, not collected).
        report['totalRows'] = 1 + sum(1 for _ in it)
        return {'report': report, 'visits': [], 'count': 0,
                'error': 'Required columns missing: ' + ', '.join(missing_required)}

    def cell(row: dict, logical: str):
        # JS: r[mapped[logical]] — mapped headers exist for every row thanks to
        # sheet_to_json defval:''; unmapped headers are undefined (→ None here).
        h = mapped.get(logical)
        if h is None:
            return None
        if h in row:
            return row[h]
        return ''

    visits: list[dict] | None = [] if sink is None else None
    dup_set: set[str] = set()
    rows_seen = 0
    count = 0

    # `first` doubles as the header row AND the first data row (sheet_to_json
    # semantics) — it has to go through the loop like any other row.
    for r in chain((first,), it):
        rows_seen += 1
        date_obj = to_date(cell(r, 'date'))
        dse_code = js_string_trim(cell(r, 'dse_code'))
        dse_name = js_string_trim(cell(r, 'dse_name'))
        iso = fmt_date_iso(date_obj)
        if not iso:
            report['missingDate'] += 1
            continue
        if not dse_code and not dse_name:
            report['missingDse'] += 1
            continue

        on_route_raw = cell(r, 'on_route')
        on_route = to_yn(on_route_raw)
        productivity = to_yn(cell(r, 'productivity'))

        start_m = to_time_minutes(cell(r, 'start_time'))
        end_m = to_time_minutes(cell(r, 'end_time'))
        day_start_m = to_time_minutes(cell(r, 'day_start_time'))
        intime_m = to_time_minutes(cell(r, 'intime'))

        lat = to_num(cell(r, 'visit_latitude'))
        lon = to_num(cell(r, 'visit_longitude'))
        dev_m = to_num(cell(r, 'deviation_in_meter'))

        has_start = start_m is not None
        has_end = end_m is not None
        duration_min = None
        if has_start and has_end:
            duration_min = end_m - start_m
            if duration_min < 0:
                report['negativeDuration'] += 1
                duration_min = None
        if duration_min is not None and duration_min > 240:
            report['longDurations'] += 1

        is_valid = True
        if not has_start:
            report['missingStartTime'] += 1
            is_valid = False
        if not has_end:
            report['missingEndTime'] += 1
            is_valid = False
        intime_raw = cell(r, 'intime')
        if intime_raw is None or intime_raw == '':
            report['missingIntime'] += 1
        if (lat is None or lon is None or lat < LT_LAT or lat > GT_LAT
                or lon < LT_LON or lon > GT_LON or (lat == 0 and lon == 0)):
            report['missingCoordinates'] += 1
            is_valid = False
        if dev_m is None or dev_m < 0:
            report['invalidDeviation'] += 1
            is_valid = False
        if on_route == 'UNKNOWN':
            report['missingOnRoute'] += 1
            is_valid = False
        if productivity == 'UNKNOWN':
            report['invalidProductivity'] += 1
            is_valid = False
        if day_start_m is None:
            report['missingDayStart'] += 1
        channel_raw = cell(r, 'channel_name')
        if channel_raw is None or js_string(channel_raw).strip() == '':
            report['missingChannel'] += 1

        order_value = to_num(cell(r, 'order_value'))
        if order_value is None:
            report['missingOrderValue'] += 1
        dist = to_num(cell(r, 'distance_travelled'))
        if dist is None or dist < 0:
            report['invalidDistance'] += 1

        call_comp_raw = cell(r, 'call_compliance')
        call_comp = None
        if call_comp_raw is not None and call_comp_raw != '':
            cn = to_num(call_comp_raw)
            call_comp = ('YES' if cn >= 1 else 'NO') if cn is not None else to_yn(call_comp_raw)
        if call_comp is None:
            report['missingCallCompliance'] += 1

        asm = js_string_trim(cell(r, 'asm'))
        aso = js_string_trim(cell(r, 'aso'))
        zsm = js_string_trim(cell(r, 'zsm'))
        if not asm and not aso:
            report['missingAsmAso'] += 1

        ch = classify_channel(channel_raw)
        ch_name = js_string_trim(channel_raw)

        prod_raw = js_string_trim(cell(r, 'productivity'))
        call_made = to_num(cell(r, 'calls_made'))

        ret_code = js_string_trim(cell(r, 'retailer_code'))
        ret_name = js_string_trim(cell(r, 'retailer_name'))

        dup_key = (dse_code + '|' + iso + '|' + ret_code + '|'
                   + (js_to_fixed(start_m, 2) if has_start else '') + '|'
                   + (js_to_fixed(end_m, 2) if has_end else ''))
        pk = dse_code + '|' + iso + '|' + ret_code
        if dup_key in dup_set or pk in dup_set:
            report['duplicateRows'] += 1
            is_valid = False
        else:
            dup_set.add(dup_key)

        # dateObj: browser stores local-midnight epoch ms; unused downstream
        # (sorting uses its monotone equivalent = the date itself). UTC midnight
        # is stored for structural parity.
        date_obj_ms = int(dt.datetime(date_obj.year, date_obj.month, date_obj.day,
                                      tzinfo=dt.timezone.utc).timestamp() * 1000) \
            if date_obj is not None else None

        route_name_raw = cell(r, 'route_name')
        visit = {
            'branch_code': js_string_trim(cell(r, 'branch_code')),
            'branch_location': js_string_trim(cell(r, 'branch_location')),
            'dse_code': dse_code, 'dse_name': dse_name,
            'date': iso, 'dateObj': date_obj_ms,
            'route_name': None if route_name_raw is None else js_string(route_name_raw).strip(),
            'retailer_code': ret_code, 'retailer_name': ret_name,
            'contact_1': js_string_trim(cell(r, 'contact_number_1')),
            'contact_2': js_string_trim(cell(r, 'contact_number_2')),
            'channel_name': ch_name, 'channel': ch,
            'sub_channel': js_string_trim(cell(r, 'sub_channel_name')),
            'in_market_status': js_string_trim(cell(r, 'in_market_status')),
            'day_start_min': day_start_m, 'start_min': start_m, 'end_min': end_m,
            'intime_min': intime_m,
            'duration_min': duration_min,
            'distance': dist, 'order_value': order_value,
            'productivity': productivity, 'productivity_raw': prod_raw,
            'calls_made': call_made, 'call_compliance': call_comp,
            'below_5': to_yn(cell(r, 'below_5_mins')),
            'reason': js_string_trim(cell(r, 'reason')),
            'latitude': lat, 'longitude': lon,
            'deviation_m': dev_m,
            'deviation_flag': to_yn(cell(r, 'deviation')),
            'reason_for_deviation': js_string_trim(cell(r, 'reason_for_deviation')),
            'on_route': on_route,
            'on_route_raw': js_string_trim(on_route_raw),
            'remarks': js_string_trim(cell(r, 'remarks')),
            'zsm': zsm, 'asm': asm, 'aso': aso,
            'visit_p1m': to_num(cell(r, 'visit_p1m_ach')),
            'visit_p3m': to_num(cell(r, 'visit_p3m_ach')),
            'visit_ipdp': to_num(cell(r, 'visit_ip_dp_ach')),
        }
        visit['_is_valid'] = is_valid
        visit['_dup_key'] = dup_key
        if sink is None:
            assert visits is not None
            visits.append(visit)
        else:
            sink(visit)  # emitted with _is_valid/_dup_key already stamped
        count += 1
        if is_valid:
            report['validRows'] += 1

    report['totalRows'] = rows_seen
    report['invalidIntime'] = report['missingIntime']
    if not report['flags']:
        if report['missingIntime'] / max(1, report['totalRows']) > 0.05:
            report['flags'].append(
                'The intime column appears to contain non-standard elapsed time values; '
                'daily field start time is taken from day_start_time for discipline scoring.')
    # JS: stable sort by dateObj (ascending). Python's sort is stable; the key is
    # the ISO date (monotone with dateObj for any timezone). Streaming imports
    # skip it: the rows are written straight through and the readers order by
    # (business_date, id), which reproduces exactly this tie-break order.
    if visits is not None:
        visits.sort(key=lambda v: v['date'])
    return {'report': report, 'visits': visits or [], 'count': count, 'error': None}
