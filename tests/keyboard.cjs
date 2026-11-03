// Integration regression: real upstream settings input + both real keyboard modes.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures/lampa',name),'utf8');
const sources={input:fixture('input.js'),keyboard:fixture('keyboard.js'),subscribe:fixture('subscribe.js'),layers:fixture('layers.js'),template:fixture('template.js')};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
 try{
 for(const mode of ['simple','lampa']){
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<div class="menu"><ul class="menu__list"></ul></div><main></main>');
  await page.addScriptTag({path:require.resolve('jquery/dist/jquery.js')});
  await page.addScriptTag({path:path.join(__dirname,'fixtures/lampa/simple-keyboard.js')});
  await page.addStyleTag({path:path.join(__dirname,'fixtures/lampa/style.css')});
  await page.addStyleTag({content:'body{font:20px Arial;background:#111;color:white}.settings-input{position:fixed;inset:0;background:#222;padding:3em}.simple-keyboard{position:relative;max-width:1000px;margin:auto}.simple-keyboard-input{display:block;width:85%;font-size:25px;padding:15px}.simple-keyboard-buttons{display:flex;gap:2em}.focus{outline:3px solid white}'});
  await page.evaluate(({sources,mode})=>{
   window.mode=mode;window.appready=true;window.stored={};window.controllers={};window.controllerName='content';window.keypadEnabled=true;window.focused=null;window.collection=[];
   const module=(src,names,values)=>new Function(...names,src.replace(/^import .*$/gm,'').replace('export default','return'))(...values);
   const Subscribe=module(sources.subscribe,[],[]);
   const Layers=module(sources.layers,[],[]);
   const template=module(sources.template,[],[]);
   const focus=node=>{if(!node)return;$('.focus').removeClass('focus');$(node).addClass('focus');window.focused=node;$(node).trigger('hover:focus');};
   const next=direction=>{
    if(!focused)return collection[0];const r=focused.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    return collection.filter(e=>e!==focused&&e.offsetWidth).map(e=>{const n=e.getBoundingClientRect(),dx=n.left+n.width/2-x,dy=n.top+n.height/2-y;return {e,dx,dy,score:Math.hypot(dx,dy)};}).filter(n=>direction==='right'?n.dx>5&&Math.abs(n.dy)<30:direction==='left'?n.dx< -5&&Math.abs(n.dy)<30:direction==='down'?n.dy>5:n.dy< -5).sort((a,b)=>a.score-b.score)[0]?.e;
   };
   window.Navigator={canmove:d=>!!next(d),move:d=>focus(next(d))};
   const Controller={add:(n,c)=>controllers[n]=c,enabled:()=>({name:controllerName}),toggle:n=>{controllerName=n;controllers[n]?.toggle?.();},back:()=>controllers[controllerName]?.back?.(),collectionSet:root=>{collection=$(root).find('.selector').toArray();$('.focus').removeClass('focus');focused=null;},collectionFocus:(node,root)=>focus($(node)[0]||$(root).find('.selector')[0]),windowTop:()=>false};
   const Storage={field:k=>k==='keyboard_type'?mode:false,get:(k,d)=>k==='language'?'en':stored[k]??d,set:(k,v)=>stored[k]=v};
   const Platform={is:n=>n==='webos',screen:n=>n==='tv',desktop:()=>false,mouse:()=>mode==='simple'};
   const Keypad={enable:()=>keypadEnabled=true,disable:()=>keypadEnabled=false};
   const Lang={translate:k=>({ready:'Готово',cancel:'Отмена',search_input:'Поиск'}[k]||k)};
   const Utils={uid:()=>String(Date.now()),isTouchDevice:()=>false,inputDisplay:v=>String(v).replace(/</g,'&lt;')};
   const Arrays={getKeys:Object.keys,clone:v=>JSON.parse(JSON.stringify(v))};
   const Select={show:o=>{window.selection=o;}};
   const Noty={show:()=>{}};
   const Keyboard=module(sources.keyboard,['Controller','Subscribe','Noty','Platform','Android','Storage','Keypad','Lang','Layers','Arrays','Select','Utils'],[Controller,Subscribe,Noty,Platform,{},Storage,Keypad,Lang,Layers,Arrays,Select,Utils]);
   const Input=module(sources.input,['Template','Keybord','Controller','Select','Storage','Arrays','Noty','Lang','Utils'],[{get:()=>$(template)},Keyboard,Controller,Select,Storage,Arrays,Noty,Lang,Utils]);
   window.Lampa={Controller,Storage,Input,Select,Noty,Component:{add:(n,c)=>window.Catalog=c},Activity:{backward:()=>{},push:v=>window.pushed=v},
    Scroll:function(){const el=$('<div class="scroll"><div class="scroll__body"></div></div>');this.render=()=>el;this.body=()=>el.find('.scroll__body');this.append=e=>this.body().append(e);this.update=()=>{};this.destroy=()=>el.remove();},
    Reguest:function(){this.clear=()=>{};this.timeout=()=>{};this.native=(url,ok)=>setTimeout(()=>ok({schemaVersion:1,updatedAt:'2026-11-04T00:00:00Z',featured:[],events:[{id:'one',title:'Event 1',date:'2026-01-01',series:'numbered',status:'completed',participants:['A','B'],images:[]}]}),0);}};
   window.enter=key=>{const el=$('[data-key="'+key+'"]');focus(el[0]);el.trigger('hover:enter');};
   document.addEventListener('keydown',e=>{if(!keypadEnabled)return;const dirs={ArrowDown:'down',ArrowUp:'up',ArrowLeft:'left',ArrowRight:'right'};if(dirs[e.key]){e.preventDefault();controllers[controllerName]?.[dirs[e.key]]?.();}if(e.key==='Enter'){e.preventDefault();$(focused).trigger('hover:enter');}if(e.key==='Escape'){e.preventDefault();Controller.back();}});
  },{sources,mode});
  await page.addScriptTag({path:path.join(__dirname,'../events.js')});
  await page.evaluate(()=>{window.activity={};window.catalog=new Catalog(activity);$('main').append(catalog.create());catalog.start();});
  await page.waitForFunction(()=>document.querySelector('.events-card'));
  await page.evaluate(()=>enter('search'));
  assert.equal(await page.locator('.simple-keyboard-buttons .selector').count(),2);
  if(mode==='simple'){
   await page.locator('.simple-keyboard-input').fill('свободный запрос');
   await page.waitForTimeout(1100); // Native keyboard deliberately ignores blur keys for its first second.
   await page.locator('.simple-keyboard-input').press('ArrowDown');
  }else{
   await page.locator('[data-skbtn="a"]').evaluate(e=>$(e).trigger('hover:enter'));
   await page.evaluate(()=>{Lampa.Controller.collectionFocus($('.simple-keyboard-buttons__enter')[0],$('.simple-keyboard'));});
  }
  assert.ok(await page.locator('.simple-keyboard-buttons__enter').evaluate(e=>e.classList.contains('focus')));
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.settings-input'));
  await page.waitForFunction(()=>activity.events_state.term);
  const saved=await page.evaluate(()=>activity.events_state.term);
  assert.equal(saved,mode==='simple'?'свободный запрос':'a');
  await page.evaluate(()=>enter('direct'));
  assert.equal(await page.evaluate(()=>pushed.search),saved);
  // Cancel must be reachable by D-pad and preserve the old query.
  await page.evaluate(()=>{catalog.start();enter('search');});
  if(mode==='simple')await page.locator('.simple-keyboard-input').fill('отменённый запрос');
  await page.evaluate(()=>{document.activeElement.blur();Lampa.Controller.collectionSet($('.simple-keyboard'));Lampa.Controller.collectionFocus($('.simple-keyboard-buttons__enter')[0],$('.simple-keyboard'));});
  await page.keyboard.press('ArrowRight');
  assert.ok(await page.locator('.simple-keyboard-buttons__cancel').evaluate(e=>e.classList.contains('focus')));
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.settings-input'));
  assert.equal(await page.evaluate(()=>activity.events_state.term),saved);
  assert.equal(await page.evaluate(()=>keypadEnabled),true);
  // Physical Back also discards edits.
  await page.evaluate(()=>{enter('search');document.activeElement.blur();});
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('.settings-input'));
  assert.equal(await page.evaluate(()=>activity.events_state.term),saved);
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('PASS real Lampa keyboards: D-pad Done/Cancel, Enter, physical Back, free query, focus and keypad restoration.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
