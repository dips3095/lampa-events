// Screenshots of the real plugin using a minimal Lampa host and a built catalog.
// No generated posters or sample fighters. Run after scripts/enrich.py.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, '_site/data/catalog.json'), 'utf8'));
const upcoming = data.events.filter(e => e.status === 'upcoming' && e.fights?.length).sort((a,b) => a.date.localeCompare(b.date))[0];
if (!upcoming) throw new Error('Build a real catalog with an upcoming fight card first');
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH, headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1920,height:1080},timezoneId:'Europe/Moscow'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<main></main><div class="menu"><ul class="menu__list"></ul></div>');
  await page.addStyleTag({content:'html,body{margin:0;background:#111216;color:#fff;font:24px Arial}main{height:100vh}.menu{display:none}.scroll{overflow-y:auto;scrollbar-width:none}.scroll__content{width:100%}'});
  await page.addScriptTag({path:require.resolve('jquery/dist/jquery.js')});
  await page.evaluate(data=>{
   window.appready=true;window.stored={};window.controllerName='content';
   window.Lampa={
    Component:{add:(name,ctor)=>window.Catalog=ctor},
    Storage:{get:(k,d)=>stored[k]??d,set:(k,v)=>stored[k]=v},
    Activity:{push:()=>{},backward:()=>{}},Noty:{show:()=>{}},
    Controller:{add:(n,c)=>window.controller=c,enabled:()=>({name:controllerName}),toggle:n=>{controllerName=n;if(n==='content')controller.toggle();},collectionSet:()=>{},collectionFocus:n=>{if(!n)return;$('.focus').removeClass('focus');$(n).addClass('focus').trigger('hover:focus');}},
    Scroll:function(){const el=$('<div class="scroll"><div class="scroll__content"><div class="scroll__body"></div></div></div>');this.render=()=>el;this.body=()=>el.find('.scroll__body');this.append=n=>this.body().append(n);this.update=node=>{const n=$(node)[0];if(n)n.scrollIntoView({block:'nearest',inline:'nearest'});};this.destroy=()=>el.remove();},
    Reguest:function(){this.clear=()=>{};this.timeout=()=>{};this.native=(u,ok)=>setTimeout(()=>ok(data),0);}
   };
   window.enter=key=>{const el=$('[data-key="'+key+'"]');Lampa.Controller.collectionFocus(el[0]);el.trigger('hover:enter');};
  }, data);
  await page.addScriptTag({path:path.join(root,'events.js')});
  await page.evaluate(()=>{window.catalog=new Catalog({});$('main').append(catalog.create());catalog.start();});
  await page.waitForSelector('.events-hero');
  const output=path.join(root,'test-results','real');fs.mkdirSync(output,{recursive:true});
  async function shot(name){
   await page.waitForFunction(()=>Array.from(document.images).every(i=>i.complete),null,{timeout:25000}).catch(()=>{});
   const loaded=await page.locator('img').evaluateAll(images=>images.filter(i=>i.naturalWidth>0).length);
   if(!loaded)throw new Error('No original source images loaded on '+name);
   await page.screenshot({path:path.join(output,name+'.png')});
   console.log(name+': loaded '+loaded+' original images');
  }
  await shot('home');
  await page.evaluate(id=>enter('hero:'+id),upcoming.id);
  await shot('event');
  const main=upcoming.fights[0];
  await page.evaluate(id=>enter('fight:'+id+':0'),main.id);
  await shot('fighter');
  await page.evaluate(()=>{enter('follow');enter('home');});
  await page.evaluate(()=>document.querySelector('[data-group="followed"]').scrollIntoView({block:'center'}));
  await shot('followed');
  if(errors.length)throw new Error(errors.join('\n'));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
