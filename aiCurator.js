const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Sends a batch of messy channel names to Llama 3.1 for semantic extraction.
 * @param {Array<string>} rawNamesArray - Array of dirty provider channel strings
 * @returns {Object} - JSON mapping of { "raw name": "predicted.id" }
 */
async function processAiBatch(rawNamesArray) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.log("[AI Curator] Skipped: No OPENROUTER_API_KEY found in environment.");
        return {};
    }

    // Updated Prompt to match the new Truth Database format (channelname.countrycode)
    const prompt = `You are an expert IPTV metadata extractor. I will provide a JSON array of messy channel strings. 
    Map each raw name to its closest standard XMLTV ID format: "cleanname.countrycode".
    Strip all stream junk tags (FHD, 1080p, VIP, BACKUP, RAW, 50FPS).
    Example: "|| UK || SKY SPORTS F1 ULTRA HD" -> "skysportsf1.uk"
    Example: "RS: ARENA 1 PREM" -> "arenasport1premium.rs"
    Return ONLY a raw JSON object mapping the raw name as the key, and the predicted ID as the value. Do not include markdown formatting or conversational text.
    
    Input:
    ${JSON.stringify(rawNamesArray)}`;

    try {
        console.log(`[AI Curator] Sending batch of ${rawNamesArray.length} channels to Llama 3.1...`);
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: "meta-llama/llama-3.1-8b-instruct:free",
            messages: [{ role: "user", content: prompt }]
        }, {
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "HTTP-Referer": "https://iptvo.local",
                "Content-Type": "application/json"
            }
        });

        let content = res.data.choices[0].message.content.trim();
        content = content.replace(/```json/g, '').replace(/```/g, ''); // Strip markdown
        
        const mappedJson = JSON.parse(content);
        console.log(`[AI Curator] Success! Llama extracted ${Object.keys(mappedJson).length} IDs.`);
        return mappedJson;
    } catch (e) {
        console.error("[AI Curator Error] LLM parsing failed:", e.message);
        return {};
    }
}

/**
 * Processes the queue of unknown channels, asks the AI for the IDs, verifies them against the DB, and saves them.
 * @param {Array<string>} dirtyChannels - Array of raw channel names that need mapping
 * @param {string} configKey - The user's specific config hash for logging
 */
async function startAiQueue(dirtyChannels, configKey) {
    if (!process.env.OPENROUTER_API_KEY || !supabase) {
        console.log("[AI Curator] Cannot start queue: Missing API keys or Database connection.");
        return;
    }

    if (!dirtyChannels || dirtyChannels.length === 0) return;

    console.log(`[AI Curator] Found ${dirtyChannels.length} new unmapped channels. Starting background processing...`);

    // Process in safe batches of 20 to avoid OpenRouter rate limits
    for (let i = 0; i < dirtyChannels.length; i += 20) {
        const batch = dirtyChannels.slice(i, i + 20);
        const aiResults = await processAiBatch(batch);
        
        const dbUploadBatch = [];
        const predictedIds = Object.values(aiResults).filter(id => id);

        // 1. Verify which of the AI's predicted IDs actually exist in our Central Truth Database
        let validEpgIds = new Set();
        if (predictedIds.length > 0) {
            const { data: validChannels, error } = await supabase
                .from('epg_channels')
                .select('id')
                .in('id', predictedIds);
            
            if (!error && validChannels) {
                validEpgIds = new Set(validChannels.map(ch => ch.id));
            }
        }

        // 2. Format the payload for the user_mappings table
        for (const [rawName, predictedId] of Object.entries(aiResults)) {
            const isValid = validEpgIds.has(predictedId);
            
            dbUploadBatch.push({
                raw_name: rawName,
                epg_id: isValid ? predictedId : null,
                use_fallback: !isValid // True if AI failed to find a perfect match in our DB
            });
        }

        // 3. Save mapping permanently to Supabase so we never ask the AI about these specific strings again
        if (dbUploadBatch.length > 0) {
            const { error } = await supabase
                .from('user_mappings')
                .upsert(dbUploadBatch, { onConflict: 'raw_name' });
            
            if (error) console.error("[AI Curator DB Error]", error.message);
            else console.log(`[AI Curator] Saved ${dbUploadBatch.length} permanent mappings to database.`);
        }

        // Wait 10 seconds between batches so OpenRouter doesn't block the free tier
        if (i + 20 < dirtyChannels.length) {
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    console.log(`[AI Curator] Finished processing queue for ${configKey}.`);
}

module.exports = { startAiQueue };
