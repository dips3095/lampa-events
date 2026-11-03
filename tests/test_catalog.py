import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from catalog import classify, parse_archive, parse_detail, reconcile, norm, validate
from artwork import matching


class CatalogTests(unittest.TestCase):
    def test_classification(self):
        self.assertEqual(classify('UFC 18 - The Road to the Heavyweight Title'), 'numbered')
        self.assertEqual(classify('UFC - Road to UFC Season 5'), 'excluded')
        self.assertEqual(classify('UFC - The Ultimate Fighter 28 Finale'), 'finale')
        self.assertEqual(classify('UFC on ESPN 63 - A vs B'), 'broadcast')
        self.assertEqual(classify('UFC Experimental Series'), 'unknown')

    def test_archive_pagination_and_fail_closed(self):
        html = '<tr itemtype="http://schema.org/Event"><td><meta itemprop="startDate" content="1993-11-12T00:00:00Z"></td><td><a itemprop="url" href="/events/Event-7">Event 1</a></td></tr><a href="/organizations/Ultimate-Fighting-Championship-UFC-2/recent-events/2">Older Events</a>'
        rows, url = parse_archive(html, 'https://www.sherdog.com/organizations/Ultimate-Fighting-Championship-UFC-2')
        self.assertEqual(rows[0]['id'], 'sd-7')
        self.assertTrue(url.endswith('/2'))
        with self.assertRaises(ValueError): parse_archive('<html>Blocked</html>', url)

    def test_spoiler_allowlist_and_early_bracket_names(self):
        event = {'id':'sd-7','title':'Event 1','date':'1993-11-12','source':'https://www.sherdog.com/events/Event-7','series':'numbered'}
        html = '<div class="col-left"><div class="event_detail"><h1>Event 1</h1><meta itemprop="startDate" content="1993-11-12"></div>'
        for fid, name in [('1','Zed'),('2','Amy'),('1','Zed')]:
            html += '<div itemtype="http://schema.org/Person"><a href="/fighter/Person-'+fid+'"><span itemprop="name">'+name+'</span></a><b>win SPOILER</b></div>'
        value = parse_detail(html+'</div>', event, '2026-11-03')
        self.assertEqual(value['participants'], ['Amy','Zed'])
        self.assertNotIn('SPOILER', str(value))
        self.assertEqual(value['images'], [])
        with self.assertRaises(ValueError): parse_detail('<h1>Event</h1>', event, '2026-11-03')

    def test_same_day_events_do_not_match_by_date_alone(self):
        rows = [{'id':'a','title':'UFC Fight Night 1 - Alpha vs Beta','date':'2020-01-01','series':'fight-night'},
                {'id':'b','title':'UFC Fight Night 2 - Gamma vs Delta','date':'2020-01-01','series':'fight-night'}]
        refs = [{'title':'UFC Fight Night: Gamma vs Delta','date':'2020-01-01'}, {'title':'UFC Fight Night: Alpha vs Beta','date':'2020-01-01'}]
        report = reconcile(rows, refs, {})
        self.assertEqual(report['matchedCount'],2)
        self.assertFalse(report['unmatchedSource'])

    def test_artwork_identity_and_date(self):
        e={'title':'UFC 300 - Example','date':'2024-04-13'}
        c={'strEvent':'UFC 300','dateEvent':'2024-04-14','idLeague':'4443'}
        self.assertTrue(matching(e,c))
        c['strEvent']='UFC 301'
        self.assertFalse(matching(e,c))
        c['strEvent']='UFC 300';c['dateEvent']='2024-04-16'
        self.assertFalse(matching(e,c))

    def test_cancellations_are_propagated(self):
        rows=[{'id':'a','title':'UFC 233 - Example','date':'2019-01-26','series':'numbered'}]
        refs=[{'title':'UFC 233: Example','date':'2019-01-26','cancelled':True}]
        self.assertEqual(reconcile(rows, refs, {})['cancelledIds'], ['a'])

    def test_missing_year_or_removed_event_blocks_publication(self):
        from datetime import datetime, timezone
        entries=[{'id':str(y),'title':'Event','date':str(y)+'-01-01','series':'numbered','status':'completed','participants':['A','B'],'images':[]} for y in range(1993,datetime.now(timezone.utc).year+1)]
        data={'schemaVersion':1,'events':entries}
        validate(data)
        changed=copy.deepcopy(data);changed['events'].pop(3)
        with self.assertRaises(ValueError):validate(changed,data)
        changed=copy.deepcopy(data);changed['events'][0]['winner']='A'
        with self.assertRaises(ValueError):validate(changed)


if __name__ == '__main__': unittest.main()
