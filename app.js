// ─── Config ───
const IPTV_SERVER = 'http://line.tsclean.cc';
const CONFIG = {
    username: 'a4381e5399',
    password: '8cc5c756bd08'
};

// CORS proxy for API calls (needed when hosted on HTTPS like GitHub Pages)
// The IPTV server is HTTP-only, browsers block mixed content from HTTPS pages
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const PROXY = IS_LOCAL ? '' : 'https://corsproxy.io/?url=';

function proxyURL(url) {
    if (IS_LOCAL) return url;
    return PROXY + encodeURIComponent(url);
}

// ─── State ───
let currentTab = 'live';
let navStack = []; // for back navigation
let favorites = JSON.parse(localStorage.getItem('ayange_favs') || '[]');
let searchCache = { live: null, vod: null, series: null };

// Player state
let hls = null;
let playerLinks = [];
let playerLinkIndex = 0;
let channelList = [];
let channelIndex = 0;

// ─── API ───
function apiURL(action, extra = {}) {
    const params = new URLSearchParams({
        username: CONFIG.username,
        password: CONFIG.password,
        action
    });
    Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    return proxyURL(`${IPTV_SERVER}/player_api.php?${params}`);
}

async function api(action, extra = {}) {
    const res = await fetch(apiURL(action, extra));
    return res.json();
}

// Stream URLs — these go direct (not proxied) since the video player handles redirects
// For HTTPS pages, we still need proxy for the initial request
function liveURL(streamID, ext = 'm3u8') {
    return proxyURL(`${IPTV_SERVER}/live/${CONFIG.username}/${CONFIG.password}/${streamID}.${ext}`);
}
function vodURL(streamID, ext) {
    return proxyURL(`${IPTV_SERVER}/movie/${CONFIG.username}/${CONFIG.password}/${streamID}.${ext}`);
}
function seriesURL(episodeID, ext) {
    return proxyURL(`${IPTV_SERVER}/series/${CONFIG.username}/${CONFIG.password}/${episodeID}.${ext}`);
}

function vodLinks(streamID, ext) {
    const primary = ext || 'mp4';
    const links = [{ label: primary.toUpperCase(), url: vodURL(streamID, primary) }];
    for (const alt of ['mp4', 'mkv', 'avi']) {
        if (alt !== primary) links.push({ label: alt.toUpperCase(), url: vodURL(streamID, alt) });
    }
    return links;
}
function seriesLinks(episodeID, ext) {
    const primary = ext || 'mp4';
    const links = [{ label: primary.toUpperCase(), url: seriesURL(episodeID, primary) }];
    for (const alt of ['mp4', 'mkv', 'avi']) {
        if (alt !== primary) links.push({ label: alt.toUpperCase(), url: seriesURL(episodeID, alt) });
    }
    return links;
}

// ─── Navigation ───
function switchTab(tab) {
    currentTab = tab;
    navStack = [];
    document.getElementById('breadcrumb').classList.add('hidden');

    document.querySelectorAll('.nav-item, .mob-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });

    switch (tab) {
        case 'live': loadCategories('get_live_categories', 'live'); break;
        case 'movies': loadCategories('get_vod_categories', 'movie'); break;
        case 'series': loadCategories('get_series_categories', 'series'); break;
        case 'search': showSearch(); break;
        case 'favorites': showFavorites(); break;
    }
}

function pushView(title, renderFn) {
    navStack.push({ title, scrollY: document.getElementById('main').scrollTop });
    const bc = document.getElementById('breadcrumb');
    bc.classList.remove('hidden');
    document.getElementById('breadcrumb-text').textContent = title;
    renderFn();
    document.getElementById('main').scrollTop = 0;
}

function goBack() {
    if (navStack.length === 0) return;
    navStack.pop();
    if (navStack.length === 0) {
        document.getElementById('breadcrumb').classList.add('hidden');
        switchTab(currentTab);
    } else {
        const prev = navStack[navStack.length - 1];
        document.getElementById('breadcrumb-text').textContent = prev.title;
        // Re-trigger current tab's last category view
        switchTab(currentTab);
    }
}

// ─── Rendering helpers ───
const $ = id => document.getElementById(id);
const content = () => $('content');

function showLoading(msg = 'Loading...') {
    content().innerHTML = `<div class="loading"><div class="spinner"></div>${msg}</div>`;
}

function escHTML(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// ─── Categories ───
async function loadCategories(action, type) {
    showLoading('Loading categories...');
    try {
        const cats = await api(action);
        renderCategories(cats, type);
    } catch (e) {
        content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed to load</h3><p>${escHTML(e.message)}</p></div>`;
    }
}

function renderCategories(cats, type) {
    const iconClass = type === 'live' ? 'live' : type === 'movie' ? 'movie' : 'series';
    const icon = type === 'live' ? '📡' : type === 'movie' ? '🎬' : '📺';

    let search = `<div class="search-bar"><input type="text" placeholder="Search categories..." oninput="filterList(this.value, '.category-item', '.cat-name')"></div>`;

    let html = search + '<div class="category-list">';
    for (const cat of cats) {
        html += `<div class="category-item" onclick="openCategory('${escHTML(cat.category_id)}','${escHTML(cat.category_name)}','${type}')">
            <div class="cat-icon ${iconClass}">${icon}</div>
            <span class="cat-name">${escHTML(cat.category_name)}</span>
            <span class="cat-arrow">›</span>
        </div>`;
    }
    html += '</div>';
    content().innerHTML = html;
}

function openCategory(catID, catName, type) {
    pushView(catName, async () => {
        showLoading();
        try {
            if (type === 'live') {
                const channels = await api('get_live_streams', { category_id: catID });
                renderChannels(channels);
            } else if (type === 'movie') {
                const movies = await api('get_vod_streams', { category_id: catID });
                renderMediaGrid(movies, 'movie');
            } else {
                const series = await api('get_series', { category_id: catID });
                renderMediaGrid(series, 'series');
            }
        } catch (e) {
            content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed to load</h3><p>${escHTML(e.message)}</p></div>`;
        }
    });
}

// ─── Channel list ───
function renderChannels(channels) {
    let html = `<div class="search-bar"><input type="text" placeholder="Search channels..." oninput="filterList(this.value, '.channel-item', '.ch-name')"></div>`;
    html += '<div class="channel-list">';
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const isFav = isFavorite('live', ch.stream_id);
        const iconImg = ch.stream_icon
            ? `<img src="${escHTML(ch.stream_icon)}" onerror="this.outerHTML='<span class=placeholder>📺</span>'">`
            : '<span class="placeholder">📺</span>';

        html += `<div class="channel-item" data-index="${i}">
            <div class="channel-icon">${iconImg}</div>
            <div class="channel-info">
                <div class="ch-name">${escHTML(ch.name)}</div>
                <div class="ch-live">Live</div>
            </div>
            <div class="channel-actions">
                <button class="fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFav('live', ${ch.stream_id}, '${escHTML(ch.name)}', '${escHTML(ch.stream_icon || '')}', this)">♥</button>
                <button class="play-btn-sm" onclick="playLiveChannel(${i})">▶</button>
            </div>
        </div>`;
    }
    html += '</div>';
    content().innerHTML = html;

    // Store channels for channel surfing
    window._currentChannels = channels;
}

function playLiveChannel(index) {
    const channels = window._currentChannels;
    if (!channels) return;
    channelList = channels.map(ch => ({
        name: ch.name,
        urls: [
            { label: 'M3U8', url: liveURL(ch.stream_id, 'm3u8') },
            { label: 'TS', url: liveURL(ch.stream_id, 'ts') },
        ]
    }));
    channelIndex = index;
    const ch = channelList[index];
    openPlayer(ch.name, ch.urls, true);
}

// ─── Media grid ───
function renderMediaGrid(items, type) {
    let html = `<div class="search-bar"><input type="text" placeholder="Search..." oninput="filterList(this.value, '.media-card', '.card-title')"></div>`;
    html += '<div class="media-grid">';
    for (const item of items) {
        const name = item.name;
        const img = type === 'movie' ? item.stream_icon : item.cover;
        const year = type === 'movie' ? item.year : item.releaseDate || item.release_date;
        const rating = item.rating;
        const id = type === 'movie' ? item.stream_id : item.series_id;

        html += `<div class="media-card" onclick="openDetail(${id}, '${type}')">
            <div class="poster">
                ${img ? `<img src="${escHTML(img)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>${type === 'movie' ? '🎬' : '📺'}</div>'">` : `<div class="no-img">${type === 'movie' ? '🎬' : '📺'}</div>`}
                ${rating && rating !== '0' ? `<div class="rating-badge">⭐ ${escHTML(rating)}</div>` : ''}
            </div>
            <div class="card-title">${escHTML(name)}</div>
            ${year ? `<div class="card-year">${escHTML(year)}</div>` : ''}
        </div>`;
    }
    html += '</div>';
    content().innerHTML = html;
}

// ─── Detail views ───
async function openDetail(id, type) {
    if (type === 'movie') {
        pushView('Movie', async () => {
            showLoading('Loading movie...');
            try {
                const info = await api('get_vod_info', { vod_id: String(id) });
                renderMovieDetail(info, id);
            } catch (e) {
                content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed to load</h3><p>${escHTML(e.message)}</p></div>`;
            }
        });
    } else {
        pushView('Series', async () => {
            showLoading('Loading series...');
            try {
                const info = await api('get_series_info', { series_id: String(id) });
                renderSeriesDetail(info, id);
            } catch (e) {
                content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed to load</h3><p>${escHTML(e.message)}</p></div>`;
            }
        });
    }
}

function renderMovieDetail(data, streamID) {
    const info = data.info || {};
    const movie = data.movie_data || {};
    const name = movie.name || info.name || 'Movie';
    const backdrop = (info.backdrop_path && info.backdrop_path[0]) || movie.stream_icon || '';
    const ext = movie.container_extension || 'mp4';
    const links = vodLinks(streamID, ext);
    const isFav = isFavorite('vod', streamID);

    let html = `
        <div class="detail-hero">
            ${backdrop ? `<img src="${escHTML(backdrop)}" onerror="this.style.display='none'">` : ''}
            <div class="hero-gradient"></div>
            <div class="hero-info">
                <div class="hero-title">${escHTML(name)}</div>
                <div class="hero-meta">
                    ${movie.year ? `<span>${escHTML(movie.year)}</span>` : ''}
                    ${info.rating && info.rating !== '0' ? `<span class="star">⭐ ${escHTML(info.rating)}</span>` : ''}
                    ${info.genre ? `<span>${escHTML(info.genre)}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="detail-actions">
            <button class="btn btn-primary" onclick='playWithLinks(${JSON.stringify(links).replace(/'/g, "&#39;")}, "${escHTML(name)}")'>▶ Play</button>
            <button class="btn btn-fav ${isFav ? 'active' : ''}" onclick="toggleFav('vod', ${streamID}, '${escHTML(name)}', '${escHTML(movie.stream_icon || '')}', this)">♥ ${isFav ? 'Favorited' : 'Favorite'}</button>
        </div>
        ${info.plot ? `<p class="detail-plot">${escHTML(info.plot)}</p>` : ''}
        ${info.cast ? `<div class="detail-info-row"><div class="label">Cast</div><div class="value">${escHTML(info.cast)}</div></div>` : ''}
        ${info.director ? `<div class="detail-info-row"><div class="label">Director</div><div class="value">${escHTML(info.director)}</div></div>` : ''}
    `;
    content().innerHTML = html;
}

function renderSeriesDetail(data, seriesID) {
    const info = data.info || {};
    const episodes = data.episodes || {};
    const seasons = Object.keys(episodes).sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
    const name = info.name || 'Series';
    const cover = info.cover || '';
    const isFav = isFavorite('series', seriesID);

    let html = `
        <div class="detail-hero">
            ${cover ? `<img src="${escHTML(cover)}" onerror="this.style.display='none'">` : ''}
            <div class="hero-gradient"></div>
            <div class="hero-info">
                <div class="hero-title">${escHTML(name)}</div>
                <div class="hero-meta">
                    ${info.rating && info.rating !== '0' ? `<span class="star">⭐ ${escHTML(String(info.rating))}</span>` : ''}
                    ${info.genre ? `<span>${escHTML(info.genre)}</span>` : ''}
                    ${seasons.length ? `<span>${seasons.length} Season${seasons.length > 1 ? 's' : ''}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="detail-actions">`;

    // Play first episode button
    if (seasons.length && episodes[seasons[0]] && episodes[seasons[0]].length) {
        const firstEp = episodes[seasons[0]][0];
        const epLinks = seriesLinks(firstEp.id, firstEp.container_extension);
        html += `<button class="btn btn-primary" onclick='playWithLinks(${JSON.stringify(epLinks).replace(/'/g, "&#39;")}, "${escHTML(firstEp.title || name + ' S1E1')}")'>▶ Play</button>`;
    }

    html += `<button class="btn btn-fav ${isFav ? 'active' : ''}" onclick="toggleFav('series', ${seriesID}, '${escHTML(name)}', '${escHTML(cover)}', this)">♥ ${isFav ? 'Favorited' : 'Favorite'}</button>
        </div>
        ${info.plot ? `<p class="detail-plot">${escHTML(info.plot)}</p>` : ''}`;

    // Season pills
    if (seasons.length) {
        html += '<div class="season-bar">';
        for (const s of seasons) {
            html += `<button class="season-pill ${s === seasons[0] ? 'active' : ''}" onclick="selectSeason('${s}', this)">Season ${s}</button>`;
        }
        html += '</div>';
        html += `<div id="episode-list"></div>`;
    }

    content().innerHTML = html;

    // Store episodes data for season switching
    window._seriesEpisodes = episodes;
    window._seriesName = name;
    if (seasons.length) renderEpisodes(seasons[0]);
}

function selectSeason(season, el) {
    document.querySelectorAll('.season-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    renderEpisodes(season);
}

function renderEpisodes(season) {
    const episodes = window._seriesEpisodes[season] || [];
    const seriesName = window._seriesName;
    let html = '<div class="episode-list">';
    for (const ep of episodes) {
        const links = seriesLinks(ep.id, ep.container_extension);
        const title = ep.title || `Episode ${ep.episode_num || '?'}`;
        const duration = ep.info?.duration || '';
        const plot = ep.info?.plot || '';

        html += `<div class="episode-item" onclick='playWithLinks(${JSON.stringify(links).replace(/'/g, "&#39;")}, "${escHTML(title)}")'>
            <button class="ep-play">▶</button>
            <div class="ep-info">
                <div class="ep-title">Episode ${ep.episode_num || '?'}</div>
                ${ep.title ? `<div class="ep-sub">${escHTML(ep.title)}</div>` : ''}
                ${plot ? `<div class="ep-sub" style="margin-top:4px">${escHTML(plot.substring(0, 120))}${plot.length > 120 ? '...' : ''}</div>` : ''}
            </div>
            ${duration ? `<span class="ep-duration">${escHTML(duration)}</span>` : ''}
        </div>`;
    }
    html += '</div>';
    document.getElementById('episode-list').innerHTML = html;
}

// ─── Search ───
function showSearch() {
    let html = `
        <div class="search-bar"><input type="text" id="global-search" placeholder="Search channels, movies, series..." oninput="debounceSearch(this.value)"></div>
        <div class="scope-bar">
            <button class="scope-pill active" onclick="setScope('all', this)">All</button>
            <button class="scope-pill" onclick="setScope('live', this)">Live TV</button>
            <button class="scope-pill" onclick="setScope('movies', this)">Movies</button>
            <button class="scope-pill" onclick="setScope('series', this)">Series</button>
        </div>
        <div id="search-status"></div>
        <div id="search-results">
            <div class="empty-state">
                <div class="empty-icon">🔍</div>
                <h3>Search across all content</h3>
                <p>Type at least 2 characters</p>
            </div>
        </div>
    `;
    content().innerHTML = html;
    window._searchScope = 'all';

    // Load all data in background
    loadSearchData();
}

let searchTimeout;
function debounceSearch(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => runSearch(query), 300);
}

window._searchScope = 'all';
function setScope(scope, el) {
    window._searchScope = scope;
    document.querySelectorAll('.scope-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    const q = document.getElementById('global-search')?.value || '';
    if (q.length >= 2) runSearch(q);
}

async function loadSearchData() {
    const status = document.getElementById('search-status');
    if (!status) return;
    let loaded = 0;
    const total = 3;
    const update = () => {
        if (loaded < total) {
            status.innerHTML = `<div class="loading"><div class="spinner"></div>Indexing content (${loaded}/${total})...</div>`;
        } else {
            const count = (searchCache.live?.length || 0) + (searchCache.vod?.length || 0) + (searchCache.series?.length || 0);
            status.innerHTML = `<div style="font-size:12px;color:var(--text2);margin-bottom:8px">${count.toLocaleString()} items indexed</div>`;
        }
    };
    update();

    const load = async (key, action) => {
        if (!searchCache[key]) {
            try { searchCache[key] = await api(action); } catch { searchCache[key] = []; }
        }
        loaded++;
        update();
    };

    await Promise.all([
        load('live', 'get_live_streams'),
        load('vod', 'get_vod_streams'),
        load('series', 'get_series'),
    ]);
}

function runSearch(query) {
    const results = document.getElementById('search-results');
    if (!results) return;
    if (query.length < 2) {
        results.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><h3>Search across all content</h3><p>Type at least 2 characters</p></div>`;
        return;
    }

    const scope = window._searchScope;
    const q = query.toLowerCase();
    let html = '';

    // Live
    if ((scope === 'all' || scope === 'live') && searchCache.live) {
        const matches = searchCache.live.filter(ch => ch.name.toLowerCase().includes(q)).slice(0, 50);
        if (matches.length) {
            window._searchChannels = matches;
            html += `<div class="section-heading">Live Channels (${matches.length})</div><div class="channel-list">`;
            for (let i = 0; i < matches.length; i++) {
                const ch = matches[i];
                html += `<div class="channel-item">
                    <div class="channel-icon">${ch.stream_icon ? `<img src="${escHTML(ch.stream_icon)}" onerror="this.outerHTML='<span class=placeholder>📺</span>'">` : '<span class="placeholder">📺</span>'}</div>
                    <div class="channel-info"><div class="ch-name">${escHTML(ch.name)}</div><div class="ch-live">Live</div></div>
                    <button class="play-btn-sm" onclick="playSearchChannel(${i})">▶</button>
                </div>`;
            }
            html += '</div>';
        }
    }

    // Movies
    if ((scope === 'all' || scope === 'movies') && searchCache.vod) {
        const matches = searchCache.vod.filter(m => m.name.toLowerCase().includes(q)).slice(0, 50);
        if (matches.length) {
            html += `<div class="section-heading">Movies (${matches.length})</div><div class="media-grid">`;
            for (const m of matches) {
                html += `<div class="media-card" onclick="openDetail(${m.stream_id}, 'movie')">
                    <div class="poster">${m.stream_icon ? `<img src="${escHTML(m.stream_icon)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>🎬</div>'">` : '<div class="no-img">🎬</div>'}
                    ${m.rating && m.rating !== '0' ? `<div class="rating-badge">⭐ ${escHTML(m.rating)}</div>` : ''}</div>
                    <div class="card-title">${escHTML(m.name)}</div>
                    ${m.year ? `<div class="card-year">${escHTML(m.year)}</div>` : ''}
                </div>`;
            }
            html += '</div>';
        }
    }

    // Series
    if ((scope === 'all' || scope === 'series') && searchCache.series) {
        const matches = searchCache.series.filter(s => s.name.toLowerCase().includes(q)).slice(0, 50);
        if (matches.length) {
            html += `<div class="section-heading">Series (${matches.length})</div><div class="media-grid">`;
            for (const s of matches) {
                html += `<div class="media-card" onclick="openDetail(${s.series_id}, 'series')">
                    <div class="poster">${s.cover ? `<img src="${escHTML(s.cover)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>📺</div>'">` : '<div class="no-img">📺</div>'}
                    ${s.rating && s.rating !== '0' ? `<div class="rating-badge">⭐ ${escHTML(s.rating)}</div>` : ''}</div>
                    <div class="card-title">${escHTML(s.name)}</div>
                    ${s.releaseDate || s.release_date ? `<div class="card-year">${escHTML(s.releaseDate || s.release_date)}</div>` : ''}
                </div>`;
            }
            html += '</div>';
        }
    }

    if (!html) {
        html = `<div class="empty-state"><div class="empty-icon">🔍</div><h3>No results</h3><p>No matches for "${escHTML(query)}"</p></div>`;
    }

    results.innerHTML = html;
}

function playSearchChannel(index) {
    const channels = window._searchChannels;
    if (!channels) return;
    channelList = channels.map(ch => ({
        name: ch.name,
        urls: [
            { label: 'M3U8', url: liveURL(ch.stream_id, 'm3u8') },
            { label: 'TS', url: liveURL(ch.stream_id, 'ts') },
        ]
    }));
    channelIndex = index;
    const ch = channelList[index];
    openPlayer(ch.name, ch.urls, true);
}

// ─── Favorites ───
function isFavorite(type, id) {
    return favorites.some(f => f.type === type && f.id === id);
}

function toggleFav(type, id, name, icon, btnEl) {
    const idx = favorites.findIndex(f => f.type === type && f.id === id);
    if (idx >= 0) {
        favorites.splice(idx, 1);
        if (btnEl) { btnEl.classList.remove('active'); btnEl.innerHTML = btnEl.textContent.includes('Favorite') ? '♥ Favorite' : '♥'; }
    } else {
        favorites.push({ type, id, name, icon });
        if (btnEl) { btnEl.classList.add('active'); btnEl.innerHTML = btnEl.textContent.includes('Favorite') ? '♥ Favorited' : '♥'; }
    }
    localStorage.setItem('ayange_favs', JSON.stringify(favorites));
}

function showFavorites() {
    if (!favorites.length) {
        content().innerHTML = `<div class="empty-state"><div class="empty-icon">💔</div><h3>No Favorites</h3><p>Tap the heart icon on any channel, movie, or series to save it here.</p></div>`;
        return;
    }

    let html = '';
    const live = favorites.filter(f => f.type === 'live');
    const vod = favorites.filter(f => f.type === 'vod');
    const series = favorites.filter(f => f.type === 'series');

    if (live.length) {
        html += `<div class="fav-section-title">Live Channels</div><div class="channel-list">`;
        for (const f of live) {
            html += `<div class="channel-item">
                <div class="channel-icon">${f.icon ? `<img src="${escHTML(f.icon)}" onerror="this.outerHTML='<span class=placeholder>📺</span>'">` : '<span class="placeholder">📺</span>'}</div>
                <div class="channel-info"><div class="ch-name">${escHTML(f.name)}</div></div>
                <button class="fav-btn active" onclick="toggleFav('live', ${f.id}, '', '', this); setTimeout(() => showFavorites(), 200)">♥</button>
                <button class="play-btn-sm" onclick="openPlayer('${escHTML(f.name)}', [{label:'M3U8',url:'${liveURL(f.id, "m3u8")}'},{label:'TS',url:'${liveURL(f.id, "ts")}'}], false)">▶</button>
            </div>`;
        }
        html += '</div>';
    }

    if (vod.length) {
        html += `<div class="fav-section-title">Movies</div><div class="channel-list">`;
        for (const f of vod) {
            html += `<div class="channel-item" onclick="openDetail(${f.id}, 'movie')">
                <div class="channel-icon">${f.icon ? `<img src="${escHTML(f.icon)}" onerror="this.outerHTML='<span class=placeholder>🎬</span>'">` : '<span class="placeholder">🎬</span>'}</div>
                <div class="channel-info"><div class="ch-name">${escHTML(f.name)}</div></div>
                <span class="cat-arrow">›</span>
            </div>`;
        }
        html += '</div>';
    }

    if (series.length) {
        html += `<div class="fav-section-title">Series</div><div class="channel-list">`;
        for (const f of series) {
            html += `<div class="channel-item" onclick="openDetail(${f.id}, 'series')">
                <div class="channel-icon">${f.icon ? `<img src="${escHTML(f.icon)}" onerror="this.outerHTML='<span class=placeholder>📺</span>'">` : '<span class="placeholder">📺</span>'}</div>
                <div class="channel-info"><div class="ch-name">${escHTML(f.name)}</div></div>
                <span class="cat-arrow">›</span>
            </div>`;
        }
        html += '</div>';
    }

    content().innerHTML = html;
}

// ─── Filter helper ───
function filterList(query, itemSelector, textSelector) {
    const items = document.querySelectorAll(itemSelector);
    const q = query.toLowerCase();
    items.forEach(item => {
        const text = item.querySelector(textSelector)?.textContent?.toLowerCase() || '';
        item.style.display = text.includes(q) ? '' : 'none';
    });
}

// ─── Player ───
function openPlayer(title, links, isChannelSurf = false) {
    playerLinks = links;
    playerLinkIndex = 0;
    const overlay = $('player-overlay');
    overlay.classList.remove('hidden');
    $('player-title').textContent = title;
    $('player-error').classList.add('hidden');
    $('video-player').style.display = '';

    // Channel nav
    const nav = $('channel-nav');
    if (isChannelSurf && channelList.length > 1) {
        nav.classList.remove('hidden');
        updateChannelNav();
    } else {
        nav.classList.add('hidden');
    }

    playCurrentLink();
    document.addEventListener('keydown', playerKeyHandler);
}

function playCurrentLink() {
    if (playerLinkIndex >= playerLinks.length) {
        showPlayerError('All formats failed. This content may be unavailable.');
        return;
    }

    const link = playerLinks[playerLinkIndex];
    const video = $('video-player');
    $('player-error').classList.add('hidden');
    video.style.display = '';

    // Destroy old HLS instance
    if (hls) { hls.destroy(); hls = null; }

    const url = link.url;

    if (url.endsWith('.m3u8') && Hls.isSupported()) {
        hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            startLevel: -1
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) tryNextLink();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else if (url.endsWith('.m3u8') && video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        video.src = url;
        video.play().catch(() => {});
        video.onerror = () => tryNextLink();
    } else {
        // Direct play (mp4, mkv, etc.)
        video.src = url;
        video.play().catch(() => {});
        video.onerror = () => tryNextLink();
    }
}

function tryNextLink() {
    playerLinkIndex++;
    if (playerLinkIndex < playerLinks.length) {
        playCurrentLink();
    } else {
        showPlayerError('Playback failed. This content may not be available in a browser-compatible format.');
    }
}

function showPlayerError(msg) {
    $('video-player').style.display = 'none';
    $('player-error').classList.remove('hidden');
    $('player-error-msg').textContent = msg;
    $('try-next-btn').style.display = playerLinkIndex < playerLinks.length - 1 ? '' : 'none';
}

function closePlayer() {
    const overlay = $('player-overlay');
    overlay.classList.add('hidden');
    const video = $('video-player');
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (hls) { hls.destroy(); hls = null; }
    channelList = [];
    document.removeEventListener('keydown', playerKeyHandler);
}

function playWithLinks(links, title) {
    channelList = [];
    openPlayer(title, links, false);
}

// Channel surfing
function nextChannel() {
    if (channelIndex + 1 >= channelList.length) return;
    channelIndex++;
    const ch = channelList[channelIndex];
    $('player-title').textContent = ch.name;
    playerLinks = ch.urls;
    playerLinkIndex = 0;
    updateChannelNav();
    playCurrentLink();
}

function prevChannel() {
    if (channelIndex <= 0) return;
    channelIndex--;
    const ch = channelList[channelIndex];
    $('player-title').textContent = ch.name;
    playerLinks = ch.urls;
    playerLinkIndex = 0;
    updateChannelNav();
    playCurrentLink();
}

function updateChannelNav() {
    $('channel-counter').textContent = `${channelIndex + 1}/${channelList.length}`;
    $('prev-ch-btn').disabled = channelIndex <= 0;
    $('next-ch-btn').disabled = channelIndex + 1 >= channelList.length;
}

// Keyboard shortcuts
function playerKeyHandler(e) {
    if (e.key === 'Escape') { closePlayer(); e.preventDefault(); }
    if (e.key === ' ') {
        const v = $('video-player');
        v.paused ? v.play() : v.pause();
        e.preventDefault();
    }
    if (e.key === 'ArrowLeft') { $('video-player').currentTime -= 10; e.preventDefault(); }
    if (e.key === 'ArrowRight') { $('video-player').currentTime += 10; e.preventDefault(); }
    if (e.key === 'ArrowUp' && channelList.length) { prevChannel(); e.preventDefault(); }
    if (e.key === 'ArrowDown' && channelList.length) { nextChannel(); e.preventDefault(); }
    if (e.key === 'f') { toggleFullscreen(); e.preventDefault(); }
}

function toggleFullscreen() {
    const el = $('player-overlay');
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        el.requestFullscreen().catch(() => {});
    }
}

// ─── Init ───
switchTab('live');
