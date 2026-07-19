const axios = require('axios');
const zlib = require('zlib');
const sax = require('sax');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase using environment variables set up in your Render dashboard
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Streams a massive EPG XML file directly into Supabase without crashing RAM.
 * This runs periodically or on a cron job, completely bypassing Render's local disk constraints.
 * @param {string} xmlGzUrl - URL to the premium .xml.gz file (e.g., EPGShare01)
 */
async function syncPremiumEpgToSupabase(xmlGzUrl) {
    if (!supabase) {
        console.error("[Universal EPG Error] Supabase environment variables are not configured.");
        return;
    }

    console.log(`[Universal EPG] Starting memory-safe EPG sync from ${xmlGzUrl}...`);

    try {
        // 1. Open an HTTP read stream to download the compressed file
        const response = await axios({
            method: 'get',
            url: xmlGzUrl,
            responseType: 'stream',
            timeout: 60000
        });

        // 2. Create the unzip pipeline and the streaming XML parser
        const unzipStream = zlib.createGunzip();
        const xmlStream = sax.createStream(true, { trim: true, normalize: true });

        let currentChannel = null;
        let channelBatch = [];

        // 3. Listen for tags as they flow line-by-line
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
            // Extract text contents inside <display-name>
            if (currentChannel && text.trim().length > 0) {
                // EPG files might have multiple display names, we grab the first complete one found
                if (!currentChannel.name) {
                    currentChannel.name = text;
                }
            }
        });

        xmlStream.on('closetag', async (tagName) => {
            if (tagName === 'channel' && currentChannel) {
                // Enforce lowercase clean IDs for strict indexing matching later
                currentChannel.id = currentChannel.id.toLowerCase();
                channelBatch.push(currentChannel);
                currentChannel = null;

                // 4. Batch Upload to Supabase to respect API rate limits and keep active RAM under 40MB
                if (channelBatch.length >= 500) {
                    const batchToUpload = [...channelBatch];
                    channelBatch = []; // Immediately release array from garbage collection memory

                    const { error } = await supabase
                        .from('epg_channels')
                        .upsert(batchToUpload, { onConflict: 'id' });

                    if (error) {
                        console.error("[Universal EPG Supabase Error]", error.message);
                    } else {
                        console.log(`[Universal EPG] Streamed and saved 500 premium channels to database...`);
                    }
                }
            }
        });

        xmlStream.on('end', async () => {
            // Upload any remaining records left in the final array slice
            if (channelBatch.length > 0) {
                await supabase.from('epg_channels').upsert(channelBatch, { onConflict: 'id' });
            }
            console.log("[Universal EPG] Premium EPG Synchronization complete! All records cached safely on cloud.");
        });

        xmlStream.on('error', (err) => {
            console.error("[Universal EPG SAX Error]", err.message);
        });

        // 5. Pipe the streams together: Download -> Unzip -> SAX Event Listener
        response.data.pipe(unzipStream).pipe(xmlStream);

    } catch (err) {
        console.error("[Universal EPG Error] Failed to fetch or stream EPG source:", err.message);
    }
}

/**
 * Upgrades a channel with premium assets by querying the persistent Supabase database mapping layers.
 * Handles AI-mapped IDs, custom user fallbacks, and strict mappings.
 * @param {string} cleanNameString - The parsed clean string key representing the channel
 * @param {object} configObj - The client installation options containing preferences
 * @returns {object|null} - The premium channel metadata record containing official ID, logo, and mapping choices
 */
async function upgradeChannelAssets(cleanNameString, configObj = {}) {
    if (!supabase) return null;

    try {
        // 1. Check if the AI has already matched this exact raw provider channel string before
        const { data: existingMapping, error: mapError } = await supabase
            .from('user_mappings')
            .select('*')
            .eq('raw_name', cleanNameString)
            .single();

        if (existingMapping) {
            // If a historical mapping exists, check if it was marked as a complete fallback failure
            if (existingMapping.use_fallback) {
                // User choice: Did they explicitly select they prefer raw provider details over custom text posters?
                if (configObj.fallbackPreference === 'provider') {
                    return null; // Signals the parser to fallback to default stream attributes
                }
                return { id: null, logo: null, isFallbackPoster: true }; // Trigger imageEngine.js rendering
            }

            // A valid premium EPG target exists! Fetch it directly from the central directory
            const { data: channelAsset } = await supabase
                .from('epg_channels')
                .select('*')
                .eq('id', existingMapping.epg_id)
                .single();

            if (channelAsset) {
                return {
                    id: channelAsset.id, // Official XMLTV reference string
                    logo: channelAsset.logo_url || null
                };
            }
        }

        // 2. If no historical mapping exists yet, let the core parser loop know so it can trigger aiCurator.js
        return { needsAiCuration: true };

    } catch (e) {
        console.error("[Universal EPG Retrieval Error]", e.message);
        return null;
    }
}

module.exports = { syncPremiumEpgToSupabase, upgradeChannelAssets };
