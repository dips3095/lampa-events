"""Recover sanitized progress from cached pages without making network requests."""
from datetime import datetime, timezone
import hashlib
from pathlib import Path
from catalog import ARCHIVE, parse_archive, parse_detail, scoped_page, write_json

cache = Path('.cache/source')
events = {}
seen = set()
url = ARCHIVE
while url and url not in seen:
    seen.add(url)
    path = cache / (hashlib.sha256(url.encode()).hexdigest() + '.html')
    rows, url = parse_archive(path.read_text(encoding='utf8'), url)
    rows, url = scoped_page(rows, url)
    events.update({e['id']: e for e in rows})
state = {}
today = datetime.now(timezone.utc).date().isoformat()
for event in events.values():
    if event['series'] == 'excluded':
        continue
    path = cache / (hashlib.sha256(event['source'].encode()).hexdigest() + '.html')
    if path.exists():
        state[event['id']] = {'fetchedAt': path.stat().st_mtime,
                              'event': parse_detail(path.read_text(encoding='utf8'), event, today)}
        if len(state) % 25 == 0:
            write_json(Path('.data-work/details.json'), state)
            print('Recovered', len(state), flush=True)
write_json(Path('.data-work/details.json'), state)
write_json(Path('.data-work/artwork.json'), {})
print('Checkpoint ready:', len(state), flush=True)
