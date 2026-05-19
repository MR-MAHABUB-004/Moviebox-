const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const idCache = new Map();

async function getAnilistInfo(anilistId) {
  try {
    const query = `
      query {
        Media (id: ${parseInt(anilistId)}, type: ANIME) {
          title { romaji english native }
          format
          synonyms
        }
      }
    `;

    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({ query })
    });

    if (!res.ok) {
      throw new Error(`Anilist API returned ${res.status}`);
    }

    const data = await res.json();
    return data.data?.Media;
  } catch (error) {
    console.error("Error fetching Anilist info:", error);

    try {
      const kitsuRes = await fetch(
        `https://kitsu.io/api/edge/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilistId}&include=item`
      );

      if (!kitsuRes.ok) {
        throw new Error(`Kitsu API returned ${kitsuRes.status}`);
      }

      const kitsuData = await kitsuRes.json();

      const anime = kitsuData.included?.find((i) => i.type === "anime");

      if (anime) {
        return {
          title: {
            english: anime.attributes.titles.en || null,
            romaji: anime.attributes.titles.en_jp || null,
            native: anime.attributes.titles.ja_jp || null
          },
          format:
            anime.attributes.subtype === "movie" ||
            anime.attributes.showType === "movie"
              ? "MOVIE"
              : "TV",
          synonyms: anime.attributes.abbreviatedTitles || []
        };
      }
    } catch (kitsuError) {
      console.error("Error fetching from Kitsu:", kitsuError);
    }

    return null;
  }
}

async function getAniwaveIdFromAnilist(anilistId) {
  try {
    if (idCache.has(anilistId)) {
      return idCache.get(anilistId);
    }

    const media = await getAnilistInfo(anilistId);

    if (!media) return null;

    const titles = media.title;
    const isMovie = media.format === "MOVIE";

    const cleanTitle = (str) =>
      str
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const removeParens = (str) =>
      str.replace(/\(.*?\)/g, "").trim();

    let results = [];

    const searchQueries = [
      titles.english,
      titles.romaji,
      titles.english ? removeParens(titles.english) : null,
      titles.romaji ? removeParens(titles.romaji) : null,
      titles.english ? cleanTitle(titles.english) : null,
      titles.romaji ? cleanTitle(titles.romaji) : null,
      titles.english ? titles.english.split(":")[0] : null,
      titles.romaji ? titles.romaji.split(":")[0] : null,
      titles.english ? titles.english.split("-")[0] : null,
      titles.romaji ? titles.romaji.split("-")[0] : null
    ].filter(Boolean);

    const uniqueQueries = [...new Set(searchQueries)];

    for (const q of uniqueQueries) {
      if (!q || q.length < 2) continue;

      try {
        const url = `https://aniwaves.ru/filter?keyword=${encodeURIComponent(q)}`;

        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
          }
        });

        const html = await response.text();

        const regex =
          /<a class="name d-title" href="\/watch\/([^"]+)"(?: data-jp="([^"]*)")?[^>]*>([^<]+)<\/a>/g;

        let match;

        while ((match = regex.exec(html)) !== null) {
          if (!results.find((r) => r.id === match[1])) {
            results.push({
              id: match[1],
              jp: (match[2] || "").toLowerCase(),
              en: match[3].toLowerCase()
            });
          }
        }

        if (results.length > 0) break;
      } catch (e) {
        console.error("Search error:", e);
      }
    }

    const normalize = (str) =>
      str.toLowerCase().replace(/[^a-z0-9]/g, "");

    const getWords = (str) =>
      str
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);

    const primaryTitles = [
      titles.english,
      titles.romaji
    ].filter(Boolean);

    const allTitles = [
      ...primaryTitles,
      ...(media.synonyms || [])
    ].filter(Boolean);

    let bestMatch = null;

    const normalizedPrimary = primaryTitles.map(normalize);

    bestMatch = results.find(
      (r) =>
        normalizedPrimary.includes(normalize(r.jp)) ||
        normalizedPrimary.includes(normalize(r.en))
    );

    if (!bestMatch) {
      const normalizedAll = allTitles.map(normalize);

      bestMatch = results.find(
        (r) =>
          normalizedAll.includes(normalize(r.jp)) ||
          normalizedAll.includes(normalize(r.en))
      );
    }

    if (!bestMatch && results.length > 0) {
      let highestScore = 0;

      for (const result of results) {
        const resEnWords = getWords(result.en);
        const resJpWords = getWords(result.jp);

        const isResultMovie =
          resEnWords.includes("movie") ||
          resJpWords.includes("movie");

        let formatMultiplier = 1;

        if (isMovie && isResultMovie) formatMultiplier = 1.2;
        if (isMovie && !isResultMovie) formatMultiplier = 0.8;
        if (!isMovie && isResultMovie) formatMultiplier = 0.8;

        for (const possible of primaryTitles) {
          const posWords = getWords(possible);

          const calcScore = (w1, w2) => {
            const set1 = new Set(w1);
            const set2 = new Set(w2);

            const intersection = new Set(
              [...set1].filter((x) => set2.has(x))
            );

            const union = new Set([...set1, ...set2]);

            return intersection.size / union.size;
          };

          const scoreEn =
            calcScore(posWords, resEnWords) *
            formatMultiplier;

          const scoreJp =
            calcScore(posWords, resJpWords) *
            formatMultiplier;

          const maxScore = Math.max(scoreEn, scoreJp);

          if (maxScore > highestScore) {
            highestScore = maxScore;
            bestMatch = result;
          }
        }
      }

      if (highestScore < 0.4) {
        bestMatch = null;
      }
    }

    if (bestMatch) {
      idCache.set(anilistId, bestMatch.id);
      return bestMatch.id;
    }

    return null;
  } catch (error) {
    console.error("getAniwaveIdFromAnilist error:", error);
    throw error;
  }
}

// SEARCH API
app.get("/api/search", async (req, res) => {
  const { keyword } = req.query;

  if (!keyword) {
    return res.status(400).json({
      error: "Keyword is required"
    });
  }

  try {
    const url = `https://aniwaves.ru/filter?keyword=${encodeURIComponent(keyword)}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      }
    });

    const html = await response.text();

    const results = [];

    const regex =
      /<a class="name d-title" href="\/watch\/([^"]+)"[^>]*>([^<]+)<\/a>/g;

    let match;

    while ((match = regex.exec(html)) !== null) {
      results.push({
        id: match[1],
        title: match[2]
      });
    }

    res.json({ results });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to scrape data",
      details: error.message
    });
  }
});

// EPISODES API
app.get("/api/episodes", async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({
      error: "id is required"
    });
  }

  try {
    const aniwaveId = await getAniwaveIdFromAnilist(id);

    if (!aniwaveId) {
      return res.status(404).json({
        error: "Anime not found"
      });
    }

    const numericIdMatch = aniwaveId.match(/-(\d+)$/);

    const numericId = numericIdMatch
      ? numericIdMatch[1]
      : aniwaveId;

    const episodesUrl = `https://aniwaves.ru/ajax/episode/list/${numericId}`;

    const response = await fetch(episodesUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
      }
    });

    const data = await response.json();

    const html = data.result;

    const episodes = [];

    const regex =
      /<li[^>]*title="([^"]+)"[^>]*>\s*<a[^>]*data-num="([0-9.]+)"[^>]*data-sub="([0-9]*)"[^>]*data-dub="([0-9]*)"/g;

    let match;

    while ((match = regex.exec(html)) !== null) {
      episodes.push({
        title: match[1],
        number: parseFloat(match[2]),
        isSub: match[3] === "1",
        isDub: match[4] === "1"
      });
    }

    episodes.sort((a, b) => a.number - b.number);

    res.json({
      id,
      aniwaveId,
      episodes
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to fetch episodes",
      details: error.message
    });
  }
});

// STREAM API
app.get("/api/stream", async (req, res) => {
  const { id, ep, type, server } = req.query;

  if (!id || !ep || !type) {
    return res.status(400).json({
      error: "id, ep and type are required"
    });
  }

  let targetServer = "Vidplay";

  const srv = server?.toLowerCase();

  if (srv === "mycloud" || srv === "hd-1") {
    targetServer = "MyCloud";
  }

  try {
    const aniwaveId = await getAniwaveIdFromAnilist(id);

    if (!aniwaveId) {
      return res.status(404).json({
        error: "Anime not found"
      });
    }

    const numericIdMatch = aniwaveId.match(/-(\d+)$/);

    const numericId = numericIdMatch
      ? numericIdMatch[1]
      : aniwaveId;

    const serverListUrl = `https://aniwaves.ru/ajax/server/list?servers=${numericId}&eps=${ep}`;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest"
    };

    const response = await fetch(serverListUrl, {
      headers
    });

    const json = await response.json();

    const html = json.result;

    const extractServerUrl = async (
      serverName,
      targetType
    ) => {
      const regex = new RegExp(
        `<div class="type" data-type="${targetType}">([\\s\\S]*?)<\\/div>`,
        "i"
      );

      const match = html.match(regex);

      if (!match) return null;

      const typeHtml = match[1];

      const serverRegex = new RegExp(
        `<li[^>]*data-link-id="([^"]+)"[^>]*>${serverName}<\\/li>`,
        "i"
      );

      const serverMatch = typeHtml.match(serverRegex);

      if (!serverMatch) return null;

      const linkId = serverMatch[1];

      const sourceUrl = `https://aniwaves.ru/ajax/sources?id=${linkId}`;

      const sourceRes = await fetch(sourceUrl, {
        headers
      });

      const sourceJson = await sourceRes.json();

      return sourceJson.result?.url || null;
    };

    const serverUrl = await extractServerUrl(
      targetServer,
      type
    );

    if (!serverUrl) {
      return res.status(404).json({
        error: "Stream server not found"
      });
    }

    const urlObj = new URL(serverUrl);

    const embedId = urlObj.pathname.split("/").pop();

    const baseUrl =
      urlObj.origin +
      urlObj.pathname.split("/").slice(0, -1).join("/");

    const getSourcesUrl = `${baseUrl}/getSources?id=${embedId}`;

    const sourceRes = await fetch(getSourcesUrl, {
      headers: {
        ...headers,
        Referer: urlObj.origin + "/"
      }
    });

    const sourceText = await sourceRes.text();

    let data;

    try {
      data = JSON.parse(sourceText);
    } catch {
      data = {};
    }

    res.json({
      id,
      ep,
      type,
      server: targetServer,
      stream: {
        m3u8:
          typeof data.sources === "string"
            ? data.sources
            : data.sources?.[0]?.file || null,
        intro: data.intro || null,
        outro: data.outro || null,
        tracks: data.tracks || []
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to fetch stream",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
