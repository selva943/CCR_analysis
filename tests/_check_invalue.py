import sys
sys.path.insert(0, r'G:\Selva\CCR_analysis\backend')
from app.db import _in_value, _VISIT_SELECT
print('in_value plain :', repr(_in_value('plain')))
print('in_value comma :', repr(_in_value('a,b')))
print('in_value space :', repr(_in_value('New Delhi')))
print('in_value quote :', repr(_in_value('x"y')))
print('select fields  :', _VISIT_SELECT[:80], '...')
print('select has id  :', _VISIT_SELECT.endswith(',id'))
