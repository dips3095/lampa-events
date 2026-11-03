"""Optional artwork enrichment. Failures never erase a valid catalog or image."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time

import requests
from catalog import norm, number, write_json


def matching(event, candidate):
    if str(candidate.get('idLeague')) != '4443' or not candidate.get('strEvent'):
        return False
    try:
        delta = abs((datetime.fromisoformat(event['date']) - datetime.strptime(candidate['dateEvent'], '%Y-%m-%d')).days)
    except (ValueError, KeyError, TypeError):
        return False
    if delta > 1:
        return False
    n, other = number(event['title']), number(candidate['strEvent'])
    if n is not None or other is not None:
        return n is not None and n == other
    stop = {'ufc', 'fight', 'night', 'vs', 'on', 'the', 'espn', 'fox'}
    a = set(norm(event['title']).split()) - stop
    b = set(norm(candidate['strEvent']).split()) - stop
    return len(a & b) >= 2 and len(a & b) / max(1, min(len(a), len(b))) >= 0.6


def enrich(catalog, state_path, budget=24):
    state = json.loads(state_path.read_text(encoding='utf8')) if state_path.exists() else {}
    session = requests.Session()
    session.headers['User-Agent'] = 'LampaEventsCatalog/0.2'
    now = time.time()
    # Rotate unresolved posters fairly; successful posters are rechecked monthly.
    ordered = sorted(catalog['events'], key=lambda e: state.get(e['id'], {}).get('checked', 0))
    requests_made = 0
    for event in ordered:
        record = state.get(event['id'], {})
        event['images'] = list(dict.fromkeys(event['images'] + record.get('images', [])))
    for event in ordered:
        record = state.get(event['id'], {})
        if now - record.get('checked', 0) < (30 * 86400 if record.get('images') else 7 * 86400):
            continue
        if requests_made >= budget:
            break
        time.sleep(2.2)  # Below the free provider's 30 requests/minute limit.
        requests_made += 1
        try:
            response = session.get('https://www.thesportsdb.com/api/v1/json/123/searchevents.php',
                                   params={'e': event['title'], 'd': event['date']}, timeout=12)
            response.raise_for_status()
            candidates = response.json().get('event', response.json().get('events')) or []
            if not isinstance(candidates, list):
                raise ValueError('Malformed artwork response')
            images = []
            for candidate in candidates:
                if matching(event, candidate):
                    # strThumb can contain a result photo. Only the explicit poster field is trusted.
                    poster = candidate.get('strPoster') or ''
                    if poster.startswith('https://'):
                        images.append(poster)
            if images:
                event['images'] = list(dict.fromkeys(event['images'] + images))
            state[event['id']] = {'checked': now, 'images': event['images']}
            write_json(state_path, state)
        except (requests.RequestException, ValueError, TypeError):
            print('Artwork provider unavailable; keeping known images and designed covers.', flush=True)
            break
    # Include state entries for every event without advancing failed lookups.
    for event in ordered:
        if event['id'] not in state:
            state[event['id']] = {'checked': 0, 'images': event['images']}
    write_json(state_path, state)


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('catalog')
    p.add_argument('--state', default='.data-work/artwork.json')
    p.add_argument('--budget', type=int, default=24)
    a = p.parse_args()
    path = Path(a.catalog)
    value = json.loads(path.read_text(encoding='utf8'))
    enrich(value, Path(a.state), a.budget)
    write_json(path, value)
