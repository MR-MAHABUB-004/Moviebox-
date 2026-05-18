/**
 * MovieBox API Wrapper  —  v2  (auto-refreshing anonymous token)
 *
 * TOKEN EXPIRY FIX
 * ────────────────
 * The original code required a static Bearer JWT passed at construction
 * time. JWTs issued by MovieBox expire in ~24 h, so the wrapper would
 * silently fail with HTTP 401 / API code -1.
 *
 * Fix applied: the site issues *anonymous guest tokens* to any visitor
 * without login. We POST to /user/token with a stable UUID (device ID)
 * and receive a fresh JWT. The token is cached in memory and
 * transparently re-fetched whenever a request fails with 401 or
 * API error code -1 (auth error). No manual token management needed.
 *
 * Usage (no token required):
 *   const api = new MovieBoxAPI();
 *   const home = await api.getHome();
 */

class MovieBoxAPI {
  /**
   * @param {object} [options]
   * @param {string} [options.lang='en']
   * @param {string} [options.timezone='Asia/Dhaka']
   * @param {string} [options.host='moviebox.ph']
   * @param {string} [options.uuid]  - stable device UUID (auto-generated if omitted)
   */
  constructor({ lang = 'en', timezone = 'Asia/Dhaka', host = 'moviebox.ph', uuid } = {}) {
    this.lang     = lang;
    this.timezone = timezone;
    this.host     = host;

    // Stable "device" UUID – reuse across calls so the backend treats us
    // as the same client (same anonymous account / same token pool).
    // In a browser you could persist this in localStorage.
    this._uuid = uuid || this._generateUUID();

    this.BASE_API   = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
    this.PLAYER_API = 'https://h5.aoneroom.com/wefeed-h5-bff';
    this.UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

    // ── Token cache ────────────────────────────────────────────────
    this._token      = null;   // current JWT string
    this._tokenExp   = 0;      // expiry timestamp (ms)
    this._tokenFetch = null;   // in-flight promise (prevents stampede)
  }

  // ─── UUID helper ────────────────────────────────────────────────────────────

  _generateUUID() {
    // RFC-4122 v4 UUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ─── Token management ───────────────────────────────────────────────────────

  /**
   * Fetch a fresh anonymous guest token from MovieBox.
   * The site uses this exact endpoint to authenticate anonymous visitors.
   * Returns the raw JWT string.
   */
  async _fetchGuestToken() {
    const res = await fetch(`${this.BASE_API}/user/token`, {
      method: 'POST',
      headers: {
        'accept':           'application/json',
        'accept-language':  'en-US,en;q=0.9',
        'content-type':     'application/json',
        'origin':           `https://${this.host}`,
        'referer':          `https://${this.host}/`,
        'user-agent':       this.UA,
        'x-request-lang':   this.lang,
        'x-client-info':    JSON.stringify({ timezone: this.timezone }),
        'sec-ch-ua':        '"Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?1',
        'sec-fetch-dest':   'empty',
        'sec-fetch-mode':   'cors',
        'sec-fetch-site':   'cross-site',
      },
      body: JSON.stringify({
        uuid:       this._uuid,
        deviceType: 'Android',
        appVersion: '4.2.0',
      }),
    });

    if (!res.ok) throw new Error(`Token endpoint HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`Token API error ${json.code}: ${json.message}`);

    const { token, expireTime } = json.data;
    return { token, expireTime }; // expireTime is a Unix timestamp (seconds)
  }

  /**
   * Return a valid token, fetching/refreshing as needed.
   * Safe to call concurrently (promise is shared to avoid stampedes).
   */
  async _getToken() {
    const now = Date.now();

    // Still valid (with 60-second safety margin)?
    if (this._token && this._tokenExp - 60_000 > now) return this._token;

    // Avoid simultaneous refreshes
    if (!this._tokenFetch) {
      this._tokenFetch = this._fetchGuestToken()
        .then(({ token, expireTime }) => {
          this._token    = token;
          this._tokenExp = expireTime * 1000; // convert s → ms
          this._tokenFetch = null;
          return token;
        })
        .catch(err => {
          this._tokenFetch = null;
          throw err;
        });
    }

    return this._tokenFetch;
  }

  // ─── Internal request helpers ───────────────────────────────────────────────

  async _headers(extra = {}) {
    const token = await this._getToken();
    return {
      'accept':             'application/json',
      'accept-language':    'en-US,en;q=0.9',
      'authorization':      `Bearer ${token}`,
      'content-type':       'application/json',
      'origin':             `https://${this.host}`,
      'referer':            `https://${this.host}/`,
      'user-agent':         this.UA,
      'x-client-info':      JSON.stringify({ timezone: this.timezone }),
      'x-request-lang':     this.lang,
      'sec-ch-ua':          '"Chromium";v="137", "Not/A)Brand";v="24"',
      'sec-ch-ua-mobile':   '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest':     'empty',
      'sec-fetch-mode':     'cors',
      'sec-fetch-site':     'cross-site',
      ...extra,
    };
  }

  /**
   * Shared retry logic: if the first attempt returns 401 or API code -1,
   * force-refresh the token and retry once.
   */
  async _request(fn) {
    try {
      return await fn(await this._headers());
    } catch (err) {
      if (err.message.includes('401') || err.message.includes('code -1')) {
        // Force token refresh
        this._token    = null;
        this._tokenExp = 0;
        return fn(await this._headers());
      }
      throw err;
    }
  }

  async _get(url, params = {}) {
    return this._request(async headers => {
      const qs   = new URLSearchParams(params).toString();
      const full = qs ? `${url}?${qs}` : url;
      const res  = await fetch(full, { headers });
      if (res.status === 401) throw new Error('HTTP 401');
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      if (json.code === -1) throw new Error('API code -1: auth error');
      if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
      return json.data;
    });
  }

  async _post(url, body = {}) {
    return this._request(async headers => {
      const res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
      });
      if (res.status === 401) throw new Error('HTTP 401');
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      if (json.code === -1) throw new Error('API code -1: auth error');
      if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
      return json.data;
    });
  }

  // ─── Home & Discovery ────────────────────────────────────────────────────────

  async getHome() {
    return this._get(`${this.BASE_API}/home`, { host: this.host });
  }

  async getTrendingSearches() {
    const data = await this._get(`${this.BASE_API}/subject/everyone-search`);
    return data.everyoneSearch.map(i => i.title);
  }

  async getTrending(page = 0, perPage = 18) {
    return this._get(`${this.BASE_API}/subject/trending`, {
      page: String(page),
      perPage: String(perPage),
    });
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  async searchSuggest(keyword, perPage = 10) {
    const data = await this._post(`${this.BASE_API}/subject/search-suggest`, { keyword, perPage });
    return data.items.map(i => i.word);
  }

  async search(keyword, page = 0, perPage = 18) {
    return this._post(`${this.BASE_API}/subject/search`, { keyword, page, perPage });
  }

  // ─── Subject detail ──────────────────────────────────────────────────────────

  async getDetail(detailPath) {
    return this._get(`${this.BASE_API}/detail`, { detailPath });
  }

  async getRecommendations(subjectId, page = 1, perPage = 12) {
    const data = await this._get(`${this.BASE_API}/subject/detail-rec`, {
      subjectId,
      page: String(page),
      perPage: String(perPage),
    });
    return data.items;
  }

  async filter({
    classify = 'All', country = 'All', genre = 'All',
    sort = 'ForYou', year = 'All', tabId = 2, page = 0, perPage = 18,
  } = {}) {
    return this._get(`${this.BASE_API}/home/movieFilter`, {
      tabId: String(tabId),
      filterType: JSON.stringify({ classify, country, genre, sort, year }),
      page: String(page),
      perPage: String(perPage),
    });
  }

  // ─── Playback ─────────────────────────────────────────────────────────────────

  async getStreams(subjectId, detailPath, { se, ep } = {}) {
    const params = { subjectId, detailPath };
    if (se != null) params.se = String(se);
    if (ep != null) params.ep = String(ep);
    return this._get(`${this.BASE_API}/subject/play`, params);
  }

  async getCaptions(subjectId, detailPath, videoId, format = 'MP4') {
    const data = await this._get(`${this.BASE_API}/subject/caption`, {
      format, id: videoId, subjectId, detailPath,
    });
    return data.captions;
  }

  // ─── Navigation / UI ─────────────────────────────────────────────────────────

  async getBottomTabs() {
    const data = await this._get(`${this.BASE_API}/tab/get-bottom-tab-list`);
    return data.bottomTabs;
  }

  async getI18n(lang = 'en') {
    const res = await fetch(`https://${this.host}/_i18n/mFaJqHLe/${lang}/messages.json`, {
      headers: { 'accept': '*/*', 'referer': `https://${this.host}/`, 'user-agent': this.UA },
    });
    return res.json();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MovieBoxAPI };
}
// export { MovieBoxAPI };   // ESM

/*
USAGE — no token needed:

const api = new MovieBoxAPI();                       // auto-fetches guest token
const api = new MovieBoxAPI({ lang: 'en' });         // same, with options

const home        = await api.getHome();
const suggestions = await api.searchSuggest('Squid');
const detail      = await api.getDetail('the-girl-downstairs-gaxQDYM1395');
const streams     = await api.getStreams('4318991932157509584', 'the-girl-downstairs-gaxQDYM1395');
*/
