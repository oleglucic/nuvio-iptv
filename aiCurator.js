const axios = require('axios');

// Global memory cache for AI mappings so we don't re-ask known channels
const globalAiCache = new Map();

async function processAiBatch(rawNamesArray) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.log("[AI Curator] Skipped: No OPENROUTER_API_KEY found in environment.");
        return {};
    }

    const prompt = `You are an IPTV channel mapping engine. I will provide a JSON array of messy channel names. 
    Map each raw name to its closest logical, standard canonical ID (format: countrycode_channelname).
    Example: "|| UK || SKY SPORTS F1 ULTRA HD" -> "uk_skysportsf1"
    Example: "RS: ARENA 1 PREM" -> "rs_arenasport1premium"
    Return ONLY a raw JSON object mapping the raw name as the key, and the clean ID as the value. Do not include markdown formatting, backticks, or conversational text.
    
    Input:
    ${JSON.stringify(rawNamesArray)}`;

    try {
        console.log(`[AI Curator] Sending batch of ${rawNamesArray.length} channels to Llama 3.1 (Free)...`);
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
        // Strip markdown code blocks just in case the AI tries to be helpful
        content = content.replace(/```json/g, '').replace(/```/g, '');
        
        const mappedJson = JSON.parse(content);
        console.log(`[AI Curator] Success! Mapped ${Object.keys(mappedJson).length} channels.`);
        return mappedJson;
    } catch (e) {
        console.error("[AI Curator Error]", e.message);
        return {};
    }
}

// Background queue processor
async function startAiQueue(userMapData, configKey) {
    if (!process.env.OPENROUTER_API_KEY) return;
    
    const dirtyChannels = [];
    
    // Scan the user's channel map to find streams that look messy or unmapped
    for (const [cId, channelObj] of userMapData.channelMap.entries()) {
        const rawName = channelObj.meta.name;
        // If it isn't in our global cache yet, queue it up
        if (!globalAiCache.has(rawName)) {
            dirtyChannels.push(rawName);
        }
    }

    if (dirtyChannels.length === 0) {
        console.log(`[AI Curator] All channels for ${configKey} are already cached!`);
        return;
    }

    console.log(`[AI Curator] Found ${dirtyChannels.length} new channels. Starting background drip-feed...`);

    // Process in batches of 20 to avoid rate limits
    for (let i = 0; i < dirtyChannels.length; i += 20) {
        const batch = dirtyChannels.slice(i, i + 20);
        const aiResults = await processAiBatch(batch);
        
        // Save the AI's answers into our permanent server memory
        for (const [raw, clean] of Object.entries(aiResults)) {
            if (clean) globalAiCache.set(raw, clean);
        }

        // Wait 10 seconds between batches so OpenRouter doesn't block us
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
    console.log(`[AI Curator] Finished processing queue for ${configKey}.`);
}

module.exports = { startAiQueue, globalAiCache };
