const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { streamFetchIPTV, getEpgText, userCaches } = require('./iptvParser');
const { getPremiumPoster } = require('./imageEngine');

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
        .row-flex { display: flex; gap: 10px; }
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

    <div class="row-flex">
        <div style="width: 50%;">
            <label class="setting-label">Fallback Mode</label>
            <select id="fallbackPreference">
                <option value="custom">Clean Text Posters</option>
                <option value="provider">Raw Image</option>
            </select>
        </div>
        <div style="width: 50%;">
            <label class="setting-label">Timezone Shift</label>
            <select id="timezoneOffset">
                <option value="-12">UTC -12</option>
                <option value="-11">UTC -11</option>
                <option value="-10">UTC -10</option>
                <option value="-9">UTC -9</option>
                <option value="-8">UTC -8</option>
                <option value="-7">UTC -7</option>
                <option value="-6">UTC -6</option>
                <option value="-5">UTC -5</option>
                <option value="-4">UTC -4</option>
                <option value="-3">UTC -3</option>
                <option value="-2">UTC -2</option>
                <option value="-1">UTC -1</option>
                <option value="0">UTC +0</option>
                <option value="1">UTC +1</option>
                <option value="2">UTC +2</option>
                <option value="3">UTC +3</option>
                <option value="4">UTC +4</option>
                <option value="5">UTC +5</option>
                <option value="6">UTC +6</option>
                <option value="7">UTC +7</option>
                <option value="8">UTC +8</option>
                <option value="9">UTC +9</option>
                <option value="10">UTC +10</option>
                <option value="11">UTC +11</option>
                <option value="12">UTC +12</option>
            </select>
        </div>
    </div>

    <label class="setting-label">Custom EPG Source (Optional)</label>
    <input type="text" id="customEpgUrl" placeholder="Leave empty to use provider EPG">

    <button type="button" id="loadCatalogsBtn" onclick="fetchCatalogs()">Load Available Catalogs</button>

    <div id="catalogContainer">
        <span class="setting-label" style="margin-top:0;">Select Active Layout Catalogs</span>
        <div style="margin: 8px 0; display:flex; gap:10px;">
            <button type="button" onclick="toggleAllCheckboxes(true)" style="padding:4px; font-size:11px; background:#334155;">All</button>
            <button type="button" onclick="toggleAllCheckboxes(false)" style="padding:4px; font-size:11px; background:#334155;">Clear</button>
        </div>
        <div id="checklistList" class="scroll-box"></div>
    </div>

    <button type="button" id="installBtn" onclick="generateStremioLink()" style="background:#059669; margin-top:15px;">Install Addon</button>
</div>

<script>
    let totalCategoriesCount = 0;

    window.onload = function() {
        toggleFormInputs();
        const detectedOffset = -Math.round(new Date().getTimezoneOffset() / 60);
        const tzSelect = document.getElementById('timezoneOffset');
        if (tzSelect.querySelector('option[value="' + detectedOffset + '"]')) {
            tzSelect.value = detectedOffset.toString();
        }
    };

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
            btn.innerText = "Load Available Catalogs";
            btn.disabled = false;
            return true;
        } catch (err) {
            alert("Connection Mapping Failed: " + err.message);
            btn.innerText = "Load Available Catalogs";
            btn.disabled = false;
            return false;
        }
    }

    function toggleAllCheckboxes(status) {
        document.querySelectorAll('.catalog-chk').forEach(chk => chk.checked = status);
    }

    async function generateStremioLink() {
        let allCheckboxes = document.querySelectorAll('.catalog-chk');
        const installBtn = document.getElementById('installBtn');
        
        // FIXED: Auto-sync communication gap handler
        if (allCheckboxes.length === 0) {
            installBtn.innerText = "Auto-Syncing Catalogs...";
            installBtn.disabled = true;
            
            const syncSuccess = await fetchCatalogs();
            
            installBtn.innerText = "Install Addon";
            installBtn.disabled = false;
            
            if (!syncSuccess) return;
            allCheckboxes = document.querySelectorAll('.catalog-chk');
        }

        const checked = [];
        const unchecked = [];

        allCheckboxes.forEach(chk => {
            const val = decodeURIComponent(chk.value);
            if (chk.checked) checked.push(val);
            else unchecked.push(val);
        });

        const type = document.getElementById('providerType').value;
        const fallbackPref = document.getElementById('fallbackPreference').value;
        const tzOffset = document.getElementById('timezoneOffset').value;
        const customEpg = document.getElementById('customEpgUrl').value.trim();
        
        const configObj = { 
            type, 
            fallbackPreference: fallbackPref,
            timezoneOffset: parseInt(tzOffset)
        };

        if (customEpg) {
            configObj.epg = customEpg;
        }

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

        let base64Config = btoa(unescape(encodeURIComponent(JSON.stringify(configObj))));
        base64Config = base64Config.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        
        const manifestUrl = \`stremio://\${window.location.host}/\${base64Config}/manifest.json\`;
        
        navigator.clipboard.writeText(manifestUrl).catch(() => {}).finally(() => {
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
        rawB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

// Stremio Manifest Router
app.get('/:config/manifest.json', (req, res) => {
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
            extra: [{ name: 'genre', isRequired: false }]
        }]
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
    let id = req.params.id;
    const configObj = extractConfig(req);
    
    if (id.startsWith('iptv:')) id = id.substring(5);

    const ud = userCaches.get(config);
    if (!ud || !ud.channelMap.has(id)) return res.json({ meta: {} });
    const channel = ud.channelMap.get(id);

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const engineImage = `${rootUrl}/${config}/poster/${id}.png?t=${ud.lastUpdated}`;
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
    let id = req.params.id;

    if (id.startsWith('iptv:')) id = id.substring(5);

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
    let id = req.params.id;
    
    if (id.startsWith('iptv:')) id = id.substring(5);
    
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
