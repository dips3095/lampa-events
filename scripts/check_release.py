import json
from pathlib import Path
import sys
from catalog import START_YEAR, validate

value = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
coverage = validate(value)
assert value['coverage'] == coverage, 'Coverage counts must match actual events'
ids = {e['id'] for e in value['events']}
assert set(value['featured']) <= ids
assert all(e['sources'] and e['source'] in e['sources'] for e in value['events'])
assert value['startYear'] == START_YEAR, 'Unexpected catalog range'
assert len(value['events']) >= 600, 'Unexpectedly short archive for 2010 onward'
print(f"PASS release: {len(ids)} events, {len(coverage)} years, no result fields")
