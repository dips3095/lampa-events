const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../events.js'), 'utf8');
// Lampa's extension checker recognizes scripts by this literal API prefix.
assert.match(source, /Lampa\./, 'Lampa must recognize this file as an extension');
(async () => {
 const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox']});
 try {
 const page = await browser.newPage();
 await page.setContent('<div class="menu"><ul class="menu__list"></ul></div><main></main>');
 await page.addScriptTag({path: process.env.JQUERY_PATH || require.resolve('jquery/dist/jquery.js')});
 await page.evaluate(() => {
  window.appready = true;window.controllerName='content';window.focusCalls=0;
  window.fixture = {events: [
   {idEvent:'1', idLeague:'4443',strEvent:'EVENT 311 Main Event',dateEvent:'2025-01-19',strDescriptionEN:'SPOILER'},
   {idEvent:'2', idLeague:'4443',strEvent:'EVENT Evening 249',dateEvent:'2025-01-11'},
   {idEvent:'1', idLeague:'4443',strEvent:'EVENT 311',dateEvent:'2025-01-19'},
   {idEvent:'bad',idLeague:'4443',strEvent:123,dateEvent:'2025-01-20'},
   {idEvent:'3', idLeague:'9999',strEvent:'Other sport',dateEvent:'2025-01-20'}]};
  window.Lampa = {
   Component:{add:(name,ctor)=>{window.Catalog=ctor;}},
   Activity:{push:data=>{window.pushed=data;},backward:()=>{}},
   Controller:{add:(name,c)=>{window.controller=c;},enabled:()=>({name:window.controllerName}),toggle:()=>{window.controllerName='content';window.controller.toggle();},
    collectionSet:()=>{},collectionFocus:(node)=>{window.focusCalls++;$(node).trigger('hover:focus');}},
   Select:{show:options=>{window.selection=options;}},
   Scroll:function(){const body=$('<div>');this.render=this.body=()=>body;this.append=e=>body.append(e);this.update=()=>{};this.destroy=()=>body.remove();},
   Reguest:function(){this.clear=()=>{};this.timeout=()=>{};this.native=(url,ok,fail)=>{window.requestURL=url;setTimeout(()=>window.failRequest?fail():ok(window.fixture),0);};}
  };
 });
 await page.evaluate(()=>{window.savedLampa=window.Lampa;delete window.Lampa;setTimeout(()=>{window.Lampa=window.savedLampa;},100);});
 await page.addScriptTag({path: require('node:path').join(__dirname, '../events.js')});
 await page.waitForFunction(()=>typeof window.Catalog==='function');
 await page.evaluate(()=>{window.catalog=new window.Catalog({events_year:2025});$('main').append(catalog.create());catalog.start();});
 await page.waitForSelector('.events-card');
 assert.equal(await page.locator('.events-card').count(),2);
 assert.match(await page.locator('.events-title').first().innerText(),/^EVENT 311/);
 assert.equal((await page.locator('main').innerText()).includes('SPOILER'),false);
 await page.evaluate(()=>{$('.events-card').first().trigger('hover:enter');selection.onSelect(selection.items[0]);});
 const pushed=await page.evaluate(()=>window.pushed);
 assert.equal(pushed.search,'EVENT 311'); assert.equal(pushed.component,'torrents'); assert.equal(pushed.from_search,true);
 await page.evaluate(()=>{$('.events-card').last().trigger('hover:enter');selection.onSelect(selection.items[1]);});
 assert.equal(await page.evaluate(()=>pushed.search),'EVENT 2025.01.11');
 await page.evaluate(()=>{$('.events-card').first().trigger('hover:focus');controller.right();});
 // A completed network request must not steal focus from a modal.
 await page.evaluate(()=>{window.controllerName='select';window.beforeFocus=window.focusCalls;$('.events-toolbar .selector').last().trigger('hover:enter');});
 await page.waitForFunction(()=>$('.events-card').length===2);
 assert.equal(await page.evaluate(()=>window.focusCalls),await page.evaluate(()=>window.beforeFocus));
 await page.evaluate(()=>{window.controllerName='content';});
 // Switch to a fresh year and exercise the failure/retry state.
 await page.evaluate(()=>{window.failRequest=true;$('.events-toolbar .selector').first().trigger('hover:enter');selection.onSelect({year:2024});});
 await page.waitForFunction(()=>$('.events-status').text().includes('Не удалось'));
 await page.evaluate(()=>{window.failRequest=false;window.fixture={events:null};$('.events-toolbar .selector').last().trigger('hover:enter');});
 await page.waitForFunction(()=>$('.events-status').text().includes('не найдены'));
 await page.evaluate(()=>catalog.destroy());
 assert.equal(await page.locator('.events-catalog').count(),0);
 console.log('PASS: startup, cards, sorting, deduplication, spoiler omission, search handoff, date search, navigation, error, retry, empty response, cleanup.');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
