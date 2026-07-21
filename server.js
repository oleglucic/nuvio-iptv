const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { streamFetchIPTV, getEpgText, userCaches } = require('./iptvParser');
const { getPremiumPoster } = require('./imageEngine');

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Shallow Category Discovery Route
app.post('/api/get-groups', async (req, res) => {
    const { type, m3uUrl, xtreamUrl, username, password } = req.body;
    try {
        if (type === 'xtream') {
            if (!xtreamUrl || !username || !password) return res.status(400).json({ error: "Missing Credentials" });
            const cleanUrl = xtreamUrl.replace(/\/$/, "");
            const apiRes = await axios.get(`${cleanUrl}/player_api.php?username=${username}&password=${password}&action=get_live_categories`, { timeout: 10000 });
            if (Array.isArray(apiRes.data)) {
                return res.json({ categories: apiRes.data.map(cat => cat.category_name).sort() });
            }
            return res.status(400).json({ error: "Invalid provider structure response" });
        } else {
            if (!m3uUrl) return res.status(400).json({ error: "Missing M3U Stream URL" });
            const m3uRes = await axios.get(m3uUrl, { headers: { 'Range': 'bytes=0-5242880' }, timeout: 10000 });
            const lines = m3uRes.data.split('\n');
            const groups = new Set();
            for (const line of lines) {
                if (line.startsWith('#EXTINF:')) {
                    const match = line.match(/group-title="([^"]+)"/);
                    if (match && match[1]) groups.add(match[1]);
                }
            }
            return res.json({ categories: Array.from(groups).sort() });
        }
    } catch (err) {
        return res.status(500).json({ error: "Connection to provider failed: " + err.message });
    }
});

// Stremio Addon Configuration Parsing
function extractConfig(req) {
    try {
        let rawB64 = (req.params.config || req.query.config || '');
        rawB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
        // Pad to a multiple of 4
        while (rawB64.length % 4 !== 0) rawB64 += '=';
        const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
        // Handle btoa(unescape(encodeURIComponent(...))) encoding from dashboard
        try { return JSON.parse(decodeURIComponent(escape(decoded))); } catch (_) {}
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

// Ensure cache is populated before serving data routes
async function ensureCache(config, configObj) {
    if (!configObj) return null;
    let cached = userCaches.get(config);
    if (!cached || cached.status === 'error' ||
        (cached.status === 'ready' && (Date.now() - cached.lastUpdated > 60 * 60 * 1000))) {
        streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] fetch failed:', e.message));
        cached = userCaches.get(config);
    }
    return cached;
}

// Stremio Manifest Router
app.get('/:config/manifest.json', async (req, res) => {
    const config = req.params.config;
    const configObj = extractConfig(req);

    let genreOptions = [];
    if (configObj) {
        const cached = userCaches.get(config);
        if (cached && cached.uniqueGroups) {
            genreOptions = Array.from(cached.uniqueGroups);
        }
        ensureCache(config, configObj);
    }

    res.json({
        id: 'org.iptvo.premium',
        version: '1.0.0',
        name: 'IPTVo Premium',
        description: 'AI Curation Stack & Intelligent Catalog Filter Layer',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [{
            type: 'tv',
            id: 'iptvo_live',
            name: 'IPTVo Live TV',
            extra: [{ name: 'genre', isRequired: false, options: genreOptions }]
        }]
    });
});

// Stremio Catalog Router
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    const config = req.params.config;
    const configObj = extractConfig(req);
    if (!configObj) return res.json({ metas: [] });

    const ud = await ensureCache(config, configObj);

      if (!ud || !ud.channelMap) return res.json({ metas: [] });

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const selectedGenre = req.query.genre; 
    const metas = [];

    for (const [chKey, channel] of ud.channelMap.entries()) {
        if (selectedGenre && channel.meta.group !== selectedGenre) continue;

        const engineImage = `${rootUrl}/${config}/poster/${chKey}.png?t=${ud.lastUpdated}`;
        const passedThroughLogo = channel.meta.logo || engineImage;
        const epgDescription = getEpgText(chKey, ud.epgData, configObj.timezoneOffset || 0);

        metas.push({
            id: channel.meta.id,
            type: 'tv',
            name: channel.meta.name,
            poster: engineImage,
            background: engineImage,
            logo: passedThroughLogo,
            description: epgDescription,
            genres: [channel.meta.group] 
        });
    }
    res.json({ metas });
});

// Stremio Meta Information Router
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const config = req.params.config;
    const id = req.params.id; // Keep full id including iptv: prefix
    const configObj = extractConfig(req);

    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
    if (!ud || !ud.channelMap.has(id)) return res.json({ meta: {} });
    const channel = ud.channelMap.get(id);

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const engineImage = `${rootUrl}/${config}/poster/${encodeURIComponent(id)}.png?t=${ud.lastUpdated}`;
    const passedThroughLogo = channel.meta.logo || engineImage;
    const epgDescription = getEpgText(id, ud.epgData, configObj ? configObj.timezoneOffset : 0);

    res.json({
        meta: {
            id: channel.meta.id,
            type: 'tv',
            name: channel.meta.name,
            poster: engineImage,
            background: engineImage,
            logo: passedThroughLogo,
            description: epgDescription
        }
    });
});

// Stremio Stream Handler Routing
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const config = req.params.config;
    const id = req.params.id; // Keep full id including iptv: prefix
    const configObj = extractConfig(req);

    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
    if (!ud || !ud.channelMap.has(id)) return res.json({ streams: [] });
    const channel = ud.channelMap.get(id);

    const streamsToReturn = channel.streams
        .sort((a, b) => b.score - a.score)
        .map(stream => ({
            title: stream.title ? `${stream.name} | ${stream.title}` : stream.name,
            url: stream.url
        }));

    res.json({ streams: streamsToReturn });
});

// Fallback Canvas Image Generator Route
app.get('/:config/poster/:id.png', async (req, res) => {
    const config = req.params.config;
    const id = decodeURIComponent(req.params.id); // Keep full id including iptv: prefix
    const configObj = extractConfig(req);

    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
    let logoUrl = null;
    let channelName = "Live TV";
    
    if (ud && ud.channelMap.has(id)) {
        const channel = ud.channelMap.get(id);
        logoUrl = channel.meta.logo;
        channelName = channel.meta.name;
    }

    try {
        const cachedPosterPath = await getPremiumPoster(id, logoUrl, channelName);
        res.sendFile(cachedPosterPath);
    } catch (error) {
        console.error("[Poster Generation Error]", error.message);
        res.status(500).send("Error compiling image layer context");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IPTVo Premium Backend operational on port ${PORT}`));
