const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

class MovieBoxAPI {
  constructor() {
    this.baseURL = "https://h5-api.aoneroom.com/wefeed-h5api-bff";

    // Your Bearer Token
    this.token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjIxNTIzNjg2NDE4MDczODA1NiwiYXRwIjozLCJleHQiOiIxNzcxMDg2MDg0IiwiZXhwIjoxNzg1NTIzMzQ3LCJpYXQiOjE3Nzc3NDcwNDd9.P23mEwbQ3F3Zd8glTqs7YwccT6KQYQVnUvMH02KLgis";

    this.host = "moviebox.ph";
    this.lang = "en";
    this.timezone = "Asia/Dhaka";

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        authority: "h5-api.aoneroom.com",
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        origin: "https://moviebox.ph",
        referer: "https://moviebox.ph/",
        "sec-ch-ua":
          '"Chromium";v="137", "Not/A)Brand";v="24"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "user-agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
        "x-client-info": JSON.stringify({
          timezone: this.timezone,
        }),
        "x-request-lang": this.lang,
      },
    });
  }

  async getHomepage() {
    try {
      const response = await this.client.get("/home", {
        params: {
          host: this.host,
        },
      });

      return response.data;
    } catch (error) {
      return {
        status: false,
        message:
          error.response?.data ||
          error.message ||
          "Failed to fetch homepage",
      };
    }
  }
}

const api = new MovieBoxAPI();

/*
|--------------------------------------------------------------------------
| Root
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    status: true,
    message: "MovieBox API Running",
    endpoints: [
      "/api/home",
      "/api/platforms",
      "/api/raw-home",
    ],
  });
});

/*
|--------------------------------------------------------------------------
| Raw Homepage Data
|--------------------------------------------------------------------------
*/

app.get("/api/raw-home", async (req, res) => {
  const data = await api.getHomepage();
  res.json(data);
});

/*
|--------------------------------------------------------------------------
| Clean Homepage
|--------------------------------------------------------------------------
*/

app.get("/api/home", async (req, res) => {
  try {
    const data = await api.getHomepage();

    if (!data || data.code !== 0) {
      return res.status(500).json(data);
    }

    const banners =
      data.data?.operatingList?.find(
        (x) => x.type === "BANNER"
      )?.banner?.items || [];

    const results = banners.map((item) => ({
      id: item.subject?.subjectId,
      title: item.subject?.title,
      type:
        item.subject?.subjectType === 1
          ? "movie"
          : "series",
      releaseDate: item.subject?.releaseDate,
      genre: item.subject?.genre,
      imdb: item.subject?.imdbRatingValue,
      imdbVotes: item.subject?.imdbRatingCount,
      country: item.subject?.countryName,
      image: item.image?.url,
      cover: item.subject?.cover?.url,
      detailPath: item.subject?.detailPath,
      postTitle: item.subject?.postTitle,
      hasResource: item.subject?.hasResource,
    }));

    res.json({
      status: true,
      total: results.length,
      results,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      message: error.message,
    });
  }
});

/*
|--------------------------------------------------------------------------
| Platforms
|--------------------------------------------------------------------------
*/

app.get("/api/platforms", async (req, res) => {
  try {
    const data = await api.getHomepage();

    const platforms = data.data?.platformList || [];

    res.json({
      status: true,
      total: platforms.length,
      results: platforms,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      message: error.message,
    });
  }
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
