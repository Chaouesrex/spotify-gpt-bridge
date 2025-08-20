import express from "express";
import session from "express-session";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();

// Needed for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());

// Use session to store auth tokens
app.use(
  session({
    secret: process.env.SESSION_SECRET || "defaultsecret",
    resave: false,
    saveUninitialized: true,
  })
);

// Spotify auth values
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

// Step 1: Login route
app.get("/login", (req, res) => {
  const scope = "user-read-playback-state user-modify-playback-state";
  const authUrl =
    "https://accounts.spotify.com/authorize" +
    `?response_type=code&client_id=${clientId}&scope=${encodeURIComponent(
      scope
    )}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

// Step 2: Callback route
app.get("/callback", async (req, res) => {
  const code = req.query.code || null;

  try {
    const response = await axios({
      method: "post",
      url: "https://accounts.spotify.com/api/token",
      data: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
      }),
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    req.session.access_token = response.data.access_token;
    req.session.refresh_token = response.data.refresh_token;

    res.send("✅ Login successful! You can now use the GPT bridge.");
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("❌ Error authenticating with Spotify");
  }
});

// Example: Play route
app.post("/play", async (req, res) => {
  if (!req.session.access_token) {
    return res.status(401).send("Not logged in.");
  }

  try {
    await axios({
      method: "put",
      url: "https://api.spotify.com/v1/me/player/play",
      headers: {
        Authorization: `Bearer ${req.session.access_token}`,
      },
    });

    res.send("▶️ Playback started!");
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("❌ Failed to start playback.");
  }
});

// Example: Pause route
app.post("/pause", async (req, res) => {
  if (!req.session.access_token) {
    return res.status(401).send("Not logged in.");
  }

  try {
    await axios({
      method: "put",
      url: "https://api.spotify.com/v1/me/player/pause",
      headers: {
        Authorization: `Bearer ${req.session.access_token}`,
      },
    });

    res.send("⏸️ Playback paused!");
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("❌ Failed to pause playback.");
  }
});

// Serve OpenAPI spec
app.get("/openapi.yaml", (req, res) => {
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
