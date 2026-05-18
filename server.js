'use strict';

const express = require('express');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════

const BASE_URL    = 'https://moviebox.ph';
const H5_API      = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const PLAYER_API  = 'https://h5.aoneroom.com/wefeed-h5-bff';
const UA          = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const DEVICE_UUID = process.env.DEVICE_UUID || 'd8c3539e-2e46-4000-af20-7046a856e30a';

// ══════════════════════════════════════════════════════════════════
// CORS middleware
// ══════════════════════════════════════════════════════════════════

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',   '*');
  res.setHeader('Access-Control-Allow-Methods',  'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, X-Stream-Resolution');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ══════════════════════════════════════════════════════════════════
// TokenManager
// ══════════════════════════════════════════════════════════════════

const TokenManager = (() => {
  let _token     = null;
  let _expireAt  = 0;
  let _inflightP = null;

  async function _fetchGuest() {
    const res = await fetch(`${H5_API}/user/token`, {
      method:  'POST',
      headers: _baseHeaders(),
      body: JSON.stringify({
        uuid:       DEVICE_UUID,
        deviceType: 'Android',
        appVersion: '4.2.0',
      }),
    });
    if (!res.ok) throw new Error(`Token endpoint HTTP ${res.status}`);
    const body = await res.json();
    if (body.code !== 0) throw new Error(`Token API error ${body.code}: ${body.message}`);
    const { token, expireTime } = body.data;
    _token    = token;
    _expireAt = expireTime * 1000;
    return token;
  }

  async function getToken() {
    if (_token && _expireAt - 60_000 > Date.now()) return _token;
    if (!_inflightP) {
      _inflightP = _fetchGuest().finally(() => { _inflightP = null; });
    }
    return _inflightP;
  }

  function invalidate() { _token = null; _expireAt = 0; }

  return { getToken, invalidate };
})();

// ══════════════════════════════════════════════════════════════════
// Header helpers
// ══════════════════════════════════════════════════════════════════

function _baseHeaders(extra = {}) {
  return {
    'accept':             'application/json',
    'accept-language':    'en-US,en;q=0.9',
    'content-type':       'application/json',
    'user-agent':         UA,
    'x-client-info':      JSON.stringify({ timezone: 'Asia/Dhaka' }),
    'x-request-lang':     'en',
    'origin':             BASE_URL,
    'referer':            `${BASE_URL}/`,
    'sec-ch-ua':          '"Chromium";v="137", "Not/A)Brand";v="24"',
    'sec-ch-ua-mobile':   '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'cross-site',
    ...extra,
  };
}

async function apiHeaders(extra = {}) {
  const token = await TokenManager.getToken();
  return _baseHeaders({ authorization: `Bearer ${token}`, ...extra });
}

// ══════════════════════════════════════════════════════════════════
// Resilient fetch (auto-retry on 401 / code -1)
// ══════════════════════════════════════════════════════════════════

async function resilientFetch(fetchFn) {
  let res = await fetchFn(await apiHeaders());

  const isAuthError = async (r) => {
    if (r.status === 401) return true;
    if (!r.ok) return false;
    try { const j = await r.clone().json(); return j.code === -1; }
    catch { return false; }
  };

  if (await isAuthError(res)) {
    TokenManager.invalidate();
    res = await fetchFn(await apiHeaders());
  }
  return res;
}

async function apiGet(url, params = {}) {
  const qs   = new URLSearchParams(params).toString();
  const full = qs ? `${url}?${qs}` : url;
  const res  = await resilientFetch(h => fetch(full, { headers: h }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`API error ${body.code}: ${body.message}`);
  return body.data;
}

async function apiPost(url, bodyObj = {}) {
  const res = await resilientFetch(h =>
    fetch(url, { method: 'POST', headers: h, body: JSON.stringify(bodyObj) })
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`API error ${body.code}: ${body.message}`);
  return body.data;
}

// ══════════════════════════════════════════════════════════════════
// Data fetchers
// ══════════════════════════════════════════════════════════════════

async function fetchHomeData() {
  const data = await apiGet(`${H5_API}/home`, { host: 'moviebox.ph' });
  const ops  = data?.operatingList || [];
  const sections = [];

  for (const op of ops) {
    const title = op.title || '';

    if (op.banner) {
      const items = (op.banner.items || [])
        .filter(i => i.title && !i.title.includes('Communities'))
        .map(i => ({
          name:       i.title,
          poster_url: i.image?.url || i.subject?.cover?.url || null,
          url:        i.detailPath ? `${BASE_URL}/detail/${i.detailPath}` : null,
          badge:      i.subject?.corner || null,
          slug:       i.detailPath || null,
        }));
      sections.push({ section: 'Banner', count: items.length, movies: items, more_url: null });
      continue;
    }

    const subs = op.subjects || [];
    if (!subs.length || !title) continue;

    sections.push({
      section:  title,
      count:    subs.length,
      more_url: null,
      movies:   subs.map(s => ({
        name:       s.title || s.name,
        poster_url: s.cover?.url || s.thumbnail || null,
        url:        s.detailPath ? `${BASE_URL}/detail/${s.detailPath}` : null,
        slug:       s.detailPath || null,
        badge:      s.corner || null,
        blurhash:   s.cover?.blurHash || null,
      })),
    });
  }
  return sections;
}

async function fetchCategoryData(category) {
  const tabMap = { movie: '2', 'tv-series': '5', 'animated-series': '6' };
  const data   = await apiGet(`${H5_API}/home/movieFilter`, {
    tabId:      tabMap[category] || '2',
    filterType: JSON.stringify({ classify: 'All', country: 'All', genre: 'All', sort: 'ForYou', year: 'All' }),
    page:       '0',
    perPage:    '60',
  });
  const items  = data?.items || [];
  const label  = { movie: 'All Movies', 'tv-series': 'All TV Series' }[category] ?? 'All Animation';
  return [{
    section:  label,
    more_url: null,
    count:    items.length,
    movies:   items.map(s => ({
      name:       s.title || s.name || '',
      poster_url: s.cover?.url || null,
      url:        s.detailPath ? `${BASE_URL}/detail/${s.detailPath}` : null,
      slug:       s.detailPath || null,
      badge:      s.corner || null,
      blurhash:   s.cover?.blurHash || null,
      year:       s.releaseDate || null,
      rating:     s.imdbRatingValue || null,
    })),
  }];
}

async function fetchRankingData() {
  const data  = await apiGet(`${H5_API}/subject/rank-list`);
  const lists = Array.isArray(data) ? data : [data];
  return lists.map((list, _) => {
    const items = list.items || list.subjects || [];
    return {
      section:  list.title || 'Most Watched',
      more_url: null,
      count:    items.length,
      movies:   items.map((s, i) => ({
        name:       s.title || s.name || '',
        poster_url: s.cover?.url || null,
        url:        s.detailPath ? `${BASE_URL}/detail/${s.detailPath}` : null,
        slug:       s.detailPath || null,
        rank:       String(i + 1),
        badge:      s.corner || null,
      })),
    };
  });
}

async function fetchStreams(subjectId, detailPath, se, ep) {
  const data = await apiGet(`${H5_API}/subject/play`, { subjectId, detailPath, se, ep });
  return data?.streams || [];
}

async function discoverDomain() {
  try {
    const res = await fetch(`${H5_API}/media-player/get-domain`,
      { headers: await apiHeaders({ 'X-Client-Type': 'h5' }) });
    if (res.ok) {
      const d = await res.json();
      return (d.data || 'https://123movienow.cc').replace(/\/+$/, '');
    }
  } catch {}
  return 'https://123movienow.cc';
}

// ══════════════════════════════════════════════════════════════════
// Helper: send JSON
// ══════════════════════════════════════════════════════════════════

function send(res, data, status = 200) {
  res.status(status).json(data);
}

function notFound(res, msg = 'Not found') {
  send(res, { error: msg }, 404);
}

// ══════════════════════════════════════════════════════════════════
// Routes — Root
// ══════════════════════════════════════════════════════════════════

app.get('/', (_, res) => send(res, {
  api:     'MovieBox API',
  version: '4.2.0',
  runtime: 'Node.js / Express (Render)',
  endpoints: {
    home:      { '/home': 'Home feed', '/home/sections': 'Section names', '/home/section/:name': 'Section by name', '/home/banner': 'Banner', '/home/trending': 'Trending', '/home/hot': 'Hot', '/home/cinema': 'Cinema' },
    movies:    { '/movies': 'All movies', '/movies/sections': 'Sections', '/movies/section/:name': 'Section by name' },
    tv_series: { '/tv-series': 'All TV series', '/tv-series/sections': 'Sections', '/tv-series/section/:name': 'Section by name' },
    animation: { '/animation': 'All animation', '/animation/sections': 'Sections', '/animation/section/:name': 'Section by name' },
    ranking:   { '/ranking': 'Ranking lists', '/ranking/sections': 'Sections', '/ranking/section/:name': 'Section by name' },
    search:    { '/search?q=': 'Search titles', '/search/suggest?q=': 'Autocomplete' },
    detail:    { '/detail/:slug': 'Full metadata + streams', '/episodes/:slug': 'Episode list' },
    streaming: { '/api/stream/:id?detail_path=': 'Raw stream URLs (JSON)', '/watch/:id?detail_path=&resolution=': 'Zero-buffer video proxy' },
  },
}));

// ══════════════════════════════════════════════════════════════════
// Routes — Home
// ══════════════════════════════════════════════════════════════════

app.get('/home', async (_, res) => {
  try {
    const sections = await fetchHomeData();
    send(res, { source: `${H5_API}/home`, total_sections: sections.length, sections });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/home/sections', async (_, res) => {
  try {
    const sections = await fetchHomeData();
    send(res, { total: sections.length, sections: sections.map(s => ({ name: s.section, count: s.count, more_url: s.more_url })) });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/home/banner', async (_, res) => {
  try {
    const sections = await fetchHomeData();
    const banner   = sections.find(s => s.section === 'Banner');
    send(res, { count: banner?.count ?? 0, featured: banner?.movies ?? [] });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/home/trending', async (_, res) => {
  try {
    const sections = await fetchHomeData();
    const match    = sections.find(s => ['trending now', 'popular movie'].some(kw => s.section.toLowerCase().includes(kw)));
    match ? send(res, match) : notFound(res, 'Trending section not found');
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/home/hot', async (_, res) => {
  try {
    const sections = await fetchHomeData();
    const match    = sections.find(s => s.section.toLowerCase().includes('hot'));
    match ? send(res, match) : notFound(res, 'Hot section not found');
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/home/cinema', async (_, res) => {
  try {
    const sections = await fetchHomeData();
    const match    = sections.find(s => ['cinema', 'popular series'].some(kw => s.section.toLowerCase().includes(kw)));
    match ? send(res, match) : notFound(res, 'Cinema section not found');
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/home/section/:name', async (req, res) => {
  try {
    const name    = req.params.name.toLowerCase();
    const sections = await fetchHomeData();
    const matched  = sections.filter(s => s.section.toLowerCase().includes(name));
    matched.length
      ? send(res, { results: matched })
      : send(res, { message: `No section matching '${req.params.name}'`, available: sections.map(s => s.section) }, 404);
  } catch (e) { send(res, { error: e.message }, 500); }
});

// ══════════════════════════════════════════════════════════════════
// Routes — Categories (movies / tv-series / animation)
// ══════════════════════════════════════════════════════════════════

function categoryRoutes(path, category) {
  app.get(`/${path}`, async (_, res) => {
    try {
      const sections = await fetchCategoryData(category);
      send(res, { source: `${H5_API}/home/movieFilter`, total_sections: sections.length, sections });
    } catch (e) { send(res, { error: e.message }, 500); }
  });

  app.get(`/${path}/sections`, async (_, res) => {
    try {
      const sections = await fetchCategoryData(category);
      send(res, { total: sections.length, sections: sections.map(s => ({ name: s.section, count: s.count, more_url: s.more_url })) });
    } catch (e) { send(res, { error: e.message }, 500); }
  });

  app.get(`/${path}/section/:name`, async (req, res) => {
    try {
      const name     = req.params.name.toLowerCase();
      const sections = await fetchCategoryData(category);
      const matched  = sections.filter(s => s.section.toLowerCase().includes(name));
      matched.length
        ? send(res, { results: matched })
        : send(res, { message: `No section matching '${req.params.name}'`, available: sections.map(s => s.section) }, 404);
    } catch (e) { send(res, { error: e.message }, 500); }
  });
}

categoryRoutes('movies',    'movie');
categoryRoutes('tv-series', 'tv-series');
categoryRoutes('animation', 'animated-series');

// ══════════════════════════════════════════════════════════════════
// Routes — Ranking
// ══════════════════════════════════════════════════════════════════

app.get('/ranking', async (_, res) => {
  try {
    const sections = await fetchRankingData();
    send(res, { source: `${H5_API}/subject/rank-list`, total_sections: sections.length, sections });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/ranking/sections', async (_, res) => {
  try {
    const sections = await fetchRankingData();
    send(res, { total: sections.length, sections: sections.map(s => ({ name: s.section, count: s.count, more_url: s.more_url })) });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/ranking/section/:name', async (req, res) => {
  try {
    const name     = req.params.name.toLowerCase();
    const sections = await fetchRankingData();
    const matched  = sections.filter(s => s.section.toLowerCase().includes(name));
    matched.length
      ? send(res, { results: matched })
      : send(res, { message: `No section matching '${req.params.name}'`, available: sections.map(s => s.section) }, 404);
  } catch (e) { send(res, { error: e.message }, 500); }
});

// ══════════════════════════════════════════════════════════════════
// Routes — Search
// ══════════════════════════════════════════════════════════════════

app.get('/search/suggest', async (req, res) => {
  const q = req.query.q;
  if (!q) return send(res, { error: 'q parameter required' }, 400);
  try {
    const data = await apiPost(`${H5_API}/subject/search-suggest`, { keyword: q, perPage: 10 });
    send(res, { query: q, suggestions: (data?.items || []).map(i => i.word).filter(Boolean) });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return send(res, { error: 'q parameter required' }, 400);
  try {
    const data   = await apiPost(`${H5_API}/subject/search`, { keyword: q, perPage: 30, page: 0 });
    const movies = (data?.items || []).map(s => ({
      name:       s.title || '',
      poster_url: s.cover?.url || null,
      url:        s.detailPath ? `${BASE_URL}/detail/${s.detailPath}` : null,
      slug:       s.detailPath || null,
      badge:      s.corner || null,
      blurhash:   s.cover?.blurHash || null,
    }));
    send(res, { query: q, count: movies.length, movies });
  } catch (e) { send(res, { error: e.message }, 500); }
});

// ══════════════════════════════════════════════════════════════════
// Routes — Detail & Episodes
// ══════════════════════════════════════════════════════════════════

app.get('/detail/:slug', async (req, res) => {
  try {
    const data     = await apiGet(`${H5_API}/detail`, { detailPath: req.params.slug });
    const subject  = data.subject  || {};
    const resource = data.resource || {};
    const streams  = resource.streams || [];
    send(res, {
      slug:   req.params.slug,
      source: `${H5_API}/detail`,
      metadata: {
        id:           subject.subjectId,
        title:        subject.title,
        description:  subject.description,
        release_date: subject.releaseDate,
        duration:     subject.duration,
        genre:        subject.genre,
        country:      subject.countryName,
        imdb_rating:  subject.imdbRatingValue,
        poster:       subject.cover?.url || null,
        badge:        subject.corner,
        dubs:         subject.dubs || [],
        top_cast:     data.stars || data.topCast || [],
        seasons:      resource.seasons || [],
        user_reviews: (data.reviews || []).map(r => ({
          user:       r.user?.nickname || null,
          content:    r.content,
          created_at: r.createdAt || null,
        })),
      },
      streams: {
        mp4: streams.filter(s => s.format === 'MP4').map(s => s.url),
        hls: streams.filter(s => s.format === 'HLS').map(s => s.url),
      },
    });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/episodes/:slug', async (req, res) => {
  try {
    const data        = await apiGet(`${H5_API}/detail`, { detailPath: req.params.slug });
    const resource    = data.resource || {};
    const subject     = data.subject  || {};
    const seasonsData = resource.seasons || [];
    const subjectId   = subject.subjectId || null;

    if (!seasonsData.length)
      return send(res, { slug: req.params.slug, message: 'No seasons found — this may be a movie.', seasons: [] });

    const seasons = seasonsData.map(s => {
      const episodes = [];
      for (let i = 1; i <= (s.maxEp || 0); i++) {
        episodes.push({
          name:           `Episode ${i}`,
          ep:             i,
          se:             s.se,
          watch_url:      subjectId ? `/watch/${subjectId}?detail_path=${req.params.slug}&se=${s.se}&ep=${i}` : null,
          stream_api_url: subjectId ? `/api/stream/${subjectId}?detail_path=${req.params.slug}&se=${s.se}&ep=${i}` : null,
        });
      }
      return { season: s.se, episode_count: s.maxEp || 0, episodes };
    });

    send(res, { slug: req.params.slug, subject_id: subjectId, total_seasons: seasons.length, seasons });
  } catch (e) { send(res, { error: e.message }, 500); }
});

// ══════════════════════════════════════════════════════════════════
// Routes — Streaming
// ══════════════════════════════════════════════════════════════════

app.get('/api/stream/:id', async (req, res) => {
  const detailPath = req.query.detail_path;
  if (!detailPath) return send(res, { error: 'detail_path is required' }, 400);
  const se = req.query.se || '0';
  const ep = req.query.ep || '0';

  try {
    const streams = await fetchStreams(req.params.id, detailPath, se, ep);
    if (!streams.length) return notFound(res, 'No streams found');

    const formatted = streams
      .map(s => ({
        resolution: s.resolutions ? `${s.resolutions}p` : 'Unknown',
        format:     s.format || null,
        url:        s.url,
        size_bytes: s.size || null,
        id:         s.id   || null,
      }))
      .sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));

    let subtitles = [];
    const streamId = streams[0]?.id;
    if (streamId) {
      try {
        const capData = await apiGet(`${H5_API}/subject/caption`, {
          format: 'MP4', id: streamId, subjectId: req.params.id, detailPath,
        });
        subtitles = (capData?.captions || [])
          .filter(s => s.lan === 'en' || s.lanName?.toLowerCase().includes('english'))
          .map(s => ({ language: s.lanName || 'English', url: s.url }));
      } catch (err) {
        console.error('Subtitle fetch failed:', err.message);
      }
    }

    send(res, {
      subject_id:  req.params.id,
      detail_path: detailPath,
      season:      parseInt(se),
      episode:     parseInt(ep),
      count:       formatted.length,
      sources:     formatted,
      subtitles,
    });
  } catch (e) { send(res, { error: e.message }, 500); }
});

app.get('/watch/:id', async (req, res) => {
  const detailPath = req.query.detail_path;
  if (!detailPath) return send(res, { error: 'detail_path is required' }, 400);
  const se         = req.query.se         || '0';
  const ep         = req.query.ep         || '0';
  const resolution = parseInt(req.query.resolution || '0', 10);

  try {
    const streams = await fetchStreams(req.params.id, detailPath, se, ep);
    if (!streams.length) return notFound(res, 'No streams found');

    const stream = resolution > 0
      ? (streams.find(s => parseInt(s.resolutions) === resolution) ?? streams[streams.length - 1])
      : [...streams].sort((a, b) => parseInt(b.resolutions) - parseInt(a.resolutions))[0];

    if (!stream.url) return notFound(res, 'Stream URL is empty');

    const cdnDomain  = await discoverDomain();
    const cdnHeaders = {
      Referer:      `${cdnDomain}/`,
      Origin:       cdnDomain,
      Accept:       '*/*',
      'User-Agent': UA,
    };
    if (req.headers.range) cdnHeaders['Range'] = req.headers.range;

    const vidResp = await fetch(stream.url, { headers: cdnHeaders, redirect: 'follow' });

    if (vidResp.status !== 200 && vidResp.status !== 206) {
      const errBody = await vidResp.text();
      return send(res, { error: `CDN returned ${vidResp.status}`, detail: errBody.slice(0, 200) }, vidResp.status);
    }

    res.status(vidResp.status);
    res.setHeader('Accept-Ranges',        'bytes');
    res.setHeader('Content-Type',         vidResp.headers.get('content-type') || 'video/mp4');
    res.setHeader('X-Stream-Resolution',  `${stream.resolutions}p`);
    res.setHeader('Cache-Control',        'no-store');

    const cl = vidResp.headers.get('content-length');
    const cr = vidResp.headers.get('content-range');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range',  cr);

    // Pipe stream directly — zero buffering
    vidResp.body.pipe(res);
  } catch (e) { send(res, { error: e.message }, 500); }
});

// ══════════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`MovieBox API running on port ${PORT}`);
});
