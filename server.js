import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";

const app = express();
app.use(express.json());
app.use(cookieParser());

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  ACTION_SHARED_SECRET
} = process.env;

let REFRESH_TOKEN = "";

const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

async function tokenFromRefresh() {
  if (!REFRESH_TOKEN) throw new Error("No refresh token yet");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN })
  });
  if (!res.ok) throw new Error("Refresh failed");
  return res.json();
}

function guard(req, res, next) {
  if (req.headers.authorization !== `Bearer ${ACTION_SHARED_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/login", (_req, res) => {
  const scopes = [
    "user-modify-playback-state",
    "user-read-playback-state",
    "user-read-currently-playing"
  ].join(" ");
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: scopes
  });
  res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI
    })
  });
  const data = await r.json();
  REFRESH_TOKEN = data.refresh_token;
  res.send("✅ Connected! You can close this tab.");
});

async function sp(method, path, body) {
  const { access_token } = await tokenFromRefresh();
  const r = await fetch("https://api.spotify.com/v1" + path, {
    method,
    headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return {};
  return r.json();
}

app.post("/play", guard, async (req, res) => {
  try {
    await sp("PUT", "/me/player/play", req.body || {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/pause", guard, async (_req, res) => {
  try { await sp("PUT", "/me/player/pause"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/next", guard, async (_req, res) => {
  try { await sp("POST", "/me/player/next"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/status", guard, async (_req, res) => {
  try { const j = await sp("GET", "/me/player"); res.json(j); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (_r, res) => res.send("Spotify GPT bridge is running"));

app.listen(3000, () => console.log("http://localhost:3000"));
