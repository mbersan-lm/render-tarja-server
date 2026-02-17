const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || "https://tarjassenhaforte123.lovable.app";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://tarjassenhaforte123.lovable.app";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// In-memory LRU cache
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> { buffer, createdAt }

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.createdAt > CACHE_TTL_MS) cache.delete(key);
  }
}

function cacheSet(key, buffer) {
  evictExpired();
  // LRU: if at limit, delete oldest
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { buffer, createdAt: Date.now() });
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Move to end (refresh LRU position)
  cache.delete(key);
  cache.set(key, entry);
  return entry.buffer;
}

function hashPayload(obj) {
  // Sort keys for deterministic hashing
  const sorted = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

// ---------------------------------------------------------------------------
// Browser pool (single persistent browser, reused across requests)
// ---------------------------------------------------------------------------
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browserPromise;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(express.json({ limit: "2mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Main endpoint — POST / (client sends to RENDER_API_URL directly)
app.post("/", async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.model || !payload.theme) {
    return res.status(400).json({ error: "Missing model or theme in payload" });
  }

  // Check cache
  const key = hashPayload(payload);
  const cached = cacheGet(key);
  if (cached) {
    console.log("[cache] HIT", key.slice(0, 12));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("X-Cache", "HIT");
    return res.send(cached);
  }

  console.log("[render] START", key.slice(0, 12));
  const startTime = Date.now();

  let page = null;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: 1,
    });
    page = await context.newPage();

    // Inject payload before any script runs
    await page.addInitScript((data) => {
      window.__EXPORT_PAYLOAD__ = data;
    }, payload);

    // Navigate to the /export route
    await page.goto(`${APP_URL}/export`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Wait for the page to signal readiness
    await page.waitForFunction(() => window.__EXPORT_READY__ === true, {
      timeout: 20000,
    });

    // Extra safety: one more frame
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => r()))
    );

    // Screenshot the export container
    const element = page.locator("#export-root");
    const pngBuffer = await element.screenshot({ type: "png" });

    // Cache it
    cacheSet(key, pngBuffer);

    const elapsed = Date.now() - startTime;
    console.log("[render] DONE", key.slice(0, 12), `${elapsed}ms`);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("X-Cache", "MISS");
    res.send(pngBuffer);

    // Close context (not browser) to free memory
    await context.close();
  } catch (err) {
    console.error("[render] ERROR:", err.message);
    if (page) {
      try {
        await page.context().close();
      } catch (_) {}
    }
    res.status(500).json({ error: "Render failed", detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] APP_URL = ${APP_URL}`);
  console.log(`[server] ALLOWED_ORIGIN = ${ALLOWED_ORIGIN}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[server] SIGTERM received, closing browser...");
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
