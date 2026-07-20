const { createClient } = require('@supabase/supabase-js');

// ── Lazy singleton ──────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const hasSupabase = !!(supabaseUrl && supabaseKey);

let supabase = null;
if (hasSupabase) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('[DB] Supabase client initialised.');
} else {
    console.warn('[DB] SUPABASE_URL / SUPABASE_KEY not set — AI overrides disabled.');
}

// ── getOverride ─────────────────────────────────────────────────────────────
/**
 * Look up an AI-resolved canonical ID for a raw channel name.
 * @param {string} rawName
 * @returns {Promise<{canonical_id: string, confidence: number}|null>}
 */
async function getOverride(rawName) {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('ai_overrides')
            .select('canonical_id, confidence')
            .eq('raw_name', rawName)
            .single();

        if (error || !data) return null;
        return { canonical_id: data.canonical_id, confidence: parseFloat(data.confidence) };
    } catch (e) {
        console.error('[DB Error] getOverride:', e.message);
        return null;
    }
}

// ── setOverride ─────────────────────────────────────────────────────────────
/**
 * Insert or update an AI override mapping.
 * @param {string} rawName
 * @param {string} canonicalId
 * @param {number} [confidence=0.85]
 */
async function setOverride(rawName, canonicalId, confidence = 0.85) {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from('ai_overrides')
            .upsert(
                { raw_name: rawName, canonical_id: canonicalId, confidence, updated_at: new Date().toISOString() },
                { onConflict: 'raw_name' }
            );
        if (error) throw error;
    } catch (e) {
        console.error('[DB Error] setOverride:', e.message);
    }
}

// ── incrementConfidence ─────────────────────────────────────────────────────
/**
 * Increase a mapping's confidence score (capped at 0.99).
 * @param {string} rawName
 * @param {number} [delta=0.01]
 */
async function incrementConfidence(rawName, delta = 0.01) {
    if (!supabase) return;
    try {
        const current = await getOverride(rawName);
        if (!current) return;
        const newConf = Math.min(0.99, current.confidence + delta);
        const { error } = await supabase
            .from('ai_overrides')
            .update({ confidence: newConf, updated_at: new Date().toISOString() })
            .eq('raw_name', rawName);
        if (error) throw error;
    } catch (e) {
        console.error('[DB Error] incrementConfidence:', e.message);
    }
}

// ── decrementConfidence ─────────────────────────────────────────────────────
/**
 * Decrease a mapping's confidence score (floored at 0.0).
 * @param {string} rawName
 * @param {number} [delta=0.1]
 */
async function decrementConfidence(rawName, delta = 0.1) {
    if (!supabase) return;
    try {
        const current = await getOverride(rawName);
        if (!current) return;
        const newConf = Math.max(0.0, current.confidence - delta);
        const { error } = await supabase
            .from('ai_overrides')
            .update({ confidence: newConf, updated_at: new Date().toISOString() })
            .eq('raw_name', rawName);
        if (error) throw error;
    } catch (e) {
        console.error('[DB Error] decrementConfidence:', e.message);
    }
}

// ── incrementUsage ──────────────────────────────────────────────────────────
/**
 * Bump usage_count for a raw_name mapping.
 * @param {string} rawName
 */
async function incrementUsage(rawName) {
    if (!supabase) return;
    try {
        // Use RPC or a plain read-modify-write (table has no DB trigger, so we do it here)
        const { data, error: readErr } = await supabase
            .from('ai_overrides')
            .select('usage_count')
            .eq('raw_name', rawName)
            .single();

        if (readErr || !data) return;
        const { error } = await supabase
            .from('ai_overrides')
            .update({ usage_count: (data.usage_count || 0) + 1 })
            .eq('raw_name', rawName);
        if (error) throw error;
    } catch (e) {
        console.error('[DB Error] incrementUsage:', e.message);
    }
}

// ── getAllOverrides ──────────────────────────────────────────────────────────
/**
 * Fetch all override rows (used by the dashboard).
 * @returns {Promise<Array>}
 */
async function getAllOverrides() {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('ai_overrides')
            .select('*')
            .order('usage_count', { ascending: false });
        if (error) throw error;
        return data || [];
    } catch (e) {
        console.error('[DB Error] getAllOverrides:', e.message);
        return [];
    }
}

// ── Legacy aliases kept for any remaining call-sites ────────────────────────
const getMapping  = getOverride;
const saveMapping = setOverride;
const adjustConfidence = async (rawName, isSuccess) => {
    if (isSuccess) return incrementConfidence(rawName);
    return decrementConfidence(rawName);
};
const getAllMappings = getAllOverrides;

module.exports = {
    // Primary API
    getOverride,
    setOverride,
    incrementConfidence,
    decrementConfidence,
    incrementUsage,
    getAllOverrides,
    hasSupabase,
    // Legacy aliases
    getMapping,
    saveMapping,
    adjustConfidence,
    getAllMappings
};
