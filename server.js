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
    // sometimes Spotify omits refresh_token if already granted; keep existing if missing
    if (r.data.refresh_token) REFRESH_TOKEN = r.data.refresh_token;

    res.send("✅ Connected! You can close this tab.");
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send("❌ Error authenticating with Spotify.");
  }
});

// ---------- Playback controls (for GPT) ----------
app.post("/play", guard, async (_req, res) => {
  const r = await sp("put", "/me/player/play");
  return r.status < 300 ? res.json({ ok: true }) : res.status(r.status).json(r.data);
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
  const v = Math.max(0, Math.min(100, Number(req.body?.volume ?? 50)));
  const r = await sp("put", `/me/player/volume`, { params: { volume_percent: v } });
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

async function getUserId() {
  const r = await sp("get", "/me");
  if (r.status >= 300) throw new Error("Failed to get user profile");
  return r.data.id;
}

async function findPlaylistIdByName(name) {
  const userId = await getUserId();
  let offset = 0;
  while (true) {
    const r = await sp("get", `/users/${userId}/playlists`, { params: { limit: 50, offset } });
    if (r.status >= 300) throw new Error("Failed to list playlists");
    const hit = r.data.items.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    if (r.data.items.length < 50) return null;
    offset += 50;
  }
}

async function createPlaylist(name, description = "Created by GPT Bridge", isPublic = false) {
  const userId = await getUserId();
  const r = await sp("post", `/users/${userId}/playlists`, {
    data: { name, description, public: isPublic },
  });
  if (r.status >= 300) throw new Error("Failed to create playlist");
  return r.data.id;
}

// Create a playlist explicitly
app.post("/playlist", guard, async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const id = await createPlaylist(name, req.body?.description, !!req.body?.public);
    res.json({ ok: true, playlistId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add a song to a playlist by name; creates playlist if missing
// Body: { playlistName: string, query?: string, uri?: string, createIfMissing?: boolean }
app.post("/playlist/add", guard, async (req, res) => {
  const { playlistName, query, uri, createIfMissing = true } = req.body || {};
  if (!playlistName) return res.status(400).json({ error: "playlistName is required" });

  try {
    // resolve track URI
    let trackUri = uri;
    if (!trackUri && query) {
      const sr = await sp("get", "/search", { params: { q: query, type: "track", limit: 1 } });
      const item = sr.data?.tracks?.items?.[0];
      if (!item) return res.status(404).json({ error: "Track not found" });
      trackUri = item.uri;
    }
    if (!trackUri) return res.status(400).json({ error: "Provide 'uri' or 'query'." });

    // find or create playlist
    let playlistId = await findPlaylistIdByName(playlistName);
    if (!playlistId && createIfMissing) {
      playlistId = await createPlaylist(playlistName);
    }
    if (!playlistId) return res.status(404).json({ error: "Playlist not found" });

    // add track
    const r = await sp("post", `/playlists/${playlistId}/tracks`, { data: { uris: [trackUri] } });
    if (r.status >= 300) return res.status(r.status).json(r.data);

    res.json({ ok: true, playlistId, added: trackUri });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve OpenAPI spec (so your Custom GPT can import it)
app.get("/openapi.yaml", (_req, res) => {
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

app.get("/", (_req, res) => res.send("Spotify GPT Bridge is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on :${PORT}`));
