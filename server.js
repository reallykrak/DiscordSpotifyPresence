const express = require('express');
const fs = require('fs');
const path = require('path');

let fetch;
(async () => {
  const fetchModule = await import('node-fetch');
  fetch = fetchModule.default;
})();

const app = express();
const PORT = process.env.PORT || 5000;

const dataFile    = path.join(__dirname, 'src', 'Spotify', 'Data.json');
const statusFile  = path.join(__dirname, 'src', 'Databases', 'status.json');
const tokensFile  = path.join(__dirname, 'src', 'Databases', 'tokens.json');
const settingsFile = path.join(__dirname, 'settings.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'src', 'public')));

const readJSON  = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return def; } };
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let isStarted = readJSON(statusFile, { started: false }).started || false;
let spotifyToken = null;
let tokenExpiry  = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const cfg = readJSON(settingsFile, {});
  if (!cfg.Client || !cfg.Secret || cfg.Client === 'SPOTIFY_CLIENT_ID') return null;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(cfg.Client + ':' + cfg.Secret).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const d = await res.json();
    spotifyToken = d.access_token;
    tokenExpiry  = Date.now() + (d.expires_in - 60) * 1000;
    return spotifyToken;
  } catch (e) {
    console.error('Spotify token error:', e.message);
    return null;
  }
}

async function getSpotifyTrackInfo(spotifyUrl) {
  const url     = spotifyUrl.replace('https://open.spotify.com/intl-tr', 'https://open.spotify.com').split('?')[0];
  const trackId = url.split('/').pop();
  const token   = await getSpotifyToken();
  if (!token) throw new Error('Spotify credentials not configured');
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Spotify API: ${res.status}`);
  const data = await res.json();
  if (!data || !data.id) throw new Error('Invalid track data');
  return buildTrackObject(data);
}

function buildTrackObject(data) {
  return {
    track: {
      album: {
        artists: data.artists.map(a => ({
          external_urls: { spotify: a.external_urls?.spotify || '' },
          href: a.href || '', id: a.id || '', name: a.name, type: 'artist', uri: a.uri || ''
        })),
        href: data.album?.href || '',
        images: data.album?.images || [],
        name: data.album?.name || '',
        uri: data.album?.uri || ''
      },
      duration_ms: data.duration_ms,
      id: data.id,
      name: data.name
    }
  };
}

async function getDiscordProfile(token) {
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { 'Authorization': token }
  });
  if (!res.ok) throw new Error('Invalid token or Discord API error');
  const d = await res.json();
  return {
    id: d.id,
    username: d.global_name || d.username,
    discriminator: d.discriminator || '0',
    avatar: d.avatar
      ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(parseInt(d.id) >> 22) % 6}.png`
  };
}

/* ── SEARCH ── */
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const token = await getSpotifyToken();
  if (!token) return res.status(400).json({ error: 'Spotify not configured. Add credentials in Settings first.' });
  try {
    const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Spotify search: ${r.status}`);
    const data = await r.json();
    const tracks = (data.tracks?.items || []).map(item => ({
      id: item.id,
      name: item.name,
      artists: item.artists.map(a => a.name).join(', '),
      album: item.album?.name || '',
      cover: item.album?.images?.[0]?.url || '',
      duration_ms: item.duration_ms,
      _raw: item
    }));
    res.json(tracks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── ADD TRACK BY ID ── */
app.post('/songs/add-track', async (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  const token = await getSpotifyToken();
  if (!token) return res.status(400).json({ error: 'Spotify not configured' });
  try {
    const r = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Spotify API: ${r.status}`);
    const data = await r.json();
    const trackObj = buildTrackObject(data);
    const existing = readJSON(dataFile, { items: [] });
    if ((existing.items || []).find(s => s.track?.id === trackId))
      return res.status(409).json({ error: 'Track already in queue' });
    existing.items = (existing.items || []).concat([trackObj]);
    writeJSON(dataFile, existing);
    res.json({ message: 'Added', track: trackObj });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── SONGS ── */
app.get('/songs', (req, res) => {
  const songs = readJSON(dataFile, { items: [] }).items || [];
  res.json(songs);
});

app.post('/songs/links', async (req, res) => {
  const { links } = req.body;
  if (!links) return res.status(400).json({ error: 'No links provided' });
  const arr = links.split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
  const newSongs = [], errors = [];
  for (const link of arr) {
    try {
      if (!link.includes('spotify.com') || !link.includes('/track/')) {
        errors.push({ link, error: 'Invalid Spotify track URL' }); continue;
      }
      newSongs.push(await getSpotifyTrackInfo(link));
    } catch (e) { errors.push({ link, error: e.message }); }
  }
  const existing = readJSON(dataFile, { items: [] });
  writeJSON(dataFile, { items: (existing.items || []).concat(newSongs) });
  res.json({ message: `Added ${newSongs.length} song(s)`, added: newSongs, errors });
});

app.delete('/songs/:id', (req, res) => {
  const data = readJSON(dataFile, { items: [] });
  data.items = (data.items || []).filter(s => s.track?.id !== req.params.id);
  writeJSON(dataFile, data);
  res.json({ message: 'Deleted' });
});

app.put('/songs/:id', (req, res) => {
  const data = readJSON(dataFile, { items: [] });
  data.items = (data.items || []).map(s => s.track?.id === req.params.id ? req.body : s);
  writeJSON(dataFile, data);
  res.json({ message: 'Updated' });
});

/* ── TOKENS ── */
app.get('/tokens', (req, res) => {
  const tokens = readJSON(tokensFile, []);
  res.json(tokens.map(t => ({ ...t, token: t.token.slice(0, 10) + '…' })));
});

app.post('/tokens', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const profile = await getDiscordProfile(token);
    const tokens  = readJSON(tokensFile, []);
    if (tokens.find(t => t.discordId === profile.id))
      return res.status(409).json({ error: 'This account is already added' });
    const entry = { discordId: profile.id, username: profile.username, avatar: profile.avatar, token, addedAt: new Date().toISOString() };
    tokens.push(entry);
    writeJSON(tokensFile, tokens);
    const cfg = readJSON(settingsFile, {});
    if (!cfg.tokens) cfg.tokens = [];
    if (!cfg.tokens.includes(token)) { cfg.tokens.push(token); writeJSON(settingsFile, cfg); }
    res.json({ message: 'Token added', profile });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/tokens/:id', (req, res) => {
  const tokens  = readJSON(tokensFile, []);
  const removed = tokens.find(t => t.discordId === req.params.id);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  writeJSON(tokensFile, tokens.filter(t => t.discordId !== req.params.id));
  const cfg = readJSON(settingsFile, {});
  cfg.tokens = (cfg.tokens || []).filter(t => t !== removed.token);
  writeJSON(settingsFile, cfg);
  res.json({ message: 'Removed' });
});

/* ── SETTINGS ── */
app.get('/settings', (req, res) => {
  const cfg = readJSON(settingsFile, {});
  res.json({ channels: cfg.channels || [], Client: cfg.Client || '', Secret: cfg.Secret || '' });
});

app.post('/settings', (req, res) => {
  const { channels, Client, Secret } = req.body;
  const cfg    = readJSON(settingsFile, {});
  const tokens = readJSON(tokensFile, []).map(t => t.token);
  writeJSON(settingsFile, {
    tokens,
    channels: Array.isArray(channels) ? channels : [channels].filter(Boolean),
    Client: Client || cfg.Client || '',
    Secret: Secret || cfg.Secret || ''
  });
  spotifyToken = null; tokenExpiry = 0;
  res.json({ message: 'Settings saved' });
});

/* ── STATUS / START / STOP ── */
app.get('/status', (req, res) => res.json({ started: isStarted }));

app.post('/start-button', (req, res) => {
  const tokens = readJSON(tokensFile, []);
  const cfg    = readJSON(settingsFile, {});
  if (!tokens.length) return res.status(400).json({ error: 'No tokens added. Go to Tokens tab first.' });
  if (!cfg.channels?.length || !cfg.channels[0]) return res.status(400).json({ error: 'Voice channel not configured. Check Settings.' });
  isStarted = true;
  writeJSON(statusFile, { started: true });
  setTimeout(() => {
    try {
      const idx = path.join(__dirname, 'index.js');
      if (require.cache[idx]) delete require.cache[idx];
      require('./index.js');
    } catch (e) { console.error('[server] index.js error:', e.message); }
  }, 1500);
  res.json({ success: true, message: 'Bot starting…' });
});

app.post('/stop-button', (req, res) => {
  isStarted = false;
  writeJSON(statusFile, { started: false });
  res.json({ success: true, message: 'Stopped' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`[server] http://0.0.0.0:${PORT}`));
