const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const readline = require('readline');
const zlib = require('zlib');

const app = express();
app.use(express.json()); app.use(express.urlencoded({ extended: true }));
const userCaches = new Map();

const manifestTemplate = {
    id: 'community.nuvio.groupedpro', version: '4.9.0', name: 'Grouped IPTV Pro',
    description: 'Dynamic deduplicated country catalogs, advanced Dolby Vision/Audio parsing, sorting, and live EPG.',
    resources: ['catalog', 'meta', 'stream'], types: ['tv'], idPrefixes: ['iptv:']
};

function parseXMLDate(x) {
    if (!x || x.length < 14) return 0;
    const offset = x.substring(15).trim() || '+0000';
    const fOffset = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
    return new Date(`${x.substring(0,4)}-${x.substring(4,6)}-${x.substring(6,8)}T${x.substring(8,10)}:${x.substring(10,12)}:${x.substring(12,14)}${fOffset}`).getTime();
}

function normaliseFormat(str) {
    if (!str) return "";
    const map = {
        '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
        'ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ʰ':'h','ⁱ':'i','ʲ':'j','ᵏ':'k','ˡ':'l','ᵐ':'m','ⁿ':'n','ᵒ':'o','ᵖ':'p','ʳ':'r','ˢ':'s','ᵗ':'t','ᵘ':'u','ᵛ':'v','ʷ':'w','ˣ':'x','ʸ':'y','ᶻ':'z',
        'ᴬ':'a','ᴮ':'b','ᶜ':'c','ᴰ':'d','ᴱ':'e','ᶠ':'f','ᴳ':'g','ᴴ':'h','ᴵ':'i','ᴶ':'j','ᴷ':'k','ᴸ':'l','ᴹ':'m','ᴺ':'n','ᴼ':'o','ᴾ':'p','ᴿ':'r','ˢ':'s','ᵀ':'t','ᵁ':'u','ⱽ':'v','ᵂ':'w',
        '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9',
        'ₐ':'a','ₑ':'e','ₕ':'h','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t','ᵤ':'u','ᵥ':'v','ₓ':'x'
    };
    return str.split('').map(c => map[c] || c).join('');
}

// Seamlessly parses standard, mashed, or shorthand video and audio profiles
function parseStreamInfo(n) {
    const low = n.toLowerCase();
    const cleanN = " " + normaliseFormat(low).replace(/[^a-z0-9]/g, " ") + " ";
    
    let name = "HD";
    let score = 50000;
    
    if (cleanN.includes(" 8k ")) { name = "8K"; score = 80000; }
    else if (cleanN.includes(" 4k ") || cleanN.includes(" uhd ") || /\s2160[pi]\s/.test(cleanN) || /\s3180[pi]\s/.test(cleanN)) { name = "4K"; score = 70000; }
    else if (cleanN.includes(" fhd ") || cleanN.includes(" 1080p ") || cleanN.includes(" 1080i ")) { name = "FHD"; score = 60000; }
    else if (cleanN.includes(" hd ") || cleanN.includes(" 720p ")) { name = "HD"; score = 50000; }
    else if (cleanN.includes(" sd ") || cleanN.includes(" 576p ") || cleanN.includes(" 480p ")) { name = "SD"; score = 40000; }
    
    const e = [];
    if (cleanN.includes(" raw ")) { e.push("RAW"); score += 600; }
    if (cleanN.includes(" vip ")) { e.push("VIP"); score += 500; }
    if (cleanN.includes(" hevc ") || cleanN.includes(" h265 ") || cleanN.includes(" hevc")) { e.push("HEVC"); score += 400; }
    
    // Dynamic Dolby Vision Extraction Matrix
    if (/dolby\s*vision|dovi|\bdv\b/i.test(low) || cleanN.includes(" dovi ") || cleanN.includes(" dolbyvision ")) {
        e.push("Dolby Vision");
        score += 350;
    }
    
    // Dynamic Dolby Audio & Atmos Profile Extraction Matrix
    if (/atmos/i.test(low) || cleanN.includes(" atmos ")) {
        e.push("Dolby Atmos");
        score += 300;
    } else if (/dolby\s*audio|dolby\s*digital|\bac3\b|\beac3\b|\bdd5\.1\b|\bdd\+/i.test(low) || cleanN.includes(" dolbyaudio ") || cleanN.includes(" ac3 ") || cleanN.includes(" eac3 ") || (cleanN.includes(" dolby ") && !/vision/i.test(low))) {
        e.push("Dolby Audio");
        score += 200;
    }
    
    if (cleanN.includes(" 60fps ") || cleanN.includes(" 60 fps ")) { e.push("60FPS"); score += 300; }
    if (cleanN.includes(" 50fps ") || cleanN.includes(" 50 fps ")) { e.push("50FPS"); score += 200; }
    if (cleanN.includes(" 24 7 ") || cleanN.includes(" 247 ")) e.push("24/7");
    if (cleanN.includes(" backup ") || cleanN.includes(" alt ")) { e.push("ALT LINK"); score -= 25000; }
    
    return { name, title: e.length > 0 ? e.join(" • ") : "Direct Stream", score };
}

async function streamFetchIPTV(configKey, m3uUrl, epgUrl) {
    if (userCaches.has(configKey) && userCaches.get(configKey).status === 'loading') return;
    userCaches.set(configKey, { status: 'loading', channelMap: new Map(), catalogItems: [], uniqueGroups: new Set(), epgData: {} });
    
    try {
        const res = await axios({ method: 'get', url: m3uUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
        let mStream = res.data;
        if (res.headers['content-encoding'] === 'gzip' || m3uUrl.toLowerCase().endsWith('.gz')) mStream = mStream.pipe(zlib.createGunzip());
        const rl = readline.createInterface({ input: mStream, crlfDelay: Infinity });
        
        const tMap = new Map(), tCat = []; const groups = new Set(), epgMap = new Map(); let cItem = null;
        
        for await (const line of rl) {
            const t = line.trim();
            if (t.startsWith('#EXTINF:')) {
                if (t.match(/\.(mp4|mkv)$/i) || t.includes('/movie/') || t.includes('/series/')) { cItem = null; continue; }
                const tvgId = t.match(/tvg-id=["']([^"']+)["']/i), tvgName = t.match(/tvg-name=["']([^"']+)["']/i);
                const logo = t.match(/tvg-logo=["']([^"']+)["']/i), grp = t.match(/group-title=["']([^"']+)["']/i);
                const rawName = t.lastIndexOf(',') !== -1 ? t.substring(t.lastIndexOf(',') + 1).trim() : "Unknown";
                
                let cleanNameStr = normaliseFormat(rawName);
                // Clean Channel Name (Expanded to fully wipe audio/video profile metadata tags from group grouping keys)
                let cName = cleanNameStr.replace(/\b(HD|FHD|UHD|4K|8K|SD|RAW|HEVC|1080p|1080i|720p|60fps|50fps|H265|VOD|DOLBY|AUDIO|VISION|ATMOS|DV|DOVI|AC3|EAC3)\b/gi, ' ');
                cName = cName.replace(/\b24\s*[\/_\-]?\s*7\b/gi, ' ');
                cName = cName.replace(/^(?:VIP|UK|US|CA|AU|NZ|IE|ZA|FR|DE|IT|ES|PT|NL|BE|PREMIUM|LOCAL|LIVE)\s*[-:|_\/\|\s]+\s*/gi, ' ');
                cName = cName.replace(/\b\d+[pi]\b|\b\d+\s*fps\b|\(.*?\)|\s*\[.*?\]\s*/gi, ' ');
                cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                const cId = cName.replace(/[^a-z0-9]/g, "") || "unknown";
                
                let rawGrp = grp ? grp[1].trim() : 'Uncategorized';
                let normGrp = normaliseFormat(rawGrp);
                let countryPrefix = "";
                
                const countryMatch = normGrp.match(/^([a-z]{2,3})\b/i);
                if (countryMatch) {
                    const code = countryMatch[1].toUpperCase();
                    const exclusions = ["ALL", "NEW", "VIP", "PPV", "RAW", "ALT", "VOD", "FHD", "UHD", "KIDS", "FOR", "THE", "TOP", "BIG", "ONE", "AND", "OUT", "NOT", "YES", "OFF"];
                    if (!exclusions.includes(code)) {
                        countryPrefix = code + " | ";
                        normGrp = normGrp.substring(countryMatch[0].length).trim();
                    }
                }
                
                let cleanGrp = normGrp.replace(/\b(HD|FHD|UHD|4K|8K|SD|RAW|HEVC|1080p|1080i|720p|H265|LIVE|VOD|VIP|60FPS|50FPS|DOLBY|AUDIO|VISION|ATMOS|DV|DOVI|AC3|EAC3|FPS)\b/gi, ' ');
                cleanGrp = cleanGrp.replace(/[-\/|:_\s]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                let finalGrp = countryPrefix + cleanGrp;
                if (!cleanGrp || cleanGrp.length < 2) finalGrp = rawGrp;
                
                if (tvgId) epgMap.set(tvgId[1].toLowerCase().trim(), cId);
                if (tvgName) epgMap.set(tvgName[1].toLowerCase().trim(), cId);
                epgMap.set(rawName.toLowerCase().trim(), cId);
                epgMap.set(rawName.toLowerCase().replace(/\s+/g, ''), cId);
                epgMap.set(cId, cId);
                
                cItem = { cId, cName, rawName, logo: logo ? logo[1] : '', grp: finalGrp };
            } else if (t.startsWith('http') && cItem) {
                const { cId, cName, rawName, logo, grp } = cItem;
                const catId = `iptv_${grp.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
                groups.add(grp);
                if (!tMap.has(cId)) {
                    const mItem = { id: `iptv:${cId}`, type: 'tv', name: cName.replace(/\b\w/g, c => c.toUpperCase()), poster: logo, background: logo, genres: [grp], catalogId: catId };
                    tMap.set(cId, { meta: mItem, streams: [] }); tCat.push(mItem);
                }
                
                const sInfo = parseStreamInfo(rawName);
                tMap.get(cId).streams.push({ name: sInfo.name, title: sInfo.title, url: t, score: sInfo.score }); 
                cItem = null;
            }
        }
        
        const tEpg = {}; let eCount = 0;
        if (epgUrl) {
            try {
                const epgRes = await axios({ method: 'get', url: epgUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                let eStream = epgRes.data;
                if (epgRes.headers['content-encoding'] === 'gzip' || epgUrl.toLowerCase().endsWith('.gz')) eStream = eStream.pipe(zlib.createGunzip());
                const rlEpg = readline.createInterface({ input: eStream, crlfDelay: Infinity });
                
                let inProg = false, currP = "";
                for await (const line of rlEpg) {
                    if (line.includes('<programme')) { inProg = true; currP = line; }
                    else if (inProg) { currP += "\n" + line; }
                    if (inProg && line.includes('</programme>')) {
                        inProg = false; const chMatch = currP.match(/channel Gentile=["']([^"']+)["']/i) || currP.match(/channel=["']([^"']+)["']/i);
                        if (chMatch) {
                            const rawEpgId = chMatch[1].toLowerCase().trim();
                            const mId = epgMap.get(rawEpgId) || epgMap.get(rawEpgId.replace(/\s+/g, ''));
                            if (mId && tMap.has(mId)) {
                                const startMatch = currP.match(/start=["']([^"']+)["']/), stopMatch = currP.match(/stop=["']([^"']+)["']/);
                                const titleMatch = currP.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
                                const descMatch = currP.match(/<desc[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/desc>/i);
                                if (!tEpg[mId]) tEpg[mId] = [];
                                tEpg[mId].push({ start: parseXMLDate(startMatch ? startMatch[1] : ""), stop: parseXMLDate(stopMatch ? stopMatch[1] : ""), title: titleMatch ? titleMatch[1].trim() : "Unknown", desc: descMatch ? descMatch[1].trim() : "" });
                                eCount++;
                            }
                        }
                    }
                }
                console.log(`[Stream] EPG Zlib Parser successfully mapped ${eCount} programs!`);
            } catch (e) { console.error(`EPG Error:`, e.message); }
        }
        userCaches.set(configKey, { status: 'ready', channelMap: tMap, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg, lastUpdated: Date.now() });
    } catch (err) { userCaches.set(configKey, { status: 'error', message: err.message }); }
}

function getEpgText(chKey, epgData) {
    const now = Date.now(), sched = epgData[chKey];
    if (!sched || sched.length === 0) return "No TV guide mapped.";
    const fProgs = sched.filter(p => p.stop > now).sort((a,b) => a.start - b.start);
    if (fProgs.length === 0) return "No upcoming programs mapped.";
    const cP = fProgs[0], nP = fProgs[1]; let text = "";
    if (cP) text += `🟢 LATEST (${new Date(cP.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} - ${new Date(cP.stop).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})\n${cP.title}\n${cP.desc}\n\n`;
    if (nP) text += `⏭️ UP NEXT (${new Date(nP.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})\n${nP.title}`;
    return text;
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
    
    const paged = fCat.slice(skip, skip + 100).map(item => {
        const chKey = item.id.replace('iptv:', '');
        const { catalogId, ...rest } = item;
        return { ...rest, description: getEpgText(chKey, ud.epgData) };
    });
    res.json({ metas: paged });
});

app.get(['/:config/meta/:type/:id.json', '/:config/meta/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
    const { config, type, id } = req.params; const chKey = id.replace('iptv:', ''); const ud = userCaches.get(config);
    if (type === 'tv' && ud && ud.status === 'ready' && ud.channelMap.has(chKey)) {
        const targetMeta = ud.channelMap.get(chKey).meta || {};
        const { catalogId, ...sMeta } = JSON.parse(JSON.stringify(targetMeta));
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
