/* Events for Lampa, v0.1.3. */
(function () {
    'use strict';
    if (window.events_catalog_loaded || window.events_catalog_loading) return;
    window.events_catalog_loading = true;
    var L = window.Lampa;
    var $ = window.jQuery || window.$;
    var cache = {};

    function normalize(events) {
        var seen = Object.create(null);
        return (events || []).filter(function (e) {
            if (!e || String(e.idLeague) !== '4443' || typeof e.strEvent !== 'string' || !e.strEvent.trim() || !e.idEvent ||
                !/^\d{4}-\d{2}-\d{2}$/.test(e.dateEvent || '') || seen[e.idEvent]) return false;
            seen[e.idEvent] = true;
            return true;
        }).map(function (e) {
            return {id: String(e.idEvent), title: e.strEvent.trim(), date: e.dateEvent,
                poster: /^https:\/\//.test(e.strPoster || e.strThumb || '') ? (e.strPoster || e.strThumb) : ''};
        }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    }

    function query(event) {
        var numbered = event.title.match(/^(\S+)\s+(\d+)\b/);
        return numbered ? numbered[1] + ' ' + numbered[2] : event.title.replace(/\s+/g, ' ').trim();
    }

    function search(event, text) {
        L.Activity.push({url: '', title: event.title, component: 'torrents',
            search: text, search_one: text, search_two: text, from_search: true, page: 1,
            movie: {title: event.title, original_title: event.title, release_date: event.date}});
    }

    function Catalog(object) {
        var self = this;
        var year = Number(object.events_year) || new Date().getFullYear();
        var root = $('<div class="events-catalog"></div>');
        var scroll = new L.Scroll({mask: true, over: true});
        var net = new L.Reguest();
        var last = null;
        var dead = false;
        var started = false;
        var ticket = 0;
        var active = false;
        root.append(scroll.render());

        function button(text, handler, target) {
            var el = $('<div class="selector events-button"></div>').text(text);
            el.on('hover:focus', function () { last = el[0]; scroll.update(el, true); });
            el.on('hover:enter', handler);
            target.append(el);
            return el;
        }
        function focus() {
            if (dead || !active) return;
            if (L.Controller.enabled && L.Controller.enabled().name !== 'content') return;
            L.Controller.collectionSet(root);
            L.Controller.collectionFocus(last || root.find('.selector')[0], root);
        }
        function chooseYear() {
            var items = [];
            for (var y = new Date().getFullYear(); y >= 1993; y--) items.push({title: String(y), year: y});
            L.Select.show({title: 'Год событий', items: items,
                onSelect: function (item) { year = item.year; object.events_year = year; load(); self.start(); },
                onBack: function () { self.start(); }});
        }
        function header(message) {
            last = null;
            scroll.body().empty();
            var bar = $('<div class="events-toolbar"></div>');
            button('Год: ' + year, chooseYear, bar);
            button('Обновить', function () { delete cache[year]; load(); }, bar);
            scroll.append(bar);
            scroll.append($('<div class="events-status"></div>').text(message));
        }
        function select(event) {
            var options = [{title: 'Найти раздачи — ' + query(event), query: query(event)},
                {title: 'Поиск по дате — ' + event.date, query: event.title.split(/\s+/)[0] + ' ' + event.date.replace(/-/g, '.')}];
            L.Select.show({title: event.title + ' · ' + event.date, items: options,
                onSelect: function (item) { search(event, item.query); },
                onBack: function () { self.start(); }});
        }
        function display(events) {
            if (dead) return;
            header(events.length ? 'Выберите турнир. Наличие записи проверяется при поиске.' : 'За этот год турниры не найдены. Выберите другой год.');
            var grid = $('<div class="events-grid"></div>');
            var today = new Date().toISOString().slice(0, 10);
            events.forEach(function (event) {
                var card = button('', function () { select(event); }, grid).addClass('events-card');
                var poster = $('<div class="events-poster"><span>EVENTS</span></div>');
                if (event.poster) {
                    var img = $('<img alt="">').attr('src', event.poster);
                    img.on('error', function () { $(this).remove(); });
                    poster.append(img);
                }
                card.append(poster);
                card.append($('<div class="events-title"></div>').text(event.title));
                card.append($('<div class="events-date"></div>').text(event.date + (event.date > today ? ' · Предстоящий' : '')));
            });
            scroll.append(grid);
            focus();
        }
        function load() {
            var id = ++ticket;
            net.clear();
            if (cache[year] && Date.now() - cache[year].time < 900000) return display(cache[year].events);
            header('Загрузка турниров…');
            focus();
            net.timeout(15000);
            net.native('https://www.thesportsdb.com/api/v1/json/123/eventsseason.php?id=4443&s=' + year,
                function (data) {
                    if (dead || id !== ticket) return;
                    if (!data || !Object.prototype.hasOwnProperty.call(data, 'events') ||
                        (data.events !== null && !Array.isArray(data.events))) return failed();
                    var events = normalize(data.events);
                    cache[year] = {time: Date.now(), events: events};
                    display(events);
                }, failed);
            function failed() {
                if (dead || id !== ticket) return;
                header('Не удалось загрузить каталог TheSportsDB. Нажмите «Обновить» или попробуйте позже.');
                focus();
            }
        }
        function move(direction) {
            var nodes = root.find('.selector');
            var i = Math.max(0, nodes.index(last));
            var next = i;
            if (direction === 'left') {
                if (i === 0 || (i >= 2 && (i - 2) % 5 === 0)) return L.Controller.toggle('menu');
                next--;
            }
            if (direction === 'right') next++;
            if (direction === 'up') {
                if (i < 2) return L.Controller.toggle('head');
                next = i < 7 ? 0 : i - 5;
            }
            if (direction === 'down') next = i < 2 ? 2 : Math.min(i + 5, nodes.length - 1);
            if (next >= 0 && next < nodes.length) L.Controller.collectionFocus(nodes[next], root);
        }
        this.create = function () { return root; };
        this.render = function () { return root; };
        this.start = function () {
            active = true;
            L.Controller.add('content', {toggle: focus, update: function () {},
                left: function () { move('left'); }, right: function () { move('right'); },
                up: function () { move('up'); }, down: function () { move('down'); },
                back: function () { L.Activity.backward(); }});
            L.Controller.toggle('content');
            if (!started) { started = true; load(); }
        };
        this.pause = this.stop = function () { active = false; };
        this.destroy = function () { dead = true; net.clear(); scroll.destroy(); root.remove(); };
    }

    function install() {
        if (!L || !$ || window.events_catalog_loaded) return;
        window.events_catalog_loaded = true;
        window.events_catalog_loading = false;
        window.Lampa.Component.add('events_catalog', Catalog);
        $('<style>').text('.events-catalog{height:100%}.events-toolbar{display:flex;gap:1em;margin-bottom:1em}.events-button{padding:.7em;border-radius:.4em;background:rgba(255,255,255,.08)}.events-button.focus{outline:.18em solid #fff;background:#a71920}.events-status{opacity:.7;margin-bottom:1.2em}.events-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1.2em;padding:.3em .3em 3em}.events-card{padding:.5em}.events-poster{position:relative;aspect-ratio:2/3;height:16em;background:#252525;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:.3em}.events-poster span{font-size:2em;font-weight:bold;color:#d8212a}.events-poster img{position:absolute;width:100%;height:100%;object-fit:cover}.events-title{margin-top:.6em;font-size:.9em;line-height:1.3}.events-date{opacity:.65;font-size:.75em;margin-top:.4em}').appendTo('head');
        var menu = $('<li class="menu__item selector"><div class="menu__ico"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v16H3z"/><text x="4" y="15" font-size="8" fill="#111">EV</text></svg></div><div class="menu__text">События</div></li>');
        menu.on('hover:enter', function () { L.Activity.push({url: '', title: 'События', component: 'events_catalog', page: 1}); });
        $('.menu .menu__list').first().append(menu);
    }
    var attempts = 0;
    function ready() {
        L = window.Lampa;
        $ = window.jQuery || window.$;
        if (L && $ && window.appready && $('.menu .menu__list').length) install();
        else if (++attempts < 120) setTimeout(ready, 500);
        else window.events_catalog_loading = false;
    }
    ready();
}());
