import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   CONFIG
========================= */

const MIRROR_HOSTS = [
    "h5.aoneroom.com",
    "movieboxapp.in",
    "moviebox.pk",
    "moviebox.ph",
    "moviebox.id",
    "v.moviebox.ph",
    "netnaija.video"
];

const SELECTED_HOST = "h5.aoneroom.com";

const HOST_URL = `https://${SELECTED_HOST}`;

const DEFAULT_HEADERS = {
    "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
    "Accept-Language": "en-US,en;q=0.5",
    Accept: "application/json",
    "User-Agent": "okhttp/4.12.0",
    Referer: HOST_URL,
    Host: SELECTED_HOST,
    Connection: "keep-alive",
    "X-Forwarded-For": "1.1.1.1",
    "CF-Connecting-IP": "1.1.1.1",
    "X-Real-IP": "1.1.1.1"
};

const SubjectType = {
    ALL: 0,
    MOVIES: 1,
    TV_SERIES: 2,
    MUSIC: 6
};

/* =========================
   COOKIE CACHE
========================= */

let cookieCache = null;
let cookieCacheTime = 0;

const COOKIE_CACHE_DURATION = 1000 * 60 * 60;

/* =========================
   HELPERS
========================= */

function processApiResponse(data) {
    if (data && data.data) {
        return data.data;
    }

    return data;
}

function sanitizeFilename(filename) {
    return filename
        .replace(/[<>:"/\\|?*]/g, "")
        .replace(/\s+/g, "_")
        .replace(/_{2,}/g, "_")
        .trim();
}

/* =========================
   GET COOKIES
========================= */

async function getCookies() {
    const now = Date.now();

    if (
        cookieCache &&
        now - cookieCacheTime < COOKIE_CACHE_DURATION
    ) {
        return cookieCache;
    }

    try {
        const response = await fetch(
            `${HOST_URL}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
            {
                headers: DEFAULT_HEADERS
            }
        );

        const rawCookie = response.headers.get("set-cookie");

        if (rawCookie) {
            cookieCache = rawCookie
                .split(",")
                .map((c) => c.split(";")[0].trim())
                .join("; ");

            cookieCacheTime = now;
        }

        return cookieCache;
    } catch (e) {
        console.log("Cookie Error:", e.message);
        return null;
    }
}

/* =========================
   API REQUEST
========================= */

async function makeApiRequest(url, options = {}) {
    const cookies = await getCookies();

    const headers = {
        ...DEFAULT_HEADERS,
        ...(options.headers || {})
    };

    if (cookies) {
        headers.Cookie = cookies;
    }

    return fetch(url, {
        ...options,
        headers
    });
}

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
    res.send(`
    <html>
        <head>
            <title>MovieBox API</title>
            <style>
                body{
                    font-family: Arial;
                    background:#111;
                    color:white;
                    padding:40px;
                }

                h1{
                    color:#00ff88;
                }

                code{
                    background:#222;
                    padding:4px 8px;
                    border-radius:5px;
                }
            </style>
        </head>
        <body>
            <h1>🎬 MovieBox API</h1>

            <p>Render Ready Node.js API</p>

            <h3>Endpoints:</h3>

            <ul>
                <li><code>/api/homepage</code></li>
                <li><code>/api/trending</code></li>
                <li><code>/api/search/:query</code></li>
                <li><code>/api/info/:id</code></li>
                <li><code>/api/sources/:id</code></li>
                <li><code>/api/stream?url=</code></li>
                <li><code>/api/download?url=</code></li>
            </ul>
        </body>
    </html>
    `);
});

/* =========================
   HOMEPAGE
========================= */

app.get("/api/homepage", async (req, res) => {
    try {
        const response = await makeApiRequest(
            `${HOST_URL}/wefeed-h5-bff/web/home`
        );

        const data = await response.json();

        res.json({
            status: "success",
            data: processApiResponse(data)
        });

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   TRENDING
========================= */

app.get("/api/trending", async (req, res) => {
    try {
        const page = req.query.page || 0;
        const perPage = req.query.perPage || 18;

        const params = new URLSearchParams({
            page,
            perPage,
            uid: "5591179548772780352"
        });

        const response = await makeApiRequest(
            `${HOST_URL}/wefeed-h5-bff/web/subject/trending?${params}`
        );

        const data = await response.json();

        res.json({
            status: "success",
            data: processApiResponse(data)
        });

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   SEARCH
========================= */

app.get("/api/search/:query", async (req, res) => {
    try {
        const query = req.params.query;

        const page = parseInt(req.query.page) || 1;

        const perPage =
            parseInt(req.query.perPage) || 24;

        const subjectType =
            parseInt(req.query.type) ||
            SubjectType.ALL;

        const payload = {
            keyword: query,
            page,
            perPage,
            subjectType
        };

        const response = await makeApiRequest(
            `${HOST_URL}/wefeed-h5-bff/web/subject/search`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json"
                },
                body: JSON.stringify(payload)
            }
        );

        const data = await response.json();

        const content = processApiResponse(data);

        if (content.items) {
            content.items = content.items.map(
                (item) => ({
                    ...item,
                    thumbnail:
                        item?.cover?.url ||
                        item?.stills?.url ||
                        null
                })
            );
        }

        res.json({
            status: "success",
            data: content
        });

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   INFO
========================= */

app.get("/api/info/:id", async (req, res) => {
    try {
        const params = new URLSearchParams({
            subjectId: req.params.id
        });

        const response = await makeApiRequest(
            `${HOST_URL}/wefeed-h5-bff/web/subject/detail?${params}`
        );

        const data = await response.json();

        const content = processApiResponse(data);

        if (content.subject) {
            content.subject.thumbnail =
                content?.subject?.cover?.url ||
                content?.subject?.stills?.url ||
                null;
        }

        res.json({
            status: "success",
            data: content
        });

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   SOURCES
========================= */

app.get("/api/sources/:id", async (req, res) => {
    try {
        const movieId = req.params.id;

        const season =
            parseInt(req.query.season) || 0;

        const episode =
            parseInt(req.query.episode) || 0;

        const params = new URLSearchParams({
            subjectId: movieId,
            se: season,
            ep: episode
        });

        const response = await makeApiRequest(
            `${HOST_URL}/wefeed-h5-bff/web/subject/download?${params}`
        );

        const data = await response.json();

        const content = processApiResponse(data);

        if (content.downloads) {

            const protocol =
                req.headers["x-forwarded-proto"] ||
                "https";

            const host = req.get("host");

            const baseUrl =
                `${protocol}://${host}`;

            content.processedSources =
                content.downloads.map((file) => ({
                    id: file.id,
                    quality:
                        file.resolution ||
                        "Unknown",
                    size: file.size,
                    directUrl: file.url,
                    streamUrl:
                        `${baseUrl}/api/stream?url=${encodeURIComponent(file.url)}`,
                    downloadUrl:
                        `${baseUrl}/api/download?url=${encodeURIComponent(file.url)}`
                }));
        }

        res.json({
            status: "success",
            data: content
        });

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   STREAM
========================= */

app.get("/api/stream", async (req, res) => {
    try {
        const streamUrl = req.query.url;

        if (!streamUrl) {
            return res.status(400).json({
                status: "error",
                message: "Missing stream URL"
            });
        }

        const headers = {
            "User-Agent": "okhttp/4.12.0"
        };

        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await fetch(streamUrl, {
            headers
        });

        res.status(response.status);

        response.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });

        if (!response.body) {
            return res.end();
        }

        const reader = response.body.getReader();

        async function stream() {
            while (true) {
                const { done, value } =
                    await reader.read();

                if (done) {
                    res.end();
                    break;
                }

                res.write(Buffer.from(value));
            }
        }

        stream();

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   DOWNLOAD
========================= */

app.get("/api/download", async (req, res) => {
    try {
        const downloadUrl = req.query.url;

        const title =
            req.query.title || "video";

        const quality =
            req.query.quality || "";

        if (!downloadUrl) {
            return res.status(400).json({
                status: "error",
                message: "Missing download URL"
            });
        }

        let filename =
            sanitizeFilename(title);

        if (quality) {
            filename += `_${quality}`;
        }

        filename += ".mp4";

        const headers = {
            "User-Agent": "okhttp/4.12.0"
        };

        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await fetch(downloadUrl, {
            headers
        });

        res.status(response.status);

        response.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`
        );

        if (!response.body) {
            return res.end();
        }

        const reader = response.body.getReader();

        async function stream() {
            while (true) {
                const { done, value } =
                    await reader.read();

                if (done) {
                    res.end();
                    break;
                }

                res.write(Buffer.from(value));
            }
        }

        stream();

    } catch (e) {
        res.status(500).json({
            status: "error",
            message: e.message
        });
    }
});

/* =========================
   404
========================= */

app.use((req, res) => {
    res.status(404).json({
        status: "error",
        message: "Endpoint not found"
    });
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `Server running on port ${PORT}`
    );
});
