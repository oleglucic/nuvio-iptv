// redisCache.js
// Persists the in-memory channel cache (userCaches entries) to Redis, so a
// container restart can rehydrate instantly instead of re-parsing the whole
// M3U/Xtream source from scratch. The in-memory Map stays the fast path for
// every request; Redis is purely the durability layer behind it.

const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL;
let redis = null;

if (redisUrl) {
    redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 200, 2000)
    });
    redis.on('error', (e) => console.error('[Redis Error]', e.message));
    redis.on('connect', () => console.log('[Redis] Connected.'));
} else {
    console.warn('[Redis] REDIS_URL not set - cache persistence disabled, running memory-only.');
}

const KEY_PREFIX = 'nuvio:cache:';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours - well beyond MAX_CACHE_AGE, just a safety net

/**
 * Convert an in-memory cache entry (with Map/Set fields) into a JSON-safe plain object.
 * @param {object} cacheData - the value normally stored in userCaches
 */
function serializeCache(cacheData) {
    return JSON.stringify({
        status: cacheData.status,
        channelMap: Object.fromEntries(cacheData.channelMap || new Map()),
        logoTracker: Object.fromEntries(cacheData.logoTracker || new Map()),
        catalogItems: cacheData.catalogItems || [],
        uniqueGroups: Array.from(cacheData.uniqueGroups || new Set()),
        epgData: cacheData.epgData || {},
        lastUpdated: cacheData.lastUpdated || Date.now()
    });
}

/**
 * Reverse of serializeCache - rebuild Map/Set fields from the JSON-safe plain object.
 * @param {string} raw - the JSON string read back from Redis
 */
function deserializeCache(raw) {
    const obj = JSON.parse(raw);
    return {
        status: obj.status,
        channelMap: new Map(Object.entries(obj.channelMap || {})),
        logoTracker: new Map(Object.entries(obj.logoTracker || {})),
        catalogItems: obj.catalogItems || [],
        uniqueGroups: new Set(obj.uniqueGroups || []),
        epgData: obj.epgData || {},
        lastUpdated: obj.lastUpdated || 0
    };
}

/**
 * Write a channel cache entry through to Redis. Fire-and-forget safe - errors
 * are logged, never thrown, since Redis is a durability layer, not the source of truth.
 * @param {string} configKey
 * @param {object} cacheData
 */
async function saveCacheToRedis(configKey, cacheData) {
    if (!redis) return;
    try {
        await redis.set(KEY_PREFIX + configKey, serializeCache(cacheData), 'EX', CACHE_TTL_SECONDS);
    } catch (e) {
        console.error('[Redis Error] saveCacheToRedis:', e.message);
    }
}

/**
 * Load a channel cache entry from Redis, if present.
 * @param {string} configKey
 * @returns {Promise<object | null>}
 */
async function loadCacheFromRedis(configKey) {
    if (!redis) return null;
    try {
        const raw = await redis.get(KEY_PREFIX + configKey);
        if (!raw) return null;
        return deserializeCache(raw);
    } catch (e) {
        console.error('[Redis Error] loadCacheFromRedis:', e.message);
        return null;
    }
}

/**
 * List every config key currently persisted in Redis - used to pre-warm
 * the in-memory cache for all known configs on boot.
 * @returns {Promise<string[]>}
 */
async function listCachedConfigKeys() {
    if (!redis) return [];
    try {
        const keys = await redis.keys(KEY_PREFIX + '*');
        return keys.map(k => k.substring(KEY_PREFIX.length));
    } catch (e) {
        console.error('[Redis Error] listCachedConfigKeys:', e.message);
        return [];
    }
}

module.exports = {
    saveCacheToRedis,
    loadCacheFromRedis,
    listCachedConfigKeys,
    hasRedis: !!redis
};