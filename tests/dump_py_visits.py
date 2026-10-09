"""Dump the Python pipeline's visits + report for parity comparison with the
JS golden run. Stdlib only (backend modules are stdlib-only too).

Run: python tests/dump_py_visits.py [outdir] [xlsx]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(r'G:\Selva\CCR_analysis')
sys.path.insert(0, str(ROOT / 'backend'))

from app import ccr_parse, xlsxio  # noqa: E402

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
XLSX_FILE = Path(sys.argv[2]) if len(sys.argv) > 2 else (ROOT / 'Input' / 'MTD_CCR.xlsx')


def sanitize(v):
    """JSON.stringify parity: NaN/Infinity → null."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def main() -> None:
    data = XLSX_FILE.read_bytes()
    rows = xlsxio.sheet_rows(data)
    res = ccr_parse.process_sheet(rows)
    visits = res['visits']
    # strip private bookkeeping keys (not present in JS visit objects)
    public = []
    for v in visits:
        p = {k: sanitize(x) for k, x in v.items() if not k.startswith('_')}
        public.append(p)
    (OUT / 'visits_py.json').write_text(
        json.dumps(public, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (OUT / 'report_py.json').write_text(
        json.dumps(res['report'], ensure_ascii=False, indent=1), encoding='utf-8')
    print('visits:', len(public), 'totalRows:', res['report']['totalRows'])


if __name__ == '__main__':
    main()
