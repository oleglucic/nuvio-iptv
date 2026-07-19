const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { streamFetchIPTV, userCaches } = require('./iptvParser');
const { generateFallbackPoster } = require('./imageEngine');
const { syncPremiumEpgToSupabase } = require('./universalEpg');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Serving the Dashboard HTML directly from server.js
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IPTVo Setup Engine</title>
    <style>
        body { background: #0b0f19; color: #f8fafc; font-family: system-ui, sans-serif; max-width: 500px; margin: 40px auto; padding: 20px; }
        .card { background: #111827; border: 1px solid #1f2937; padding: 25px; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); text-align: center; }
        h2 { color: #6366f1; margin-bottom: 20px; }
        select, input, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        select, input { background: #1f2937; border: 1px solid #374151; color: #fff; }
        button { background: #6366f1; border: none; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { background: #4f46e5; }
        button:disabled { background: #374151; cursor: not-allowed; }
        #catalogContainer { display: none; background: #0f172a; border: 1px solid #1e293b; padding: 15px; border-radius: 8px; text-align: left; margin: 20px 0; }
        .scroll-box { max-height: 220px; overflow-y: auto; margin-top: 10px; border-top: 1px solid #334155; padding-top: 10px; }
        .chk-row { display: flex; align-items: center; margin: 6px 0; cursor: pointer; font-size: 13px; }
        .chk-row input { width: auto; margin-right: 10px; }
        .setting-label { color:#818cf8; font-weight:bold; font-size:14px; display:block; text-align:left; margin: 15px 0 5px 0; }
    </style>
</head>
<body>

<div class="card">
    <h2>IPTVo Engine Setup</h2>
    
    <select id="providerType" onchange="toggleFormInputs()">
        <option value="xtream">Xtream Codes API</option>
        <option value="m3u">M3U Playlist URL</option>
    </select>

    <div id="xtreamFields">
        <input type="text" id="xtreamUrl" placeholder="Server URL (e.g. http://provider.com:8080)">
        <input type="text" id="username" placeholder="Username">
        <input type="password" id="password" placeholder="Password">
    </div>

    <div id="m3uFields" style="display:none;">
        <input type="text" id="m3uUrl" placeholder="Paste full .m3u / .m3u8 link here">
    </div>

    <label class="setting-label">Missing Logo Behavior</label>
    <select id="fallbackPreference">
        <option value="custom">Generate Clean Text Posters (Recommended)</option>
        <option value="provider">Use Provider's Raw Image (If available)</option>
    </select>

    <button type="button" id="loadCatalogsBtn" onclick="fetchCatalogs()">Load Available Catalogs</button>

    <div id="catalogContainer">
        <span class="setting-label" style="margin-top:0;">Select Active Layout Catalogs</span>
        <div style="margin: 8px 0; display:flex; gap:10px;">
            <button type="button" onclick="toggleAllCheckboxes(true)" style="padding:4px; font-size:11px; background:#334155;">All</button>
            <button type="button" onclick="toggleAllCheckboxes(false)" style="padding:4px; font-size:11px; background:#334155;">Clear</button>
        </div>
        <div id="checklistList" class="scroll-box"></div>
    </div>

    <button type="button" id="installBtn" onclick="generateStremioLink()" style="background:#059669; margin-top:15px;">Generate Stremio Link</button>
</div>

<script>
    let totalCategoriesCount = 0;

    function toggleFormInputs() {
        const type = document.getElementById('providerType').value;
        document.getElementById('xtreamFields').style.display = type === 'xtream' ? 'block' : 'none';
        document.getElementById('m3uFields').style.display = type === 'm3u' ? 'block' : 'none';
    }

    async function fetchCatalogs() {
        const btn = document.getElementById('loadCatalogsBtn');
        const container = document.getElementById('catalogContainer');
        const listDiv = document.getElementById('checklistList');
        
        const type = document.getElementById('providerType').value;
        const m3uUrl = document.getElementById('m3uUrl').value;
        const xtreamUrl = document.getElementById('xtreamUrl').value;
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        btn.innerText = "Scanning Provider Lines...";
        btn.disabled = true;
        listDiv.innerHTML = "";

        try {
            const response = await fetch('/api/get-groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, m3uUrl, xtreamUrl, username, password })
            });
            
            const data = await response.json();
            if (data.error) throw new Error(data.error);

            totalCategoriesCount = data.categories.length;
            
            data.categories.forEach(cat => {
                const label = document.createElement('label');
                label.className = "chk-row";
                label.innerHTML = \`<input type="checkbox" class="catalog-chk" value="\${encodeURIComponent(cat)}" checked> <span>\${cat}</span>\`;
                listDiv.appendChild(label);
            });

            container.style.display = "block";
            btn.innerText = "Catalogs Sync Complete!";
        } catch (err) {
            alert("Connection Mapping Failed: " + err.message);
            btn.innerText = "Load Available Catalogs";
            btn.disabled = false;
        }
    }

    function toggleAllCheckboxes(status) {
        document.querySelectorAll('.catalog-chk').forEach(chk => chk.checked = status);
    }

    function generateStremioLink() {
        const allCheckboxes = document.querySelectorAll('.catalog-chk');
        const checked = [];
        const unchecked = [];

        allCheckboxes.forEach(chk => {
            const val = decodeURIComponent(chk.value);
            if (chk.checked) checked.push(val);
            else unchecked.push(val);
        });

        const type = document.getElementById('providerType').value;
        const fallbackPref = document.getElementById('fallbackPreference').value;
        
        const configObj = { type, fallbackPreference: fallbackPref };

        if (type === 'xtream') {
            configObj.xtreamUrl = document.getElementById('xtreamUrl').value;
            configObj.username = document.getElementById('username').value;
            configObj.password = document.getElementById('password').value;
        } else {
            configObj.m3uUrl = document.getElementById('m3uUrl').value;
        }

        if (allCheckboxes.length > 0) {
            if (checked.length <= totalCategoriesCount / 2) {
                configObj.include = checked;
            } else {
                configObj.exclude = unchecked;
            }
        }

        // Convert Base64 to URL-Safe Base64 so Express routing doesn't break
        let base64Config = btoa(unescape(encodeURIComponent(JSON.stringify(configObj))));
        base64Config = base64Config.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        
        const manifestUrl = \`stremio://\${window.location.host}/\${base64Config}/manifest.json\`;
        
        alert("Success! Copying setup addon protocol mapping directly to device clipboard.");
        navigator.clipboard.writeText(manifestUrl).then(() => {
            window.location.href = manifestUrl;
        });
    }
</script>
</body>
</html>
    `);
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
        let rawB64 = req.params.config;
        // Convert URL-Safe Base64 back into Standard Base64 for Node Buffer decoding
        rawB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
        
        const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

// Stremio Manifest Router
app.get('/:config/manifest.json', (req, res) => {
    const configObj = extractConfig(req);
    if (!configObj) return res.status(400).send("Bad Config Structure");

    res.json({
        id: 'org.iptvo.premium',
        version: '1.0.0',
        name: 'IPTVo Premium',
        description: 'AI Curation Stack & Intelligent Catalog Filter Layer',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [{ type: 'tv', id: 'iptvo_live', name: 'IPTVo Live TV' }]
    });
});

// Stremio Catalog Router
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    const config = req.params.config;
    const configObj = extractConfig(req);
    if (!configObj) return res.json({ metas: [] });

    await streamFetchIPTV(config, configObj);
    const ud = userCaches.get(config);

    if (!ud || !ud.channelMap) return res.json({ metas: [] });

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const metas = [];

    for (const [chKey, channel] of ud.channelMap.entries()) {
        const customImage = channel.meta.logo ? channel.meta.logo : `${rootUrl}/${config}/poster/${chKey}.png?t=${ud.lastUpdated}`;
        metas.push({
            id: channel.meta.id,
            type: 'tv',
            name: channel.meta.name,
            poster: customImage,
            background: customImage,
            logo: customImage,
            description: `Category: ${channel.meta.genres[0]}`
        });
    }
    res.json({ metas });
});

// Stremio Meta Information Router
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const config = req.params.config;
    const id = req.params.id;
    const ud = userCaches.get(config);

    if (!ud || !ud.channelMap.has(id)) return res.json({ meta: {} });
    const channel = ud.channelMap.get(id);

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const customImage = channel.meta.logo ? channel.meta.logo : `${rootUrl}/${config}/poster/${id}.png?t=${ud.lastUpdated}`;

    res.json({
        meta: {
            id: channel.meta.id,
            type: 'tv',
            name: channel.meta.name,
            poster: customImage,
            background: customImage,
            logo: customImage,
            description: `Live Stream: ${channel.meta.name} via category [${channel.meta.genres[0]}]`
        }
    });
});

// Stremio Stream Handler Routing
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const config = req.params.config;
    const id = req.params.id;
    const ud = userCaches.get(config);

    if (!ud || !ud.channelMap.has(id)) return res.json({ streams: [] });
    const channel = ud.channelMap.get(id);

    const streamsToReturn = channel.streams.map(stream => ({
        title: stream.title ? `${stream.name} | ${stream.title}` : stream.name,
        url: stream.url
    }));

    res.json({ streams: streamsToReturn });
});

// Fallback Canvas Image Generator Route
app.get('/:config/poster/:id.png', async (req, res) => {
    const config = req.params.config;
    const id = req.params.id;
    const ud = userCaches.get(config);

    let channelName = "Live TV";
    if (ud && ud.channelMap.has(id)) {
        channelName = ud.channelMap.get(id).meta.name;
    }

    const imgBuffer = await generateFallbackPoster(channelName);
    res.set('Content-Type', 'image/png');
    res.send(imgBuffer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`IPTVo Premium Backend operational on port ${PORT}`);
    
    // Trigger the EPG sync in the background automatically when the server boots
    const epgSourceUrl = 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz';
    syncPremiumEpgToSupabase(epgSourceUrl);
});
