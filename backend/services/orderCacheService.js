/**
 * Redis-based caching service for orders
 * Implements industry-standard caching patterns used by Uber, Grab, Swiggy
 */

class OrderCacheService {
    constructor(redisClient) {
        this.redis = redisClient;
        this.CACHE_TTL = {
            ORDERS_LIST: 30, // 30 seconds for orders list
            ORDER_DETAIL: 60, // 1 minute for order details
            USER_ORDERS: 45, // 45 seconds for user-specific orders
            DRIVER_ORDERS: 15, // 15 seconds for driver orders (more dynamic)
        };
        this.CACHE_PREFIX = 'orders_cache:';
    }

    /**
     * Generate cache key based on request parameters
     */
    generateCacheKey(userId, userType, query = {}) {
        const { page = 1, limit = 20, status, ...otherParams } = query;
        const keyParts = [
            this.CACHE_PREFIX,
            userType,
            userId,
            `page_${page}`,
            `limit_${limit}`,
            status ? `status_${status}` : '',
            Object.keys(otherParams).length > 0 ? `params_${JSON.stringify(otherParams)}` : ''
        ].filter(Boolean);
        
        return keyParts.join(':');
    }

    /**
     * Get cached orders
     */
    async getCachedOrders(userId, userType, query = {}) {
        try {
            const cacheKey = this.generateCacheKey(userId, userType, query);
            const cached = await this.redis.get(cacheKey);
            
            if (cached) {
                const data = JSON.parse(cached);
                return {
                    ...data,
                    fromCache: true,
                    cacheKey
                };
            }
            return null;
        } catch (error) {
            console.error('Cache get error:', error);
            return null;
        }
    }

    /**
     * Cache orders with appropriate TTL
     */
    async setCachedOrders(userId, userType, query, data) {
        try {
            const cacheKey = this.generateCacheKey(userId, userType, query);
            const ttl = userType === 'driver' ? this.CACHE_TTL.DRIVER_ORDERS : this.CACHE_TTL.USER_ORDERS;
            
            const cacheData = {
                ...data,
                cachedAt: new Date().toISOString(),
                ttl
            };

            await this.redis.setex(cacheKey, ttl, JSON.stringify(cacheData));
            return cacheKey;
        } catch (error) {
            console.error('Cache set error:', error);
        }
    }

    /**
     * Invalidate cache when orders change
     */
    async invalidateOrderCache(orderId, userId = null, userType = null) {
        try {
            const patterns = [
                `${this.CACHE_PREFIX}*`,
                orderId ? `${this.CACHE_PREFIX}*order_${orderId}*` : null,
                userId ? `${this.CACHE_PREFIX}*${userId}*` : null
            ].filter(Boolean);

            for (const pattern of patterns) {
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            }
        } catch (error) {
            console.error('Cache invalidation error:', error);
        }
    }

    /**
     * Get cache statistics
     */
    async getCacheStats() {
        try {
            const keys = await this.redis.keys(`${this.CACHE_PREFIX}*`);
            const stats = {
                totalKeys: keys.length,
                keysByType: {},
                memoryUsage: 0
            };

            for (const key of keys) {
                const parts = key.split(':');
                const type = parts[2] || 'unknown';
                stats.keysByType[type] = (stats.keysByType[type] || 0) + 1;
                
                try {
                    const size = await this.redis.memory('usage', key);
                    stats.memoryUsage += size || 0;
                } catch (e) {
                    // Memory command might not be available in all Redis versions
                }
            }

            return stats;
        } catch (error) {
            console.error('Cache stats error:', error);
            return { error: error.message };
        }
    }

    /**
     * Warm up cache with frequently accessed data
     */
    async warmupCache() {
        try {
            console.log('🔥 Warming up order cache...');
            // This would typically pre-populate cache with most common queries
            // Implementation depends on your specific access patterns
        } catch (error) {
            console.error('Cache warmup error:', error);
        }
    }

    /**
     * Clean up expired cache entries
     */
    async cleanupExpiredCache() {
        try {
            const keys = await this.redis.keys(`${this.CACHE_PREFIX}*`);
            let cleanedCount = 0;
            
            for (const key of keys) {
                const ttl = await this.redis.ttl(key);
                if (ttl === -2) { // Key doesn't exist
                    cleanedCount++;
                }
            }
            
            return { cleanedCount, totalKeys: keys.length };
        } catch (error) {
            console.error('Cache cleanup error:', error);
            return { error: error.message };
        }
    }
}

module.exports = OrderCacheService;
