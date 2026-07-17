const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const readline = require('readline');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const userCaches = new Map();

const manifestTemplate = {
    id: 'community.nuvio.groupediptv',
    version: '2.1.0',
    name: 'Grouped IPTV (Ultra-Light)',
    description: 'Stream-optimized IPTV quality grouping with zero-memory footprint.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [{ type: 'tv', id: 'grouped_channels', name: 'Live IPTV' }]
};

// Stream-based line-by-line parser (Uses almost 0MB of RAM)
async function streamFetchIPTV(configKey, m3uUrl) {
    if (userCaches.has(configKey) && userCaches.get(configKey).status === 'loading') return;

    userCaches.set(configKey, {
        status: 'loading',
        channelMap: new Map(),
        catalogItems: []
    });

    try {
        console.log(`[Stream] Starting line-by-line parsing for config: ${configKey.substring(0, 10)}`);
        
        const response = await axios({
            method: 'get',
            url: m3uUrl,
            responseType: 'stream',
            // Tricking m3u4u into thinking a browser is downloading the file
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 60000
        });

        const rl = readline.createInterface({
            input: response.data,
            crlfDelay: Infinity
        });

        const tempMap = new Map();
        const tempCatalog = [];
        let currentItem = null;

        for await (const line of rl) {
            const trimmed = line.trim();

            if (trimmed.startsWith('#EXTINF:')) {
                // Skip VOD content immediately without processing attributes
                if (trimmed.includes('.mp4') || trimmed.includes('.mkv') || trimmed.includes('/movie/') || trimmed.includes('/series/')) {
                    currentItem = null;
                    continue;
                }

                // Extract attributes using fast regex matching
                const tvgIdMatch = trimmed.match(/tvg-id="([^"]+)"/i);
                const logoMatch = trimmed.match(/tvg-logo="([^"]+)"/i);
                const groupMatch = trimmed.match(/group-title="([^"]+)"/i);
                
                // Get display name (everything after the last comma)
                const commaIndex = trimmed.lastIndexOf(',');
                const rawName = commaIndex !== -1 ? trimmed.substring(commaIndex + 1).trim() : "Unknown Channel";

                // Normalize name using regex to strip quality tags
                const regexFilter = /\s*(\[.*?\]|\(.*?\)|HD|FHD|UHD|4K|SD|RAW|HEVC|1080p|720p)\s*/gi;
                const coreName = rawName.replace(regexFilter, '').trim().toLowerCase();
                const channelId = (tvgIdMatch ? tvgIdMatch[1] : coreName.replace(/[^a-z0-9]/g, "")) || "unknown";

                currentItem = {
                    channelId,
                    coreName: rawName.replace(regexFilter, '').trim(),
                    streamTitle: rawName,
                    logo: logoMatch ? logoMatch[1] : '',
                    group: groupMatch ? groupMatch[1] : 'Live TV'
                };
            } else if (trimmed.startsWith('http') && currentItem) {
                // Found the stream URL line right after an EXTINF line
                const { channelId, coreName, streamTitle, logo, group } = currentItem;

                if (!tempMap.has(channelId)) {
                    const metaItem = {
                        id: `iptv:${channelId}`,
                        type: 'tv',
                        name: coreName.replace(/\b\w/g, char => char.toUpperCase()),
                        poster: logo,
                        background: logo,
                        description: `Custom grouped channel stream list.`,
                        genres: [group]
                    };
                    tempMap.set(channelId, { meta: metaItem, streams: [] });
                    tempCatalog.push(metaItem);
                }

                tempMap.get(channelId).streams.push({
                    title: streamTitle,
                    url: trimmed
                });

                currentItem = null; // Reset for next item
            }
        }

        userCaches.set(configKey, {
            status: 'ready',
            channelMap: tempMap,
            catalogItems: tempCatalog,
            lastUpdated: Date.now()
        });

        console.log(`[Stream] Complete! Successfully compressed into ${tempCatalog.length} distinct channels.`);

    } catch (err) {
        userCaches.set(configKey, { status: 'error', message: err.message });
        console.error(`[Stream] Critical Failure:`, err.message);
    }
}

// --- PROTOCOL ROUTING ---

app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    const decodedBuffer = Buffer.from(req.params.config, 'base64').toString('utf-8');
    try {
        const configData = JSON.parse(decodedBuffer);
        if (!configData.m3u) return res.status(400).json({ error: "Missing M3U URL" });
        
        // Execute stream compilation instantly in background
        streamFetchIPTV(req.params.config, configData.m3u);
        
        res.json(JSON.parse(JSON.stringify(manifestTemplate)));
    } catch(e) {
        res.status(400).json({ error: "Invalid configuration profile" });
    }
});

// Catalog polling to prevent empty loads
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params;
    
    let attempts = 0;
    while (attempts < 15) {
        const userData = userCaches.get(config);
        
        if (userData && userData.status === 'ready') {
            if (type === 'tv' && id === 'grouped_channels') {
                return res.json({ catalogs: userData.catalogItems });
            }
            break; 
        }
        
        if (userData && userData.status === 'error') {
            console.error("[Catalog Check] Parser failed:", userData.message);
            break; 
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
    }
    
    // Fallback in case of long loading
    const finalCheck = userCaches.get(config);
    if (finalCheck && finalCheck.status === 'ready' && type === 'tv' && id === 'grouped_channels') {
         return res.json({ catalogs: finalCheck.catalogItems });
    }
    
    return res.json({ catalogs: [] });
});

app.get('/:config/meta/:type/:id.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params;
    const channelKey = id.replace('iptv:', '');
    const userData = userCaches.get(config);
    
    if (type === 'tv' && userData && userData.status === 'ready' && userData.channelMap.has(channelKey)) {
        return res.json({ meta: userData.channelMap.get(channelKey).meta });
    }
    return res.json({ meta: null });
});

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

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    res.send(`
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
            <h1 class="text-2xl font-bold text-indigo-400 mb-2">📺 Stream-Optimized IPTV</h1>
            <p class="text-slate-400 text-sm mb-6">Built to bypass low-memory cloud limitations using line-by-line streaming architecture.</p>
            
            <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">m3u4u Playlist URL</label>
                <input type="url" id="m3uInput" oninput="generateLink()" placeholder="https://itv.m3u4u.com/..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-indigo-500 text-slate-200">
            </div>

            <div id="installSection" class="hidden mt-6 pt-6 border-t border-slate-700 space-y-3">
                <a id="installBtn" href="#" class="block text-center bg-emerald-600 hover:bg-emerald-500 text-sm font-medium py-3 rounded-lg transition shadow-md w-full">Install Addon to Nuvio</a>
                <input type="text" id="manifestUrlBox" readonly onclick="this.select()" class="w-full bg-slate-900 border border-slate-700 text-[11px] font-mono p-2 rounded text-slate-400 text-center focus:outline-none">
            </div>
        </div>
        <script>
            function generateLink() {
                const m3u = document.getElementById('m3uInput').value.trim();
                const installSection = document.getElementById('installSection');
                if (!m3u) { installSection.classList.add('hidden'); return; }
                const b64 = btoa(JSON.stringify({ m3u: m3u }));
                const manifestUrl = window.location.protocol + '//' + window.location.host + '/' + b64 + '/manifest.json';
                document.getElementById('installBtn').href = 'stremio://' + window.location.host + '/' + b64 + '/manifest.json';
                document.getElementById('manifestUrlBox').value = manifestUrl;
                installSection.classList.remove('hidden');
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(process.env.PORT || 7000);
