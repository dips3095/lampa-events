"""Optional, provenance-preserving UFC detail enrichment. Never invent absent data.

Sherdog supplies stable numeric identities and historical pairs. Official UFC
pages supply card sections, anchored start times and neutral athlete portraits.
Failures preserve the last successful detail snapshot and its original date.
"""
import argparse
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from catalog import Fetcher, norm, number, text, write_json

UFC = 'https://www.ufc.com'
SECTIONS = {'main-card': 'main', 'prelims-card': 'prelims', 'early-prelims': 'early',
            'early-prelims-card': 'early', 'prelims': 'prelims'}
DETAIL_FIELDS = {'fights', 'venue', 'startTime', 'sectionTimes', 'detailsUpdatedAt', 'detailSource', 'heroImages'}
VERSION = 1


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def https_url(value, base):
    url = urljoin(base, value or '')
    return url if urlparse(url).scheme == 'https' and urlparse(url).hostname else ''


def portrait(value, base):
    url = https_url(value, base)
    # The official card sometimes reuses a current champion's belt photograph.
    if not value or re.search(r'belt|champion|placeholder|silhouette|no[_-]?image', url, re.I):
        return ''
    return url


def identity(name):
    # Also handles the source's "Weili Zhang" versus "Zhang Weili" ordering.
    return ' '.join(sorted(norm(name).split()))


def parse_sherdog(html, event):
    soup = BeautifulSoup(html, 'html.parser')
    date = soup.select_one('.event_detail [itemprop="startDate"]')
    if not date or date.get('content', '')[:10] != event['date']:
        raise ValueError('Sherdog detail date mismatch')
    fighters, fights = {}, []
    blocks = soup.select('.fight_card, .new_table tr[itemprop="subEvent"]')
    for block in blocks:
        ids, outcomes = [], []
        for person in block.select('[itemtype$="/Person"]'):
            link = person.select_one('a[href^="/fighter/"]')
            name = text(person.select_one('[itemprop="name"]'))
            match = re.search(r'-(\d+)$', link.get('href', '')) if link else None
            if not match or not name:
                continue
            fid = 'sd-f-' + match[1]
            image = person.select_one('[itemprop="image"]')
            image = portrait(image.get('src', image.get('content', '')), event['source']) if image else ''
            # Keep the provider's exact URL; do not guess larger image variants.
            fighters[fid] = {'id': fid, 'name': name, 'images': [image] if image else [],
                             'sources': [urljoin(event['source'], link['href'])]}
            ids.append(fid)
            outcomes.append(text(person.select_one('.final_result')).lower())
        if len(ids) != 2 or ids[0] == ids[1]:
            continue
        fight = {'id': event['id'] + ':' + ':'.join(sorted(ids)), 'fighters': ids,
                 'section': 'unknown', 'weightClass': text(block.select_one('.weight_class'))}
        method = text(block.select_one('.winby b'))
        round_value, clock = '', ''
        if 'fight_card' in block.get('class', []):
            resume = block.find_next_sibling('table', class_='fight_card_resume')
            if resume:
                fields = {}
                for cell in resume.select('td'):
                    label = text(cell.select_one('em'))
                    fields[label] = text(cell)[len(label):].strip()
                method, round_value, clock = fields.get('Method', ''), fields.get('Round', ''), fields.get('Time', '')
        else:
            cells = block.find_all('td', recursive=False)
            if len(cells) >= 7:
                round_value, clock = text(cells[-2]), text(cells[-1])
        winner = ids[outcomes.index('win')] if 'win' in outcomes else None
        outcome = 'win' if winner else ('draw' if 'draw' in outcomes else 'nc' if any(v in ('nc', 'no contest') for v in outcomes) else None)
        if outcome:
            fight['result'] = {'outcome': outcome, 'winner': winner, 'method': method,
                               'round': round_value, 'time': clock}
        fights.append(fight)
    if not fights and event['participants']:
        raise ValueError('Sherdog fight markup unavailable')
    return {'fights': fights, 'venue': text(soup.select_one('.event_detail [itemprop="location"]')),
            'detailSource': event['source']}, fighters


def parse_ufc_index(html):
    soup = BeautifulSoup(html, 'html.parser')
    entries = []
    for card in soup.select('.c-card-event--result'):
        link = card.select_one('a[href*="/event/"]')
        date = card.select_one('[data-main-card-timestamp]')
        if link and date and date.get('data-main-card-timestamp', '').isdigit():
            times = {}
            for key, section in [('main', 'main'), ('prelims', 'prelims'), ('early', 'early')]:
                value = date.get('data-' + key + '-card-timestamp', '')
                if value.isdigit() and 0 <= int(date['data-main-card-timestamp']) - int(value) <= 12 * 3600:
                    times[section] = datetime.fromtimestamp(int(value), timezone.utc).isoformat()
            entries.append({'url': urljoin(UFC, link['href']), 'timestamp': int(date['data-main-card-timestamp']), 'sectionTimes': times})
    if not entries:
        raise ValueError('Official event index markup unavailable')
    return list({e['url']: e for e in entries}.values())


def parse_ufc(html, event, known_fighters=None, aliases=None):
    soup = BeautifulSoup(html, 'html.parser')
    hero = soup.select_one('.c-hero')
    anchor = hero.select_one('[data-timestamp]') if hero else None
    if not anchor or not anchor.get('data-timestamp', '').isdigit():
        raise ValueError('Official event has no anchored start time')
    start = datetime.fromtimestamp(int(anchor['data-timestamp']), timezone.utc)
    if abs((start.date() - datetime.fromisoformat(event['date']).date()).days) > 1:
        raise ValueError('Official event date mismatch')
    heading = text(hero.select_one('h1'))
    official_number = re.search(r'\bUFC\s+(\d+)\b', heading, re.I)
    if (int(official_number[1]) if official_number else None) != number(event['title']):
        raise ValueError('Official event number mismatch')
    known_fighters = known_fighters or {}
    destination_aliases = aliases if aliases is not None else {}
    aliases = dict(destination_aliases)
    fighters, fights = {}, []
    for node in soup.select('.fight-card .c-listing-fight'):
        ids, outcomes = [], []
        for side in ('red', 'blue'):
            name_node = node.select_one('.c-listing-fight__corner-name--' + side)
            link = name_node.select_one('a[href]') if name_node else None
            name = text(name_node)
            if not name or not link:
                continue
            source = https_url(link['href'], UFC)
            if urlparse(source).hostname not in ('www.ufc.com', 'ufc.com') or not urlparse(source).path.startswith('/athlete/'):
                continue
            candidates = [f['id'] for f in known_fighters.values() if identity(f['name']) == identity(name)]
            fid = aliases.get(source) or (candidates[0] if len(candidates) == 1 else 'ufc-f-' + urlparse(source).path.rstrip('/').split('/')[-1])
            aliases[source] = fid
            p = deepcopy(known_fighters.get(fid, {'id': fid, 'name': name, 'images': [], 'sources': []}))
            image = node.select_one('.c-listing-fight__corner-image--' + side + ' img')
            image = portrait(image.get('src'), UFC) if image else ''
            if image:
                p['images'] = list(dict.fromkeys([image] + p['images']))[:3]
            p['sources'] = list(dict.fromkeys(p['sources'] + [source]))
            fighters[fid] = p
            ids.append(fid)
            outcome = node.select_one('.c-listing-fight__corner-body--' + side + ' [class*="c-listing-fight__outcome--"]')
            outcomes.append(text(outcome).lower())
        if len(ids) != 2 or ids[0] == ids[1]:
            raise ValueError('Incomplete official fighter pair')
        parent = next((p for p in node.parents if p.get('id') in SECTIONS), None)
        section = SECTIONS[parent['id']] if parent else 'unknown'
        weight = re.sub(r'\s+(?:Title )?Bout$', '', text(node.select_one('.c-listing-fight__class-text')), flags=re.I)
        fight = {'id': event['id'] + ':' + ':'.join(sorted(ids)), 'fighters': ids,
                 'section': section, 'weightClass': weight}
        winner = ids[outcomes.index('win')] if 'win' in outcomes else None
        outcome = 'win' if winner else 'draw' if 'draw' in outcomes else 'nc' if any(v in ('nc', 'no contest') for v in outcomes) else None
        if outcome:
            fight['result'] = {'outcome': outcome, 'winner': winner,
                               'method': text(node.select_one('.c-listing-fight__result-text.method')),
                               'round': text(node.select_one('.c-listing-fight__result-text.round')),
                               'time': text(node.select_one('.c-listing-fight__result-text.time'))}
        fights.append(fight)
    if not fights:
        raise ValueError('Official fight card unavailable')
    # Date alone is not sufficient on double-event days, or for a mistyped URL.
    participants = {identity(n) for n in event['participants']}
    if not official_number and len(participants & {identity(f['name']) for f in fighters.values()}) < 2:
        raise ValueError('Official event participants do not establish identity')
    times = {'main': start.isoformat()}
    main_time = soup.select_one('#main-card time[datetime]')
    if main_time:
        # UFC's section fields can label Eastern wall time with a literal Z.
        # Calibrate against the independently provided main-card Unix timestamp.
        try:
            raw_main = datetime.fromisoformat(main_time['datetime'].replace('Z', '+00:00'))
            shift = start - raw_main
            if abs(shift.total_seconds()) <= 14 * 3600 and shift.total_seconds() % 1800 == 0:
                for element_id, section in SECTIONS.items():
                    node = soup.select_one('#' + element_id + ' time[datetime]')
                    if node:
                        value = datetime.fromisoformat(node['datetime'].replace('Z', '+00:00')) + shift
                        if 0 <= (start - value).total_seconds() <= 12 * 3600:
                            times[section] = value.isoformat()
        except (ValueError, TypeError):
            pass
    img = hero.select_one('.c-hero__image img[src]')
    image = https_url(img['src'], UFC) if img else ''
    destination_aliases.update(aliases)
    return {'fights': fights, 'venue': text(hero.select_one('.field--name-venue')), 'startTime': start.isoformat(),
            'sectionTimes': times, 'heroImages': [image] if image else []}, fighters


def parse_profile(html, expected_name=None):
    soup = BeautifulSoup(html, 'html.parser')
    if expected_name and identity(text(soup.select_one('h1.hero-profile__name'))) != identity(expected_name):
        raise ValueError('Official athlete identity mismatch')
    bio = soup.select_one('.c-bio--athlete')
    if not bio:
        raise ValueError('Official athlete biography unavailable')
    fields = {text(n.select_one('.c-bio__label')): text(n.select_one('.c-bio__text')) for n in bio.select('.c-bio__field')}
    result = {}
    for source, dest in [('Place of Birth', 'birthplace'), ('Trains at', 'team'), ('Fighting style', 'style')]:
        if fields.get(source):
            result[dest] = fields[source]
    try:
        height = float(fields.get('Height', '')) * 2.54
        if 100 < height < 250:
            result['heightCm'] = round(height)
    except ValueError:
        pass
    # No narrative bio, age that goes stale, record, belt, rank or win streak.
    return result


def merge_fighters(target, incoming):
    for fid, fighter in incoming.items():
        old = target.get(fid, {})
        merged = {**old, **fighter}
        for field in ('images', 'sources'):
            values = list(dict.fromkeys(fighter.get(field, []) + old.get(field, [])))
            if field == 'images':
                def quality(url):
                    crop = re.search(r'/image_crop/(\d+)/(\d+)/', url)
                    return min(int(crop[1]), int(crop[2])) if crop else 500
                values.sort(key=quality, reverse=True)
            merged[field] = values[:4]
        target[fid] = merged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('catalog')
    parser.add_argument('--state', default='.data-work/enrichment.json')
    parser.add_argument('--cache', default='.cache/source')
    parser.add_argument('--offline', action='store_true', help='Only parse existing HTML cache')
    parser.add_argument('--archive-batch', type=int, default=20)
    parser.add_argument('--profile-batch', type=int, default=24)
    args = parser.parse_args()
    catalog_path, state_path = Path(args.catalog), Path(args.state)
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    state = json.loads(state_path.read_text(encoding='utf8')) if state_path.exists() else {}
    state.setdefault('events', {})
    state.setdefault('fighters', {})
    state.setdefault('aliases', {})
    fetch = Fetcher(Path(args.cache), delay=0.7)
    failures, official_index = [], []
    now = datetime.now(timezone.utc)

    def get(url, age):
        if args.offline:
            path = fetch.directory / (hashlib.sha256(url.encode()).hexdigest() + '.html')
            if not path.exists():
                raise FileNotFoundError(url)
            fetch.fetched_at = path.stat().st_mtime
            return path.read_text(encoding='utf8')
        return fetch.get(url, age)

    try:
        official_index = parse_ufc_index(get(UFC + '/events', 3 * 3600))
    except (ValueError, RuntimeError, OSError) as exc:
        failures.append('Official schedule: ' + str(exc))
    archive_budget = args.archive_batch
    # Prioritize the nearest upcoming event, then recent events, then the archive.
    ordered = sorted(catalog['events'], key=lambda e: (0 if e['status'] == 'upcoming' else 1, e['date'] if e['status'] == 'upcoming' else str(99999999 - int(e['date'].replace('-', '')))))
    for index, event in enumerate(ordered):
        cached = state['events'].get(event['id'], {})
        if cached.get('date') != event['date'] or cached.get('version') != VERSION:
            cached = {}
        recent = event['date'] >= (now - timedelta(days=60)).date().isoformat()
        max_age = 3 * 3600 if recent else 30 * 86400
        fresh = cached and time.time() - cached.get('fetchedAt', 0) < max_age
        needs_official = (not recent and cached and number(event['title']) and archive_budget > 0
                          and not cached['details'].get('detailSource', '').startswith(UFC)
                          and time.time() - cached.get('officialTriedAt', 0) > 6 * 86400)
        if needs_official:
            fresh = False
        if not fresh:
            source_path = fetch.directory / (hashlib.sha256(event['source'].encode()).hexdigest() + '.html')
            should_fetch = recent or source_path.exists() or archive_budget > 0
            if not recent and not source_path.exists() and should_fetch:
                archive_budget -= 1
            if should_fetch and event['status'] != 'cancelled':
                details, people, fetched_at = None, {}, 0
                try:
                    if not recent and source_path.exists():
                        html = source_path.read_text(encoding='utf8')
                        fetch.fetched_at = source_path.stat().st_mtime
                    else:
                        html = get(event['source'], max_age)
                    details, people = parse_sherdog(html, event)
                    fetched_at = fetch.fetched_at
                except (ValueError, RuntimeError, OSError) as exc:
                    if recent:
                        failures.append(event['id'] + ' primary: ' + str(exc))
                candidates = [v['url'] for v in official_index if abs((datetime.fromtimestamp(v['timestamp'], timezone.utc).date() - datetime.fromisoformat(event['date']).date()).days) <= 1]
                n = number(event['title'])
                if n and (recent or not cached or needs_official):
                    candidates.append(UFC + '/event/ufc-' + str(n))
                if cached.get('details', {}).get('detailSource', '').startswith(UFC):
                    candidates.insert(0, cached['details']['detailSource'])
                # Bound the gradual historical backfill; do not crawl every official event at once.
                if not recent and cached and not needs_official:
                    candidates = []
                if not recent and not source_path.exists() and archive_budget <= 0:
                    candidates = []
                official_tried_at = cached.get('officialTriedAt', 0)
                for url in list(dict.fromkeys(candidates)):
                    official_cache = fetch.directory / (hashlib.sha256(url.encode()).hexdigest() + '.html')
                    if not recent and not official_cache.exists():
                        if archive_budget <= 0:
                            continue
                        archive_budget -= 1
                    official_tried_at = time.time()
                    try:
                        official, new_people = parse_ufc(get(url, max_age), event, {**state['fighters'], **people}, state['aliases'])
                        entry = next((v for v in official_index if v['url'] == url and v['sectionTimes'].get('main') == official['startTime']), None)
                        if entry:
                            official['sectionTimes'].update(entry['sectionTimes'])
                        fetched_at = fetch.fetched_at
                        details = official
                        details['detailSource'] = url
                        merge_fighters(people, new_people)
                        break
                    except (ValueError, RuntimeError, OSError) as exc:
                        if recent:
                            failures.append(event['id'] + ' official: ' + str(exc))
                if details:
                    if cached.get('details', {}).get('detailSource', '').startswith(UFC) and not details.get('detailSource', '').startswith(UFC):
                        details = deepcopy(cached['details'])
                        fetched_at = cached['fetchedAt']
                    # Keep previous trustworthy section/time metadata only when the
                    # entire snapshot was retained. Never combine an old card with a new timestamp.
                    details['detailsUpdatedAt'] = datetime.fromtimestamp(fetched_at, timezone.utc).isoformat()
                    cached = {'version': VERSION, 'date': event['date'], 'fetchedAt': fetched_at, 'details': details,
                              'officialTriedAt': official_tried_at}
                    state['events'][event['id']] = cached
                    merge_fighters(state['fighters'], people)
                    if index % 20 == 0:
                        write_json(state_path, state)
        for field in DETAIL_FIELDS:
            event.pop(field, None)
        if cached:
            event.update(deepcopy(cached['details']))
            if event.get('startTime') and event['status'] != 'cancelled' and datetime.fromisoformat(event['startTime']) > now:
                event['status'] = 'upcoming'
            for fight in event.get('fights', []):
                for fid in fight['fighters']:
                    if fight['weightClass'] and fid in state['fighters']:
                        f = state['fighters'][fid]
                        if event['date'] >= f.get('weightDate', ''):
                            f['weightClass'], f['weightDate'] = fight['weightClass'], event['date']
            # New official card members must be searchable even if the primary
            # archive's participant list has not caught up yet.
            event['participants'] = sorted(set(event['participants']) | {
                state['fighters'][fid]['name'] for fight in event.get('fights', []) for fid in fight['fighters']
            }, key=norm)
        if index % 50 == 0:
            print(f'Detail enrichment {index + 1}/{len(ordered)}', flush=True)
    profiles = 0
    attempted_profiles = set()
    for event in ordered:
        for fight in event.get('fights', []):
            for fid in fight['fighters']:
                fighter = state['fighters'][fid]
                url = next((u for u in fighter['sources'] if u.startswith(UFC + '/athlete/')), None)
                if not url or fid in attempted_profiles or profiles >= args.profile_batch or time.time() - fighter.get('profileFetchedAt', 0) < 30 * 86400:
                    continue
                attempted_profiles.add(fid)
                profiles += 1
                try:
                    fighter.update(parse_profile(get(url, 30 * 86400), fighter['name']))
                    fighter['profileFetchedAt'] = fetch.fetched_at
                    fighter['profileUpdatedAt'] = datetime.fromtimestamp(fetch.fetched_at, timezone.utc).isoformat()
                except (ValueError, RuntimeError, OSError) as exc:
                    failures.append(fid + ': ' + str(exc))
    write_json(state_path, state)
    catalog['schemaVersion'] = 2
    catalog['fighters'] = {fid: {k: v for k, v in f.items() if k != 'profileFetchedAt'} for fid, f in state['fighters'].items()}
    catalog['detailsCoverage'] = {'events': sum(bool(e.get('fights')) for e in catalog['events']), 'fighters': len(catalog['fighters'])}
    from catalog import validate
    validate(catalog)
    write_json(catalog_path, catalog)
    write_json(Path('.cache/enrichment-report.json'), {'at': iso_now(), 'coverage': catalog['detailsCoverage'], 'warnings': failures})
    print(json.dumps({'coverage': catalog['detailsCoverage'], 'warnings': len(failures)}, ensure_ascii=False), flush=True)
    for message in failures[:12]:
        print('Detail warning: ' + message, flush=True)


if __name__ == '__main__':
    main()
