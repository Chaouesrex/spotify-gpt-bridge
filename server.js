// server.js  (ESM)
import express from "express";
import session from "express-session";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config / Secrets
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const ACTION_SHARED_SECRET = process.env.ACTION_SHARED_SECRET || "";

// Optional session (you can keep, but GPT auth will use the shared secret)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "defaultsecret",
    resave: false,
    saveUninitialized: true,
  })
);

// ---- Simple guard so only your GPT can call these endpoints
function guard(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${ACTION_SHARED_SECRET}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ---- In-memory tokens for stateless GPT calls
let ACCESS_TOKEN = null;
let REFRESH_TOKEN = null;
let ACCESS_EXPIRES_AT = 0;

const basicAuth = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

async function ensureAccessToken() {
  const now = Date.now();
  if (ACCESS_TOKEN && now < ACCESS_EXPIRES_AT - 10_000) return ACCESS_TOKEN;

  if (!REFRESH_TOKEN) throw new Error("Not connected. Visit /login once to authorize.");

  const r = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
    { headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" } }
  );

  ACCESS_TOKEN = r.data.access_token;
  ACCESS_EXPIRES_AT = now + (r.data.expires_in || 3600) * 1000;
  return ACCESS_TOKEN;
}

async function sp(method, pathUrl, { params, data } = {}) {
  const token = await ensureAccessToken();
  return axios({
    method,
    url: `https://api.spotify.com/v1${pathUrl}`,
    params,
    data,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
}

// ---------- OAuth ----------
app.get("/login", (_req, res) => {
  const scopes = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-modify-private",
    "playlist-modify-public",
  ].join(" ");
  const authUrl =
    "https://accounts.spotify.com/authorize" +
    `?response_type=code&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const r = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    ACCESS_TOKEN = r.data.access_token;
    ACCESS_EXPIRES_AT = Date.now() + (r.data.expires_in || 3600) * 1000;
    if (r.data.refresh_token) REFRESH_TOKEN = r.data.refresh_token;

    res.send("✅ Connected! You can close this tab.");
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send("❌ Error authenticating with Spotify.");
  }
});

// ---------- Helpers ----------
async function ensureActiveDevice() {
  const status = await sp("get", "/me/player");
  if (status.status === 200 && status.data?.device?.id) return status.data.device.id;

  const devs = await sp("get", "/me/player/devices");
  const first = devs.data?.devices?.[0];
  if (!first) throw new Error("No available devices. Open Spotify and play a song briefly.");

  await sp("put", "/me/player", { data: { device_ids: [first.id], play: false } });
  return first.id;
}

// ---------- Playback controls ----------
app.post("/play", guard, async (_req, res) => {
  try {
    await ensureActiveDevice();
    const r = await sp("put", "/me/player/play");
    return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
});

app.post("/pause", guard, async (_req, res) => {
  const r = await sp("put", "/me/player/pause");
  return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
});

app.post("/next", guard, async (_req, res) => {
  const r = await sp("post", "/me/player/next");
  return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
});

app.post("/previous", guard, async (_req, res) => {
  const r = await sp("post", "/me/player/previous");
  return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
});

app.get("/status", guard, async (_req, res) => {
  const r = await sp("get", "/me/player");
  return res.status(r.status).json(r.data);
});

app.post("/volume", guard, async (req, res) => {
  try {
    await ensureActiveDevice();
    const v = Math.max(0, Math.min(100, Number(req.body?.volume ?? 50)));
    const r = await sp("put", `/me/player/volume`, { params: { volume_percent: v } });
    return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
});

// ---------- Devices ----------
app.get("/devices", guard, async (_req, res) => {
  const r = await sp("get", "/me/player/devices");
  return res.status(r.status).json(r.data);
});

app.post("/transfer", guard, async (req, res) => {
  const deviceId = req.body?.deviceId;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  const r = await sp("put", "/me/player", { data: { device_ids: [deviceId], play: false } });
  return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
});

// ---------- Search + Playlists ----------
app.get("/search", guard, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing query param 'q'." });
  const r = await sp("get", "/search", { params: { q, type: "track", limit: 1 } });
  if (r.status >= 300) return res.status(r.status).json(r.data);
  const t = r.data?.tracks?.items?.[0];
  if (!t) return res.status(404).json({ error: "No track found." });
  res.json({
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album?.name,
  });
});

// … (keep your playlist create/add endpoints, OpenAPI route, and addTrack handler here) …

// ---------- Startup ----------
app.get("/", (_req, res) => res.send("Spotify GPT Bridge is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on :${PORT}`));
