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
    version: '3.1.0',
    name: 'Grouped IPTV (Pro + EPG)',
    description: 'Dynamic catalogs, search, prefix deduplication, and live EPG.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['iptv:']
};

// Converts messy XMLTV timestamps (20260717140000 +0000) into clean milliseconds
function parseXMLDate(xmlDate) {
    if (!xmlDate || xmlDate.length < 14) return 0;
    const y = xmlDate.substring(0, 4), m = xmlDate.substring(4, 6), d = xmlDate.substring(6, 8);
    const h = xmlDate.substring(8, 10), min = xmlDate.substring(10, 12), s = xmlDate.substring(12, 14);
    const offset = xmlDate.substring(15).trim() || '+0000';
    const formattedOffset = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}${formattedOffset}`).getTime();
}

async function streamFetchIPTV(configKey, m3uUrl, epgUrl) {
    if (userCaches.has(configKey) && userCaches.get(configKey).status === 'loading') return;

    userCaches.set(configKey, {
        status: 'loading',
        channelMap: new Map(),
        catalogItems: [],
        uniqueGroups: new Set(),
        epgData: {}
    });

    try {
        console.log(`[Stream] Parsing M3U for: ${configKey.substring(0, 10)}`);
        
        // --- 1. M3U STREAM PARSER ---
        const response = await axios({
            method: 'get', url: m3uUrl, responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 60000
        });

        const rl = readline.createInterface({ input: response.data, crlfDelay: Infinity });

        const tempMap = new Map();
        const tempCatalog = [];
        const groups = new Set();
        let currentItem = null;

        for await (const line of rl) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXTINF:')) {
                if (trimmed.match(/\.(mp4|mkv)$/i) || trimmed.includes('/movie/') || trimmed.includes('/series/')) {
                    currentItem = null; continue;
                }

                const tvgIdMatch = trimmed.match(/tvg-id="([^"]+)"/i);
                const logoMatch = trimmed.match(/tvg-logo="([^"]+)"/i);
                const groupMatch = trimmed.match(/group-title="([^"]+)"/i);
                
                const commaIndex = trimmed.lastIndexOf(',');
                const rawName = commaIndex !== -1 ? trimmed.substring(commaIndex + 1).trim() : "Unknown Channel";
                const groupName = groupMatch ? groupMatch[1].trim() : 'Uncategorized';

                const qualityFilter = /\s*(\[.*?\]|\(.*?\)|HD|FHD|UHD|4K|SD|RAW|HEVC|1080p|720p|60fps|50fps)\s*/gi;
                let cleanName = rawName.replace(qualityFilter, '').trim();

                const prefixFilter = /^(VIP|UK|US|CA|AU|NZ|IE|ZA|FR|DE|IT|ES|PT|NL|BE|PREMIUM|LOCAL|VOD|LIVE|24\/7)\s*[-|:|\||_]?\s*/gi;
                cleanName = cleanName.replace(prefixFilter, '').trim();

                const coreName = cleanName.toLowerCase();
                const channelId = (tvgIdMatch && tvgIdMatch[1] !== "") ? tvgIdMatch[1] : coreName.replace(/[^a-z0-9]/g, "");

                currentItem = {
                    channelId: channelId || "unknown", coreName: cleanName,
                    streamTitle: rawName, logo: logoMatch ? logoMatch[1] : '', group: groupName
                };
            } else if (trimmed.startsWith('http') && currentItem) {
                const { channelId, coreName, streamTitle, logo, group } = currentItem;
                const generatedCatalogId = `iptv_${group.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;

                groups.add(group);

                if (!tempMap.has(channelId)) {
                    const metaItem = {
                        id: `iptv:${channelId}`, type: 'tv',
                        name: coreName.replace(/\b\w/g, char => char.toUpperCase()),
                        poster: logo, background: logo,
                        description: `Live Stream: ${coreName.toUpperCase()}`,
                        genres: [group], catalogId: generatedCatalogId 
                    };
                    tempMap.set(channelId, { meta: metaItem, streams: [] });
                    tempCatalog.push(metaItem);
                }
                tempMap.get(channelId).streams.push({ title: streamTitle, url: trimmed });
                currentItem = null; 
            }
        }

        // --- 2. EPG STREAM PARSER (ZERO-MEMORY IMPL) ---
        const tempEpg = {};
        if (epgUrl) {
            console.log(`[Stream] Parsing EPG...`);
            try {
                const epgRes = await axios({
                    method: 'get', url: epgUrl, responseType: 'stream',
                    headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000
                });
                const rlEpg = readline.createInterface({ input: epgRes.data, crlfDelay: Infinity });
                
                let insideProg = false;
                let currentProg = "";
                
                for await (const line of rlEpg) {
                    if (line.includes('<programme')) {
                        insideProg = true; currentProg = line;
                    } else if (insideProg) {
                        currentProg += "\n" + line;
                    }
                    
                    if (insideProg && line.includes('</programme>')) {
                        insideProg = false;
                        const channelMatch = currentProg.match(/channel="([^"]+)"/);
                        
                        // ONLY save memory if this channel exists in our M3U list!
                        if (channelMatch && tempMap.has(channelMatch[1])) {
                            const startMatch = currentProg.match(/start="([^"]+)"/);
                            const stopMatch = currentProg.match(/stop="([^"]+)"/);
                            const titleMatch = currentProg.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
                            const descMatch = currentProg.match(/<desc[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/desc>/i);
                            
                            const channelId = channelMatch[1];
                            if (!tempEpg[channelId]) tempEpg[channelId] = [];
                            
                            tempEpg[channelId].push({
                                start: parseXMLDate(startMatch ? startMatch[1] : ""),
                                stop: parseXMLDate(stopMatch ? stopMatch[1] : ""),
                                title: titleMatch ? titleMatch[1].trim() : "Unknown Program",
                                desc: descMatch ? descMatch[1].trim() : ""
                            });
                        }
                    }
                }
                console.log(`[Stream] EPG Guide successfully matched to channels.`);
            } catch (epgErr) {
                console.error(`[Stream] EPG parsing failed:`, epgErr.message);
            }
        }

        userCaches.set(configKey, {
            status: 'ready', channelMap: tempMap, catalogItems: tempCatalog,
            uniqueGroups: groups, epgData: tempEpg, lastUpdated: Date.now()
        });

        console.log(`[Stream] Complete! Mapped to ${groups.size} provider catalogs.`);

    } catch (err) {
        userCaches.set(configKey, { status: 'error', message: err.message });
        console.error(`[Stream] Critical Failure:`, err.message);
    }
}

// --- PROTOCOL ROUTING ---
app.get('/:config/manifest.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    const decodedBuffer = Buffer.from(req.params.config, 'base64').toString('utf-8');
    try {
        const configData = JSON.parse(decodedBuffer);
        if (!configData.m3u) return res.status(400).json({ error: "Missing M3U URL" });
        
        await streamFetchIPTV(req.params.config, configData.m3u, configData.epg);
        const userData = userCaches.get(req.params.config);
        
        const instanceManifest = JSON.parse(JSON.stringify(manifestTemplate));
        const catalogs = [];

        if (userData && userData.status === 'ready') {
            Array.from(userData.uniqueGroups).sort().forEach(group => {
                catalogs.push({
                    type: 'tv', id: `iptv_${group.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`, name: group,
                    extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
                });
            });
        }
        
        if (catalogs.length === 0) {
            catalogs.push({ type: 'tv', id: 'grouped_channels', name: 'Live IPTV', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
        }
        
        instanceManifest.catalogs = catalogs;
        res.json(instanceManifest);
    } catch(e) {
        res.status(400).json({ error: "Invalid configuration profile" });
    }
});

app.get(['/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id, extra } = req.params;
    
    if (type !== 'tv') return res.json({ metas: [] });

    let skip = 0; let search = null;
    if (extra) {
        const skipMatch = extra.match(/skip=([0-9]+)/);
        if (skipMatch) skip = parseInt(skipMatch[1]);
        const searchMatch = extra.match(/search=([^&]+)/);
        if (searchMatch) search = decodeURIComponent(searchMatch[1]).toLowerCase();
    }

    const userData = userCaches.get(config);
    if (!userData || userData.status !== 'ready') return res.json({ metas: [] });

    let filteredCatalog = userData.catalogItems.filter(item => item.catalogId === id);
    if (search) filteredCatalog = filteredCatalog.filter(item => item.name.toLowerCase().includes(search));

    const paginatedCatalog = filteredCatalog.slice(skip, skip + 100);
    const safeCatalog = paginatedCatalog.map(({ catalogId, ...rest }) => rest);

    return res.json({ metas: safeCatalog });
});

// EPG INJECTOR
app.get(['/:config/meta/:type/:id.json', '/:config/meta/:type/:id/:extra.json'], (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { config, type, id } = req.params;
    const channelKey = id.replace('iptv:', '');
    const userData = userCaches.get(config);
