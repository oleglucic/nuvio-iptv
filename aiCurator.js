const axios = require('axios');
const { getOverride, setOverride } = require('./db');

// In-memory runtime cache for AI overrides
const globalAiCache = new Map();

/**
 * Asks OpenRouter AI to resolve messy channel strings into a unified canonical ID format.
 */
async function processAiBatch(rawNamesArray) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return {};

    const prompt = `You are a channel deduplication engine. I will give you an array of messy IPTV strings.
    Some of these are duplicates or backups of the same station. 
    Map each raw name to a clean, canonical ID format (e.g., "iptv:us_hbo", "iptv:uk_skysportsf1"). Ensure you start the ID with "iptv:".
    Ensure alternate links, backups, and quality variations of the identical station receive the EXACT same ID string so they collapse together.
    
    Return ONLY a raw JSON object where the key is the raw name and the value is the clean unified ID. No markdown.
    
    Input: ${JSON.stringify(rawNamesArray)}`;

    try {
        console.log(`[AI Curator] Resolving duplicates for a batch of ${rawNamesArray.length} channels...`);
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: "openrouter/free",
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
 * @param {Array<{rawName: string, baseCleanName: string, cId: string}>} dirtyChannels
 */
async function startAiQueue(dirtyChannels, configKey) {
    if (!process.env.OPENROUTER_API_KEY || !dirtyChannels || dirtyChannels.length === 0) return;

    console.log(`[AI Curator] Background queue triggered for ${dirtyChannels.length} stream evaluations...`);

    // 1. Conflict & Filter Detection
    const rawNamesByBase = new Map();
    const idCounts = new Map();
    
    dirtyChannels.forEach(ch => {
        // Group by baseCleanName
        if (!rawNamesByBase.has(ch.baseCleanName)) {
            rawNamesByBase.set(ch.baseCleanName, new Set());
        }
        rawNamesByBase.get(ch.baseCleanName).add(ch.rawName);

        // Count occurrences of ID
        idCounts.set(ch.cId, (idCounts.get(ch.cId) || 0) + 1);
    });

    const channelsToProcess = [];

    for (const ch of dirtyChannels) {
        const isAlt = /backup|alt|mirror/i.test(ch.rawName);
        const isShortOrUnknown = ch.baseCleanName === 'unknown' || ch.baseCleanName.length < 3;
        const hasBaseNameConflict = (rawNamesByBase.get(ch.baseCleanName)?.size || 0) > 1;
        const isOverMerged = (idCounts.get(ch.cId) || 0) > 3;

        // Check if DB already has mapping and confidence is low
        const existing = await getOverride(ch.rawName);
        const isLowConfidence = existing && existing.confidence < 0.5;

        if (isAlt || isShortOrUnknown || hasBaseNameConflict || isOverMerged || isLowConfidence || !existing) {
            channelsToProcess.push(ch.rawName);
        }
    }

    const uniqueToProcess = [...new Set(channelsToProcess)];
    if (uniqueToProcess.length === 0) {
        console.log(`[AI Curator] No flagged channels requiring processing for ${configKey}.`);
        return;
    }

    console.log(`[AI Curator] Flagged ${uniqueToProcess.length} channels for AI verification.`);

    for (let i = 0; i < uniqueToProcess.length; i += 20) {
        const batch = uniqueToProcess.slice(i, i + 20);
        const aiResults = await processAiBatch(batch);
        
        for (const [raw, clean] of Object.entries(aiResults)) {
            if (clean && clean.startsWith('iptv:')) {
                globalAiCache.set(raw, clean);
                
                // Persist to Supabase with 0.85 initial confidence
                await setOverride(raw, clean, 0.85);
            }
        }

        // Drip-feed delay to respect OpenRouter API limits
        if (i + 20 < uniqueToProcess.length) {
            await new Promise(resolve => setTimeout(resolve, 8000));
        }
    }
    console.log(`[AI Curator] Finished override database update. Next reload will use the new mappings.`);
}

module.exports = { startAiQueue, globalAiCache };
