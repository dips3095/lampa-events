"""Build a spoiler-free catalog. Raw HTML stays in the private build cache."""
import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time
import unicodedata
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = 'https://www.sherdog.com/organizations/Ultimate-Fighting-Championship-UFC-2'
REFERENCE = 'https://en.wikipedia.org/wiki/List_of_UFC_events'
FEATURED = [100, 116, 139, 189, 205, 217, 236, 261, 300]


def text(value):
    return ' '.join(value.get_text(' ', strip=True).split()) if value else ''


def norm(value):
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower()
    return ' '.join(re.findall(r'[a-z0-9]+', value))


def classify(title):
    tail = re.sub(r'^\S+\s*[-:]?\s*', '', title).strip()
    if re.match(r'(?:Road to|Contender|Dana White)', tail, re.I) or re.search(r'episode|season \d', tail, re.I):
        return 'excluded'
    if re.match(r'^\d+\b', tail):
        return 'numbered'
    if re.search(r'(ultimate fighter|\bTUF\b)', title, re.I):
        return 'finale' if re.search(r'finale|final\b', title, re.I) else 'excluded'
    if re.match(r'Fight Night\b', tail, re.I):
        return 'fight-night'
    if re.match(r'on (?:ESPN|ABC|Fox|FX|Fuel TV|Versus)\b', tail, re.I):
        return 'broadcast'
    if re.match(r'(?:Ultimate Ultimate|Ultimate Japan|Japan|Brazil|Ultimate Fight Night|Fight for the Troops|Live\b|The Final Chapter|White House)', tail, re.I):
        return 'special'
    return 'unknown'


def number(title):
    found = re.match(r'^\S+\s+(\d+)\b', title)
    return int(found[1]) if found else None


def parse_archive(html, url):
    soup = BeautifulSoup(html, 'html.parser')
    events = []
    for row in soup.select('tr[itemtype$="/Event"]'):
        link = row.select_one('a[itemprop="url"][href^="/events/"]')
        date = row.select_one('meta[itemprop="startDate"]')
        if not link or not date:
            raise ValueError('Archive row changed: missing event URL or date')
        event_id = re.search(r'-(\d+)$', link['href'])
        if not event_id or not re.match(r'^\d{4}-\d{2}-\d{2}', date.get('content', '')):
            raise ValueError('Invalid archive identity/date')
        title = text(link)
        events.append(dict(id='sd-' + event_id[1], title=title, date=date['content'][:10],
                           series=classify(title), source=urljoin(url, link['href'])))
    if not events:
        raise ValueError('No archive rows: source blocked or markup changed')
    next_link = next((a for a in soup.select('a[href]') if 'Older Events' in text(a)), None)
    next_url = urljoin(url, next_link['href']) if next_link else None
    if next_url and not next_url.startswith(ARCHIVE + '/recent-events/'):
        raise ValueError('Unexpected archive pagination URL')
    return events, next_url


def parse_detail(html, event, today):
    soup = BeautifulSoup(html, 'html.parser')
    heading = soup.select_one('.event_detail h1')
    date = soup.select_one('.event_detail meta[itemprop="startDate"]')
    if not heading or not date or date.get('content', '')[:10] != event['date']:
        raise ValueError('Event detail missing or date disagrees: ' + event['id'])
    people = {}
    for person in soup.select('.col-left [itemtype$="/Person"]'):
        link = person.select_one('a[href^="/fighter/"]')
        name = person.select_one('[itemprop="name"]')
        if link and name and text(name):
            fid = re.search(r'-(\d+)$', link['href'])
            if fid:
                people[fid[1]] = text(name)
    # Alphabetical names only: source order can reveal winners in tournament brackets.
    participants = sorted(set(people.values()), key=norm)
    cancelled = event.get('status') == 'cancelled' or bool(re.search(r'\b(cancelled|canceled)\b', text(heading), re.I))
    if len(participants) < 2 and event['date'] < today and not cancelled:
        raise ValueError('Completed event has no full participants: ' + event['id'])
    images = []
    # Explicit poster assets only. Never use og:image, fighter images or news photos.
    for img in soup.select('.event_detail img[src]'):
        src = urljoin(event['source'], img['src'])
        if '/poster/' in src or '/posters/' in src:
            if src.startswith('https://'):
                images.append(src)
    return {**event, 'title': text(heading), 'participants': participants,
            'status': 'cancelled' if cancelled else ('completed' if event['date'] < today else 'upcoming'),
            'images': images, 'sources': [event['source']]}


def parse_reference(html):
    soup = BeautifulSoup(html, 'html.parser')
    events = []
    for table in soup.select('table.wikitable'):
        header = text(table.select_one('tr')).lower()
        if 'event' not in header or 'date' not in header:
            continue
        cancelled_rows = 0
        for row in table.select('tr')[1:]:
            cells = row.select('td')
            cancel_cell = next((c for c in cells if text(c).lower() in ('canceled', 'cancelled')), None)
            if cancel_cell:
                cancelled_rows = int(cancel_cell.get('rowspan', 1))
            cancelled = cancelled_rows > 0
            cancelled_rows = max(0, cancelled_rows - 1)
            link = next((a for a in row.select('a[href]')
                         if re.match(r'^(?:UFC\b|The Ultimate Fighter)', text(a))), None)
            dates = [re.search(r'\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b', text(c)) for c in cells]
            date_match = next((d for d in dates if d), None)
            if not link or not date_match:
                continue
            raw = date_match[0]
            dt = None
            for fmt in ('%b %d, %Y', '%B %d, %Y'):
                try:
                    dt = datetime.strptime(raw, fmt).date().isoformat()
                    break
                except ValueError:
                    pass
            if dt:
                events.append({'title': text(link), 'date': dt, 'cancelled': cancelled,
                               'source': urljoin(REFERENCE, link['href'])})
    if len(events) < 500:
        raise ValueError('Independent reference is incomplete or its markup changed')
    return events


def reconcile(events, reference, reviews):
    included = [e for e in events if e['series'] not in ('excluded', 'unknown')]
    used = set()
    unmatched = []
    cancelled_ids = []
    for ref in reference:
        candidates = [e for e in included if abs((datetime.fromisoformat(e['date']) - datetime.fromisoformat(ref['date'])).days) <= 1]
        n = number(ref['title'])
        matches = [e for e in candidates if number(e['title']) == n] if n else [e for e in candidates if number(e['title']) is None]
        if len(matches) > 1:
            if 'ultimate fighter' in ref['title'].lower():
                matches = [e for e in matches if e['series'] == 'finale']
            else:
                tokens = set(norm(ref['title']).split()) - {'ufc', 'fight', 'night', 'vs', 'on', 'the'}
                ranked = sorted(((len(tokens & set(norm(e['title']).split())), e) for e in matches), key=lambda pair: pair[0], reverse=True)
                if ranked and ranked[0][0] >= 2 and ranked[0][0] > ranked[1][0]:
                    matches = [ranked[0][1]]
        override = reviews.get('matches', {}).get(norm(ref['title']) + '|' + ref['date'])
        if override:
            matches = [e for e in included if e['id'] == override['id']]
        if len(matches) > 1:
            matches = [e for e in matches if e['date'] == ref['date']]
        if len(matches) == 1 and matches[0]['id'] not in used:
            used.add(matches[0]['id'])
            if ref.get('cancelled'):
                cancelled_ids.append(matches[0]['id'])
        elif norm(ref['title']) + '|' + ref['date'] not in reviews.get('referenceExceptions', {}):
            unmatched.append(ref)
    source_only = [e for e in included if e['id'] not in used and e['id'] not in reviews.get('sourceExceptions', {})]
    return {'referenceCount': len(reference), 'matchedCount': len(used), 'cancelledIds': cancelled_ids,
            'unmatchedReference': unmatched, 'unmatchedSource': source_only}


def validate(catalog, previous=None):
    if catalog.get('schemaVersion') != 1 or not isinstance(catalog.get('events'), list):
        raise ValueError('Unsupported catalog schema')
    events = catalog['events']
    ids = set()
    years = Counter()
    today = datetime.now(timezone.utc).date().isoformat()
    allowed = {'id', 'title', 'date', 'series', 'source', 'status', 'participants', 'images', 'sources'}
    for e in events:
        if set(e) - allowed or e['id'] in ids or not e['title'] or e['series'] in ('unknown', 'excluded'):
            raise ValueError('Invalid or duplicate event: ' + e.get('id', '?'))
        datetime.strptime(e['date'], '%Y-%m-%d')
        if e['date'] < today and e['status'] != 'cancelled' and len(e['participants']) < 2:
            raise ValueError('Missing participants: ' + e['id'])
        if any(not u.startswith('https://') for u in e['images']):
            raise ValueError('Unsafe artwork URL')
        ids.add(e['id'])
        years[e['date'][:4]] += 1
    missing = [str(y) for y in range(1993, int(today[:4]) + 1) if not years[str(y)]]
    if missing:
        raise ValueError('Missing archive years: ' + ','.join(missing))
    if previous and set(e['id'] for e in previous['events']) - ids:
        raise ValueError('Previously published events disappeared')
    return dict(sorted(years.items()))


class Fetcher:
    def __init__(self, directory, delay=1.2):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.delay = delay
        self.last = 0
        self.fetched_at = 0
        self.session = requests.Session()
        self.session.headers['User-Agent'] = 'LampaEventsCatalog/0.2 (+https://github.com/dips3095/lampa-events)'

    def get(self, url, max_age=86400):
        path = self.directory / (hashlib.sha256(url.encode()).hexdigest() + '.html')
        if path.exists() and time.time() - path.stat().st_mtime < max_age:
            self.fetched_at = path.stat().st_mtime
            return path.read_text(encoding='utf8')
        for attempt in range(3):
            time.sleep(max(0, self.delay - (time.monotonic() - self.last)))
            try:
                self.last = time.monotonic()
                response = self.session.get(url, timeout=30)
                if response.status_code in (401, 403):
                    raise RuntimeError('Source denied access: ' + url)
                response.raise_for_status()
                response.encoding = 'utf-8'
                result = response.text
                path.write_text(result, encoding='utf8')
                self.fetched_at = time.time()
                return result
            except requests.RequestException:
                if attempt == 2:
                    raise
                time.sleep(5 * (attempt + 1))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    os.replace(temp, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='_site/data/catalog.json')
    parser.add_argument('--previous')
    parser.add_argument('--cache', default='.cache/source')
    parser.add_argument('--state', default='.data-work/details.json')
    parser.add_argument('--audit-only', action='store_true')
    parser.add_argument('--full', action='store_true')
    args = parser.parse_args()
    fetch = Fetcher(Path(args.cache))
    reviews = json.loads((ROOT / 'data/reviews.json').read_text(encoding='utf8'))
    url = ARCHIVE
    pages = set()
    events = {}
    while url:
        if url in pages or len(pages) > 30:
            raise ValueError('Pagination loop')
        pages.add(url)
        rows, url = parse_archive(fetch.get(url, 3600), url)
        for e in rows:
            if e['id'] in reviews.get('series', {}):
                e['series'] = reviews['series'][e['id']]['series']
            events[e['id']] = e
    rows = list(events.values())
    unknown = [e for e in rows if e['series'] == 'unknown']
    reference = parse_reference(fetch.get(REFERENCE, 3600))
    audit = reconcile(rows, reference, reviews)
    for event in rows:
        if event['id'] in audit['cancelledIds']:
            event['status'] = 'cancelled'
    audit.update(pages=len(pages), total=len(rows), unknown=unknown,
                 counts=dict(Counter(e['series'] for e in rows)))
    write_json(Path('.cache/audit.json'), audit)
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in audit.items()}), flush=True)
    if args.audit_only:
        return
    if unknown or audit['unmatchedReference'] or audit['unmatchedSource']:
        raise ValueError('Archive reconciliation requires review; see .cache/audit.json')
    today = datetime.now(timezone.utc).date()
    previous = json.loads(Path(args.previous).read_text(encoding='utf8')) if args.previous and Path(args.previous).exists() else None
    result = []
    additions = reviews.get('additions', [])
    state_path = Path(args.state)
    detail_state = json.loads(state_path.read_text(encoding='utf8')) if state_path.exists() else {}
    selected = sorted((e for e in rows if e['series'] != 'excluded'), key=lambda e: e['date'], reverse=True)
    for i, e in enumerate(selected):
        recent = e['date'] >= (today - timedelta(days=30)).isoformat()
        # Leave room for scheduler jitter: an early run must not defer refresh another day.
        age = 0 if args.full else (23 * 3600 if recent else 6 * 86400)
        cached = detail_state.get(e['id'], {})
        if cached and time.time() - cached.get('fetchedAt', 0) < age and cached['event']['date'] == e['date'] and cached['event']['title'] == e['title']:
            value = dict(cached['event'])
            if e.get('status') == 'cancelled':
                value['status'] = 'cancelled'
        else:
            value = parse_detail(fetch.get(e['source'], age), e, today.isoformat())
            detail_state[e['id']] = {'fetchedAt': fetch.fetched_at, 'event': value}
            write_json(state_path, detail_state)
        result.append(value)
        if i % 20 == 0:
            print(f'Details {i + 1}/{len(selected)}', flush=True)
    for addition in additions:
        matches = [e for e in result if e['date'] == addition['date'] and e['series'] == addition['series']]
        if len(matches) == 1:
            # Keep the public ID stable when a reviewed supplement reaches the primary source.
            matches[0]['id'] = addition['id']
        elif not matches:
            result.append(addition)
        else:
            raise ValueError('Ambiguous supplementary event identity')
    result.sort(key=lambda e: (e['date'], e['id']), reverse=True)
    catalog = {'schemaVersion': 1, 'updatedAt': datetime.now(timezone.utc).isoformat(),
               'events': result, 'featured': [e['id'] for e in result if number(e['title']) in FEATURED],
               'coverage': {}, 'sources': [ARCHIVE, REFERENCE]}
    catalog['coverage'] = validate(catalog, previous)
    write_json(Path(args.output), catalog)
    print(f'Published candidate: {len(result)} events', flush=True)


if __name__ == '__main__':
    main()
