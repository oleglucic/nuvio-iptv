const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const readline = require('readline');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const userCaches = new Map();

const manifestTemplate = {
    id: 'community.nuvio.groupediptv', version: '3.3.0', name: 'Grouped IPTV (Pro + EPG)',
    description: 'Dynamic catalogs, search, prefix deduplication, and bulletproof EPG.',
    resources: ['catalog', 'meta', 'stream'], types: ['tv'], idPrefixes: ['iptv:']
};

function parseXMLDate(x) {
    if (!x || x.length < 14) return 0;
    const offset = x.substring(15).trim() || '+0000';
    const fOffset = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
    return new Date(`${x.substring(0,4)}-${x.substring(4,6)}-${x.substring(6,8)}T${x.substring(8,10)}:${x.substring(10,12)}:${x.substring(12,14)}${fOffset}`).getTime();
}

async function streamFetchIPTV(configKey, m3uUrl, epgUrl) {
    if (userCaches.has(configKey) && userCaches.get(configKey).status === 'loading') return;
    userCaches.set(configKey, { status: 'loading', channelMap: new Map(), catalogItems: [], uniqueGroups: new Set(), epgData: {} });
    
    try {
        const res = await axios({ method: 'get', url: m3uUrl, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
        const rl = readline.createInterface({ input: res.data, crlfDelay: Infinity });
        const tMap = new Map(), tCat = []; const groups = new Set(), epgMap = new Map(); let cItem = null;
        
        for await (const line of rl) {
            const t = line.trim();
            if (t.startsWith('#EXTINF:')) {
                if (t.match(/\.(mp4|mkv)$/i) || t.includes('/movie/') || t.includes('/series/')) { cItem = null; continue; }
                const tvgId = t.match(/tvg-id="([^"]+)"/i), logo = t.match(/tvg-logo="([^"]+)"/i), grp = t.match(/group-title="([^"]+)"/i);
                const rawName = t.lastIndexOf(',') !== -1 ? t.substring(t.lastIndexOf(',') + 1).trim() : "Unknown";
                let cName = rawName.replace(/\b(HD|FHD|UHD|4K|8K|SD|RAW|HEVC|1080p|1080i|720p|60fps|50fps|H265|24\/7|VOD)\b|\(.*?\)|\s*\[.*?\]\s*/gi, ' ');
                cName = cName.replace(/^(?:VIP|UK|US|CA|AU|NZ|IE|ZA|FR|DE|IT|ES|PT|NL|BE|PREMIUM|LOCAL|LIVE)\s*[-:|_\/\|\s]+\s*/gi, ' ');
                cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                const cId = cName.replace(/[^a-z0-9]/g, "") || "unknown";
                if (tvgId) epgMap.set(tvgId[1].toLowerCase(), cId); epgMap.set(cId, cId);
                cItem = { cId, cName, rawName, logo: logo ? logo[1] : '', grp: grp ? grp[1].trim() : 'Uncategorized' };
            } else if (t.startsWith('http') && cItem) {
                const { cId, cName, rawName, logo, grp } = cItem;
                const catId = `iptv_${grp.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
                groups.add(grp);
                if (!tMap.has(cId)) {
                    const mItem = { id: `iptv:${cId}`, type: 'tv', name: cName.replace(/\b\w/g, c => c.toUpperCase()), poster: logo, background: logo, description: `Live Stream: ${cName.toUpperCase()}`, genres: [grp], catalogId: catId };
                    tMap.set(cId, { meta: mItem, streams: [] }); tCat.push(mItem);
                }
                tMap.get(cId).streams.push({ title: rawName, url: t }); cItem = null;
            }
        }
        
        const tEpg = {}; let epgCount = 0;
        if (epgUrl) {
            try {
                const epgRes = await axios({ method: 'get', url: epgUrl, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                const rlEpg = readline.createInterface({ input: epgRes.data, crlfDelay: Infinity });
                let inProg = false, currP = "";
                for await (const line of rlEpg) {
                    if (line.includes('<programme')) { inProg = true; currP = line; }
                    else if (inProg) { currP += "\n" + line; }
                    if (inProg && line.includes('</programme>')) {
                        inProg = false; const chMatch = currP.match(/channel="([^"]+)"/);
                        if (chMatch) {
                            const mId = epgMap.get(chMatch[1].toLowerCase());
                            if (mId && tMap.has(mId)) {
                                const startMatch = currP.match(/start="([^"]+)"/), stopMatch = currP.match(/stop="([^"]+)"/);
                                const titleMatch = currP.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i), descMatch = currP.match(/<desc[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/desc>/i);
                                if (!tEpg[mId]) tEpg[mId] = [];
                                tEpg[mId].push({ start: parseXMLDate(startMatch ? startMatch[1] : ""), stop: parseXMLDate(stopMatch ? stopMatch[1] : ""), title: titleMatch ? titleMatch[1].trim() : "Unknown", desc: descMatch ? descMatch[1].trim() : "" });
                                epgCount++;
                            }
                        }
                    }
                }
                console.log(`[Stream] EPG Guide successfully matched ${epgCount} programs to channels.`);
            } catch (e) { console.error(`EPG Error:`, e.message); }
        }
        userCaches.set(configKey, { status: 'ready', channelMap: tMap, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg, lastUpdated: Date.now() });
    } catch (err) { userCaches.set(configKey, { status: 'error', message: err.message }); }
}

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
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    res.json({ metas: fCat.slice(skip, skip + 100).map(({ catalogId, ...rest }) => rest) });
});

app.get(['/:config/meta/:type/:id.json', '/:config/meta/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
    const { config, type, id } = req.params; const chKey = id.replace('iptv:', ''); const ud = userCaches.get(config);
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) {
        const { catalogId, ...sMeta } = JSON.parse(JSON.stringify(ud.channelMap.get(chKey).meta));
        const now = Date.now(), sched = ud.epgData[chKey];
        if (sched && sched.length > 0) {
            const fProgs = sched.filter(p => p.stop > now).sort((a,b) => a.start - b.start);
            const cProg = fProgs[0], nProg = fProgs[1];
            let text = "";
            if (cProg) text += `🟢 LATEST (${new Date(cProg.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} - ${new Date(cProg.stop).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})\n${cProg.title}\n${cProg.desc}\n\n`;
            if (nProg) text += `⏭️ UP NEXT (${new Date(nProg.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})\n${nProg.title}`;
            if (text) sMeta.description = text;
        } else sMeta.description = "No TV guide schedule mapped for this channel.";
        return res.json({ meta: sMeta });
    }
    return res.json({ meta: null });
});

app.get(['/:config/stream/:type/:id.json', '/:config/stream/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params; const chKey = id.replace('iptv:', ''); const ud = userCaches.get(config);
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) return res.json({ streams: ud.channelMap.get(chKey).streams });
    return res.json({ streams: [] });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Nuvio IPTV Setup</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;}</style></head><body class="flex items-center justify-center min-h-screen p-4"><div class="bg-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-lg border border-slate-700"><h1 class="text-2xl font-bold text-indigo-400 mb-2">📺 Nuvio IPTV Pro + EPG</h1><p class="text-slate-400 text-sm mb-6">Featuring dynamic catalogs, search, prefix deduplication, and TV Guide.</p><div class="space-y-4"><div><label class="block text-xs font-semibold text-slate-400 uppercase mb-2">M3U Playlist URL</label><input type="url" id="m3uInput" oninput="generateLink()" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none text-slate-200"></div><div><label class="block text-xs font-semibold text-slate-400 uppercase mb-2">XMLTV EPG URL (Optional)</label><input type="url" id="epgInput" oninput="generateLink()" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none text-slate-200"></div></div><div id="installSection" class="hidden mt-6 pt-6 border-t border-slate-700 space-y-3"><a id="installBtn" href="#" class="block text-center bg-indigo-600 hover:bg-indigo-500 text-sm font-medium py-3 rounded-lg w-full">Install Addon to Nuvio</a><p class="text-[11px] text-slate-500 text-center">Server will build your categories on install.</p></div></div><script>function generateLink(){const m=document.getElementById('m3uInput').value.trim();const e=document.getElementById('epgInput').value.trim();const s=document.getElementById('installSection');if(!m){s.classList.add('hidden');return;}const o={m3u:m};if(e)o.epg=e;const b=btoa(JSON.stringify(o));document.getElementById('installBtn').href='stremio://'+window.location.host+'/'+b+'/manifest.json';s.classList.remove('hidden');}</script></body></html>`);
});

app.listen(process.env.PORT || 7000);
