const express = require('express');
const path = require('path');
const { streamFetchIPTV, getEpgText, userCaches } = require('./iptvParser');
const { getPremiumPoster } = require('./imageEngine');

const app = express();
app.use(express.json()); app.use(express.urlencoded({ extended: true }));

const manifestTemplate = {
    id: 'community.nuvio.groupedpro', version: '5.3.0', name: 'Grouped IPTV Pro',
    description: 'Dynamic country catalogs, Premium Blurred Poster Engine, and live EPG.',
    resources: ['catalog', 'meta', 'stream'], types: ['tv'], idPrefixes: ['iptv:']
};

// High-speed dynamic poster streaming endpoint route
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

app.get('/:config/manifest.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    try {
        const conf = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf-8'));
        if (!conf.m3u) return res.status(400).json({ error: "Missing M3U" });
        await streamFetchIPTV(req.params.config, conf.m3u, conf.epg);
        const ud = userCaches.get(req.params.config);
        const instMan = JSON.parse(JSON.stringify(manifestTemplate));
        const catalogs = [];
        if (ud && ud.status === 'ready') {
            Array.from(ud.uniqueGroups).sort().forEach(g => catalogs.push({ type: 'tv', id: `iptv_${g.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`, name: g, extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }));
        }
        if (catalogs.length === 0) catalogs.push({ type: 'tv', id: 'grouped_channels', name: 'Live IPTV', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
        instMan.catalogs = catalogs; res.json(instMan);
    } catch(e) { res.status(400).json({ error: "Invalid config" }); }
});

app.get(['/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
    const { config, type, id, extra } = req.params;
    if (type !== 'tv') return res.json({ metas: [] });
    let skip = 0, search = null;
    if (extra) {
        const skipMatch = extra.match(/skip=([0-9]+)/); if (skipMatch) skip = parseInt(skipMatch[1]);
        const searchMatch = extra.match(/search=([^&]+)/); if (searchMatch) search = decodeURIComponent(searchMatch[1]).toLowerCase();
    }
    const ud = userCaches.get(config);
    if (!ud || ud.status !== 'ready') return res.json({ metas: [] });
    let fCat = ud.catalogItems.filter(i => i.catalogId === id);
    if (search) fCat = fCat.filter(i => i.name.toLowerCase().includes(search));
    
    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const paged = fCat.slice(skip, skip + 100).map(item => {
        const chKey = item.id.replace('iptv:', '');
        const { catalogId, ...rest } = item;
        const customImage = `${rootUrl}/${config}/poster/${chKey].png`;
        return { 
            ...rest, 
            poster: customImage, 
            background: customImage, 
            description: getEpgText(chKey, ud.epgData) 
        };
    });
    res.json({ metas: paged });
});

app.get(['/:config/meta/:type/:id.json', '/:config/meta/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
    const { config, type, id } = req.params; const chKey = id.replace('iptv:', ''); const ud = userCaches.get(config);
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) {
        const targetMeta = ud.channelMap.get(chKey).meta || {};
        const { catalogId, ...sMeta } = JSON.parse(JSON.stringify(targetMeta));
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const customImage = `${rootUrl}/${config}/poster/${chKey}.png`;
        sMeta.poster = customImage;
        sMeta.background = customImage;
        sMeta.description = getEpgText(chKey, ud.epgData);
        return res.json({ meta: sMeta });
    }
    return res.json({ meta: null });
});

app.get(['/:config/stream/:type/:id.json', '/:config/stream/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params; const chKey = id.replace('iptv:', ''); const ud = userCaches.get(config);
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) {
        const sortedStreams = [...ud.channelMap.get(chKey).streams]
            .sort((a, b) => b.score - a.score)
            .map(({ score, ...cleanStream }) => cleanStream);
        return res.json({ streams: sortedStreams });
    }
    return res.json({ streams: [] });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Nuvio IPTV Setup</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;}</style></head><body class="flex items-center justify-center min-h-screen p-4"><div class="bg-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-lg border border-slate-700"><h1 class="text-2xl font-bold text-indigo-400 mb-2">📺 Nuvio IPTV Pro + EPG</h1><p class="text-slate-400 text-sm mb-6">Featuring dynamic catalogs, search, prefix deduplication, and TV Guide.</p><div class="space-y-4"><div><label class="block text-xs font-semibold text-slate-400 uppercase mb-2">M3U Playlist URL</label><input type="url" id="m3uInput" oninput="generateLink()" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none text-slate-200"></div><div><label class="block text-xs font-semibold text-slate-400 uppercase mb-2">XMLTV EPG URL (Optional)</label><input type="url" id="epgInput" oninput="generateLink()" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none text-slate-200"></div></div><div id="installSection" class="hidden mt-6 pt-6 border-t border-slate-700 space-y-3"><a id="installBtn" href="#" class="block text-center bg-indigo-600 hover:bg-indigo-500 text-sm font-medium py-3 rounded-lg w-full">Install Addon to Nuvio</a><p class="text-[11px] text-slate-500 text-center">Server will build your categories on install.</p></div></div><script>function generateLink(){const m=document.getElementById('m3uInput').value.trim();const e=document.getElementById('epgInput').value.trim();const s=document.getElementById('installSection');if(!m){s.classList.add('hidden');return;}const o={m3u:m};if(e)o.epg=e;const b=btoa(JSON.stringify(o));document.getElementById('installBtn').href='stremio://'+window.location.host+'/'+b+'/manifest.json';s.classList.remove('hidden');}</script></body></html>`);
});

app.listen(process.env.PORT || 7000);
