const axios = require('axios');
const zlib = require('zlib');
const sax = require('sax');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

async function syncPremiumEpgToSupabase(xmlGzUrl) {
    if (!supabase) {
        console.error("[Universal EPG Error] Supabase environment variables are not configured.");
        return;
    }

    console.log(`[Universal EPG] Starting memory-safe EPG sync from ${xmlGzUrl}...`);

    try {
        const response = await axios({
            method: 'get',
            url: xmlGzUrl,
            responseType: 'stream',
            timeout: 60000
        });

        const unzipStream = zlib.createGunzip();
        const xmlStream = sax.createStream(true, { trim: true, normalize: true });

        let currentChannel = null;
        let channelBatch = [];

        xmlStream.on('opentag', (node) => {
            if (node.name === 'channel') {
                currentChannel = {
                    id: node.attributes.id,
                    name: '',
                    logo_url: null
                };
            }
            if (node.name === 'icon' && currentChannel) {
                currentChannel.logo_url = node.attributes.src;
            }
        });

        xmlStream.on('text', (text) => {
            if (currentChannel && text.trim().length > 0) {
                if (!currentChannel.name) {
                    currentChannel.name = text;
                }
            }
        });

        xmlStream.on('closetag', async (tagName) => {
            if (tagName === 'channel' && currentChannel) {
                currentChannel.id = currentChannel.id.toLowerCase();
                channelBatch.push(currentChannel);
                currentChannel = null;

                if (channelBatch.length >= 500) {
                    const batchToUpload = [...channelBatch];
                    channelBatch = [];

                    // Deduplicate within the array slice to protect PostgreSQL upserts
                    const uniqueBatchMap = new Map();
                    batchToUpload.forEach(item => uniqueBatchMap.set(item.id, item));
                    const cleanBatch = Array.from(uniqueBatchMap.values());

                    const { error } = await supabase
                        .from('epg_channels')
                        .upsert(cleanBatch, { onConflict: 'id' });

                    if (error) {
                        console.error("[Universal EPG Supabase Error]", error.message);
                    } else {
                        console.log(`[Universal EPG] Streamed and saved ${cleanBatch.length} premium channels to database...`);
                    }
                }
            }
        });

        xmlStream.on('end', async () => {
            if (channelBatch.length > 0) {
                const uniqueBatchMap = new Map();
                channelBatch.forEach(item => uniqueBatchMap.set(item.id, item));
                const cleanBatch = Array.from(uniqueBatchMap.values());

                await supabase.from('epg_channels').upsert(cleanBatch, { onConflict: 'id' });
            }
            console.log("[Universal EPG] Premium EPG Synchronization complete!");
        });

        xmlStream.on('error', (err) => {
            console.error("[Universal EPG SAX Error]", err.message);
        });

        response.data.pipe(unzipStream).pipe(xmlStream);

    } catch (err) {
        console.error("[Universal EPG Error] Failed to fetch or stream EPG source:", err.message);
    }
}

async function upgradeChannelAssets(cleanNameString, configObj = {}) {
    if (!supabase) return null;

    try {
        const { data: existingMapping } = await supabase
            .from('user_mappings')
            .select('*')
            .eq('raw_name', cleanNameString)
            .single();

        if (existingMapping) {
            if (existingMapping.use_fallback) {
                if (configObj.fallbackPreference === 'provider') {
                    return null;
                }
                return { id: null, logo: null, isFallbackPoster: true };
            }

            const { data: channelAsset } = await supabase
                .from('epg_channels')
                .select('*')
                .eq('id', existingMapping.epg_id)
                .single();

            if (channelAsset) {
                return {
                    id: channelAsset.id,
                    logo: channelAsset.logo_url || null
                };
            }
        }

        return { needsAiCuration: true };

    } catch (e) {
        return null;
    }
}

module.exports = { syncPremiumEpgToSupabase, upgradeChannelAssets };
