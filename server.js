const express = require("express");
const session = require("express-session");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

app.use(express.json());

// Use session to store auth tokens
app.use(
  session({
    secret: process.env.SESSION_SECRET || "defaultsecret",
    resave: false,
    saveUninitialized: true,
  })
);

// Spotify auth endpoints
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

    res.send("Login successful! You can now use the GPT bridge.");
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("Error authenticating with Spotify");
  }
});

// Example: Play/pause route
app.post("/playpause", async (req, res) => {
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

    res.send("Playback started/paused!");
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("Failed to control playback.");
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
