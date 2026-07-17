const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const { parse: parseM3U } = require('iptv-playlist-parser');
const epgParser = require('epg-parser');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global Cache to hold parsed data for different users securely
// Key: Base64 config string -> Value: { channelMap, catalogItems, epgData, isLoaded }
const userCaches = new Map();

const manifestTemplate = {
    id: 'community.nuvio.groupediptv',
    version: '2.0.0',
    name: 'Grouped IPTV (Instant)',
    description: 'Smart IPTV quality grouping with dynamic background fetching.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [{ type: 'tv', id: 'grouped_channels', name: 'Live IPTV' }]
};

// Background Processing Engine (Memory Optimized)
async function asynchronousFetch(configKey, m3uUrl, epgUrl) {
    if (userCaches.has(configKey) && userCaches.get(configKey).status === 'loading') return;

    userCaches.set(configKey, {
        status: 'loading',
        channelMap: new Map(),
        catalogItems: [],
        epgData: {}
    });

    try {
        console.log(`[Background] Starting memory-optimized sync for ${configKey.substring(0, 10)}...`);
        
        // 1. Fetch & Parse M3U
        const m3uRes = await axios.get(m3uUrl, { timeout: 30000 });
        const playlist = parseM3U(m3uRes.data);
        
        const tempMap = new Map();
        const tempCatalog = [];

        playlist.items.forEach(item => {
            // MEMORY SAVER: Skip Video-On-Demand (Movies/Series) based on common file extensions
            if (item.url.match(/\.(mp4|mkv|avi)$/i) || item.url.includes('/movie/') || item.url.includes('/series/')) {
                return; 
            }

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
                    description: `Synchronizing live schedule guide...`,
                    genres: [item.group.title || 'Live TV']
                };
                tempMap.set(channelId, { meta: metaItem, streams: [] });
                tempCatalog.push(metaItem);
            }
            tempMap.get(channelId).streams.push({ title: streamTitle, url: item.url });
        });

        // Clear raw M3U string from memory immediately
        m3uRes.data = null; 

        // 2. Fetch & Parse EPG
        let tempEpg = {};
        if (epgUrl) {
            try {
                const epgRes = await axios.get(epgUrl, { timeout: 45000 });
                const parsedEpg = epgParser.parse(epgRes.data);
                
                parsedEpg.programs.forEach(p => {
                    // MEMORY SAVER: Only keep EPG data if the channel actually exists in our filtered list
                    if (tempMap.has(p.channel)) {
                        if (!tempEpg[p.channel]) tempEpg[p.channel] = [];
                        
                        // Strip out unnecessary heavy metadata (like cast lists) and only keep the basics
                        tempEpg[p.channel].push({
                            start: p.start,
                            stop: p.stop,
                            title: p.title,
                            desc: p.desc
                        });
                    }
                });
                
                // Clear raw EPG data from memory immediately
                epgRes.data = null;
                parsedEpg.programs = null;

            } catch (epgErr) {
                console.error(`[Background] EPG download failed:`, epgErr.message);
            }
        }

        userCaches.set(configKey, {
            status: 'ready',
            channelMap: tempMap,
            catalogItems: tempCatalog,
            epgData: tempEpg,
            lastUpdated: Date.now()
        });
        console.log(`[Background] Sync complete. Grouped into ${tempCatalog.length} channels.`);

    } catch (err) {
        userCaches.set(configKey, { status: 'error', message: err.message });
        console.error(`[Background] Critical Sync Error:`, err.message);
    }
}

// Helper to decode Base64 URL configurationsafely
function decodeConfig(configParam) {
    try {
        const decoded = Buffer.from(configParam, 'base64').toString('utf-8');
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

// --- STREMIO / NUVIO PROTOCOL ROUTING ---

// Dynamic Manifest Delivery (Instant Response)
app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    const configData = decodeConfig(req.params.config);
    if (!configData || !configData.m3u) {
        return res.status(400).json({ error: "Invalid configuration string" });
    }

    // Trigger background loading immediately upon installation check, completely unblocking the UI response
    asynchronousFetch(req.params.config, configData.m3u, configData.epg);

    // Deep copy template manifest and attach specific configuration to it
    const instanceManifest = JSON.parse(JSON.stringify(manifestTemplate));
    res.json(instanceManifest);
});

// Dynamic Catalog Endpoint
app.get('/:config/catalog/:type/:id.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params;
    
    const userData = userCaches.get(config);
    if (type === 'tv' && id === 'grouped_channels' && userData && userData.status === 'ready') {
        return res.json({ catalogs: userData.catalogItems });
    }
    
    // If the server is still parsing in background, return temporary empty state gracefully
    return res.json({ catalogs: [] });
});

// Dynamic Meta (EPG Details) Endpoint
app.get('/:config/meta/:type/:id.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params;
    const channelKey = id.replace('iptv:', '');
    
    const userData = userCaches.get(config);
    if (type === 'tv' && userData && userData.status === 'ready' && userData.channelMap.has(channelKey)) {
        let metaResponse = JSON.parse(JSON.stringify(userData.channelMap.get(channelKey).meta));
        const now = new Date();
        const channelSchedule = userData.epgData[channelKey];
        
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
        return res.json({ meta: metaResponse });
    }
    return res.json({ meta: null });
});

// Dynamic Stream Endpoint
app.get('/:config/stream/:type/:id.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params;
    const channelKey = id.replace('iptv:', '');
    
    const userData = userCaches.get(config);
    if (type === 'tv' && userData && userData.status === 'ready' && userData.channelMap.has(channelKey)) {
        return res.json({ streams: userData.channelMap.get(channelKey).streams });
    }
    return res.json({ streams: [] });
});

// --- CLIENT-SIDE FRONTEND CONFIGURATION DASHBOARD ---
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
            <h1 class="text-2xl font-bold text-indigo-400 mb-2">📺 Instant IPTV Grouper</h1>
            <p class="text-slate-400 text-sm mb-6">Paste your links. An installation string will generate in real time without making you wait.</p>
            
            <div class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">M3U Playlist URL</label>
                    <input type="url" id="m3uInput" oninput="generateLink()" placeholder="https://itv.m3u4u.com/..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 text-slate-200">
                </div>
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">XMLTV EPG URL (Optional)</label>
                    <input type="url" id="epgInput" oninput="generateLink()" placeholder="https://epg.m3u4u.com/..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 text-slate-200">
                </div>
            </div>

            <div id="installSection" class="hidden mt-6 pt-6 border-t border-slate-700 space-y-3">
                <span class="block text-xs font-semibold text-emerald-400 uppercase tracking-wider">✨ Addon Ready Instantly</span>
                <a id="installBtn" href="#" class="block text-center bg-emerald-600 hover:bg-emerald-500 text-sm font-medium py-3 rounded-lg transition shadow-md w-full">Install Addon to Nuvio</a>
                <p class="text-[11px] text-slate-500 text-center">If installing on a different device, your custom manifest URL is below:</p>
                <input type="text" id="manifestUrlBox" readonly onclick="this.select()" class="w-full bg-slate-900 border border-slate-700 text-[11px] font-mono p-2 rounded text-slate-400 select-all text-center focus:outline-none">
            </div>
        </div>

        <script>
            function generateLink() {
                const m3u = document.getElementById('m3uInput').value.trim();
                const epg = document.getElementById('epgInput').value.trim();
                const installSection = document.getElementById('installSection');
                
                if (!m3u) {
                    installSection.classList.add('hidden');
                    return;
                }

                // Create JSON object configuration and convert straight to base64
                const configObj = { m3u: m3u, epg: epg };
                const b64 = btoa(JSON.stringify(configObj));
                
                const hostUrl = window.location.host;
                const manifestUrl = window.location.protocol + '//' + hostUrl + '/' + b64 + '/manifest.json';
                const stremioUrl = 'stremio://' + hostUrl + '/' + b64 + '/manifest.json';

                document.getElementById('installBtn').href = stremioUrl;
                document.getElementById('manifestUrlBox').value = manifestUrl;
                installSection.classList.remove('hidden');
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.listen(process.env.PORT || 7000);
