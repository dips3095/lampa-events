import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from wiki_posters import infoboxes, choose_poster, file_key


class PosterTests(unittest.TestCase):
    def test_only_matching_event_infobox_artwork(self):
        raw='''{{Infobox MMA event
|name= UFC 300: A vs. B
|image= UFC_300_poster.jpg
|date= {{start date|2024|04|13}}
|venue= Example {{nested|one}}
}}
[[File:Post_event_result_photo.jpg]]
{{Infobox MMA event
|name= UFC 301: C vs. D
|image= UFC_301_poster.jpg
|date= {{start date|2024|05|04}}
}}'''
        boxes=infoboxes(raw)
        self.assertEqual(len(boxes),2)
        self.assertEqual(choose_poster({'title':'UFC 300 - A vs B','date':'2024-04-13','series':'numbered'},boxes),'UFC_300_poster.jpg')
        self.assertIsNone(choose_poster({'title':'UFC 302 - A vs B','date':'2024-04-13','series':'numbered'},boxes))
        self.assertIsNone(choose_poster({'title':'UFC 300 - A vs B','date':'2024-06-01','series':'numbered'},boxes))

    def test_annual_article_selects_the_correct_card(self):
        boxes=[{'title':'UFC Fight Night: Alpha vs Beta','date':'2010-01-01','file':'first.jpg'},
               {'title':'UFC Fight Night: Gamma vs Delta','date':'2010-01-01','file':'second.jpg'}]
        self.assertEqual(choose_poster({'title':'UFC Fight Night 20 - Gamma vs Delta','date':'2010-01-01','series':'fight-night'},boxes),'second.jpg')
        self.assertIsNone(choose_poster({'title':'UFC Fight Night - Unknown vs Missing','date':'2010-01-01','series':'fight-night'},boxes))
        event={'title':'UFC Fight Night 226 - Gane vs. Spivak','date':'2023-09-02','series':'fight-night'}
        variant=[{'title':'UFC Fight Night: Gane vs. Spivac','date':'2023-09-02','file':'gane.jpg'}]
        self.assertEqual(choose_poster(event,variant,'UFC Fight Night: Gane vs. Spivac'),'gane.jpg')

    def test_no_logo_or_arena_fallback(self):
        raw='{{Infobox MMA event\n|name= UFC 300\n|image= Arena logo.svg\n|date= April 13, 2024\n}}'
        self.assertFalse(infoboxes(raw))
        self.assertEqual(file_key('File:UFC_300_poster.jpg'),file_key('UFC 300 poster.jpg'))

    def test_embedded_file_keeps_filename_not_display_size(self):
        raw='{{Infobox MMA event\n|name= UFC 274\n|image= [[File:Official poster for UFC 274.jpg|250px]]\n|date= {{start date|2022|05|07}}\n}}'
        self.assertEqual(infoboxes(raw)[0]['file'],'Official poster for UFC 274.jpg')


if __name__=='__main__':unittest.main()
