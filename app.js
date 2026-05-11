// ─── Config ───
// Credentials are injected server-side by the proxy in server.py. The
// frontend never carries the IPTV username/password.
const IPTV_SERVER = '';

// ─── State ───
let currentTab = 'movies';
let navStack = [];
let favorites = JSON.parse(localStorage.getItem('ayange_favs') || '[]');
let continueWatching = JSON.parse(localStorage.getItem('ayange_cw') || '[]');
let searchCache = { live: null, vod: null, series: null };
let categoryCache = { live: null, movie: null, series: null };
let contentCache = {};
let lastRefresh = Date.now();
const CACHE_TTL_MS = 10 * 60 * 1000;          // catalog goes stale after 10 min
const NEW_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // "NEW" badge for items added in last 14 days

// Player state
let hls = null;
let playerLinks = [];
let playerLinkIndex = 0;
let channelList = [];
let channelIndex = 0;
let playbackTimer = null;

// Play registry
let _playRegistry = {};
let _playId = 0;

function registerPlay(links, title, meta) {
    const id = _playId++;
    _playRegistry[id] = { links, title, meta };
    return id;
}

function playRegistered(id) {
    const data = _playRegistry[id];
    if (!data) return;
    if (data.meta) addToContinueWatching(data.meta);
    playWithLinks(data.links, data.title);
}

// ─── API ───
function apiURL(action, extra = {}) {
    const params = new URLSearchParams({ action });
    Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    return `${IPTV_SERVER}/player_api.php?${params}`;
}

async function api(action, extra = {}) {
    const res = await fetch(apiURL(action, extra));
    return res.json();
}

function liveURL(streamID, ext = 'm3u8') {
    return `${IPTV_SERVER}/live/${streamID}.${ext}`;
}
function vodURL(streamID, ext) {
    return `${IPTV_SERVER}/movie/${streamID}.${ext}`;
}
function seriesURL(episodeID, ext) {
    return `${IPTV_SERVER}/series/${episodeID}.${ext}`;
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
    // Transcoded version first (fixes audio codec issues like EAC3/AC3/DTS, includes subtitles)
    const links = [
        { label: 'Transcode', url: `${IPTV_SERVER}/transcode/series/${episodeID}.${primary}` },
        { label: primary.toUpperCase(), url: seriesURL(episodeID, primary) },
    ];
    for (const alt of ['mp4', 'mkv', 'avi']) {
        if (alt !== primary) links.push({ label: alt.toUpperCase(), url: seriesURL(episodeID, alt) });
    }
    return links;
}

function vodLinksTranscode(streamID, ext) {
    const primary = ext || 'mp4';
    const links = [
        { label: 'Transcode', url: `${IPTV_SERVER}/transcode/movie/${streamID}.${primary}` },
        { label: primary.toUpperCase(), url: vodURL(streamID, primary) },
    ];
    for (const alt of ['mp4', 'mkv', 'avi']) {
        if (alt !== primary) links.push({ label: alt.toUpperCase(), url: vodURL(streamID, alt) });
    }
    return links;
}

// ─── Helpers ───
const $ = id => document.getElementById(id);
const content = () => $('content');

function escHTML(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}

function showLoading(msg = 'Loading...') {
    content().innerHTML = `<div class="loading"><div class="spinner"></div>${msg}</div>`;
}

function setGreeting() {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning,' : h < 18 ? 'Good afternoon,' : 'Good evening,';
    $('greeting').textContent = g;
    const d = new Date();
    $('date-display').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// ─── Refresh & Cache Invalidation ───
function clearAllCaches() {
    searchCache = { live: null, vod: null, series: null };
    categoryCache = { live: null, movie: null, series: null };
    contentCache = {};
    lastRefresh = Date.now();
}

async function refreshAll() {
    clearAllCaches();
    const btn = $('refresh-btn');
    if (btn) btn.classList.add('spinning');
    try {
        if (navStack.length) {
            navStack[navStack.length - 1].renderFn();
        } else {
            switchTab(currentTab);
        }
        showToast('Catalog refreshed');
    } finally {
        setTimeout(() => btn && btn.classList.remove('spinning'), 700);
    }
}

function showToast(msg) {
    let t = $('toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Auto-refresh when tab is visible again after the cache TTL has passed.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (Date.now() - lastRefresh) > CACHE_TTL_MS) {
        refreshAll();
    }
});

function isNewItem(item) {
    const ts = parseInt(item.added) || parseInt(item.last_modified) || 0;
    if (!ts) return false;
    return (Date.now() - ts * 1000) < NEW_THRESHOLD_MS;
}

// ─── Catalog filtering & display helpers ───
// Provider tags categories like "|EN|", "|FR|", "|NL|", "|AR|", "|IR|", "|SPT|", etc.
// We surface English/global content on the home view; users can still find
// other languages via the search tab.
const ENGLISH_PREFIX_RE = /^\s*\|(EN|MULTI|UK|US)\|/i;
const NON_ENGLISH_PREFIX_RE = /^\s*\|(?!EN\b|MULTI\b|UK\b|US\b)[A-Z]{2,4}\|/i;
const ENGLISH_KEYWORDS = ['NETFLIX', 'DISNEY', 'APPLE', 'HBO', 'AMAZON', 'IMDB', 'OSCAR', 'HULU', 'PRIME', 'PARAMOUNT', 'PEACOCK', 'STARZ', 'BROADWAY'];

function isEnglishCategory(cat) {
    const name = (cat?.category_name || '').toUpperCase();
    if (!name) return false;
    if (ENGLISH_PREFIX_RE.test(name)) return true;
    if (NON_ENGLISH_PREFIX_RE.test(name)) return false;
    if (/\|SPT\||\|MU\|/.test(name)) return false;                  // sports / music channels
    if (/SPORT|UFC|\bWWE\b|BOXING|GLORY|FORMULE|\bF1\b/.test(name)) return false;
    // Untagged: keep if it names a Western platform
    return ENGLISH_KEYWORDS.some(k => name.includes(k));
}

function buildEnglishCategoryIDs(cats) {
    const set = new Set();
    for (const c of (cats || [])) {
        if (isEnglishCategory(c)) set.add(String(c.category_id));
    }
    return set;
}

// Strip provider language prefixes like "EN - ", "|EN| ", "FR :", "AR -" so the
// poster shows just the real movie title.
function cleanTitle(raw) {
    if (!raw) return '';
    return String(raw)
        .replace(/^\s*\|?[A-Z]{2,4}\|?\s*[-–—:|]\s*/i, '')
        .replace(/^\s*\|[A-Z]{2,4}\|\s*/i, '')
        .trim() || String(raw);
}

function itemSortKey(item) {
    return parseInt(item.added) || parseInt(item.last_modified) || 0;
}

const YEAR_IN_TITLE_RE = /\((\d{4})\)/;
function itemYear(item) {
    if (!item) return 0;
    if (item.year && /^\d{4}/.test(item.year)) return parseInt(item.year);
    const m = YEAR_IN_TITLE_RE.exec(item.name || '');
    if (m) return parseInt(m[1]);
    if (item.releaseDate) return parseInt(String(item.releaseDate).slice(0, 4)) || 0;
    return 0;
}

function itemRating(item) {
    const r = parseFloat(item.rating);
    return isNaN(r) ? 0 : r;
}

// Categories that are language-tagged English but actually subbed/dubbed foreign films.
// We hide these from the curated home rows so "Latest Movies" stays mainstream English.
const FOREIGN_BUCKET_RE = /(ENG\s*-?\s*SUB|MULTI\s*-?\s*SUB|FOREIGN|\bDUB\b|TURKISH|ARABIC|HINDI|KOREAN|JAPANESE|CHINESE|RUSSIAN|GERMAN MOVIES|SPANISH MOVIES)/i;

function bestImage(item, type) {
    if (type === 'series') {
        if (Array.isArray(item.backdrop_path) && item.backdrop_path[0]) return item.backdrop_path[0];
        return item.cover || item.stream_icon || '';
    }
    return item.stream_icon || item.cover || '';
}

function bestBackdrop(item, type) {
    if (Array.isArray(item.backdrop_path) && item.backdrop_path[0]) return item.backdrop_path[0];
    return bestImage(item, type);
}

// ─── Hero carousel ───
let _heroTimer = null;
let _heroIdx = 0;
let _heroCount = 0;

function clearHero() {
    if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
    _heroIdx = 0;
    _heroCount = 0;
}

function renderHero(items, type) {
    if (!items || !items.length) return '';
    let slides = '';
    let dots = '';
    items.forEach((it, i) => {
        const id = type === 'movie' ? it.stream_id : it.series_id;
        const title = cleanTitle(it.name);
        const hasBackdrop = Array.isArray(it.backdrop_path) && it.backdrop_path[0];
        const bg = hasBackdrop ? it.backdrop_path[0] : bestImage(it, type);
        const poster = type === 'series' ? (it.cover || it.stream_icon || '') : (it.stream_icon || it.cover || '');
        const rating = it.rating;
        const year = itemYear(it) || '';
        const genre = (it.genre || '').split(',')[0];
        const plot = it.plot || '';

        slides += `<div class="hero-slide${i === 0 ? ' active' : ''}" data-idx="${i}">
            ${bg ? `<div class="hero-bg${hasBackdrop ? '' : ' hero-bg-blurred'}" style="background-image:url('${escHTML(bg)}')"></div>` : '<div class="hero-bg hero-bg-fallback"></div>'}
            <div class="hero-overlay"></div>
            <div class="hero-content">
                ${poster ? `<div class="hero-poster"><img src="${escHTML(poster)}" loading="lazy" onerror="this.style.display='none'"></div>` : ''}
                <div class="hero-text">
                    <div class="hero-badge">${isNewItem(it) ? 'NEW · ' : ''}FEATURED</div>
                    <h1 class="hero-title-lg">${escHTML(title)}</h1>
                    <div class="hero-meta-lg">
                        ${rating && rating !== '0' ? `<span class="star">★ ${escHTML(String(rating).slice(0,3))}</span>` : ''}
                        ${year ? `<span>${escHTML(String(year))}</span>` : ''}
                        ${genre ? `<span>${escHTML(genre)}</span>` : ''}
                    </div>
                    ${plot ? `<p class="hero-plot">${escHTML(plot)}</p>` : ''}
                    <div class="hero-actions">
                        <button class="btn btn-primary" onclick="openDetail(${id}, '${type}')">&#9654; Play</button>
                        <button class="btn btn-glass" onclick="openDetail(${id}, '${type}')">More Info</button>
                    </div>
                </div>
            </div>
        </div>`;

        dots += `<span class="hero-dot${i === 0 ? ' active' : ''}" onclick="setHero(${i})"></span>`;
    });

    return `<div class="hero-banner" id="hero-banner">
        <div class="hero-slides">${slides}</div>
        <div class="hero-dots">${dots}</div>
    </div>`;
}

function setHero(idx) {
    _heroIdx = idx;
    document.querySelectorAll('#hero-banner .hero-slide').forEach((s, i) => s.classList.toggle('active', i === idx));
    document.querySelectorAll('#hero-banner .hero-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

function initHeroCarousel(items) {
    clearHero();
    _heroCount = (items || []).length;
    if (_heroCount <= 1) return;
    _heroTimer = setInterval(() => setHero((_heroIdx + 1) % _heroCount), 7000);
}

// ─── Genre row config ───
const MOVIE_GENRE_ROWS = [
    { title: 'Netflix Picks', match: /\bNETFLIX\b/i },
    { title: 'Action & Thriller', match: /\b(ACTION|THRILLER)\b/i },
    { title: 'Comedy', match: /\bCOMEDY\b/i, exclude: /STAND-?UP/i },
    { title: 'Drama', match: /\bDRAMA\b/i },
    { title: 'Horror', match: /\bHORROR\b/i },
    { title: 'Sci-Fi & Fantasy', match: /\b(SCIENCE|FANTASY|FANTASTY)\b/i },
    { title: 'Marvel Universe', match: /\bMARVEL\b/i },
    { title: 'Adventure', match: /\bADVENTURE\b/i },
    { title: '4K Ultra HD', match: /\b4K\b/i },
    { title: 'Disney+ & Pixar', match: /\b(DISNEY|PIXAR)\b/i },
    { title: 'Family & Kids', match: /\b(FAMILY|CHILDREN|KIDS)\b/i, exclude: /4K/i },
    { title: 'HBO Max', match: /\bHBO\b/i },
    { title: 'Apple TV+', match: /\bAPPLE\b/i },
    { title: 'Anime', match: /\bANIME\b/i },
    { title: 'Documentaries', match: /\bDOCUMENTARY\b/i },
    { title: 'Stand-Up Comedy', match: /STAND-?UP/i },
    { title: 'Classic Cinema', match: /\bCLASSIC\b/i },
    { title: 'Westerns', match: /\bWESTERN/i },
];

const SERIES_GENRE_ROWS = [
    { title: 'Netflix Series', match: /\bNETFLIX\b/i },
    { title: 'HBO Max', match: /\bHBO\b/i },
    { title: 'Apple TV+', match: /\bAPPLE\b/i },
    { title: 'Disney+', match: /\bDISNEY\b/i },
    { title: 'Amazon Prime', match: /\b(AMAZON|PRIME)\b/i },
    { title: 'Top Series', match: /\bTOP\b/i },
    { title: '4K Series', match: /\b4K\b/i },
    { title: 'Anime', match: /\bANIME\b/i },
    { title: 'Kids & Family', match: /\b(KIDS|FAMILY|CHILDREN)\b/i },
];

// ─── Continue Watching ───
function addToContinueWatching(meta) {
    if (!meta || !meta.id) return;
    continueWatching = continueWatching.filter(c => !(c.id === meta.id && c.type === meta.type));
    continueWatching.unshift({ ...meta, ts: Date.now() });
    if (continueWatching.length > 20) continueWatching = continueWatching.slice(0, 20);
    localStorage.setItem('ayange_cw', JSON.stringify(continueWatching));
}

function renderContinueWatching() {
    const items = continueWatching.filter(c => {
        if (currentTab === 'movies') return c.type === 'vod';
        if (currentTab === 'series') return c.type === 'series';
        if (currentTab === 'live') return c.type === 'live';
        return true;
    }).slice(0, 10);
    if (!items.length) return '';

    let cards = '';
    for (const item of items) {
        const img = item.img
            ? `<img class="cw-img" src="${escHTML(item.img)}" onerror="this.outerHTML='<div class=cw-no-img>${item.type === 'live' ? '📡' : '🎬'}</div>'" loading="lazy">`
            : `<div class="cw-no-img">${item.type === 'live' ? '📡' : '🎬'}</div>`;
        const onclick = item.type === 'live'
            ? `playQuickLive(${item.id})`
            : `openDetail(${item.id}, '${item.type === 'vod' ? 'movie' : 'series'}')`;
        cards += `<div class="cw-card" onclick="${onclick}">
            ${img}
            <div class="cw-overlay">
                <div class="cw-play">&#9654;</div>
                <div class="cw-info">
                    <div class="cw-title">${escHTML(cleanTitle(item.name))}</div>
                    <div class="cw-meta">${item.type === 'live' ? 'Live' : item.year || ''}</div>
                </div>
            </div>
        </div>`;
    }

    return `<div class="section">
        <div class="section-header"><span class="section-title">Continue Watching</span><span class="section-arrow">&#8250;</span></div>
        <div class="row-scroll">${cards}</div>
    </div>`;
}

// ─── Navigation ───
function switchTab(tab) {
    currentTab = tab;
    navStack = [];
    $('breadcrumb').classList.add('hidden');

    document.querySelectorAll('.tab-pill, .mob-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });

    const main = $('main');
    main.classList.remove('has-catbar', 'has-breadcrumb');

    switch (tab) {
        case 'movies': loadHomeView('movie'); break;
        case 'series': loadHomeView('series'); break;
        case 'live': loadHomeView('live'); break;
        case 'search': showSearch(); break;
        case 'favorites': showFavorites(); break;
    }
}

function pushView(title, renderFn) {
    clearHero();
    navStack.push({ title, renderFn, scrollY: $('main').scrollTop });
    $('breadcrumb').classList.remove('hidden');
    $('category-bar').classList.add('hidden');
    $('breadcrumb-text').textContent = title;
    $('main').classList.remove('has-catbar');
    $('main').classList.add('has-breadcrumb');
    renderFn();
    $('main').scrollTop = 0;
}

function goBack() {
    if (!navStack.length) return;
    navStack.pop();
    if (!navStack.length) {
        $('breadcrumb').classList.add('hidden');
        switchTab(currentTab);
    } else {
        const prev = navStack[navStack.length - 1];
        $('breadcrumb-text').textContent = prev.title;
        if (prev.renderFn) prev.renderFn();
    }
}

// ─── Home View ───
async function loadHomeView(type) {
    clearHero();
    showLoading('Loading...');
    $('category-bar').classList.add('hidden');

    if (type === 'live') {
        return loadLiveHome();
    }
    return loadCuratedHome(type);
}

async function loadLiveHome() {
    try {
        if (!categoryCache.live) categoryCache.live = await api('get_live_categories');
        const cats = categoryCache.live;
        renderCategoryPills(cats, 'live');
        $('category-bar').classList.remove('hidden');
        $('main').classList.add('has-catbar');
        await renderLiveHomeRows(cats);
    } catch (e) {
        content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed to load</h3><p>${escHTML(e.message)}</p></div>`;
    }
}

async function loadCuratedHome(type) {
    const catAction = type === 'movie' ? 'get_vod_categories' : 'get_series_categories';
    const allAction = type === 'movie' ? 'get_vod_streams' : 'get_series';
    const cacheKey = type === 'movie' ? 'vod' : 'series';

    try {
        if (!categoryCache[type]) categoryCache[type] = await api(catAction);
        if (!searchCache[cacheKey]) {
            content().innerHTML = `<div class="loading"><div class="spinner"></div>Building your catalog...</div>`;
            try { searchCache[cacheKey] = await api(allAction); } catch { searchCache[cacheKey] = []; }
        }
        const cats = categoryCache[type] || [];
        const enIDs = buildEnglishCategoryIDs(cats);
        const items = (searchCache[cacheKey] || []).filter(it => enIDs.has(String(it.category_id)));

        // English-only category pills (drop subbed-foreign buckets too)
        const enCats = cats.filter(c => enIDs.has(String(c.category_id)) && !FOREIGN_BUCKET_RE.test(c.category_name || ''));
        renderCategoryPills(enCats, type);
        $('category-bar').classList.remove('hidden');
        $('main').classList.add('has-catbar');

        renderCuratedHome(items, cats, type);
    } catch (e) {
        content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed to load</h3><p>${escHTML(e.message)}</p></div>`;
    }
}

function renderCuratedHome(items, allCats, type) {
    if (!items.length) {
        content().innerHTML = `<div class="empty-state"><div class="empty-icon">🎬</div><h3>No content</h3><p>Try refreshing the catalog.</p></div>`;
        return;
    }

    const idOf = it => String(type === 'movie' ? it.stream_id : it.series_id);
    const catById = new Map(allCats.map(c => [String(c.category_id), c]));
    const inForeignBucket = it => {
        const c = catById.get(String(it.category_id));
        return !!(c && FOREIGN_BUCKET_RE.test(c.category_name || ''));
    };

    // "Mainstream" pool feeds the hero + Latest/Top Rated. Drops items in
    // sub/dub/foreign buckets and keeps only those with a poster.
    const mainstream = items.filter(it => !inForeignBucket(it) && bestImage(it, type));

    const currentYear = new Date().getFullYear();
    const recentCutoff = currentYear - 2; // last ~2 calendar years count as "latest"

    // LATEST: recent year, has rating, sorted by added (most-recently uploaded first)
    const latestPool = mainstream.filter(it => {
        const y = itemYear(it);
        return y >= recentCutoff && itemRating(it) > 0;
    });
    latestPool.sort((a, b) => itemSortKey(b) - itemSortKey(a));

    // HERO: top of latest pool, but require a strong rating + presentable image
    const heroPool = latestPool.filter(it => itemRating(it) >= 6.5);
    const featured = (heroPool.length >= 3 ? heroPool : latestPool).slice(0, 6);
    const heroIDSet = new Set(featured.map(idOf));

    const latest = latestPool.filter(it => !heroIDSet.has(idOf(it))).slice(0, 25);

    // TOP RATED: well-rated items from the recent window
    const topRated = mainstream
        .filter(it => itemRating(it) >= 7.5 && itemYear(it) >= recentCutoff - 3)
        .sort((a, b) => itemRating(b) - itemRating(a))
        .slice(0, 25);

    let html = renderHero(featured, type);
    html += renderContinueWatching();
    if (latest.length >= 6) {
        html += renderMediaRow(type === 'movie' ? 'Latest Movies' : 'New Episodes', latest, type);
    }
    if (topRated.length >= 6) {
        html += renderMediaRow('Top Rated', topRated, type);
    }

    // GENRE ROWS — sourced from category-name matching, only English & not sub/dub buckets.
    const ROWS = type === 'movie' ? MOVIE_GENRE_ROWS : SERIES_GENRE_ROWS;
    const usedIDs = new Set();
    for (const row of ROWS) {
        const matchedIDs = new Set();
        for (const c of allCats) {
            const name = c.category_name || '';
            if (!row.match.test(name)) continue;
            if (row.exclude && row.exclude.test(name)) continue;
            if (!isEnglishCategory(c)) continue;
            if (FOREIGN_BUCKET_RE.test(name)) continue;
            if (usedIDs.has(String(c.category_id))) continue;
            matchedIDs.add(String(c.category_id));
        }
        if (!matchedIDs.size) continue;

        const rowItems = items
            .filter(it => matchedIDs.has(String(it.category_id)) && bestImage(it, type))
            .sort((a, b) => itemSortKey(b) - itemSortKey(a))
            .slice(0, 20);
        if (rowItems.length >= 6) {
            html += renderMediaRow(row.title, rowItems, type);
            for (const id of matchedIDs) usedIDs.add(id);
        }
    }

    content().innerHTML = html;
    initHeroCarousel(featured);
}

async function renderLiveHomeRows(cats) {
    let html = renderContinueWatching();
    const rowCats = cats.slice(0, 6);
    const promises = rowCats.map(cat => loadCategoryContent(cat.category_id, 'live').catch(() => []));
    content().innerHTML = html + `<div class="loading"><div class="spinner"></div>Loading channels...</div>`;
    const results = await Promise.all(promises);
    html = renderContinueWatching();
    for (let i = 0; i < rowCats.length; i++) {
        const ch = results[i];
        if (!ch || !ch.length) continue;
        html += renderChannelRow(rowCats[i].category_name, ch.slice(0, 15), rowCats[i].category_id);
    }
    if (!html) html = `<div class="empty-state"><div class="empty-icon">📡</div><h3>No channels</h3></div>`;
    content().innerHTML = html;
}

function renderCategoryPills(cats, type) {
    let html = `<button class="cat-pill active" onclick="selectCategory('all', '${type}', this)">All</button>`;
    for (const cat of cats.slice(0, 30)) {
        html += `<button class="cat-pill" onclick="selectCategory('${cat.category_id}', '${type}', this)">${escHTML(cat.category_name)}</button>`;
    }
    $('category-pills').innerHTML = html;
}

async function selectCategory(catID, type, el) {
    document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');

    if (catID === 'all') {
        await loadHomeView(type);
    } else {
        showLoading();
        try {
            const items = await loadCategoryContent(catID, type);
            if (type === 'live') {
                renderChannelGrid(items);
            } else {
                renderGridView(items, type);
            }
        } catch (e) {
            content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><h3>Failed</h3><p>${escHTML(e.message)}</p></div>`;
        }
    }
}

async function loadCategoryContent(catID, type) {
    const key = `${type}_${catID}`;
    if (contentCache[key]) return contentCache[key];
    const action = type === 'live' ? 'get_live_streams' : type === 'movie' ? 'get_vod_streams' : 'get_series';
    const data = await api(action, { category_id: catID });
    contentCache[key] = data;
    return data;
}

function renderMediaRow(title, items, type) {
    let cards = '';
    for (const item of items) {
        const name = cleanTitle(item.name);
        const img = type === 'movie' ? item.stream_icon : item.cover;
        const id = type === 'movie' ? item.stream_id : item.series_id;
        const rating = item.rating;
        const year = itemYear(item) || '';
        const isNew = isNewItem(item);

        cards += `<div class="media-card" onclick="openDetail(${id}, '${type === 'movie' ? 'movie' : 'series'}')">
            <div class="poster">
                ${img ? `<img src="${escHTML(img)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>🎬</div>'">` : '<div class="no-img">🎬</div>'}
                ${isNew ? '<div class="new-badge">NEW</div>' : ''}
                ${rating && rating !== '0' ? `<div class="rating-badge">★ ${escHTML(String(rating).slice(0,3))}</div>` : ''}
            </div>
            <div class="card-title">${escHTML(name)}</div>
            ${year ? `<div class="card-year">${escHTML(String(year))}</div>` : ''}
        </div>`;
    }

    return `<div class="section">
        <div class="section-header"><span class="section-title">${escHTML(title)}</span><span class="section-arrow">&#8250;</span></div>
        <div class="row-scroll">${cards}</div>
    </div>`;
}

function renderChannelRow(title, channels, catID) {
    let cards = '';
    for (const ch of channels) {
        const iconImg = ch.stream_icon
            ? `<img src="${escHTML(ch.stream_icon)}" onerror="this.outerHTML='<span class=placeholder>📡</span>'">`
            : '<span class="placeholder">📡</span>';
        cards += `<div class="ch-card" onclick="playQuickLive(${ch.stream_id})">
            <div class="ch-card-icon">${iconImg}</div>
            <div class="ch-card-name">${escHTML(ch.name)}</div>
            <div class="ch-card-live">LIVE</div>
        </div>`;
    }

    return `<div class="section">
        <div class="section-header"><span class="section-title">${escHTML(title)}</span><span class="section-arrow">&#8250;</span></div>
        <div class="channel-row">${cards}</div>
    </div>`;
}

// ─── Grid Views (when a category is selected) ───
function renderGridView(items, type) {
    let html = `<div class="search-bar"><input type="text" placeholder="Filter..." oninput="filterList(this.value, '.media-card', '.card-title')"></div>`;
    html += '<div class="media-grid">';
    for (const item of items) {
        const name = cleanTitle(item.name);
        const img = type === 'movie' ? item.stream_icon : item.cover;
        const id = type === 'movie' ? item.stream_id : item.series_id;
        const year = itemYear(item) || '';
        const rating = item.rating;
        const isNew = isNewItem(item);

        html += `<div class="media-card" onclick="openDetail(${id}, '${type === 'movie' ? 'movie' : 'series'}')">
            <div class="poster">
                ${img ? `<img src="${escHTML(img)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>🎬</div>'">` : '<div class="no-img">🎬</div>'}
                ${isNew ? '<div class="new-badge">NEW</div>' : ''}
                ${rating && rating !== '0' ? `<div class="rating-badge">★ ${escHTML(String(rating).slice(0,3))}</div>` : ''}
            </div>
            <div class="card-title">${escHTML(name)}</div>
            ${year ? `<div class="card-year">${escHTML(year)}</div>` : ''}
        </div>`;
    }
    html += '</div>';
    content().innerHTML = html;
}

function renderChannelGrid(channels) {
    let html = `<div class="search-bar"><input type="text" placeholder="Search channels..." oninput="filterList(this.value, '.channel-item', '.ch-name')"></div>`;
    html += '<div class="channel-list">';
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const isFav = isFavorite('live', ch.stream_id);
        const iconImg = ch.stream_icon
            ? `<img src="${escHTML(ch.stream_icon)}" onerror="this.outerHTML='<span class=placeholder>📡</span>'">`
            : '<span class="placeholder">📡</span>';

        html += `<div class="channel-item" data-index="${i}">
            <div class="channel-icon">${iconImg}</div>
            <div class="channel-info">
                <div class="ch-name">${escHTML(ch.name)}</div>
                <div class="ch-live">Live</div>
            </div>
            <div class="channel-actions">
                <button class="fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFav('live', ${ch.stream_id}, this)">&#9829;</button>
                <button class="play-btn-sm" onclick="playLiveFromList(${i})">&#9654;</button>
            </div>
        </div>`;
    }
    html += '</div>';
    content().innerHTML = html;
    window._currentChannels = channels;
}

function playLiveFromList(index) {
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
    addToContinueWatching({ id: channels[index].stream_id, type: 'live', name: channels[index].name, img: channels[index].stream_icon });
    openPlayer(ch.name, ch.urls, true);
}

function playQuickLive(streamId) {
    const links = [
        { label: 'M3U8', url: liveURL(streamId, 'm3u8') },
        { label: 'TS', url: liveURL(streamId, 'ts') },
    ];
    channelList = [];
    openPlayer('Live', links, false);
}

// ─── Detail Views ───
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
    const name = cleanTitle(movie.name || info.name || 'Movie');
    const backdrop = (info.backdrop_path && info.backdrop_path[0]) || movie.stream_icon || '';
    const ext = movie.container_extension || 'mp4';
    const links = vodLinksTranscode(streamID, ext);
    const isFav = isFavorite('vod', streamID);
    const meta = { id: streamID, type: 'vod', name, img: backdrop, year: movie.year || '' };
    const playId = registerPlay(links, name, meta);

    let html = `
        <div class="detail-hero">
            ${backdrop ? `<img src="${escHTML(backdrop)}" onerror="this.style.display='none'">` : ''}
            <div class="hero-gradient"></div>
            <div class="hero-info">
                <div class="hero-title">${escHTML(name)}</div>
                <div class="hero-meta">
                    ${movie.year ? `<span>${escHTML(movie.year)}</span>` : ''}
                    ${info.rating && info.rating !== '0' ? `<span class="star">${escHTML(info.rating)}</span>` : ''}
                    ${info.genre ? `<span>${escHTML(info.genre)}</span>` : ''}
                    ${info.duration ? `<span>${escHTML(info.duration)}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="detail-actions">
            <button class="btn btn-primary" onclick="playRegistered(${playId})">&#9654; Play</button>
            <button class="btn btn-fav ${isFav ? 'active' : ''}" onclick="toggleFav('vod', ${streamID}, this)">&#9829; ${isFav ? 'Favorited' : 'Favorite'}</button>
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
    const name = cleanTitle(info.name || 'Series');
    const cover = info.cover || '';
    const isFav = isFavorite('series', seriesID);

    let html = `
        <div class="detail-hero">
            ${cover ? `<img src="${escHTML(cover)}" onerror="this.style.display='none'">` : ''}
            <div class="hero-gradient"></div>
            <div class="hero-info">
                <div class="hero-title">${escHTML(name)}</div>
                <div class="hero-meta">
                    ${info.rating && info.rating !== '0' ? `<span class="star">${escHTML(String(info.rating))}</span>` : ''}
                    ${info.genre ? `<span>${escHTML(info.genre)}</span>` : ''}
                    ${seasons.length ? `<span>${seasons.length} Season${seasons.length > 1 ? 's' : ''}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="detail-actions">`;

    if (seasons.length && episodes[seasons[0]] && episodes[seasons[0]].length) {
        const firstEp = episodes[seasons[0]][0];
        const epLinks = seriesLinks(firstEp.id, firstEp.container_extension);
        const meta = { id: seriesID, type: 'series', name, img: cover };
        const playId = registerPlay(epLinks, firstEp.title || name + ' S1E1', meta);
        html += `<button class="btn btn-primary" onclick="playRegistered(${playId})">&#9654; Play</button>`;
    }

    html += `<button class="btn btn-fav ${isFav ? 'active' : ''}" onclick="toggleFav('series', ${seriesID}, this)">&#9829; ${isFav ? 'Favorited' : 'Favorite'}</button>
        </div>
        ${info.plot ? `<p class="detail-plot">${escHTML(info.plot)}</p>` : ''}`;

    if (seasons.length) {
        html += '<div class="season-bar">';
        for (const s of seasons) {
            html += `<button class="season-pill ${s === seasons[0] ? 'active' : ''}" onclick="selectSeason('${s}', this)">Season ${s}</button>`;
        }
        html += '</div><div id="episode-list"></div>';
    }

    content().innerHTML = html;
    window._seriesEpisodes = episodes;
    window._seriesName = name;
    window._seriesID = seriesID;
    window._seriesCover = cover;
    if (seasons.length) renderEpisodes(seasons[0]);
}

function selectSeason(season, el) {
    document.querySelectorAll('.season-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    renderEpisodes(season);
}

function renderEpisodes(season) {
    const episodes = window._seriesEpisodes[season] || [];
    let html = '<div class="episode-list">';
    for (const ep of episodes) {
        const links = seriesLinks(ep.id, ep.container_extension);
        const title = ep.title || `Episode ${ep.episode_num || '?'}`;
        const duration = ep.info?.duration || '';
        const plot = ep.info?.plot || '';
        const meta = { id: window._seriesID, type: 'series', name: window._seriesName, img: window._seriesCover };
        const playId = registerPlay(links, title, meta);

        html += `<div class="episode-item" onclick="playRegistered(${playId})">
            <button class="ep-play">&#9654;</button>
            <div class="ep-info">
                <div class="ep-title">Episode ${ep.episode_num || '?'}</div>
                ${ep.title ? `<div class="ep-sub">${escHTML(ep.title)}</div>` : ''}
                ${plot ? `<div class="ep-sub" style="margin-top:4px">${escHTML(plot.substring(0, 120))}${plot.length > 120 ? '...' : ''}</div>` : ''}
            </div>
            ${duration ? `<span class="ep-duration">${escHTML(duration)}</span>` : ''}
        </div>`;
    }
    html += '</div>';
    $('episode-list').innerHTML = html;
}

// ─── Search ───
function showSearch() {
    $('category-bar').classList.add('hidden');
    $('main').classList.remove('has-catbar');

    let html = `
        <div class="search-bar"><input type="text" id="global-search" placeholder="Search movies, shows, channels..." oninput="debounceSearch(this.value)"></div>
        <div class="scope-bar">
            <button class="scope-pill active" onclick="setScope('all', this)">All</button>
            <button class="scope-pill" onclick="setScope('live', this)">Live TV</button>
            <button class="scope-pill" onclick="setScope('movies', this)">Movies</button>
            <button class="scope-pill" onclick="setScope('series', this)">Series</button>
        </div>
        <div id="search-status"></div>
        <div id="search-results">
            <div class="empty-state"><div class="empty-icon">&#128269;</div><h3>Search across all content</h3><p>Type at least 2 characters</p></div>
        </div>`;
    content().innerHTML = html;
    window._searchScope = 'all';
    loadSearchData();
    setTimeout(() => $('global-search')?.focus(), 100);
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
    const q = $('global-search')?.value || '';
    if (q.length >= 2) runSearch(q);
}

async function loadSearchData() {
    const status = $('search-status');
    if (!status) return;
    let loaded = 0;
    const update = () => {
        if (loaded < 3) {
            status.innerHTML = `<div class="loading"><div class="spinner"></div>Indexing (${loaded}/3)...</div>`;
        } else {
            const count = (searchCache.live?.length || 0) + (searchCache.vod?.length || 0) + (searchCache.series?.length || 0);
            status.innerHTML = `<div style="font-size:12px;color:var(--text3);margin-bottom:8px">${count.toLocaleString()} items indexed</div>`;
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
    await Promise.all([load('live', 'get_live_streams'), load('vod', 'get_vod_streams'), load('series', 'get_series')]);
}

function runSearch(query) {
    const results = $('search-results');
    if (!results) return;
    if (query.length < 2) {
        results.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128269;</div><h3>Search across all content</h3><p>Type at least 2 characters</p></div>`;
        return;
    }
    const scope = window._searchScope;
    const q = query.toLowerCase();
    let html = '';

    if ((scope === 'all' || scope === 'live') && searchCache.live) {
        const matches = searchCache.live.filter(ch => ch.name.toLowerCase().includes(q)).slice(0, 50);
        if (matches.length) {
            window._searchChannels = matches;
            html += `<div class="section-heading">Live Channels (${matches.length})</div><div class="channel-list">`;
            for (let i = 0; i < matches.length; i++) {
                const ch = matches[i];
                html += `<div class="channel-item">
                    <div class="channel-icon">${ch.stream_icon ? `<img src="${escHTML(ch.stream_icon)}" onerror="this.outerHTML='<span class=placeholder>📡</span>'">` : '<span class="placeholder">📡</span>'}</div>
                    <div class="channel-info"><div class="ch-name">${escHTML(ch.name)}</div><div class="ch-live">Live</div></div>
                    <button class="play-btn-sm" onclick="playSearchChannel(${i})">&#9654;</button>
                </div>`;
            }
            html += '</div>';
        }
    }

    if ((scope === 'all' || scope === 'movies') && searchCache.vod) {
        const matches = searchCache.vod.filter(m => (m.name || '').toLowerCase().includes(q) || cleanTitle(m.name).toLowerCase().includes(q)).slice(0, 50);
        if (matches.length) {
            html += `<div class="section-heading">Movies (${matches.length})</div><div class="media-grid">`;
            for (const m of matches) {
                html += `<div class="media-card" onclick="openDetail(${m.stream_id}, 'movie')">
                    <div class="poster">${m.stream_icon ? `<img src="${escHTML(m.stream_icon)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>🎬</div>'">` : '<div class="no-img">🎬</div>'}
                    ${m.rating && m.rating !== '0' ? `<div class="rating-badge">★ ${escHTML(String(m.rating).slice(0,3))}</div>` : ''}</div>
                    <div class="card-title">${escHTML(cleanTitle(m.name))}</div>
                    ${itemYear(m) ? `<div class="card-year">${escHTML(String(itemYear(m)))}</div>` : ''}
                </div>`;
            }
            html += '</div>';
        }
    }

    if ((scope === 'all' || scope === 'series') && searchCache.series) {
        const matches = searchCache.series.filter(s => (s.name || '').toLowerCase().includes(q) || cleanTitle(s.name).toLowerCase().includes(q)).slice(0, 50);
        if (matches.length) {
            html += `<div class="section-heading">Series (${matches.length})</div><div class="media-grid">`;
            for (const s of matches) {
                html += `<div class="media-card" onclick="openDetail(${s.series_id}, 'series')">
                    <div class="poster">${s.cover ? `<img src="${escHTML(s.cover)}" loading="lazy" onerror="this.outerHTML='<div class=no-img>📺</div>'">` : '<div class="no-img">📺</div>'}
                    ${s.rating && s.rating !== '0' ? `<div class="rating-badge">★ ${escHTML(String(s.rating).slice(0,3))}</div>` : ''}</div>
                    <div class="card-title">${escHTML(cleanTitle(s.name))}</div>
                </div>`;
            }
            html += '</div>';
        }
    }

    if (!html) html = `<div class="empty-state"><div class="empty-icon">&#128269;</div><h3>No results</h3><p>No matches for "${escHTML(query)}"</p></div>`;
    results.innerHTML = html;
}

function playSearchChannel(index) {
    const channels = window._searchChannels;
    if (!channels) return;
    channelList = channels.map(ch => ({
        name: ch.name,
        urls: [{ label: 'M3U8', url: liveURL(ch.stream_id, 'm3u8') }, { label: 'TS', url: liveURL(ch.stream_id, 'ts') }]
    }));
    channelIndex = index;
    const ch = channelList[index];
    addToContinueWatching({ id: channels[index].stream_id, type: 'live', name: channels[index].name, img: channels[index].stream_icon });
    openPlayer(ch.name, ch.urls, true);
}

// ─── Favorites ───
function isFavorite(type, id) { return favorites.some(f => f.type === type && f.id === id); }

function toggleFav(type, id, btnEl) {
    const idx = favorites.findIndex(f => f.type === type && f.id === id);
    if (idx >= 0) {
        favorites.splice(idx, 1);
        if (btnEl) { btnEl.classList.remove('active'); if (btnEl.textContent.includes('Favorite')) btnEl.innerHTML = '&#9829; Favorite'; }
    } else {
        const name = document.querySelector('.hero-title')?.textContent || document.querySelector('.ch-name')?.textContent || '';
        favorites.push({ type, id, name });
        if (btnEl) { btnEl.classList.add('active'); if (btnEl.textContent.includes('Favorite')) btnEl.innerHTML = '&#9829; Favorited'; }
    }
    localStorage.setItem('ayange_favs', JSON.stringify(favorites));
}

function showFavorites() {
    $('category-bar').classList.add('hidden');
    $('main').classList.remove('has-catbar');

    if (!favorites.length) {
        content().innerHTML = `<div class="empty-state"><div class="empty-icon">&#128148;</div><h3>No Favorites</h3><p>Tap the heart icon to save content here.</p></div>`;
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
                <div class="channel-icon"><span class="placeholder">📡</span></div>
                <div class="channel-info"><div class="ch-name">${escHTML(cleanTitle(f.name))}</div></div>
                <button class="fav-btn active" onclick="toggleFav('live', ${f.id}, this); setTimeout(showFavorites, 200)">&#9829;</button>
                <button class="play-btn-sm" onclick="playQuickLive(${f.id})">&#9654;</button>
            </div>`;
        }
        html += '</div>';
    }
    if (vod.length) {
        html += `<div class="fav-section-title">Movies</div><div class="channel-list">`;
        for (const f of vod) {
            html += `<div class="channel-item" onclick="openDetail(${f.id}, 'movie')">
                <div class="channel-icon"><span class="placeholder">🎬</span></div>
                <div class="channel-info"><div class="ch-name">${escHTML(cleanTitle(f.name))}</div></div>
                <span style="color:var(--text3);font-size:18px">&#8250;</span>
            </div>`;
        }
        html += '</div>';
    }
    if (series.length) {
        html += `<div class="fav-section-title">Series</div><div class="channel-list">`;
        for (const f of series) {
            html += `<div class="channel-item" onclick="openDetail(${f.id}, 'series')">
                <div class="channel-icon"><span class="placeholder">📺</span></div>
                <div class="channel-info"><div class="ch-name">${escHTML(cleanTitle(f.name))}</div></div>
                <span style="color:var(--text3);font-size:18px">&#8250;</span>
            </div>`;
        }
        html += '</div>';
    }
    content().innerHTML = html;
}

// ─── Filter ───
function filterList(query, itemSelector, textSelector) {
    const items = document.querySelectorAll(itemSelector);
    const q = query.toLowerCase();
    items.forEach(item => {
        const text = item.querySelector(textSelector)?.textContent?.toLowerCase() || '';
        item.style.display = text.includes(q) ? '' : 'none';
    });
}

// ─── Subtitles ───
let _subTracks = [];      // [{ label, lang, blobUrl }]
let _subActiveIdx = -1;   // -1 = off

// Convert SubRip (.srt) to WebVTT — really just commas → periods in timestamps + header.
function srtToVtt(srt) {
    const cleaned = String(srt).replace(/\r+/g, '').replace(/^﻿/, '');
    const body = cleaned.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
    return 'WEBVTT\n\n' + body;
}

function ensureVtt(text) {
    return /^WEBVTT/.test(text.trim()) ? text : srtToVtt(text);
}

function attachSubtitle(label, lang, vttText) {
    const blob = new Blob([vttText], { type: 'text/vtt' });
    const blobUrl = URL.createObjectURL(blob);
    _subTracks.push({ label, lang: lang || 'en', blobUrl });
    addTrackElement(_subTracks.length - 1);
    selectSub(_subTracks.length - 1);
    renderSubMenu();
}

function addTrackElement(idx) {
    const t = _subTracks[idx];
    const video = $('video-player');
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = t.label;
    el.srclang = t.lang;
    el.src = t.blobUrl;
    el.dataset.subidx = String(idx);
    video.appendChild(el);
}

function selectSub(idx) {
    _subActiveIdx = idx;
    const video = $('video-player');
    if (video.textTracks) {
        Array.from(video.textTracks).forEach(tt => { tt.mode = 'disabled'; });
    }
    if (idx >= 0) {
        // Track elements don't always populate textTracks immediately after src change,
        // so we wait briefly before forcing the mode.
        const apply = () => {
            video.querySelectorAll('track').forEach(trackEl => {
                if (parseInt(trackEl.dataset.subidx) === idx && trackEl.track) {
                    trackEl.track.mode = 'showing';
                }
            });
        };
        apply();
        setTimeout(apply, 100);
    }
    renderSubMenu();
}

function clearSubs() {
    _subTracks.forEach(t => URL.revokeObjectURL(t.blobUrl));
    _subTracks = [];
    _subActiveIdx = -1;
    const video = $('video-player');
    if (video) video.querySelectorAll('track').forEach(t => t.remove());
    $('cc-menu')?.classList.add('hidden');
    $('cc-results')?.classList.add('hidden');
    $('cc-status')?.classList.add('hidden');
    renderSubMenu();
}

function toggleSubMenu(e) {
    e?.stopPropagation();
    const menu = $('cc-menu');
    menu.classList.toggle('hidden');
    if (!menu.classList.contains('hidden')) {
        renderSubMenu();
        setTimeout(() => document.addEventListener('click', _closeSubMenuOnOutside, { once: true }), 0);
    }
}

function _closeSubMenuOnOutside(e) {
    const menu = $('cc-menu');
    const btn = $('cc-btn');
    if (menu && !menu.contains(e.target) && e.target !== btn) {
        menu.classList.add('hidden');
    } else {
        document.addEventListener('click', _closeSubMenuOnOutside, { once: true });
    }
}

function renderSubMenu() {
    const tracks = $('cc-tracks');
    if (!tracks) return;
    let html = `<button class="cc-track-item${_subActiveIdx === -1 ? ' active' : ''}" onclick="selectSub(-1)">
        <span>Off</span>${_subActiveIdx === -1 ? '<span class="check">✓</span>' : ''}
    </button>`;
    _subTracks.forEach((t, i) => {
        html += `<button class="cc-track-item${_subActiveIdx === i ? ' active' : ''}" onclick="selectSub(${i})">
            <span>${escHTML(t.label)}</span>${_subActiveIdx === i ? '<span class="check">✓</span>' : ''}
        </button>`;
    });
    tracks.innerHTML = html;
    $('cc-btn')?.classList.toggle('active', _subActiveIdx >= 0);
}

function pickSubFile() { $('sub-file-input').click(); }

async function onSubFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
        const text = await file.text();
        const label = file.name.replace(/\.(srt|vtt)$/i, '');
        attachSubtitle(label, 'en', ensureVtt(text));
        showSubStatus(`Loaded ${file.name}`);
    } catch (err) {
        showSubStatus(`Failed to load: ${err.message}`, true);
    }
}

function showSubStatus(msg, isErr) {
    const el = $('cc-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', !!isErr);
    el.classList.remove('hidden');
    clearTimeout(window._subStatusTimer);
    window._subStatusTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ─── OpenSubtitles ───
// OpenSubtitles returns JSON like {"message":"..."} or {"errors":["..."]} on failure.
// Fall back to status text / raw body so the user sees something actionable.
async function extractOSError(r) {
    let body = '';
    try { body = await r.text(); } catch {}
    try {
        const j = JSON.parse(body);
        const msg = j.message || (Array.isArray(j.errors) ? j.errors.join('; ') : j.error);
        if (msg) return `${r.status} ${msg}`;
    } catch {}
    return `${r.status} ${body || r.statusText || 'request failed'}`.trim().slice(0, 300);
}

function getOSKey() {
    let key = localStorage.getItem('ayange_os_key_v2') || '';
    if (!key) {
        key = (prompt('Enter your OpenSubtitles API key (free at opensubtitles.com/api):') || '').trim();
        if (key) localStorage.setItem('ayange_os_key_v2', key);
    }
    return key;
}

async function searchOpenSubs() {
    const key = getOSKey();
    if (!key) return;
    const fullTitle = $('player-title').textContent || '';
    const yearMatch = YEAR_IN_TITLE_RE.exec(fullTitle);
    const year = yearMatch ? yearMatch[1] : '';
    const query = cleanTitle(fullTitle).replace(/\s*\(\d{4}\).*$/, '').trim();
    if (!query) { showSubStatus('No title to search', true); return; }

    const results = $('cc-results');
    results.innerHTML = `<div class="cc-loading">Searching for "${escHTML(query)}"${year ? ' (' + year + ')' : ''}…</div>`;
    results.classList.remove('hidden');

    try {
        const params = new URLSearchParams({ q: query, lang: 'en' });
        if (year) params.set('year', year);
        const r = await fetch('/subs/search?' + params, { headers: { 'X-OS-Key': key } });
        if (!r.ok) throw new Error(await extractOSError(r));
        const data = await r.json();
        const list = data.data || [];
        if (!list.length) {
            results.innerHTML = '<div class="cc-loading">No subtitles found.</div>';
            return;
        }
        let html = '';
        for (const s of list.slice(0, 15)) {
            const a = s.attributes || {};
            const f = (a.files || [])[0] || {};
            if (!f.file_id) continue;
            const release = a.release || a.feature_details?.title || 'Subtitle';
            const yr = a.feature_details?.year || '';
            const dl = a.download_count ? `${a.download_count.toLocaleString()} downloads` : '';
            const lang = (a.language || 'en').toUpperCase();
            const safeLabel = (release + ' · ' + lang).replace(/['"\\]/g, '');
            html += `<button class="cc-result-item" onclick="downloadOSSub(${f.file_id}, '${escHTML(safeLabel)}')">
                <div class="cc-result-title">${escHTML(release)}</div>
                <div class="cc-result-sub">${escHTML(lang)}${yr ? ' · ' + escHTML(String(yr)) : ''}${dl ? ' · ' + escHTML(dl) : ''}</div>
            </button>`;
        }
        results.innerHTML = html || '<div class="cc-loading">No usable results.</div>';
    } catch (err) {
        results.innerHTML = `<div class="cc-loading error">Search failed: ${escHTML(err.message)}</div>`;
    }
}

async function downloadOSSub(fileId, label) {
    const key = getOSKey();
    if (!key) return;
    showSubStatus('Downloading subtitle…');
    try {
        const r = await fetch('/subs/get?file_id=' + encodeURIComponent(fileId), { headers: { 'X-OS-Key': key } });
        if (!r.ok) throw new Error(await extractOSError(r));
        const text = await r.text();
        attachSubtitle(label, 'en', ensureVtt(text));
        $('cc-results').classList.add('hidden');
        showSubStatus('Subtitle loaded');
    } catch (err) {
        showSubStatus(`Download failed: ${err.message}`, true);
    }
}

// ─── Player ───
// Unmute on first user interaction with the player
function setupUnmute() {
    const video = $('video-player');
    const overlay = $('player-overlay');
    function doUnmute() {
        if (video.muted) {
            video.muted = false;
        }
        overlay.removeEventListener('click', doUnmute);
        overlay.removeEventListener('touchstart', doUnmute);
    }
    overlay.addEventListener('click', doUnmute);
    overlay.addEventListener('touchstart', doUnmute);
}

function openPlayer(title, links, isChannelSurf = false) {
    clearSubs();
    playerLinks = links;
    playerLinkIndex = 0;
    $('player-overlay').classList.remove('hidden');
    $('player-title').textContent = title;
    $('player-error').classList.add('hidden');
    $('video-player').style.display = '';
    $('video-player').muted = false;

    if (isChannelSurf && channelList.length > 1) {
        $('channel-nav').classList.remove('hidden');
        updateChannelNav();
    } else {
        $('channel-nav').classList.add('hidden');
    }
    playCurrentLink();
    setupUnmute();
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

    if (hls) { hls.destroy(); hls = null; }
    if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
    video.onerror = null;
    video.onloadeddata = null;
    video.removeAttribute('src');
    video.load();

    const url = link.url;
    console.log('[AyangeTV] Trying:', link.label, url);

    // User-added <track> elements stay in the DOM across src changes; we just
    // need to re-apply the active selection once the new media is ready.
    video.onloadeddata = () => {
        console.log('[AyangeTV] Video data loaded');
        if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
        if (_subActiveIdx >= 0) selectSub(_subActiveIdx);
    };

    const hlsAvailable = typeof Hls !== 'undefined' && Hls.isSupported();

    if (url.endsWith('.m3u8') && hlsAvailable) {
        try {
            hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, startLevel: -1 });
            hls.loadSource(url);
            hls.attachMedia(video);

            let manifestLoaded = false;
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                manifestLoaded = true;
                video.play().catch(() => {});
            });

            hls.on(Hls.Events.ERROR, (_, data) => {
                console.log('[AyangeTV] HLS error:', data.type, data.details, data.fatal);
                if (data.fatal) { hls.destroy(); hls = null; tryNextLink(); }
            });

            playbackTimer = setTimeout(() => {
                if (!manifestLoaded || video.readyState < 2) {
                    if (hls) { hls.destroy(); hls = null; }
                    tryNextLink();
                }
            }, 25000);
        } catch (e) {
            console.error('[AyangeTV] HLS init error:', e);
            tryNextLink();
        }
    } else if (url.endsWith('.m3u8') && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {});
        video.onerror = () => tryNextLink();
        playbackTimer = setTimeout(() => { if (video.readyState < 2) tryNextLink(); }, 25000);
    } else {
        video.src = url;
        video.play().catch(() => {});
        video.onerror = () => tryNextLink();
        playbackTimer = setTimeout(() => { if (video.readyState < 2) tryNextLink(); }, 30000);
    }
}

function tryNextLink() {
    if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
    playerLinkIndex++;
    if (playerLinkIndex < playerLinks.length) playCurrentLink();
    else showPlayerError('Playback failed. This content may not be available in a browser-compatible format.');
}

function showPlayerError(msg) {
    $('video-player').style.display = 'none';
    $('player-error').classList.remove('hidden');
    $('player-error-msg').textContent = msg;
    $('try-next-btn').style.display = playerLinkIndex < playerLinks.length - 1 ? '' : 'none';
}

function closePlayer() {
    if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
    $('player-overlay').classList.add('hidden');
    const video = $('video-player');
    video.pause();
    video.onerror = null;
    video.onloadeddata = null;
    video.removeAttribute('src');
    video.load();
    if (hls) { hls.destroy(); hls = null; }
    clearSubs();
    channelList = [];
    document.removeEventListener('keydown', playerKeyHandler);
}

function playWithLinks(links, title) {
    channelList = [];
    openPlayer(title, links, false);
}

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

function playerKeyHandler(e) {
    if (e.key === 'Escape') { closePlayer(); e.preventDefault(); }
    if (e.key === ' ') { const v = $('video-player'); v.paused ? v.play() : v.pause(); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { $('video-player').currentTime -= 10; e.preventDefault(); }
    if (e.key === 'ArrowRight') { $('video-player').currentTime += 10; e.preventDefault(); }
    if (e.key === 'ArrowUp' && channelList.length) { prevChannel(); e.preventDefault(); }
    if (e.key === 'ArrowDown' && channelList.length) { nextChannel(); e.preventDefault(); }
    if (e.key === 'f') { toggleFullscreen(); e.preventDefault(); }
}

function toggleFullscreen() {
    const el = $('player-overlay');
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen().catch(() => {});
}

// ─── Init ───
setGreeting();
switchTab('movies');
