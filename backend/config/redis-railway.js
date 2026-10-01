const redis = require('redis');

let redisClient = null;

const connectRedis = async () => {
  try {
    // Get Redis URL from Railway environment
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.log('⚠️ REDIS_URL not found. Redis service required for production.');
      
      if (process.env.NODE_ENV === 'production') {
        throw new Error('REDIS_URL environment variable is required in production');
      }
      
      // Return null for development - app should handle gracefully
      return null;
    }
    
    console.log('🔴 Connecting to Redis...');
    
    // Create Redis client with Railway URL
    redisClient = redis.createClient({
      url: redisUrl,
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          console.error('❌ Redis connection refused');
          return new Error('Redis connection refused');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          console.error('❌ Redis retry time exhausted');
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          console.error('❌ Redis max connection attempts reached');
          return undefined;
        }
        // Reconnect after
        return Math.min(options.attempt * 100, 3000);
      }
    });

    // Handle Redis connection events
    redisClient.on('connect', () => {
      console.log('🔴 Redis connecting...');
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis connected and ready');
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });

    redisClient.on('end', () => {
      console.log('🔴 Redis connection ended');
    });

    // Connect to Redis
    await redisClient.connect();
    
    // Test connection
    await redisClient.ping();
    console.log('🏓 Redis ping successful');
    
    return redisClient;
    
  } catch (error) {
    console.error('❌ Redis connection error:', error.message);
    
    if (process.env.NODE_ENV === 'production') {
      console.error('💥 Exiting due to Redis connection failure in production');
      process.exit(1);
    }
    
    // In development, return null and let app handle gracefully
    return null;
  }
};

const getRedisClient = () => {
  return redisClient;
};

const disconnectRedis = async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
      console.log('🔴 Redis disconnected');
    } catch (error) {
      console.error('❌ Error disconnecting Redis:', error.message);
    }
  }
};

module.exports = {
  connectRedis,
  getRedisClient,
  disconnectRedis
};
