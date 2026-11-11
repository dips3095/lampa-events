const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../events.js');
const source = fs.readFileSync(path.join(__dirname, '../events.js'), 'utf8');
assert.match(source, /Lampa\./);
const fixture = {
 schemaVersion:2, updatedAt:'2026-11-03T10:00:00Z', featured:['event-5','event-9'],
 events:Array.from({length:85},(_,i)=>({
  id:'event-'+i,title:'EVENT '+(100+i)+' — Alpha vs Beta',date:'2026-'+String(1+Math.floor(i/28)).padStart(2,'0')+'-'+String(1+i%28).padStart(2,'0'),
  series:i%2?'numbered':'fight-night',status:i>=80?'upcoming':'completed',
  participants:i===79?['Islam Makhachev','José Aldo']:['Other Fighter','Another Fighter'],
  images:i===79?['https://images.test/broken.jpg','https://images.test/poster.svg']:[]
 }))
};
fixture.fighters={
 'f1':{id:'f1',name:'Islam Makhachev',images:['https://images.test/poster.svg'],sources:['https://www.ufc.com/athlete/islam-makhachev'],weightClass:'Lightweight',heightCm:178,birthplace:'Dagestan, Russia'},
 'f2':{id:'f2',name:'José Aldo',images:[],sources:[],weightClass:'Lightweight'},
 'f3':{id:'f3',name:'Other Fighter',images:[],sources:[]},
 'f4':{id:'f4',name:'Another Fighter',images:[],sources:[]}
};
for(const i of [79,80]){
 fixture.events[i].fights=[{id:'bout-'+i,fighters:['f1','f2'],section:'main',weightClass:'Lightweight'}, {id:'prelim-'+i,fighters:['f3','f4'],section:'prelims',weightClass:'Welterweight'}];
 fixture.events[i].venue='Test Arena';
 fixture.events[i].startTime='2026-03-'+(i===79?'24':'25')+'T23:00:00Z';
 fixture.events[i].sectionTimes={main:fixture.events[i].startTime};
}
fixture.events[79].fights[0].result={outcome:'win',winner:'f1',method:'UNIQUE_RESULT_METHOD',round:'2',time:'3:04'};
process.env.TZ='Europe/Moscow';
assert.equal(helpers.localTime('2026-11-14T23:00:00Z'),'15.11.2026 · 02:00 МСК');
assert.equal(helpers.localTime('2026-11-14'),'Время не объявлено');
const corrupt=JSON.parse(JSON.stringify(fixture));corrupt.events[79].fights[0].fighters[0]='absent';
assert.equal(helpers.valid(corrupt),false);
assert.ok(helpers.valid(fixture));
assert.equal(helpers.valid({...fixture,events:[null]}),false);
const migrated=helpers.scopeCatalog({...fixture,events:[...fixture.events,{...fixture.events[0],id:'old',date:'2009-12-31'},{...fixture.events[0],id:'boundary',date:'2010-01-01'}]});
assert.ok(!migrated.events.some(e=>e.id==='old'));
assert.ok(migrated.events.some(e=>e.id==='boundary'));
assert.equal(migrated.startYear,2010);
assert.ok(helpers.matches(fixture.events[79],'махачёв',{}));
assert.ok(helpers.matches(fixture.events[79],'Jose',{}));
assert.ok(!helpers.matches(fixture.events[0],'10',{}));
assert.ok(!helpers.matches(fixture.events[79],'',{from:2027}));
assert.ok(!helpers.valid({...fixture,events:[fixture.events[0],fixture.events[0]]}));

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1280,height:720},timezoneId:'Europe/Moscow'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://images.test/**',route=>route.request().url().includes('broken')?route.fulfill({status:404,body:''}):route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#345678"/></svg>'}));
 await page.setContent('<div class="menu"><ul class="menu__list"></ul></div><main></main>');
 await page.addScriptTag({path:require.resolve('jquery/dist/jquery.js')});
 await page.evaluate(data=>{
  window.fixture=data;window.appready=true;window.controllerName='content';window.focusCalls=0;window.stored={};window.pending=[];
  window.Lampa={
   Component:{add:(name,ctor)=>{window.Catalog=ctor;}},
   Activity:{push:data=>{window.pushed=data;window.catalog.stop();},backward:()=>{window.wentBack=true;}},
   Storage:{get:(key,def)=>window.stored[key]??def,set:(key,value)=>{if(window.quotaFail)throw new Error('quota');window.stored[key]=value;}},
   Input:{edit:(options,callback)=>{window.inputOptions=options;window.inputCallback=callback;window.controllerName='keyboard';}},
   Select:{show:options=>{window.selection=options;window.controllerName='select';}},
   Modal:{open:options=>{window.modalOptions=options;window.modalNode=$('<div class="modal"></div>').append(options.html).appendTo('body');window.controllerName='modal';},close:()=>{if(window.modalNode)window.modalNode.remove();window.controllerName='content';}},
   Controller:{add:(name,c)=>{window.controller=c;},enabled:()=>({name:window.controllerName}),
    toggle:name=>{window.controllerName=name;if(name==='content')window.controller.toggle();},collectionSet:()=>{},
    collectionFocus:node=>{if(!node)throw new Error('Empty focus target');window.focusCalls++;$('.focus').removeClass('focus');$(node).addClass('focus').trigger('hover:focus');}},
   Noty:{show:message=>{window.notice=message;}},
   Scroll:function(){const wrap=$('<div class="scroll"><div class="scroll__content"><div class="scroll__body"></div></div></div>');const body=wrap.find('.scroll__body');this.render=()=>wrap;this.body=()=>body;this.append=e=>body.append(e);this.update=e=>{window.lastScrolled=$(e).attr('data-key');};this.destroy=()=>wrap.remove();},
   Reguest:function(){this.timeout=()=>{};this.clear=()=>{};this.native=(url,ok,fail)=>{window.lastURL=url;const run=()=>window.failRequest?fail():ok(window.fixture);if(window.holdRequest)window.pending.push(run);else setTimeout(run,5);};}
  };
  window.enter=key=>{const el=$('[data-key="'+key+'"]');Lampa.Controller.collectionFocus(el[0]);el.trigger('hover:enter');};
  window.pick=value=>{const s=window.selection;s.onSelect(s.items.find(x=>x.action===value||x.field===value||x.value===value));};
 },fixture);
 // Delayed host startup, then repeated script load must install only once.
 await page.evaluate(()=>{window.savedLampa=window.Lampa;delete window.Lampa;setTimeout(()=>window.Lampa=window.savedLampa,30);});
 await page.addScriptTag({content:source});
 await page.waitForFunction(()=>window.Catalog);
 await page.addScriptTag({content:source});
 assert.equal(await page.locator('.menu__item').count(),1);
 await page.evaluate(()=>{window.activity={};window.catalog=new Catalog(activity);$('main').append(catalog.create());catalog.start();});
 await page.waitForFunction(()=>$('.events-status').text().includes('Обновлено'));
 assert.deepEqual(await page.locator('h2').allTextContents(),['Следующие турниры','Мои бойцы','Недавние турниры','Знаковые турниры']);
 assert.equal(await page.locator('[data-group="recent"] .events-card').count(),12);
 assert.equal(await page.locator('[data-group="soon"] .events-card').count(),4);
 assert.equal(await page.locator('[data-group="toolbar"]').innerText().then(t=>t.includes('Год:')),false);
 assert.match(await page.locator('[data-group="best"] .events-note').first().innerText(),/Авторская/);
 await page.waitForSelector('.events-poster.has-artwork');
 assert.equal(await page.locator('.has-artwork img').first().getAttribute('src'),'https://images.test/poster.svg');
 // Designed covers render even without any original artwork.
 assert.equal(await page.locator('[data-key="recent:event-78"] .events-cover strong').innerText(),fixture.events[78].title);
 // Navigation: toolbar -> rail, horizontal scroll, next rail, restore saved column.
 await page.evaluate(()=>{Lampa.Controller.collectionFocus($('[data-key="recent:event-79"]')[0]);for(let i=0;i<8;i++)controller.right();window.railKey=activity.events_state.key;controller.down();controller.up();});
 assert.equal(await page.evaluate(()=>activity.events_state.key),await page.evaluate(()=>window.railKey));
 assert.ok(await page.evaluate(()=>document.querySelector('[data-group="recent"]').scrollLeft>0));
 // Favorites persist and create a new shelf.
 await page.evaluate(()=>{enter('recent:event-79');enter('watch');controller.back();});
 await page.waitForSelector('[data-group="saved"] .events-card');
 assert.deepEqual(await page.evaluate(()=>stored.events_watchlist_v1),['event-79']);
 // Actual detail navigation, scoped spoiler controls and persistent followed fighters.
 await page.evaluate(()=>enter('hero:event-80'));
 assert.equal(await page.locator('[data-key="record"]').count(),0);
 assert.equal(await page.locator('.events-fight').count(),1);
 assert.match(await page.locator('.events-hero-meta').first().innerText(),/26\.03\.2026.*02:00 МСК/);
 await page.evaluate(()=>enter('section:prelims'));
 assert.match(await page.locator('.events-hint').allTextContents().then(a=>a.join(' ')),/Время этой части карда не объявлено/);
 await page.evaluate(()=>{enter('section:main');enter('fight:bout-80:0');enter('follow');});
 assert.deepEqual(await page.evaluate(()=>stored.events_fighters_v1),['f1']);
 assert.equal(await page.locator('.events-profile h1').innerText(),'Islam Makhachev');
 assert.equal(await page.locator('main').innerText().then(t=>t.includes('UNIQUE_RESULT_METHOD')),false);
 await page.evaluate(()=>enter('history:bout-79'));
 assert.equal(await page.locator('.events-result').count(),0);
 await page.evaluate(()=>enter('results'));
 assert.match(await page.locator('.events-result').innerText(),/UNIQUE_RESULT_METHOD/);
 await page.evaluate(()=>{enter('results');controller.back();});
 assert.equal(await page.locator('.events-profile').count(),1);
 assert.equal(await page.evaluate(()=>activity.events_state.key),'history:bout-79');
 await page.evaluate(()=>controller.back());
 assert.equal(await page.evaluate(()=>activity.events_state.key),'fight:bout-80:0');
 await page.evaluate(()=>controller.back());
 assert.equal(await page.evaluate(()=>activity.events_state.key),'hero:event-80');
 assert.equal(await page.locator('[data-key="followed:f1"]').count(),1);
 // Global opt-in is explicit and can be reverted; individual hidden results stay absent from DOM.
 await page.evaluate(()=>{enter('settings');pick(true);});
 assert.equal(await page.evaluate(()=>stored.events_results_visible_v1),true);
 await page.evaluate(()=>{enter('recent:event-79');});
 assert.match(await page.locator('.events-result').innerText(),/UNIQUE_RESULT_METHOD/);
 await page.evaluate(()=>{enter('settings');pick(false);});
 assert.equal(await page.locator('main').innerText().then(t=>t.includes('UNIQUE_RESULT_METHOD')),false);
 await page.evaluate(()=>controller.back());
 // Whole archive, pagination and combined filters.
 await page.evaluate(()=>enter('all'));
 assert.equal(await page.locator('.events-card').count(),40);
 await page.evaluate(()=>enter('more'));
 assert.equal(await page.locator('.events-card').count(),80);
 await page.evaluate(()=>enter('more'));
 assert.equal(await page.locator('.events-card').count(),85);
 await page.evaluate(()=>{enter('filters');$('[data-field="series"][data-value="numbered"]').trigger('hover:enter');modalOptions.buttons[0].onSelect();});
 assert.equal(await page.locator('.events-card').count(),40);
 assert.match(await page.locator('.events-results').innerText(),/Найдено: 42/);
 // Draft filter edits are discarded on Cancel, and all choices share one panel.
 await page.evaluate(()=>{enter('filters');$('[data-field="series"][data-value="fight-night"]').trigger('hover:enter');modalOptions.buttons[2].onSelect();});
 assert.match(await page.locator('.events-results').innerText(),/Найдено: 42/);
 await page.evaluate(()=>{enter('filters');modalOptions.buttons[1].onSelect();modalOptions.buttons[0].onSelect();enter('years');});
 assert.equal(await page.locator('.events-years .is-active').innerText(),'2026');
 assert.match(await page.locator('.events-results').innerText(),/2026 год/);
 assert.equal(await page.locator('.events-card').count(),40);
 await page.evaluate(()=>{enter('filters');});
 assert.equal(await page.locator('.modal [data-field="year"]').count(),0);
 assert.equal(await page.locator('.modal [data-field="month"]').count(),0);
 await page.evaluate(()=>{modalOptions.buttons[2].onSelect();enter('search');inputCallback('махачев');});
 await page.waitForFunction(()=>activity.events_state.term==='махачев');
 assert.equal(await page.locator('.events-card').count(),1);
 assert.equal(await page.locator('.events-title').innerText(),fixture.events[79].title);
 await page.evaluate(()=>{enter('catalog:event-79');enter('record');pick('title');});
 assert.equal(await page.evaluate(()=>pushed.search),'EVENT 179');
 assert.equal(await page.evaluate(()=>pushed.from_search),true);
 await page.evaluate(()=>catalog.start());
 assert.equal(await page.evaluate(()=>activity.events_state.key),'record');
 await page.evaluate(()=>controller.back());
 assert.equal(await page.evaluate(()=>activity.events_state.key),'catalog:event-79');
 await page.evaluate(()=>{enter('search');inputCallback('произвольный запрос');});
 await page.waitForFunction(()=>activity.events_state.term==='произвольный запрос');
 await page.evaluate(()=>enter('direct'));
 assert.equal(await page.evaluate(()=>pushed.search),'произвольный запрос');
 assert.equal(await page.evaluate(()=>pushed.component),'torrents');
 await page.evaluate(()=>catalog.start());
 assert.equal(await page.locator('.events-card').count(),0);
 // Delayed refresh cannot steal modal focus or rebuild underneath it.
 await page.evaluate(()=>{window.holdRequest=true;enter('refresh');enter('search');window.beforeFocus=focusCalls;window.pending.shift()();});
 assert.equal(await page.evaluate(()=>focusCalls),await page.evaluate(()=>beforeFocus));
 assert.equal(await page.evaluate(()=>controllerName),'keyboard');
 await page.evaluate(()=>{inputCallback('');window.holdRequest=false;window.failRequest=true;});
 await page.waitForFunction(()=>activity.events_state.term==='');
 await page.evaluate(()=>enter('refresh'));
 await page.waitForFunction(()=>$('.events-status').text().includes('сохранённый'));
 assert.ok(await page.locator('.events-card').count()>0);
 // Corrupt response also preserves last good catalog.
 await page.evaluate(()=>{window.failRequest=false;window.fixture={bad:true};enter('refresh');});
 await page.waitForFunction(()=>$('.events-status').text().includes('сохранённый'));
 await page.evaluate(data=>{window.fixture=data;enter('home');},fixture);
 // Realistic TV typography and layout; wide shelves must not overflow the page.
 await page.addStyleTag({content:'html,body{margin:0;background:#10141d;color:#fff;font-family:Arial}.menu{display:none}main{height:calc(100vh - 90px);margin-top:90px}.scroll{overflow:hidden}.scroll__content{width:100%}'});
 fs.mkdirSync('test-results',{recursive:true});
 for(const [width,height,font] of [[1280,720,16],[1920,1080,24],[3840,2160,48]]){
  await page.setViewportSize({width,height});await page.evaluate(font=>{document.body.style.fontSize=font+'px';},font);
  const geometry=await page.evaluate(()=>{const root=document.querySelector('.events-catalog').getBoundingClientRect(),p=document.querySelector('.events-poster').getBoundingClientRect();return {ratio:p.height/p.width,overflow:document.documentElement.scrollWidth>innerWidth,margin:document.querySelector('.events-toolbar').getBoundingClientRect().left-root.left};});
  assert.ok(Math.abs(geometry.ratio-.58)<.02);assert.equal(geometry.overflow,false);assert.ok(geometry.margin>=font);
  await page.screenshot({path:'test-results/home-'+width+'.png'});
  await page.evaluate(()=>enter('recent:event-79'));
  await page.screenshot({path:'test-results/event-'+width+'.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>enter('fight:bout-79:0'));
  await page.screenshot({path:'test-results/fighter-'+width+'.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>enter('home'));
 }
 // Legacy lazy-load fallback and persistent cache survive reopening with no network.
 await page.evaluate(()=>{catalog.destroy();window.IntersectionObserver=undefined;window.failRequest=true;window.catalog=new Catalog({});$('main').append(catalog.create());catalog.start();});
 await page.waitForFunction(()=>$('.events-status').text().includes('сохранённый'));
 assert.ok(await page.locator('.events-card').count()>0);
 assert.equal(await page.locator('[data-key="followed:f1"]').count(),1);
 await page.evaluate(()=>catalog.destroy());
 assert.equal(await page.locator('.events-catalog').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: archive, search, filters, favorites, artwork fallback, focus, pagination, cache, legacy mode, 720p/1080p/4K.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
