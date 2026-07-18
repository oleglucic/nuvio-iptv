const axios = require('axios');
const readline = require('readline');
const zlib = require('zlib');
const { Readable } = require('stream');

const userCaches = new Map();

function parseXMLDate(x) {
    if (!x || x.length < 14) return 0;
    try {
        const offset = x.substring(15).trim() || '+0000';
        const fOffset = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
        const isoStr = `${x.substring(0,4)}-${x.substring(4,6)}-${x.substring(6,8)}T${x.substring(8,10)}:${x.substring(10,12)}:${x.substring(12,14)}${fOffset}`;
        const time = new Date(isoStr).getTime();
        if (isNaN(time)) return 0;
        return time;
    } catch (e) {
        return 0;
    }
}

function normaliseFormat(str) {
    if (!str) return "";
    const map = {
        'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','法':'f','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ǫ':'q','ʀ':'r','s':'s','ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','x':'x','ʏ':'y','ᴢ':'z',
        '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
        'ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ʰ':'h','ⁱ':'i','ʲ':'j','ᵏ':'k','ˡ':'l','ᵐ':'m','ⁿ':'n','ᵒ':'o','ᵖ':'p','ʳ':'r','ˢ':'s','ᵗ':'t','ᵘ':'u','ᵛ':'v','ʷ':'w','ˣ':'x','ʸ':'y','ᶻ':'z',
        'ᴬ':'a','ᴮ':'b','ᶜ':'c','ᴰ':'d','ᴱ':'e','ᶠ':'f','ᴳ':'g','ᴴ':'h','ᴵ':'i','ᴶ':'j','ᴷ':'k','ᴸ':'l','ᴹ':'m','ᴺ':'n','ᴼ':'o','ᴾ':'p','ᴿ':'r','ˢ':'s','ᵀ':'t','ᵁ':'u','ⱽ':'v','ᵂ':'w',
        '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9',
        'ₐ':'a','ₑ':'e','ₕ':'h','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t','ᵤ':'u','ᵥ':'v','ₓ':'x',
        'ⓐ':'a','Ⓐ':'a','ａ':'a','Ａ':'a','ⓑ':'b','Ⓑ':'b','ｂ':'b','Ｂ':'b','ⓒ':'c','Ⓒ':'c','ｃ':'c','Ｃ':'c','ⓓ':'d','Ⓓ':'d','ｄ':'d','Ｄ':'d','ⓔ':'e','Ⓔ':'e','ｅ':'e','Ｅ':'e',
        'ⓕ':'f','Ⓕ':'f','ｆ':'f','Ｆ':'f','ⓖ':'g','Ⓖ':'g','ｇ':'g','Ｇ':'g','ⓗ':'h','Ⓗ':'h','ｈ':'h','Ｈ':'h','ⓘ':'i','Ⓘ':'i','ｉ':'i','Ｉ':'i','ⓙ':'j','Ⓙ':'j','ｊ':'j','Ｊ':'j',
        'ⓚ':'k','Ⓚ':'k','ｋ':'k','Ｋ':'k','ⓛ':'l','Ⓛ':'l','ｌ':'l','Ｌ':'l','ⓜ':'m','Ⓜ':'m','ｍ':'m','Ｍ':'m','ⓝ':'n','Ⓝ':'n','ｎ':'n','Ｎ':'n','ⓞ':'o','Ⓞ':'o','ｏ':'o','Ｏ':'o',
        'ⓟ':'p','Ⓟ':'p','ｐ':'p','Ｐ':'p','ⓠ':'q','Ⓠ':'q','ｑ':'q','Ｑ':'q','ⓡ':'r','Ⓡ':'r','ｒ':'r','Ｒ':'r','ⓢ':'s','Ⓢ':'s','ｓ':'s','Ｓ':'s','ⓣ':'t','Ⓣ':'t','ｔ':'t','Ｔ':'t',
        '<b>':'','</b>':'','ⓤ':'u','Ⓤ':'u','u':'u','Ｕ':'u','ⓥ':'v','Ⓥ':'v','ｖ':'v','Ｖ':'v','ⓦ':'w','Ⓦ':'w','ｗ':'w','Ｗ':'w','ⓧ':'x','Ⓧ':'x','ｘ':'x','Ｘ':'x','ⓨ':'y','Ⓨ':'y','ｙ':'y','Ｙ':'y',
        'ⓩ':'z','Ⓩ':'z','ｚ':'z','Ｚ':'z'
    };
    return str.split('').map(c => map[c] || c).join('');
}

function parseStreamInfo(n) {
    const norm = normaliseFormat(n).toLowerCase();
    const cleanN = " " + norm.replace(/[^a-z0-9]/g, " ") + " ";
    
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
    if (cleanN.includes(" hevc ") || cleanN.includes(" h265 ")) { e.push("HEVC"); score += 400; }
    
    if (norm.includes("dolbyvision") || norm.includes("dolby vision") || norm.includes("dovi") || cleanN.includes(" dv ")) {
        e.push("Dolby Vision"); score += 350;
    }
    
    if (norm.includes("atmos")) {
        e.push("Dolby Atmos"); score += 300;
    } else if (norm.includes("dolby") || cleanN.includes(" ac3 ") || cleanN.includes(" eac3 ") || norm.includes("dd5") || norm.includes("audio")) {
        if (!e.includes("Dolby Vision")) { e.push("Dolby Audio"); score += 200; }
    }
    
    if (cleanN.includes(" 60fps ") || cleanN.includes(" 60 fps ")) { e.push("60FPS"); score += 300; }
    if (cleanN.includes(" 50fps ") || cleanN.includes(" 50 fps ")) { e.push("50FPS"); score += 200; }
    if (cleanN.includes(" 24 7 ") || cleanN.includes(" 247 ")) e.push("24/7");
    if (cleanN.includes(" backup ") || cleanN.includes(" alt ")) { e.push("ALT LINK"); score -= 25000; }
    
    return { name, title: e.length > 0 ? e.join(" • ") : "Direct Stream", score };
}

async function streamFetchIPTV(configKey, m3uUrl, epgUrl) {
    if (userCaches.has(configKey) && userCaches.get(configKey).status === 'loading') return;
    userCaches.set(configKey, { status: 'loading', channelMap: new Map(), logoTracker: new Map(), catalogItems: [], uniqueGroups: new Set(), epgData: {} });
    
    try {
        const res = await axios({ method: 'get', url: m3uUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
        let mStream = res.data;
        if (res.headers['content-encoding'] === 'gzip' || m3uUrl.toLowerCase().endsWith('.gz')) mStream = mStream.pipe(zlib.createGunzip());
        const rl = readline.createInterface({ input: mStream, crlfDelay: Infinity });
        
        const tMap = new Map(), logoTrack = new Map(), tCat = []; const groups = new Set(), epgMap = new Map(); let cItem = null;
        
        for await (const line of rl) {
            const t = line.trim();
            if (t.startsWith('#EXTINF:')) {
                if (t.match(/\.(mp4|mkv)$/i) || t.includes('/movie/') || t.includes('/series/')) { cItem = null; continue; }
                const tvgId = t.match(/tvg-id=["']([^"']+)["']/i), tvgName = t.match(/tvg-name=["']([^"']+)["']/i);
                const logo = t.match(/tvg-logo=["']([^"']+)["']/i), grp = t.match(/group-title=["']([^"']+)["']/i);
                const rawName = t.lastIndexOf(',') !== -1 ? t.substring(t.lastIndexOf(',') + 1).trim() : "Unknown";
                
                if (/([#\-\*_=\+~]){3,}/.test(rawName) || rawName.includes('----') || rawName.includes('####')) { cItem = null; continue; }
                
                let rawGrp = grp ? grp[1].trim() : 'Uncategorized';
                let normGrp = normaliseFormat(rawGrp).toLowerCase();
                let countryPrefix = "";
                
                const countryMatch = normGrp.match(/^([a-z]{2,3})\b/i);
                if (countryMatch) {
                    const code = countryMatch[1].toUpperCase();
                    const exclusions = ["ALL", "NEW", "VIP", "PPV", "RAW", "ALT", "VOD", "FHD", "UHD", "KIDS", "FOR", "THE", "TOP", "BIG", "ONE", "AND", "OUT", "NOT", "YES", "OFF"];
                    if (!exclusions.includes(code)) {
                        countryPrefix = code + " | "; normGrp = normGrp.substring(countryMatch[0].length).trim();
                    }
                }
                
                let cleanGrp = normGrp.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|live|vod|vip|60fps|50fps|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps)\b/gi, ' ');
                cleanGrp = cleanGrp.replace(/[-\/|:_\s]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                let finalGrp = countryPrefix + cleanGrp;
                if (!cleanGrp || cleanGrp.length < 2) finalGrp = rawGrp;
                
                let cleanNameStr = normaliseFormat(rawName).toLowerCase();
                let cName = cleanNameStr.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|60fps|50fps|h265|vod|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps|vip|premium|live|backup|alt|online)\b/gi, ' ');
                cName = cName.replace(/\b24\s*[\/_\-]?\s*7\b/gi, ' ');
                cName = cName.replace(/\b\d+[pi]\b|\b\d+\s*fps\b/gi, ' ');
                cName = cName.replace(/^[a-z]{2,3}\b\s*[-:|_\/\|\s]*/gi, ' ');
                cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
                
                const countryScopeKey = countryPrefix ? countryPrefix.replace(/[^A-Z]/g, '').toLowerCase() : 'global';
                const cId = `${countryScopeKey}_${cName.replace(/[^a-z0-9]/g, "") || "unknown"}`;
                
                if (tvgId) epgMap.set(tvgId[1].toLowerCase().trim(), cId);
                if (tvgName) epgMap.set(tvgName[1].toLowerCase().trim(), cId);
                epgMap.set(rawName.toLowerCase().trim(), cId);
                epgMap.set(rawName.toLowerCase().replace(/\s+/g, ''), cId);
                epgMap.set(cId, cId);
                
                const sourceLogo = logo ? logo[1] : '';
                logoTrack.set(cId, { url: sourceLogo, name: cName });
                
                cItem = { cId, cName, rawName, logo: sourceLogo, grp: finalGrp };
            } else if (t.startsWith('http') && cItem) {
                const { cId, cName, rawName, logo, grp } = cItem;
                const catId = `iptv_${grp.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
                groups.add(grp);
                if (!tMap.has(cId)) {
                    const mItem = { id: `iptv:${cId}`, type: 'tv', name: cName.replace(/\b\w/g, c => c.toUpperCase()), genres: [grp], catalogId: catId };
                    tMap.set(cId, { meta: mItem, streams: [] }); tCat.push(mItem);
                }
                
                const sInfo = parseStreamInfo(rawName);
                tMap.get(cId).streams.push({ name: sInfo.name, title: sInfo.title, url: t, score: sInfo.score }); 
                cItem = null;
            }
        }
        
        console.log(`[EPG Engine] M3U Complete. Generated ${epgMap.size} lookup hooks.`);

        const tEpg = {}; let eCount = 0;
        if (epgUrl) {
            try {
                const epgRes = await axios({ method: 'get', url: epgUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                let rawStream = epgRes.data;
                
                const firstChunk = await new Promise((resolve) => {
                    rawStream.once('data', (chunk) => resolve(chunk));
                });

                let finalizedStream;
                if (firstChunk && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b) {
                    const combined = Readable.from((async function* () {
                        yield firstChunk;
                        for await (const chunk of rawStream) { yield chunk; }
                    })());
                    finalizedStream = combined.pipe(zlib.createGunzip());
                } else {
                    finalizedStream = Readable.from((async function* () {
                        if (firstChunk) yield firstChunk;
                        for await (const chunk of rawStream) { yield chunk; }
                    })());
                }

                const rlEpg = readline.createInterface({ input: finalizedStream, crlfDelay: Infinity });
                let inProg = false, currP = "";
                
                for await (const line of rlEpg) {
                    const lowerLine = line.toLowerCase();
                    if (lowerLine.includes('<programme')) { 
                        inProg = true; currP = line; 
                    } else if (inProg) { 
                        currP += "\n" + line; 
                    }
                    
                    if (inProg && lowerLine.includes('</programme>')) {
                        inProg = false;
                        const chMatch = currP.match(/channel=["']([^"']+)["']/i);
                        if (chMatch) {
                            const rawEpgId = chMatch[1].toLowerCase().trim();
                            const mId = epgMap.get(rawEpgId) || epgMap.get(rawEpgId.replace(/\s+/g, ''));
                            
                            if (mId && tMap.has(mId)) {
                                const startMatch = currP.match(/start=["']([^"']+)["']/), stopMatch = currP.match(/stop=["']([^"']+)["']/);
                                const titleMatch = currP.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
                                const descMatch = currP.match(/<desc[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/desc>/i);
                                
                                if (!tEpg[mId]) tEpg[mId] = [];
                                tEpg[mId].push({ 
                                    start: parseXMLDate(startMatch ? startMatch[1] : ""), 
                                    stop: parseXMLDate(stopMatch ? stopMatch[1] : ""), 
                                    title: titleMatch ? titleMatch[1].trim() : "Unknown", 
                                    desc: descMatch ? descMatch[1].trim() : "" 
                                });
                                eCount++;
                            }
                        }
                    }
                }
                console.log(`[EPG Engine] Complete. Successfully mapped ${eCount} programs to channel layouts.`);
            } catch (e) { console.error(`EPG Processing Error:`, e.message); }
        }
        userCaches.set(configKey, { status: 'ready', channelMap: tMap, logoTracker: logoTrack, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg, lastUpdated: Date.now() });
    } catch (err) { userCaches.set(configKey, { status: 'error', message: err.message }); }
}

function getEpgText(chKey, epgData, offsetHours = 0) {
    const now = Date.now(), sched = epgData[chKey];
    if (!sched || sched.length === 0) return "No TV guide mapped.";
    const fProgs = sched.filter(p => p.stop > now).sort((a,b) => a.start - b.start);
    if (fProgs.length === 0) return "No upcoming programs mapped.";
    const cP = fProgs[0], nP = fProgs[1]; let text = "";

    const formatTime = (ms) => {
        const shiftedDate = new Date(ms + (parseInt(offsetHours) * 3600000));
        return `${String(shiftedDate.getUTCHours()).padStart(2, '0')}:${String(shiftedDate.getUTCMinutes()).padStart(2, '0')}`;
    };

    if (cP) text += `🟢 LATEST (${formatTime(cP.start)} - ${formatTime(cP.stop)})\n${cP.title}\n${cP.desc}\n\n`;
    if (nP) text += `⏭️ UP NEXT (${formatTime(nP.start)})\n${nP.title}`;
    return text;
}

module.exports = { streamFetchIPTV, getEpgText, userCaches };
