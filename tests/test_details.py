import copy
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from enrich import main, merge_fighters, parse_sherdog, parse_ufc, parse_profile, parse_ufc_index, portrait
from detail_schema import validate_details

FIXTURES = Path(__file__).parent / 'fixtures' / 'details'


class DetailTests(unittest.TestCase):
    def test_real_primary_pairs_and_separate_results(self):
        event = {'id': 'sd-100836', 'title': 'UFC 300 - Pereira vs. Hill', 'date': '2024-04-13',
                 'participants': ['Alex Pereira', 'Jamahal Hill'],
                 'source': 'https://www.sherdog.com/events/UFC-300-Pereira-vs-Hill-100836'}
        detail, fighters = parse_sherdog((FIXTURES / 'sherdog-event.html').read_text(encoding='utf8'), event)
        self.assertEqual(len(detail['fights']), 2)
        main = detail['fights'][0]
        self.assertEqual(main['fighters'], ['sd-f-224511', 'sd-f-280417'])
        self.assertEqual(main['result']['winner'], 'sd-f-224511')
        self.assertEqual(main['result']['round'], '1')
        self.assertEqual(main['section'], 'unknown')  # No fabricated main/prelim boundary.
        self.assertFalse(any('record' in f for f in fighters.values()))
        validate_details({'events': [{**event, **detail}], 'fighters': fighters})

    def official(self):
        event = {'id': 'test-322', 'title': 'UFC 322 - Della Maddalena vs. Makhachev',
                 'date': '2025-11-15', 'participants': ['Jack Della Maddalena', 'Islam Makhachev']}
        html = (FIXTURES / 'ufc-event.html').read_text(encoding='utf8')
        return html, event

    def test_real_official_sections_timestamps_identity_and_belt_filter(self):
        html, event = self.official()
        known = {'sd-f-76836': {'id': 'sd-f-76836', 'name': 'Islam Makhachev', 'images': [], 'sources': []}}
        aliases = {}
        detail, fighters = parse_ufc(html, event, known, aliases)
        self.assertEqual(detail['startTime'], '2025-11-16T03:00:00+00:00')
        self.assertEqual(detail['sectionTimes']['prelims'], '2025-11-16T01:00:00+00:00')
        self.assertIn('main', {f['section'] for f in detail['fights']})
        self.assertIn('prelims', {f['section'] for f in detail['fights']})
        self.assertEqual(aliases['https://www.ufc.com/athlete/islam-makhachev'], 'sd-f-76836')
        self.assertEqual(fighters['sd-f-76836']['images'], [])
        self.assertTrue(detail['heroImages'][0].startswith('https://ufc.com/images/'))
        self.assertNotIn('Title', detail['fights'][0]['weightClass'])
        validate_details({'events': [{**event, **detail}], 'fighters': fighters})

    def test_mismatch_cannot_pollute_identity_map(self):
        html, event = self.official()
        aliases = {'existing': 'kept'}
        with self.assertRaises(ValueError):
            parse_ufc(html, {**event, 'title': 'UFC 323'}, {}, aliases)
        with self.assertRaises(ValueError):
            parse_ufc(html, {**event, 'title': 'UFC Fight Night - Example'}, {}, aliases)
        with self.assertRaises(ValueError):
            parse_ufc(html, {**event, 'date': '2025-12-15'}, {}, aliases)
        self.assertEqual(aliases, {'existing': 'kept'})
        with self.assertRaises(ValueError):
            parse_ufc('<html>Verification required</html>', event)

    def test_schedule_uses_explicit_section_timestamps(self):
        entries = parse_ufc_index('<article class="c-card-event--result"><a href="/event/ufc-322">UFC 322</a><div data-main-card-timestamp="1763262000" data-prelims-card-timestamp="1763254800" data-early-card-timestamp=""></div></article>')
        self.assertEqual(entries[0]['sectionTimes']['main'], '2025-11-16T03:00:00+00:00')
        self.assertNotIn('early', entries[0]['sectionTimes'])

    def test_profile_allowlist_and_unknown_image(self):
        html = (FIXTURES / 'ufc-profile.html').read_text(encoding='utf8')
        profile = parse_profile(html, 'Islam Makhachev')
        self.assertEqual(profile['heightCm'], 178)
        self.assertEqual(profile['birthplace'], 'Dagestan, Russia')
        self.assertNotIn('age', profile)
        self.assertNotIn('record', profile)
        self.assertEqual(portrait('/images/ATHLETE_BELT.png', 'https://www.ufc.com'), '')
        self.assertEqual(portrait('javascript:alert(1)', 'https://www.ufc.com'), '')
        with self.assertRaises(ValueError):
            parse_profile(html, 'Another Fighter')

    def test_does_not_replace_large_portrait_with_historical_thumbnail(self):
        large = 'https://www.sherdog.com/image_crop/200/300/portrait.jpg'
        small = 'https://www.sherdog.com/image_crop/44/44/portrait.jpg'
        people = {'f': {'id': 'f', 'name': 'Fighter', 'images': [large], 'sources': []}}
        merge_fighters(people, {'f': {**people['f'], 'images': [small]}})
        self.assertEqual(people['f']['images'], [large, small])

    def test_offline_pipeline_retains_official_snapshot_and_unknown_events(self):
        html, event = self.official()
        detail, fighters = parse_ufc(html, event)
        detail.update(detailSource='https://www.ufc.com/event/ufc-322', detailsUpdatedAt='2025-11-16T04:00:00+00:00')
        event.update(source='https://www.sherdog.com/events/Test-322', series='numbered', status='completed', images=[], sources=[])
        # Basic archive coverage, with one known detailed event and one future
        # event for which neither source is available. No network is permitted.
        events = [{'id': str(y), 'title': 'Cancelled event', 'date': str(y)+'-01-01', 'series': 'numbered', 'status': 'cancelled', 'participants': [], 'images': [], 'source': 'https://example.com/'+str(y)} for y in range(2010,datetime.now(timezone.utc).year+1)]
        future = {**event, 'id': 'future', 'title': 'UFC Fight Night', 'date': '2099-01-01', 'status': 'upcoming', 'participants': [], 'source': 'https://example.com/future'}
        data = {'schemaVersion': 1, 'events': events+[event, future], 'featured': [], 'updatedAt': '2026-01-01T00:00:00Z'}
        state = {'events': {event['id']: {'version': 1, 'date': event['date'], 'fetchedAt': 0, 'details': detail}}, 'fighters': fighters, 'aliases': {}}
        temporary_root = Path(__file__).resolve().parents[1] / '.cache' / 'detail-tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=temporary_root) as directory:
            root = Path(directory)
            self.assertTrue(root.resolve().is_relative_to(temporary_root.resolve()))
            (root/'catalog.json').write_text(json.dumps(data), encoding='utf8')
            (root/'state.json').write_text(json.dumps(state), encoding='utf8')
            cache = root/'cache';cache.mkdir()
            # A bad newly read primary page must not erase the older good card.
            (cache/(hashlib.sha256(event['source'].encode()).hexdigest()+'.html')).write_text('Changed markup', encoding='utf8')
            cwd = Path.cwd()
            try:
                os.chdir(root)
                with patch.object(sys, 'argv', ['enrich', str(root/'catalog.json'), '--state', str(root/'state.json'), '--cache', str(cache), '--offline', '--archive-batch', '0', '--profile-batch', '0']), patch('requests.Session.get', side_effect=AssertionError('Unexpected network')), redirect_stdout(io.StringIO()):
                    main()
            finally:
                os.chdir(cwd)
            output = json.loads((root/'catalog.json').read_text(encoding='utf8'))
            saved = next(e for e in output['events'] if e['id'] == event['id'])
            self.assertEqual(saved['detailsUpdatedAt'], detail['detailsUpdatedAt'])
            self.assertEqual(saved['fights'], detail['fights'])
            self.assertTrue({f['name'] for f in fighters.values()} <= set(saved['participants']))
            self.assertEqual(output['schemaVersion'], 2)
            self.assertNotIn('fights', next(e for e in output['events'] if e['id'] == 'future'))

    def test_schema_rejects_corrupt_links_results_and_raw_bios(self):
        html, event = self.official()
        detail, fighters = parse_ufc(html, event)
        data = {'events': [{**event, **detail}], 'fighters': fighters}
        for mutate in (
            lambda d: d['events'][0]['fights'][0]['fighters'].__setitem__(0, 'missing'),
            lambda d: d['events'][0]['fights'][0]['result'].__setitem__('winner', 'missing'),
            lambda d: d['events'][0].__setitem__('startTime', '2025-11-15T22:00:00'),
            lambda d: next(iter(d['fighters'].values())).__setitem__('biography', 'spoiler'),
            lambda d: next(iter(d['fighters'].values())).__setitem__('images', ['javascript:alert(1)']),
        ):
            invalid = copy.deepcopy(data)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate_details(invalid)


if __name__ == '__main__':
    unittest.main()
