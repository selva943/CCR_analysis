"""Minimal XLSX (first-sheet) reader that reproduces SheetJS sheet_to_json
behaviour used by app.js:

    XLSX.read(data) → wb.Sheets[wb.SheetNames[0]]
    XLSX.utils.sheet_to_json(sheet, { defval: '' })

Contract (verified against the real dashboard behaviour):
  * Header row = row 1; keys are the row-1 cell strings.
  * Data rows = every row that has at least one cell with a value
    (rows with no cells are skipped — `blankrows` default).
  * Cells absent from a row get defval '' (so row.get(h, '') semantics).
  * Cell values keep RAW types (numbers stay numbers — dates/times remain
    Excel serial fractions, `cellDates` is not enabled in the dashboard):
      t absent/'n'  → float   (NaN-safe: unparseable → None)
      t='s'         → shared string
      t='str'       → formula result string
      t='b'         → bool
      t='e'         → error text (string)
      t='inlineStr' → inline string
  * Cells present but without a <v> value behave like `undefined` (None).

Untrusted input guards: bounded member count and inflated size.

Memory: `iter_rows()` yields one row at a time and accepts a file path (or an
open binary file), so a 20MB/170k-row workbook never has to sit in RAM. The
`sheet_rows()` list wrapper is kept for the offline scripts/tests.
"""
from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
import zipfile
from typing import Any, BinaryIO, Iterator, Union

NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

MAX_ZIP_MEMBERS = 2000
MAX_TOTAL_INFLATED = 800 * 1024 * 1024  # bytes

_COL_RE = re.compile(r'^([A-Z]+)(\d+)$')


def _col_index(ref: str) -> int:
    """'BC12' → 54 (0-based column index)."""
    m = _COL_RE.match(ref)
    if not m:
        return -1
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _text(el) -> str:
    return ''.join(t.text or '' for t in el.iter(f'{{{NS_MAIN}}}t'))


def _load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        fh = zf.open('xl/sharedStrings.xml')
    except KeyError:
        return []
    out: list[str] = []
    # iterparse + clear: the full shared-string table is never materialized as
    # one element tree (it can be tens of MB on a 100k-row sheet).
    with fh:
        for _ev, el in ET.iterparse(fh, events=('end',)):
            if el.tag.rsplit('}', 1)[-1] != 'si':
                continue
            parts: list[str] = []
            for child in el:
                tag = child.tag.rsplit('}', 1)[-1]
                if tag == 't':
                    parts.append(child.text or '')
                elif tag == 'r':
                    for sub in child:
                        if sub.tag.rsplit('}', 1)[-1] == 't':
                            parts.append(sub.text or '')
                # rPh (phonetic) intentionally skipped, like SheetJS default
            out.append(''.join(parts))
            el.clear()
    return out


def _first_sheet_path(zf: zipfile.ZipFile) -> str:
    wb = ET.fromstring(zf.read('xl/workbook.xml'))
    sheets = wb.find(f'{{{NS_MAIN}}}sheets')
    if sheets is None or not list(sheets):
        raise ValueError('Workbook has no sheets')
    first = list(sheets)[0]
    rid = first.get(f'{{{NS_REL}}}id')
    rels = ET.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
    for rel in rels:
        if rel.get('Id') == rid:
            target = rel.get('Target') or ''
            if target.startswith('/'):
                return target.lstrip('/')
            if target.startswith('xl/'):
                return target
            return 'xl/' + target
    raise ValueError('Workbook relationship not found')


def _cell_value(c, shared: list[str]):
    t = c.get('t')
    v_el = None
    for child in c:
        if child.tag.rsplit('}', 1)[-1] == 'v':
            v_el = child
            break
    if t == 'inlineStr':
        for child in c:
            if child.tag.rsplit('}', 1)[-1] == 'is':
                return _text(child)
        return None
    if v_el is None:
        return None  # present cell without value → undefined
    raw = v_el.text or ''
    if t == 's':
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return None
    if t == 'b':
        return raw == '1'
    if t in ('e', 'str'):
        return raw
    # numeric (default)
    if raw == '':
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _open_zip(source: Union[bytes, bytearray, BinaryIO, str]) -> zipfile.ZipFile:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return zipfile.ZipFile(io.BytesIO(bytes(source)))
    return zipfile.ZipFile(source)  # path or a seekable binary file


def iter_rows(
    source: Union[bytes, bytearray, BinaryIO, str],
) -> Iterator[dict[str, Any]]:
    """Yield the first worksheet as sheet_to_json(defval: '') row dicts, one
    row at a time.

    `source` may be raw bytes, a path, or an open binary file — pass a path/file
    for large workbooks so the compressed bytes never have to be in memory.
    """
    zf = _open_zip(source)
    try:
        infos = zf.infolist()
        if len(infos) > MAX_ZIP_MEMBERS:
            raise ValueError('Workbook has too many entries')
        total = sum(i.file_size for i in infos)
        if total > MAX_TOTAL_INFLATED:
            raise ValueError('Workbook is too large')
        shared = _load_shared_strings(zf)
        path = _first_sheet_path(zf)

        headers: dict[int, str] = {}
        last_r = 0
        with zf.open(path) as fh:
            # iterparse on a file handle: rows are the events we materialize.
            for _event, row_el in ET.iterparse(fh, events=('end',)):
                if row_el.tag.rsplit('}', 1)[-1] != 'row':
                    continue
                r_attr = row_el.get('r')
                row_no = int(r_attr) if r_attr else last_r + 1
                last_r = row_no
                cells: dict[int, Any] = {}
                has_value = False
                for c in row_el:
                    if c.tag.rsplit('}', 1)[-1] != 'c':
                        continue
                    ref = c.get('r') or ''
                    ci = _col_index(ref)
                    if ci < 0:
                        continue
                    val = _cell_value(c, shared)
                    cells[ci] = val
                    if val is not None:
                        has_value = True
                row_el.clear()  # keep memory flat for 100k+ row sheets
                if not has_value:
                    continue  # blankrows default: skip rows without any value
                if row_no == 1:
                    for ci, val in cells.items():
                        if val is not None and val != '':
                            headers[ci] = str(val)
                    continue
                if not headers:
                    continue
                # sheet_to_json defval:'': every header column gets a key on every row
                obj: dict[str, Any] = {h: '' for h in headers.values()}
                for ci, val in cells.items():
                    h = headers.get(ci)
                    if h is None:
                        continue
                    obj[h] = val
                yield obj
    finally:
        zf.close()


def sheet_rows(data: bytes) -> list[dict[str, Any]]:
    """Read the first worksheet into sheet_to_json(defval: '') row dicts."""
    return list(iter_rows(data))
