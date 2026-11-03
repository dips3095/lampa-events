/* Lampa Events v0.2.0. Stable entry point; catalog updates independently. */
(function () {
    'use strict';
    var DATA_URL = 'https://dips3095.github.io/lampa-events/data/catalog.json';
    var START_YEAR = 2010;
    var letters = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
    var aliases = {'макгрегор':'mcgregor','конор':'conor','хабиб':'khabib','махачев':'makhachev','оливейра':'oliveira','джонс':'jones','джон':'jon','порье':'poirier','холлоуэй':'holloway','холлоуей':'holloway','гейджи':'gaethje','гэтжи':'gaethje','адесанья':'adesanya','волкановски':'volkanovski','прохазка':'prochazka','чимаев':'chimaev','шевченко':'shevchenko','нганну':'ngannou','двалишвили':'dvalishvili','пимблетт':'pimblett','мухаммад':'muhammad','нурмагомедов':'nurmagomedov','юфс':'ufc'};
    var seriesNames = {'numbered':'Номерные','fight-night':'Fight Night','broadcast':'Телевизионные','finale':'Финалы TUF','special':'Специальные'};
    function escapeHtml(value){return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    function normalize(value) {
        var s = String(value || '').toLowerCase().replace(/ё/g,'е');
        s = s.replace(/[а-я]+/g,function(word){return aliases[word] || word.replace(/[а-я]/g,function(c){return letters[c] || c;});});
        if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
        return s.replace(/kh/g,'h').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
    }
    function valid(data) {
        if (!data || data.schemaVersion !== 1 || !Array.isArray(data.events) || !data.events.length || !Array.isArray(data.featured) || typeof data.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(data.updatedAt)) return false;
        var seen = {};
        return data.events.every(function(e){
            if (!e || typeof e.id !== 'string' || seen[e.id] || typeof e.title !== 'string' || !e.title || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !seriesNames[e.series] || ['completed','upcoming','cancelled'].indexOf(e.status)<0 || !Array.isArray(e.participants) || !Array.isArray(e.images)) return false;
            seen[e.id] = true;
            return e.participants.every(function(p){return typeof p === 'string';}) && e.images.every(function(u){return typeof u === 'string' && /^https:\/\//.test(u);});
        });
    }
    function matches(e,term,f) {
        var y = Number(e.date.slice(0,4));
        if (f.from && y<f.from || f.to && y>f.to || f.month && Number(e.date.slice(5,7))!==f.month || f.series && e.series!==f.series || f.status && e.status!==f.status) return false;
        var hay = normalize(e.title+' '+e.date+' '+e.participants.join(' '));
        return normalize(term).split(' ').every(function(t){return !t || (/^\d+$/.test(t) ? (' '+hay+' ').indexOf(' '+t+' ')>=0 : hay.indexOf(t)>=0);});
    }
    function eventQuery(e) {
        var n = e.title.match(/^(\S+)\s+(\d+(?:\.\d+)?)\b/);
        return n ? n[1]+' '+n[2] : e.title.replace(/\s+/g,' ').trim();
    }
    function scopeCatalog(data){
        if(!valid(data))return null;
        var copy={schemaVersion:data.schemaVersion,startYear:START_YEAR,updatedAt:data.updatedAt,featured:data.featured.slice(),events:data.events.filter(function(e){return Number(e.date.slice(0,4))>=START_YEAR;})};
        return valid(copy)?copy:null;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = {normalize:normalize,valid:valid,matches:matches,eventQuery:eventQuery,scopeCatalog:scopeCatalog};
    if (typeof window === 'undefined') return;
    if (window.events_catalog_loaded || window.events_catalog_loading) return;
    window.events_catalog_loading = true;
    var L, $, memory;
    function read(key,fallback){try{return L.Storage.get(key,fallback);}catch(e){return fallback;}}
    function save(key,value){try{L.Storage.set(key,value);return true;}catch(e){return false;}}
    function torrents(event,term){
        L.Activity.push({url:'',title:event?event.title:term,component:'torrents',search:term,search_one:term,search_two:term,from_search:true,page:1,
            movie:{title:event?event.title:term,original_title:event?event.title:term,release_date:event?event.date:''}});
    }
    function Catalog(object) {
        var self=this, state=object.events_state || {view:'home',term:'',filters:{},limit:40,key:''};
        object.events_state=state;
        var root=$('<div class="events-catalog"></div>'),scroll=new L.Scroll({mask:true,over:true}),net=new L.Reguest();
        var catalog=memory || read('events_catalog_v1',null),favorites=read('events_watchlist_v1',[]);
        catalog=scopeCatalog(catalog);
        ['from','to'].forEach(function(key){if(state.filters[key]&&state.filters[key]<START_YEAR)state.filters[key]=START_YEAR;});
        if(!Array.isArray(favorites)) favorites=[];
        var active=false,dead=false,started=false,modal=false,dirty=false,ticket=0,last=null,observer,statusText='',positions={},imageEpoch=0;
        root.append(scroll.render());if(scroll.minus) scroll.minus();
        function canFocus(){return active && !dead && !modal && (!L.Controller.enabled || L.Controller.enabled().name==='content');}
        function focus(){
            if(!canFocus()) return;
            L.Controller.collectionSet(root);
            var target=root.find('.selector').filter(function(){return $(this).attr('data-key')===state.key;})[0];
            var fallback=last || root.find('.selector')[0];
            if(target || fallback) L.Controller.collectionFocus(target || fallback,root);
        }
        function button(label,key,action,parent){
            var el=$('<div class="selector events-button"></div>').text(label).attr('data-key',key);
            el.on('hover:focus',function(){
                last=el[0];state.key=key;
                var group=el.parent();positions[group.attr('data-group')]=group.children('.selector').index(el);
                if(group.hasClass('events-rail')){
                    var left=el[0].offsetLeft-group[0].offsetLeft;
                    group[0].scrollLeft=Math.max(0,left-group.width()/2+el.outerWidth()/2);
                }
                scroll.update(el,true);if(el[0].loadArtwork) el[0].loadArtwork();
            }).on('hover:enter',action);parent.append(el);return el;
        }
        function group(key,rail){return $('<div class="events-nav"></div>').attr('data-group',key).addClass(rail?'events-rail':'events-toolbar');}
        function resume(){modal=false;self.start();}
        function choose(title,items,select){modal=true;items=items.map(function(item){var copy={};Object.keys(item).forEach(function(k){copy[k]=item[k];});copy.title=escapeHtml(item.title);return copy;});L.Select.show({title:escapeHtml(title),items:items,onSelect:function(item){if(dead)return;modal=false;select(item);},onBack:resume});}
        function keyboard(title,value,callback){
            modal=true;L.Input.edit({title:title,value:value,free:true,nosave:true},function(value){if(dead)return;modal=false;callback(String(value||'').trim());resume();});
        }
        function openSearch(){keyboard('Название, номер, дата или участник',state.term,function(term){state.term=term;state.view='search';state.limit=40;state.key='search';draw();});}
        function setView(view){state.view=view;state.limit=40;state.key='';draw();resume();}
        function filterMenu(){
            var f=state.filters;
            choose('Фильтры',[
                {title:'Год от: '+(f.from||'любой'),field:'from'},{title:'Год до: '+(f.to||'любой'),field:'to'},
                {title:'Месяц: '+(f.month||'любой'),field:'month'},{title:'Серия: '+(seriesNames[f.series]||'все'),field:'series'},
                {title:'Статус: '+({completed:'прошедшие',upcoming:'предстоящие',cancelled:'отменённые'}[f.status]||'все'),field:'status'},
                {title:'Сбросить фильтры',field:'reset'}
            ],function(item){
                if(item.field==='reset'){state.filters={};state.limit=40;draw();resume();return;}
                var options=[{title:'Все',value:''}];
                if(item.field==='from'||item.field==='to'){
                    var max=new Date().getFullYear()+1;if(catalog)catalog.events.forEach(function(e){max=Math.max(max,Number(e.date.slice(0,4)));});
                    for(var y=max;y>=START_YEAR;y--)options.push({title:String(y),value:y});
                }else if(item.field==='month'){
                    'Январь Февраль Март Апрель Май Июнь Июль Август Сентябрь Октябрь Ноябрь Декабрь'.split(' ').forEach(function(m,i){options.push({title:m,value:i+1});});
                }else if(item.field==='series')Object.keys(seriesNames).forEach(function(s){options.push({title:seriesNames[s],value:s});});
                else options=[{title:'Все',value:''},{title:'Прошедшие',value:'completed'},{title:'Предстоящие',value:'upcoming'},{title:'Отменённые',value:'cancelled'}];
                choose(item.title,options,function(option){f[item.field]=option.value;if(f.from&&f.to&&f.from>f.to){var t=f.from;f.from=f.to;f.to=t;}state.limit=40;draw();resume();});
            });
        }
        function select(event){
            var saved=favorites.indexOf(event.id)>=0;
            choose(event.title+' · '+event.date,[{title:'Найти раздачи — '+eventQuery(event),action:'title'},
                {title:'Поиск по дате — '+event.date,action:'date'},{title:saved?'Убрать из «Посмотреть позже»':'Посмотреть позже',action:'save'}],function(item){
                if(item.action==='save'){
                    if(saved)favorites=favorites.filter(function(id){return id!==event.id;});else favorites.push(event.id);
                    if(!save('events_watchlist_v1',favorites)&&L.Noty)L.Noty.show('Не удалось сохранить список на устройстве');
                    draw();resume();
                }else{active=false;torrents(event,item.action==='title'?eventQuery(event):event.title.split(/\s+/)[0]+' '+event.date.replace(/-/g,'.'));}
            });
        }
        function artwork(event,box,card){
            var begun=false,index=0,epoch=imageEpoch;
            function next(){
                if(dead||epoch!==imageEpoch||index>=event.images.length)return;
                var url=event.images[index++];if(!/^https:\/\//.test(url)){next();return;}
                var img=$('<img alt="" decoding="async">');
                img.one('load',function(){if(dead||epoch!==imageEpoch){img.remove();return;}box.addClass('has-artwork');})
                    .one('error',function(){img.remove();next();});box.append(img);img.attr('src',url);
            }
            card[0].loadArtwork=function(){if(!begun){begun=true;next();}};
            if(observer)observer.observe(card[0]);else card[0].loadArtwork();
        }
        function card(event,parent,section){
            var el=button('',section+':'+event.id,function(){select(event);},parent).addClass('events-card');
            var cover=$('<div class="events-poster"><div class="events-cover"><span class="events-cover-label">СОБЫТИЯ</span><strong></strong><span class="events-cover-date"></span></div></div>');
            cover.find('strong').text(event.title);cover.find('.events-cover-date').text(event.date);
            var hue=0;for(var i=0;i<event.id.length;i++)hue=(hue*31+event.id.charCodeAt(i))%360;
            cover.css('background','linear-gradient(145deg,hsl('+hue+',38%,26%),#10141d 76%)');
            el.append(cover).append($('<div class="events-title"></div>').text(event.title));
            el.append($('<div class="events-date"></div>').text(event.date+(event.status==='upcoming'?' · Скоро':event.status==='cancelled'?' · Отменён':'')));
            artwork(event,cover,el);
        }
        function section(title,key,events){
            if(!events.length)return;var wrap=$('<section class="events-section"></section>');wrap.append($('<h2></h2>').text(title));
            var rail=group(key,true);wrap.append(rail);scroll.append(wrap);events.forEach(function(e){card(e,rail,key);});
        }
        function draw(){
            if(dead)return;
            if(modal||(active&&L.Controller.enabled&&L.Controller.enabled().name!=='content')){dirty=true;return;}
            dirty=false;imageEpoch++;if(observer)observer.disconnect();observer=null;last=null;scroll.body().empty();
            if(window.IntersectionObserver)observer=new window.IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){observer.unobserve(entry.target);entry.target.loadArtwork();}});},{root:root[0],rootMargin:'250px'});
            var toolbar=group('toolbar',false);
            if(state.view!=='home')button('Главная','home',function(){setView('home');},toolbar);
            button(state.term&&state.view==='search'?'Поиск: '+state.term:'Поиск','search',openSearch,toolbar);
            if(state.view==='home')button('Все турниры','all',function(){setView('all');},toolbar);else button('Фильтры','filters',filterMenu,toolbar);
            button('Обновить','refresh',function(){load(true);},toolbar);scroll.append(toolbar);
            var status=statusText;if(catalog)status+=(status?' · ':'')+'Обновлено '+catalog.updatedAt.slice(0,10);
            scroll.append($('<div class="events-status"></div>').text(status||'Загрузка каталога…'));
            if(state.view==='search'&&state.term){var direct=group('direct',false);button('Искать раздачи по этому запросу','direct',function(){active=false;torrents(null,state.term);},direct);scroll.append(direct);}
            if(!catalog){focus();return;}
            var events=catalog.events.slice().sort(function(a,b){return b.date.localeCompare(a.date)||a.id.localeCompare(b.id);});
            if(state.view==='home'){
                section('Последние турниры','recent',events.filter(function(e){return e.status==='completed';}).slice(0,12));
                section('Скоро','soon',events.filter(function(e){return e.status==='upcoming';}).reverse().slice(0,12));
                section('Лучшие турниры','best',events.filter(function(e){return catalog.featured.indexOf(e.id)>=0;}));
                section('Посмотреть позже','saved',events.filter(function(e){return favorites.indexOf(e.id)>=0;}));
            }else{
                var filtered=events.filter(function(e){return matches(e,state.view==='search'?state.term:'',state.filters);}),f=state.filters;
                var summary='Найдено: '+filtered.length;
                if(f.from||f.to)summary+=' · Годы: '+(f.from||START_YEAR)+'–'+(f.to||'…');if(f.month)summary+=' · Месяц: '+f.month;if(f.series)summary+=' · '+seriesNames[f.series];
                if(f.status)summary+=' · '+({completed:'Прошедшие',upcoming:'Предстоящие',cancelled:'Отменённые'}[f.status]);
                scroll.append($('<div class="events-results"></div>').text(summary));
                if(!filtered.length)scroll.append($('<div class="events-empty"></div>').text('События не найдены. Измените запрос или сбросьте фильтры.'));
                var grid=$('<div class="events-grid"></div>'),row;scroll.append(grid);
                filtered.slice(0,state.limit).forEach(function(e,i){if(i%5===0){row=group('grid-'+Math.floor(i/5),false).removeClass('events-toolbar').addClass('events-grid-row');grid.append(row);}card(e,row,'catalog');});
                if(filtered.length>state.limit){var more=group('more',false);button('Показать ещё','more',function(){var first=filtered[state.limit];state.limit+=40;state.key='catalog:'+first.id;draw();},more);scroll.append(more);}
            }
            focus();
        }
        function load(force){
            var id=++ticket;net.clear();statusText=catalog?'Проверка обновлений…':'Загрузка каталога…';draw();net.timeout(20000);
            net.native(DATA_URL+'?t='+(force?Date.now():Math.floor(Date.now()/300000)),function(data){
                if(dead||id!==ticket)return;data=scopeCatalog(data);if(!data){failure();return;}
                if(catalog&&data.updatedAt<catalog.updatedAt){statusText='Сохранён более свежий каталог';draw();return;}
                catalog=memory=data;statusText=save('events_catalog_v1',data)?'':'Каталог загружен; кеш устройства недоступен';
                if(!active)dirty=true;else draw();
            },failure);
            function failure(){if(dead||id!==ticket)return;statusText=catalog?'Нет обновления — показан сохранённый каталог':'Не удалось загрузить каталог. Нажмите «Обновить».';if(!active)dirty=true;else draw();}
        }
        function move(direction){
            var current=last?$(last):root.find('.selector').first();
            var rows=root.find('.events-nav').filter(function(){return $(this).children('.selector').length>0;});
            var parent=current.parent(),ri=rows.index(parent),col=parent.children('.selector').index(current),nodes=parent.children('.selector'),target;
            if(ri<0){focus();return;}
            if(direction==='left'){if(col===0)return L.Controller.toggle('menu');target=nodes[col-1];}
            if(direction==='right')target=nodes[Math.min(col+1,nodes.length-1)];
            if(direction==='up'||direction==='down'){
                var next=ri+(direction==='up'?-1:1);if(next<0)return L.Controller.toggle('head');if(next>=rows.length)return;
                var row=rows.eq(next),desired=positions[row.attr('data-group')];nodes=row.children('.selector');target=nodes[Math.min(desired===undefined?col:desired,nodes.length-1)];
            }
            if(target)L.Controller.collectionFocus(target,root);
        }
        this.create=this.render=function(){return root;};
        this.start=function(){
            if(dead)return;active=true;
            L.Controller.add('content',{toggle:focus,update:function(){},left:function(){move('left');},right:function(){move('right');},up:function(){move('up');},down:function(){move('down');},back:function(){if(state.view!=='home')setView('home');else L.Activity.backward();}});
            L.Controller.toggle('content');if(!started){started=true;draw();load(false);}else if(dirty)draw();
        };
        this.pause=this.stop=function(){active=false;};
        this.destroy=function(){dead=true;ticket++;imageEpoch++;net.clear();if(observer)observer.disconnect();scroll.destroy();root.remove();};
    }
    function install(){
        window.Lampa.Component.add('events_catalog',Catalog);
        $('<style>').text([
            '.events-catalog{height:100%;width:100%;padding:0 1.5em;box-sizing:border-box;overflow:hidden}',
            '.events-catalog .scroll{height:100%;width:100%}.events-catalog .scroll__content{width:100%;min-width:0}.events-catalog .scroll__body{padding:.5em 0 3em}',
            '.events-toolbar{display:flex;flex-wrap:wrap;gap:.7em;margin:.3em .25em 1em}.events-button{padding:.65em .9em;border-radius:.5em;background:rgba(255,255,255,.09);box-sizing:border-box}',
            '.events-button.focus{outline:.16em solid #fff;background:#334c78}.events-status{opacity:.65;font-size:.8em;margin:.5em .3em 1.4em;line-height:1.5}',
            '.events-section{margin:0 0 1.5em;min-width:0}.events-section h2{font-size:1.2em;font-weight:600;margin:.5em .25em .7em}',
            '.events-rail{position:relative;display:flex;overflow-x:auto;overflow-y:hidden;padding:.3em .25em .7em;scrollbar-width:none}.events-rail::-webkit-scrollbar{display:none}',
            '.events-rail>.events-card{flex:0 0 calc((100% - 4.8em)/5);margin-right:1.2em}.events-rail>.events-card:last-child{margin-right:0}',
            '.events-card{padding:.4em;min-width:0;border-radius:.5em}.events-poster{position:relative;height:0;padding-top:150%;overflow:hidden;border-radius:.3em}',
            '.events-cover{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;justify-content:space-between;padding:1em;box-sizing:border-box;border:1px solid rgba(255,255,255,.12)}',
            '.events-cover-label{font-size:.55em;letter-spacing:.23em;opacity:.6}.events-cover strong{font-size:1.1em;line-height:1.35;overflow-wrap:break-word;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.events-cover-date{font-size:.7em;opacity:.7}',
            '.events-poster img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover}.events-poster:not(.has-artwork) img{opacity:0}',
            '.events-title{font-size:.85em;line-height:1.35;height:2.7em;margin-top:.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:break-word}',
            '.events-date{font-size:.65em;opacity:.65;margin-top:.4em}.events-grid{padding:.3em .25em}.events-grid-row{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1.2em;margin-bottom:1.2em}',
            '.events-results{margin:.6em .3em 1em;opacity:.8}.events-empty{padding:2em .3em;opacity:.7}'
        ].join('')).appendTo('head');
        var menu=$('<li class="menu__item selector"><div class="menu__ico"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v16H3z"/><text x="4" y="15" font-size="8" fill="#111">EV</text></svg></div><div class="menu__text">События</div></li>');
        menu.on('hover:enter',function(){L.Activity.push({url:'',title:'События',component:'events_catalog',page:1});});
        $('.menu .menu__list').first().append(menu);window.events_catalog_loaded=true;window.events_catalog_loading=false;
    }
    var attempts=0;
    function ready(){L=window.Lampa;$=window.jQuery||window.$;if(L&&$&&window.appready&&$('.menu .menu__list').length)install();else if(++attempts<120)setTimeout(ready,500);else window.events_catalog_loading=false;}
    ready();
}());
