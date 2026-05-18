const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

const app = express();

const PORT = process.env.PORT || 5000;

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

/* =========================
   CONFIG
========================= */

const SELECTED_HOST =
    process.env.MOVIEBOX_API_HOST ||
    "h5.aoneroom.com";

const HOST_URL = `https://${SELECTED_HOST}`;

const DEFAULT_HEADERS = {
    "X-Client-Info":
        '{"timezone":"Africa/Nairobi"}',

    "Accept-Language":
        "en-US,en;q=0.5",

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
   AXIOS + COOKIE JAR
========================= */

const jar = new CookieJar();

const axiosInstance = wrapper(
    axios.create({
        jar,
        withCredentials: true,
        timeout: 60000,
        maxRedirects: 5
    })
);

/* =========================
   CACHE
========================= */

let cookiesInitialized = false;

/* =========================
   HELPERS
========================= */

function processApiResponse(data) {
    if (data && data.data) {
        return data.data;
    }

    return data;
}

async function ensureCookies() {
    if (cookiesInitialized) {
        return;
    }

    try {
        await axiosInstance.get(
            `${HOST_URL}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
            {
                headers: DEFAULT_HEADERS
            }
        );

        cookiesInitialized = true;

        console.log("Cookies initialized");

    } catch (e) {
        console.log(
            "Cookie init failed:",
            e.message
        );
    }
}

async function makeApiRequest(
    url,
    options = {}
) {
    await ensureCookies();

    return axiosInstance({
        url,
        headers: {
            ...DEFAULT_HEADERS,
            ...(options.headers || {})
        },
        ...options
    });
}

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
    res.send(`
        <h1>MovieBox API Running</h1>
        <p>Render Deployment Successful</p>
    `);
});

/* =========================
   HOMEPAGE
========================= */

app.get(
    "/api/homepage",
    async (req, res) => {
        try {
            const response =
                await makeApiRequest(
                    `${HOST_URL}/wefeed-h5-bff/web/home`
                );

            res.json({
                status: "success",
                data: processApiResponse(
                    response.data
                )
            });

        } catch (e) {
            res.status(500).json({
                status: "error",
                message: e.message
            });
        }
    }
);

/* =========================
   TRENDING
========================= */

app.get(
    "/api/trending",
    async (req, res) => {
        try {
            const page =
                parseInt(req.query.page) || 0;

            const perPage =
                parseInt(
                    req.query.perPage
                ) || 18;

            const response =
                await makeApiRequest(
                    `${HOST_URL}/wefeed-h5-bff/web/subject/trending`,
                    {
                        method: "GET",
                        params: {
                            page,
                            perPage,
                            uid: "5591179548772780352"
                        }
                    }
                );

            res.json({
                status: "success",
                data: processApiResponse(
                    response.data
                )
            });

        } catch (e) {
            res.status(500).json({
                status: "error",
                message: e.message
            });
        }
    }
);

/* =========================
   SEARCH
========================= */

app.get(
    "/api/search/:query",
    async (req, res) => {
        try {
            const query =
                req.params.query;

            const page =
                parseInt(req.query.page) || 1;

            const perPage =
                parseInt(
                    req.query.perPage
                ) || 24;

            const subjectType =
                parseInt(req.query.type) ||
                SubjectType.ALL;

            const response =
                await makeApiRequest(
                    `${HOST_URL}/wefeed-h5-bff/web/subject/search`,
                    {
                        method: "POST",

                        data: {
                            keyword: query,
                            page,
                            perPage,
                            subjectType
                        }
                    }
                );

            const content =
                processApiResponse(
                    response.data
                );

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
    }
);

/* =========================
   INFO
========================= */

app.get(
    "/api/info/:movieId",
    async (req, res) => {
        try {
            const response =
                await makeApiRequest(
                    `${HOST_URL}/wefeed-h5-bff/web/subject/detail`,
                    {
                        method: "GET",

                        params: {
                            subjectId:
                                req.params
                                    .movieId
                        }
                    }
                );

            res.json({
                status: "success",
                data: processApiResponse(
                    response.data
                )
            });

        } catch (e) {
            res.status(500).json({
                status: "error",
                message: e.message
            });
        }
    }
);

/* =========================
   SOURCES
========================= */

app.get(
    "/api/sources/:movieId",
    async (req, res) => {
        try {
            const season =
                parseInt(
                    req.query.season
                ) || 0;

            const episode =
                parseInt(
                    req.query.episode
                ) || 0;

            const response =
                await makeApiRequest(
                    `${HOST_URL}/wefeed-h5-bff/web/subject/download`,
                    {
                        method: "GET",

                        params: {
                            subjectId:
                                req.params
                                    .movieId,

                            se: season,

                            ep: episode
                        },

                        headers: {
                            Origin:
                                "https://fmoviesunblocked.net",

                            Referer:
                                "https://fmoviesunblocked.net/"
                        }
                    }
                );

            const content =
                processApiResponse(
                    response.data
                );

            if (content.downloads) {
                content.processedSources =
                    content.downloads.map(
                        (file) => ({
                            quality:
                                file.resolution,

                            size: file.size,

                            directUrl:
                                file.url,

                            proxyUrl:
                                `${req.protocol}://${req.get("host")}/api/download?url=${encodeURIComponent(file.url)}`
                        })
                    );
            }

            res.json({
                status: "success",
                data: content
            });

        } catch (e) {
            console.log(e);

            res.status(500).json({
                status: "error",
                message: e.message
            });
        }
    }
);

/* =========================
   DOWNLOAD PROXY
========================= */

app.get(
    "/api/download",
    async (req, res) => {
        try {
            const url = req.query.url;

            if (!url) {
                return res
                    .status(400)
                    .json({
                        status: "error",
                        message:
                            "Missing URL"
                    });
            }

            const headers = {
                "User-Agent":
                    "okhttp/4.12.0",

                Referer:
                    "https://fmoviesunblocked.net/",

                Origin:
                    "https://fmoviesunblocked.net"
            };

            if (req.headers.range) {
                headers.Range =
                    req.headers.range;
            }

            const response =
                await axios({
                    method: "GET",

                    url,

                    responseType:
                        "stream",

                    headers
                });

            res.status(
                response.status
            );

            Object.entries(
                response.headers
            ).forEach(([k, v]) => {
                res.setHeader(k, v);
            });

            res.setHeader(
                "Accept-Ranges",
                "bytes"
            );

            response.data.pipe(res);

        } catch (e) {
            console.log(
                "Download error:",
                e.message
            );

            res.status(500).json({
                status: "error",
                message: e.message
            });
        }
    }
);

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
   START
========================= */

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Server running on port ${PORT}`
    );
});
