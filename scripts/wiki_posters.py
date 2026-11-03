"""Resolve the image in the matching event infobox, including annual archive pages.

Batch metadata requests avoid downloading hundreds of individual HTML pages.
Only original image URLs and their provenance are published; raw revisions stay cached.
"""
from datetime import datetime
import html
import json
from pathlib import Path
import re
import time
from urllib.parse import unquote, urlparse, urlencode, urlsplit, urlunsplit
from catalog import Fetcher, norm, number, write_json

API = 'https://en.wikipedia.org/w/api.php'


def templates(content):
    for start in re.finditer(r'{{\s*Infobox\s+MMA\s+event\b', content, re.I):
        depth = 0
        for pair in re.finditer(r'{{|}}', content[start.start():]):
            depth += 1 if pair[0] == '{{' else -1
            if depth == 0:
                yield content[start.start():start.start() + pair.end()]
                break


def clean(value):
    value = re.sub(r'\[\[(?:[^\]|]+\|)?([^\]]+)\]\]', r'\1', value)
    return html.unescape(re.sub(r'<[^>]*>', '', value)).strip()


def infoboxes(content):
    result = []
    for box in templates(content):
        fields = {m[1].lower(): m[2].strip() for m in re.finditer(r'\n\|\s*(name|image|date)\s*=\s*(.*?)(?=\n\||\n?}}\s*$)', box, re.I | re.S)}
        if not all(fields.get(key) for key in ('name','image','date')):
            continue
        embedded = re.search(r'\[\[(?:File|Image):([^\]|]+)',fields['image'],re.I)
        image = (embedded[1] if embedded else clean(fields['image']).split('|')[0]).strip()
        image = re.sub(r'^(?:File|Image):', '', image, flags=re.I)
        if not re.search(r'\.(?:jpg|jpeg|png|webp)$', image, re.I) or re.search(r'\b(?:logo|flag|arena)\b', image, re.I):
            continue
        dt = None
        parts = re.search(r'{{\s*(?:start date|start-date|date)\s*\|(?:[^{}]*?\|)?(\d{4})\|(\d{1,2})\|(\d{1,2})', fields['date'], re.I)
        if parts:
            try: dt = datetime(*map(int, parts.groups())).date().isoformat()
            except ValueError: pass
        else:
            raw = clean(fields['date']).replace('\xa0',' ')
            match = re.search(r'\b([A-Za-z]+ \d{1,2}, \d{4})\b', raw)
            if match:
                for fmt in ('%B %d, %Y','%b %d, %Y'):
                    try: dt = datetime.strptime(match[1], fmt).date().isoformat(); break
                    except ValueError: pass
        if dt:
            result.append({'title':clean(fields['name']), 'date':dt, 'file':image})
    return result


def choose_poster(event, boxes, reference_title=''):
    ranked = []
    stop = {'ufc','fight','night','vs','on','the','ultimate','fighter','finale','espn','fox','abc'}
    for box in boxes:
        delta = abs((datetime.fromisoformat(event['date']) - datetime.fromisoformat(box['date'])).days)
        if delta > 1: continue
        n, other = number(event['title']), number(box['title'])
        overlap = len((set(norm(event['title']).split()) - stop) & (set(norm(box['title']).split()) - stop))
        if n is not None or other is not None:
            if n != other: continue
            score = 100
        elif overlap >= 2:
            score = overlap
        elif norm(reference_title) == norm(box['title']):
            # This article was independently matched to the event in the archive audit.
            # Alternate romanizations or a late main-event replacement must not lose its poster.
            score = 10
        elif event['series'] == 'finale' and 'ultimate fighter' in norm(box['title']):
            score = 1
        else: continue
        ranked.append((score * 10 - delta, box['file']))
    ranked.sort(reverse=True)
    if ranked and (len(ranked)==1 or ranked[0][0] > ranked[1][0]):
        return ranked[0][1]
    return None


def file_key(name):
    return unquote(name).replace('_',' ').removeprefix('File:').strip().casefold()


def query(fetch, params, age):
    data = json.loads(fetch.get(API + '?' + urlencode({'action':'query','format':'json','formatversion':2,'redirects':1, **params}), age))
    if 'error' in data or 'query' not in data:
        raise ValueError('Image metadata API did not return a query')
    return data['query']


def enrich(catalog, state_path):
    state = json.loads(state_path.read_text(encoding='utf8')) if state_path.exists() else {}
    fetch = Fetcher(Path('.cache/source'), delay=1.2)
    now = time.time()
    pending = {}
    for event in catalog['events']:
        record = state.get(event['id'], {})
        event['images'] = list(dict.fromkeys(event['images'] + record.get('images', [])))
        age = 23*3600 if event['status']!='completed' or not record.get('images') else 30*86400
        if now-record.get('checked',0) < age and (record.get('images') or record.get('resolverVersion')==2 and not record.get('file')): continue
        sources = [s for s in event['sources'] if urlparse(s).hostname == 'en.wikipedia.org']
        if not sources: continue
        title = unquote(urlparse(sources[0]).path.removeprefix('/wiki/')).replace('_',' ')
        if title: pending.setdefault(title,[]).append(event)
    all_files = {}
    titles = list(pending)
    for start in range(0,len(titles),15):
        batch = titles[start:start+15]
        try:
            response = query(fetch, {'prop':'revisions','rvprop':'content','rvslots':'main','titles':'|'.join(batch)}, 86400)
        except (ValueError, RuntimeError, OSError) as error:
            print(f'Poster metadata unavailable; retaining known images: {type(error).__name__}',flush=True)
            break
        redirects = {p['from']:p['to'] for p in response.get('redirects',[])}
        pages = {p['title']:p for p in response.get('pages',[])}
        for title in batch:
            canonical = title
            for _ in range(5):
                if canonical not in redirects: break
                canonical = redirects[canonical]
            page = pages.get(canonical,{})
            revisions = page.get('revisions',[])
            boxes = infoboxes(revisions[0].get('slots',{}).get('main',{}).get('content','')) if revisions else []
            for event in pending[title]:
                filename = choose_poster(event, boxes, title)
                record = {'checked':now,'resolverVersion':2,'page':title,'file':filename,'images':state.get(event['id'],{}).get('images',[])}
                state[event['id']] = record
                if filename: all_files.setdefault(filename,[]).append(event)
        write_json(state_path,state)
        print(f'Poster pages: {min(start+15,len(titles))}/{len(titles)}',flush=True)
    files = list(all_files)
    for start in range(0,len(files),50):
        batch = files[start:start+50]
        try:
            response = query(fetch, {'prop':'imageinfo','iiprop':'url','titles':'|'.join('File:'+f for f in batch)}, 30*86400)
        except (ValueError, RuntimeError, OSError) as error:
            print(f'Poster URL lookup unavailable; retaining known images: {type(error).__name__}',flush=True)
            break
        resolved = {}
        aliases = {file_key(p['from']):file_key(p['to']) for p in response.get('normalized',[])+response.get('redirects',[])}
        for page in response.get('pages',[]):
            info = page.get('imageinfo',[])
            if not info: continue
            url = urlsplit(info[0].get('url',''))
            if url.scheme=='https' and url.hostname in ('upload.wikimedia.org','thumb.wikimedia.org'):
                resolved[file_key(page['title'])] = urlunsplit((url.scheme,url.netloc,url.path,'',''))
        for filename in batch:
            key = file_key(filename)
            for _ in range(5):
                if key not in aliases: break
                key = aliases[key]
            url = resolved.get(key)
            if not url: continue
            for event in all_files[filename]:
                event['images'] = list(dict.fromkeys([url]+event['images']))
                state[event['id']]['images'] = event['images']
        write_json(state_path,state)
    print(f"Original posters: {sum(bool(e['images']) for e in catalog['events'])}/{len(catalog['events'])}",flush=True)


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('catalog')
    p.add_argument('--state',default='.data-work/wiki-posters.json')
    a=p.parse_args()
    path=Path(a.catalog)
    catalog=json.loads(path.read_text(encoding='utf8'))
    enrich(catalog,Path(a.state))
    write_json(path,catalog)
