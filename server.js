const express = require('express');
const path = require('path');
const { streamFetchIPTV, getEpgText, userCaches } = require('./iptvParser');
const { getPremiumPoster } = require('./imageEngine');

const app = express();
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

const manifestTemplate = {
    id: 'com.oleglucic.iptvo', 
    version: '0.0.1', 
    name: 'IPTVo',
    description: 'AI-Powered IPTV Curator. Auto-mapping, Catchup archives, and dynamic EPG.',
    resources: ['catalog', 'meta', 'stream'], 
    types: ['tv'], 
    idPrefixes: ['iptv:']
};

// Premium Poster Route
app.get('/:config/poster/:cId.png', async (req, res) => {
    const { config, cId } = req.params;
    const ud = userCaches.get(config);
    let logoUrl = "", nameFallback = "Live TV";
    
    if (ud && ud.logoTracker && ud.logoTracker.has(cId)) {
        const item = ud.logoTracker.get(cId);
        logoUrl = item.url; nameFallback = item.name;
    }
    
    try {
        const imagePath = await getPremiumPoster(cId, logoUrl, nameFallback);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(imagePath);
    } catch (e) {
        res.status(500).send("Image Error");
    }
});

// Manifest Router (Differentiates between M3U and Xtream)
app.get('/:config/manifest.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Headers', '*');
    try {
        const conf = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf-8'));
        
        // Trigger data ingestion depending on what configuration type the user chose
        await streamFetchIPTV(req.params.config, conf);
        
        const ud = userCaches.get(req.params.config);
        const instMan = JSON.parse(JSON.stringify(manifestTemplate));
        const catalogs = [];
        
        if (ud && ud.status === 'ready') {
            Array.from(ud.uniqueGroups).sort().forEach(g => {
                catalogs.push({ 
                    type: 'tv', 
                    id: `iptv_${g.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`, 
                    name: g, 
                    extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] 
                });
            });
        }
        
        if (catalogs.length === 0) {
            catalogs.push({ type: 'tv', id: 'grouped_channels', name: 'Live IPTV', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
        }
        
        instMan.catalogs = catalogs; 
        res.json(instMan);
    } catch(e) { 
        res.status(400).json({ error: "Invalid config or data collection failed" }); 
    }
});

// Catalog Router
app.get(['/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
    const { config, type, id, extra } = req.params;
    if (type !== 'tv') return res.json({ metas: [] });
    
    let skip = 0, search = null;
    if (extra) {
        const skipMatch = extra.match(/skip=([0-9]+)/); if (skipMatch) skip = parseInt(skipMatch[1]);
        const searchMatch = extra.match(/search=([^&]+)/); if (searchMatch) search = decodeURIComponent(searchMatch[1]).toLowerCase();
    }
    
    let offset = 0;
    try {
        const conf = JSON.parse(Buffer.from(config, 'base64').toString('utf-8'));
        if (conf.offset) offset = parseInt(conf.offset);
    } catch(e) {}

    const ud = userCaches.get(config);
    if (!ud || ud.status !== 'ready') return res.json({ metas: [] });
    let fCat = ud.catalogItems.filter(i => i.catalogId === id);
    if (search) fCat = fCat.filter(i => i.name.toLowerCase().includes(search));
    
    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const paged = fCat.slice(skip, skip + 100).map(item => {
        const chKey = item.id.replace('iptv:', '');
        const { catalogId, ...rest } = item;
        const customImage = `${rootUrl}/${config}/poster/${chKey}.png`;
        return { 
            ...rest, 
            poster: customImage, 
            background: customImage, 
            description: getEpgText(chKey, ud.epgData, offset) 
        };
    });
    res.json({ metas: paged });
});

// Meta Router
app.get(['/:config/meta/:type/:id.json', '/:config/meta/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
    const { config, type, id } = req.params; 
    const chKey = id.replace('iptv:', ''); 
    const ud = userCaches.get(config);
    
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) {
        let offset = 0;
        try {
            const conf = JSON.parse(Buffer.from(config, 'base64').toString('utf-8'));
            if (conf.offset) offset = parseInt(conf.offset);
        } catch(e) {}

        const targetMeta = ud.channelMap.get(chKey).meta || {};
        const { catalogId, ...sMeta } = JSON.parse(JSON.stringify(targetMeta));
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const customImage = `${rootUrl}/${config}/poster/${chKey}.png`;
        sMeta.poster = customImage;
        sMeta.background = customImage;
        sMeta.description = getEpgText(chKey, ud.epgData, offset);
        return res.json({ meta: sMeta });
    }
    return res.json({ meta: null });
});

// Stream Router
app.get(['/:config/stream/:type/:id.json', '/:config/stream/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params; 
    const chKey = id.replace('iptv:', ''); 
    const ud = userCaches.get(config);
    
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) {
        const sortedStreams = [...ud.channelMap.get(chKey).streams]
            .sort((a, b) => b.score - a.score)
            .map(({ score, ...cleanStream }) => cleanStream);
        return res.json({ streams: sortedStreams });
    }
    return res.json({ streams: [] });
});

// Customizable Landing Configuration Page UI
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IPTVo Configuration</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #0f172a; color: #f8fafc; font-family: sans-serif; }</style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="bg-slate-800 p-8 rounded-2xl shadow-2xl w-full max-w-xl border border-slate-700">
        <div class="text-center mb-8">
            <h1 class="text-3xl font-extrabold text-indigo-400 tracking-tight">IPTVo <span class="text-slate-500 text-sm font-normal">v0.0.1</span></h1>
            <p class="text-slate-400 text-sm mt-1">The AI-Powered Stremio & Nuvio Curator</p>
        </div>

        <div class="space-y-6">
            <div class="flex bg-slate-900 rounded-lg p-1">
                <button id="btnM3u" onclick="switchTab('m3u')" class="flex-1 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white shadow">M3U Playlist</button>
                <button id="btnXtream" onclick="switchTab('xtream')" class="flex-1 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-white">Xtream Codes</button>
            </div>

            <div id="m3uSection" class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">M3U URL</label>
                    <input type="url" id="m3uUrl" oninput="generateLink()" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors">
                </div>
            </div>

            <div id="xtreamSection" class="space-y-4 hidden">
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Server URL / Host</label>
                    <input type="url" id="xtreamHost" oninput="generateLink()" placeholder="http://domain.com:8080" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors">
                </div>
                <div class="flex gap-4">
                    <div class="flex-1">
                        <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Username</label>
                        <input type="text" id="xtreamUser" oninput="generateLink()" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors">
                    </div>
                    <div class="flex-1">
                        <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Password</label>
                        <input type="password" id="xtreamPass" oninput="generateLink()" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors">
                    </div>
                </div>
            </div>

            <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">XMLTV EPG URL (Optional)</label>
                <input type="url" id="epgUrl" oninput="generateLink()" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors">
            </div>

            <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Timezone Shift</label>
                <select id="offset" onchange="generateLink()" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors">
                    <option value="0">No Shift (UTC)</option>
                    <option value="1">+1 Hour (CET)</option>
                    <option value="2" selected>+2 Hours (CEST / Central European Summer Time)</option>
                    <option value="-5">-5 Hours (EST)</option>
                </select>
            </div>

            <div class="pt-4 border-t border-slate-700 space-y-3">
                <label class="flex items-center space-x-3 cursor-pointer">
                    <input type="checkbox" id="optCatchup" onchange="generateLink()" class="h-5 w-5 text-indigo-500 bg-slate-900 border-slate-700 rounded" checked>
                    <span class="text-sm font-medium text-slate-300">Enable 48H Catchup Archives</span>
                </label>
                <label class="flex items-center space-x-3 cursor-pointer">
                    <input type="checkbox" id="optAi" onchange="generateLink()" class="h-5 w-5 text-indigo-500 bg-slate-900 border-slate-700 rounded" checked>
                    <span class="text-sm font-medium text-slate-300">Use AI Channel Curation (OpenRouter)</span>
                </label>
                <label class="flex items-center space-x-3 cursor-pointer">
                    <input type="checkbox" id="optBlur" onchange="generateLink()" class="h-5 w-5 text-indigo-500 bg-slate-900 border-slate-700 rounded" checked>
                    <span class="text-sm font-medium text-slate-300">Generate Premium Blurred Posters</span>
                </label>
            </div>
        </div>

        <div id="installSection" class="hidden mt-8 pt-6 border-t border-slate-700">
            <a id="installBtn" href="#" class="block text-center bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 px-4 rounded-xl shadow-lg transition-transform transform hover:scale-[1.02]">
                Install IPTVo
            </a>
        </div>
    </div>

    <script>
        let currentMode = 'm3u';

        function switchTab(mode) {
            currentMode = mode;
            document.getElementById('btnM3u').className = mode === 'm3u' ? 'flex-1 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white shadow' : 'flex-1 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-white';
            document.getElementById('btnXtream').className = mode === 'xtream' ? 'flex-1 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white shadow' : 'flex-1 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-white';
            
            document.getElementById('m3uSection').style.display = mode === 'm3u' ? 'block' : 'none';
            document.getElementById('xtreamSection').style.display = mode === 'xtream' ? 'block' : 'none';
            generateLink();
        }

        function generateLink() {
            const config = {
                type: currentMode,
                offset: document.getElementById('offset').value,
                catchup: document.getElementById('optCatchup').checked,
                ai: document.getElementById('optAi').checked,
                blur: document.getElementById('optBlur').checked
            };

            const epg = document.getElementById('epgUrl').value.trim();
            if (epg) config.epg = epg;

            let isValid = false;
            if (currentMode === 'm3u') {
                const url = document.getElementById('m3uUrl').value.trim();
                if (url) { config.m3u = url; isValid = true; }
            } else {
                const host = document.getElementById('xtreamHost').value.trim();
                const user = document.getElementById('xtreamUser').value.trim();
                const pass = document.getElementById('xtreamPass').value.trim();
                if (host && user && pass) {
                    config.host = host; config.user = user; config.pass = pass;
                    isValid = true;
                }
            }

            const section = document.getElementById('installSection');
            if (!isValid) {
                section.classList.add('hidden');
                return;
            }

            const b64 = btoa(JSON.stringify(config));
            document.getElementById('installBtn').href = 'stremio://' + window.location.host + '/' + b64 + '/manifest.json';
            section.classList.remove('hidden');
        }
    </script>
</body>
</html>`);
});

app.listen(process.env.PORT || 7000);
