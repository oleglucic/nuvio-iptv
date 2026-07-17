const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const { parse: parseM3U } = require('iptv-playlist-parser');
const epgParser = require('epg-parser');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let M3U_URL = '';
let EPG_URL = '';
let channelMap = new Map(); 
let catalogItems = [];
let epgData = {};
let isConfigured = false;
let statusMessage = "Addon is waiting for configuration.";

const manifest = {
    id: 'community.nuvio.groupediptv',
    version: '1.2.0',
    name: 'Grouped IPTV Dashboard',
    description: 'Smart IPTV grouping with live EPG and Web UI configuration.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [{ type: 'tv', id: 'grouped_channels', name: 'Live IPTV' }]
};

const builder = new addonBuilder(manifest);

async function syncIPTVData() {
    if (!M3U_URL) return;
    try {
        statusMessage = "Syncing M3U and EPG data...";
        
        const m3uRes = await axios.get(M3U_URL);
        const playlist = parseM3U(m3uRes.data);
        const tempMap = new Map();
        const tempCatalog = [];

        playlist.items.forEach(item => {
            const regexFilter = /\s*(\[.*?\]|\(.*?\)|HD|FHD|UHD|4K|SD|RAW|HEVC|1080p|720p)\s*/gi;
            const coreName = item.name.replace(regexFilter, '').trim().toLowerCase();
            const channelId = item.tvg.id || coreName.replace(/[^a-z0-9]/g, "");
            const streamTitle = item.name || "Standard Quality";

            if (!tempMap.has(channelId)) {
                const metaItem = {
                    id: `iptv:${channelId}`,
                    type: 'tv',
                    name: coreName.replace(/\b\w/g, char => char.toUpperCase()), 
                    poster: item.tvg.logo || '',
                    background: item.tvg.logo || '',
                    description: `Loading guide data...`,
                    genres: [item.group.title || 'Live TV']
                };
                tempMap.set(channelId, { meta: metaItem, streams: [] });
                tempCatalog.push(metaItem);
            }
            tempMap.get(channelId).streams.push({ title: streamTitle, url: item.url });
        });

        channelMap = tempMap;
        catalogItems = tempCatalog;

        if (EPG_URL) {
            const epgRes = await axios.get(EPG_URL);
            const parsedEpg = epgParser.parse(epgRes.data);
            const tempEpg = {};
            parsedEpg.programs.forEach(p => {
                if (!tempEpg[p.channel]) tempEpg[p.channel] = [];
                tempEpg[p.channel].push(p);
            });
            epgData = tempEpg;
        }

        isConfigured = true;
        statusMessage = `Ready. Successfully loaded ${catalogItems.length} unique channels.`;
        console.log(statusMessage);
    } catch (err) {
        statusMessage = `Error syncing data: ${err.message}`;
        console.error(statusMessage);
    }
}

setInterval(() => { if(isConfigured) syncIPTVData(); }, 6 * 60 * 60 * 1000);

builder.defineCatalogHandler(({ type, id }) => {
    if (type === 'tv' && id === 'grouped_channels') return Promise.resolve({ catalogs: catalogItems });
    return Promise.resolve({ catalogs: [] });
});

builder.defineMetaHandler(({ type, id }) => {
    const channelKey = id.replace('iptv:', '');
    if (type === 'tv' && channelMap.has(channelKey)) {
        let metaResponse = JSON.parse(JSON.stringify(channelMap.get(channelKey).meta));
        const now = new Date();
        const channelSchedule = epgData[channelKey];
        
        if (channelSchedule) {
            const currentProgram = channelSchedule.find(p => new Date(p.start) <= now && new Date(p.stop) >= now);
            const nextProgram = channelSchedule.find(p => new Date(p.start) > now);
            let epgText = "";
            if (currentProgram) {
                const startTime = new Date(currentProgram.start).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                const stopTime = new Date(currentProgram.stop).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                epgText += `🟢 NOW PLAYING (${startTime} - ${stopTime})\n${currentProgram.title[0].value}\n${currentProgram.desc ? currentProgram.desc[0].value : ''}\n\n`;
            }
            if (nextProgram) {
                const nextStartTime = new Date(nextProgram.start).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                epgText += `⏭️ UP NEXT (${nextStartTime})\n${nextProgram.title[0].value}`;
            }
            if (epgText) metaResponse.description = epgText;
        } else {
            metaResponse.description = "No live TV guide metadata mapped for this channel.";
        }
        return Promise.resolve({ meta: metaResponse });
    }
    return Promise.resolve({ meta: null });
});

builder.defineStreamHandler(({ type, id }) => {
    const channelKey = id.replace('iptv:', '');
    if (type === 'tv' && channelMap.has(channelKey)) return Promise.resolve({ streams: channelMap.get(channelKey).streams });
    return Promise.resolve({ streams: [] });
});

app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Nuvio IPTV Setup</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
        <style>body { background: #0f172a; color: #f8fafc; font-family: sans-serif; }</style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-4">
        <div class="bg-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-lg border border-slate-700">
            <h1 class="text-2xl font-bold text-indigo-400 mb-2">📺 IPTV Grouper Setup</h1>
            <p class="text-slate-400 text-sm mb-6">Enter your m3u4u details below to merge quality streams under single channel icons.</p>
            
            <form action="/save" method="POST" class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">M3U Playlist URL</label>
                    <input type="url" name="m3u" value="${M3U_URL}" required placeholder="https://itv.m3u4u.com/..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 text-slate-200">
                </div>
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">XMLTV EPG URL</label>
                    <input type="url" name="epg" value="${EPG_URL}" placeholder="https://epg.m3u4u.com/..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 text-slate-200">
                </div>
                <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 font-medium py-3 rounded-lg transition text-sm cursor-pointer shadow-md">Save & Sync Playlist</button>
            </form>

            <div class="mt-6 pt-6 border-t border-slate-700">
                <span class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Status Log</span>
                <div class="bg-slate-900 text-xs font-mono p-3 rounded-lg border border-slate-700 text-emerald-400 break-words">${statusMessage}</div>
            </div>

            ${isConfigured ? `
            <div class="mt-6 flex gap-3">
                <a href="stremio://${req.get('host')}/manifest.json" class="flex-1 text-center bg-emerald-600 hover:bg-emerald-500 text-sm font-medium py-3 rounded-lg transition shadow-md">✨ Install Addon</a>
            </div>
            ` : ''}
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

app.post('/save', async (req, res) => {
    M3U_URL = req.body.m3u;
    EPG_URL = req.body.epg;
    res.redirect('/');
    await syncIPTVData();
});

const addonInterface = builder.getInterface();
app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.json(addonInterface.manifest);
});
app.get('/:resource/:type/:id.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    const { resource, type, id } = req.params;
    addonInterface.handle(resource, type, id)
        .then(resp => res.json(resp))
        .catch(err => res.status(500).json({ error: err.message }));
});

app.listen(process.env.PORT || 7000);
