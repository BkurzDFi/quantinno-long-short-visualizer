const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const ROOT = __dirname;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function handleQuote(req, res, url) {
  const requestApiKey = (url.searchParams.get("token") || "").trim();
  const apiKey = requestApiKey || FINNHUB_API_KEY;

  if (!apiKey) {
    sendJson(res, 500, {
      error: "Missing Finnhub API key. Set one in-app or start with FINNHUB_API_KEY=your_key node server.js.",
    });
    return;
  }

  const symbols = (url.searchParams.get("symbols") || "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  if (!symbols.length) {
    sendJson(res, 400, { error: "Provide one or more symbols." });
    return;
  }

  try {
    const quotes = await Promise.all(
      symbols.map(async (symbol) => {
        const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
        const response = await fetch(quoteUrl);
        if (!response.ok) throw new Error(`Finnhub returned ${response.status} for ${symbol}`);
        const data = await response.json();
        return {
          symbol,
          price: Number(data.c || 0),
          previousClose: Number(data.pc || 0),
          timestamp: Number(data.t || 0),
        };
      }),
    );

    sendJson(res, 200, { quotes });
  } catch (error) {
    sendJson(res, 502, { error: error.message || "Unable to fetch Finnhub quotes." });
  }
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/quotes") {
    await handleQuote(req, res, url);
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Quantinno visualizer running at http://127.0.0.1:${PORT}`);
});
