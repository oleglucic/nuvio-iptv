const axios = require('axios');

// Cache the open-source database in RAM so we only fetch it once per day
let globalIptvOrgCache = {
    channels: new Map(),
    lastUpdated: 0
};

// Fetches the lightweight JSON API from the open-source community
async function syncOpenSourceDatabase() {
    const now = Date.now();
    // Refresh the cache every 24 hours
    if (globalIptvOrgCache.channels.size > 0 && (now - globalIptvOrgCache.lastUpdated < 86400000)) {
        return;
    }

    try {
        console.log("[Universal EPG] Syncing with iptv-org open-source database...");
        const res = await axios.get('https://iptv-org.github.io/api/channels.json', { timeout: 15000 });
        
        const channelData = res.data;
        globalIptvOrgCache.channels.clear();

        for (const ch of channelData) {
            // Create a clean lookup key (e.g., "Sky Sports F1" -> "skysportsf1")
            if (ch.name) {
                const cleanKey = ch.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                globalIptvOrgCache.channels.set(cleanKey, {
                    logo: ch.logo || null,
                    id: ch.id || null, // Official XMLTV ID
                    categories: ch.categories || []
                });
            }
        }
        
        globalIptvOrgCache.lastUpdated = now;
        console.log(`[Universal EPG] Successfully cached ${globalIptvOrgCache.channels.size} premium channel assets.`);
    } catch (e) {
        console.error("[Universal EPG Error] Failed to sync open-source database:", e.message);
    }
}

// Upgrades a mapped channel with premium assets
async function upgradeChannelAssets(cleanNameString) {
    await syncOpenSourceDatabase();
    
    // We expect the cleanNameString to be the raw cleaned name (e.g., "skysportsf1")
    // If the AI mapped it as "uk_skysportsf1", we strip the prefix for the lookup
    const searchKey = cleanNameString.includes('_') ? cleanNameString.split('_')[1] : cleanNameString;
    
    if (globalIptvOrgCache.channels.has(searchKey)) {
        return globalIptvOrgCache.channels.get(searchKey);
    }
    
    return null;
}

module.exports = { syncOpenSourceDatabase, upgradeChannelAssets };
