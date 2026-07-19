const axios = require('axios');

// In-memory runtime cache for AI overrides
const globalAiCache = new Map();

/**
 * Asks the AI to resolve messy channel strings into a unified canonical ID format.
 */
async function processAiBatch(rawNamesArray) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return {};

    const prompt = `You are a channel deduplication engine. I will give you an array of messy IPTV strings.
    Some of these are duplicates or backups of the same station. 
    Map each raw name to a clean, canonical ID format (e.g., "us_hbo", "uk_skysportsf1"). 
    Ensure alternate links, backups, and quality variations of the identical station receive the EXACT same ID string so they collapse together.
    
    Return ONLY a raw JSON object where the key is the raw name and the value is the clean unified ID. No markdown.
    
    Input: ${JSON.stringify(rawNamesArray)}`;

    try {
        console.log(`[AI Curator] Resolving duplicates for a batch of ${rawNamesArray.length} channels...`);
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
        content = content.replace(/```json/g, '').replace(/```/g, ''); 
        
        return JSON.parse(content);
    } catch (e) {
        console.error("[AI Curator Error] Failed to process batch:", e.message);
        return {};
    }
}

/**
 * Background worker that processes unmapped or highly duplicated strings
 */
async function startAiQueue(dirtyChannels, configKey) {
    if (!process.env.OPENROUTER_API_KEY || !dirtyChannels || dirtyChannels.length === 0) return;

    console.log(`[AI Curator] Background queue triggered for ${dirtyChannels.length} edge-case streams...`);

    for (let i = 0; i < dirtyChannels.length; i += 20) {
        const batch = dirtyChannels.slice(i, i + 20);
        const aiResults = await processAiBatch(batch);
        
        for (const [raw, clean] of Object.entries(aiResults)) {
            if (clean) {
                globalAiCache.set(raw, clean);
            }
        }

        // Drip-feed delay to respect OpenRouter's free tier limits
        if (i + 20 < dirtyChannels.length) {
            await new Promise(resolve => setTimeout(resolve, 8000));
        }
    }
    console.log(`[AI Curator] Finished smart optimization for ${configKey}. Next catalog reload will be perfectly grouped.`);
}

module.exports = { startAiQueue, globalAiCache };
