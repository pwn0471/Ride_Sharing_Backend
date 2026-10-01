const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');

/**
 * Industry-standard optimization middleware
 * Based on Uber, Grab, Swiggy patterns
 */

// 1. Helmet for security headers
const securityMiddleware = helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'script-src': ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        },
    },
});

// 2. Compression for response size optimization
const compressionMiddleware = compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    },
    threshold: 1024, // Only compress responses > 1KB
});

// 3. Rate limiting for GET orders - Disabled for development
const ordersRateLimit = rateLimit({
    windowMs: 15 * 1000, // 15 second window
    max: 1000, // Very high limit for development
    message: {
        error: 'Too many order requests',
        retryAfter: 15,
        recommendation: 'Use WebSocket for real-time updates or reduce polling frequency'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for development
        return true;
    }
});

// 4. General API rate limiting - Disabled for development
const generalApiRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000, // Very high limit
    message: {
        error: 'Rate limit exceeded',
        retryAfter: 900,
        type: 'RATE_LIMIT_EXCEEDED'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for development
        return true;
    }
});

// 5. Conditional request middleware (ETags support)
const conditionalMiddleware = (req, res, next) => {
    // Add ETag support for GET requests
    if (req.method === 'GET') {
        const originalSend = res.send;
        res.send = function(data) {
            if (typeof data === 'object') {
                // Generate ETag based on data content
                const etag = `"${Buffer.from(JSON.stringify(data)).toString('base64')}"`;
                res.set('ETag', etag);
                
                // Check if client has cached version
                const clientETag = req.get('If-None-Match');
                if (clientETag === etag) {
                    return res.status(304).end();
                }
            }
            return originalSend.call(this, data);
        };
    }
    next();
};

// 6. Cache control headers
const cacheControlMiddleware = (req, res, next) => {
    if (req.method === 'GET') {
        // Different caching strategies based on endpoint
        if (req.path.includes('/orders')) {
            // Orders data: Cache for 30 seconds, stale-while-revalidate for 60 seconds
            res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        } else if (req.path.includes('/profile')) {
            // Profile data: Cache for 5 minutes
            res.set('Cache-Control', 'private, max-age=300');
        } else {
            // Default: No cache for dynamic content
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
    next();
};

// 7. Request deduplication middleware
const requestDeduplicationCache = new Map();
const deduplicationMiddleware = (req, res, next) => {
    if (req.method === 'GET' && req.user) {
        const cacheKey = `${req.user.id}:${req.path}:${JSON.stringify(req.query)}`;
        const cached = requestDeduplicationCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < 5000) { // 5 second deduplication window
            return res.json(cached.data);
        }
        
        // Store response for deduplication
        const originalSend = res.send;
        res.send = function(data) {
            if (res.statusCode === 200 && typeof data === 'object') {
                requestDeduplicationCache.set(cacheKey, {
                    data: JSON.parse(data),
                    timestamp: Date.now()
                });
                
                // Clean up old entries (keep only last 100)
                if (requestDeduplicationCache.size > 100) {
                    const keys = Array.from(requestDeduplicationCache.keys());
                    keys.slice(0, 50).forEach(key => requestDeduplicationCache.delete(key));
                }
            }
            return originalSend.call(this, data);
        };
    }
    next();
};

// 8. Polling optimization headers
const pollingOptimizationMiddleware = (req, res, next) => {
    if (req.method === 'GET' && req.path.includes('/orders')) {
        // Add recommended polling intervals
        res.set('X-Poll-Interval', req.user?.type === 'driver' ? '15' : '60'); // seconds
        res.set('X-Prefer-WebSocket', 'true');
        res.set('X-Max-Poll-Frequency', '10'); // max 10 requests per minute
    }
    next();
};

module.exports = {
    securityMiddleware,
    compressionMiddleware,
    ordersRateLimit,
    generalApiRateLimit,
    conditionalMiddleware,
    cacheControlMiddleware,
    deduplicationMiddleware,
    pollingOptimizationMiddleware
};
