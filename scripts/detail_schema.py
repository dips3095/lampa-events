"""Strict allowlist for the optional public detail model, including opt-in results."""
from datetime import datetime
from urllib.parse import urlparse

EVENT_FIELDS = {'fights', 'venue', 'startTime', 'sectionTimes', 'detailsUpdatedAt', 'detailSource', 'heroImages'}
FIGHTER_FIELDS = {'id', 'name', 'images', 'sources', 'weightClass', 'weightDate', 'birthplace', 'team', 'style', 'heightCm', 'profileUpdatedAt'}
SECTIONS = {'main', 'prelims', 'early', 'unknown'}


def require(value, message):
    if not value:
        raise ValueError(message)


def safe_url(url):
    return isinstance(url, str) and urlparse(url).scheme == 'https' and bool(urlparse(url).hostname) and not urlparse(url).username


def timestamp(value):
    require(isinstance(value, str), 'Invalid detail timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'Detail time must include timezone')


def validate_details(catalog):
    fighters = catalog.get('fighters', {})
    require(isinstance(fighters, dict), 'Invalid fighter index')
    for fid, fighter in fighters.items():
        require(isinstance(fighter, dict) and not set(fighter) - FIGHTER_FIELDS, 'Unknown fighter fields')
        require(fighter.get('id') == fid and isinstance(fighter.get('name'), str) and fighter['name'], 'Invalid fighter identity')
        for key in ('images', 'sources'):
            require(isinstance(fighter.get(key), list) and all(safe_url(u) for u in fighter[key]), 'Invalid fighter URLs')
        for key in ('weightClass', 'weightDate', 'birthplace', 'team', 'style'):
            require(key not in fighter or isinstance(fighter[key], str), 'Invalid fighter attribute')
        if 'heightCm' in fighter:
            require(isinstance(fighter['heightCm'], (int, float)) and 100 < fighter['heightCm'] < 250, 'Invalid height')
        if 'profileUpdatedAt' in fighter:
            timestamp(fighter['profileUpdatedAt'])
    for event in catalog['events']:
        for key in ('startTime', 'detailsUpdatedAt'):
            if key in event:
                timestamp(event[key])
        if 'venue' in event:
            require(isinstance(event['venue'], str), 'Invalid venue')
        if 'detailSource' in event:
            require(safe_url(event['detailSource']), 'Invalid detail source')
        if 'heroImages' in event:
            require(isinstance(event['heroImages'], list) and all(safe_url(u) for u in event['heroImages']), 'Invalid hero artwork')
        times = event.get('sectionTimes', {})
        require(isinstance(times, dict) and not set(times) - SECTIONS, 'Invalid card times')
        for value in times.values():
            timestamp(value)
        fights = event.get('fights', [])
        require(isinstance(fights, list), 'Invalid fight card')
        seen = set()
        for fight in fights:
            require(isinstance(fight, dict) and not set(fight) - {'id', 'fighters', 'section', 'weightClass', 'result'}, 'Unknown fight fields')
            require(isinstance(fight.get('id'), str) and fight['id'] not in seen, 'Duplicate fight')
            seen.add(fight['id'])
            pair = fight.get('fighters')
            require(isinstance(pair, list) and len(pair) == 2 and pair[0] != pair[1] and all(fid in fighters for fid in pair), 'Invalid fighter references')
            require(fight.get('section') in SECTIONS and isinstance(fight.get('weightClass'), str), 'Invalid card section')
            if 'result' in fight:
                result = fight['result']
                require(isinstance(result, dict) and set(result) == {'outcome', 'winner', 'method', 'round', 'time'}, 'Invalid result fields')
                require(result['outcome'] in ('win', 'draw', 'nc'), 'Invalid outcome')
                require(result['winner'] in pair if result['outcome'] == 'win' else result['winner'] is None, 'Invalid winner')
                require(all(isinstance(result[k], str) for k in ('method', 'round', 'time')), 'Invalid result details')
