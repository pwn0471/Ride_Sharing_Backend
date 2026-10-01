const redis = require('redis');

let redisClient = null;

// Mock Redis client for development
class MockRedisClient {
  constructor() {
    this.store = new Map();
    console.log('🔴 Using Mock Redis for development');
  }

  async connect() {
    console.log('🔴 Mock Redis Connected');
  }

  async get(key) {
    const result = this.store.get(key);
    return result || null;
  }

  async set(key, value) {
    this.store.set(key, value);
    return 'OK';
  }

  async setEx(key, seconds, value) {
    this.store.set(key, value);
    // In a real implementation, you'd set a timeout to delete the key
    setTimeout(() => {
      this.store.delete(key);
    }, seconds * 1000);
    return 'OK';
  }

  async del(key) {
    const deleted = this.store.delete(key);
    return deleted ? 1 : 0;
  }

  async exists(key) {
    return this.store.has(key) ? 1 : 0;
  }

  async ping() {
    return 'PONG';
  }

  on(event, callback) {
    // Mock event handling
    if (event === 'connect') {
      setTimeout(callback, 0);
    }
  }

  off(event, callback) {
    // Mock event handling
  }
}

const connectRedis = async () => {
  try {
    // Check if we should use mock Redis for development
    if (process.env.USE_MOCK_REDIS === 'true' || process.env.NODE_ENV === 'development') {
      redisClient = new MockRedisClient();
      await redisClient.connect();
      return;
    }

    const redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379
    };

    // Add password if provided
    if (process.env.REDIS_PASSWORD) {
      redisConfig.password = process.env.REDIS_PASSWORD;
    }

    redisClient = redis.createClient(redisConfig);

    redisClient.on('error', (err) => {
      console.error('❌ Redis Client Error:', err);
      
      // Fallback to mock Redis in development
      if (process.env.NODE_ENV === 'development') {
        console.log('🔧 Falling back to mock Redis for development');
        redisClient = new MockRedisClient();
        redisClient.connect();
      }
    });

    redisClient.on('connect', () => {
      console.log('🔴 Redis Connected');
    });

    await redisClient.connect();
  } catch (error) {
    console.error('❌ Redis connection error:', error.message);
    
    // In development, fallback to mock Redis
    if (process.env.NODE_ENV === 'development') {
      console.log('🔧 Using mock Redis for development');
      redisClient = new MockRedisClient();
      await redisClient.connect();
    }
  }
};

const getRedisClient = () => {
  return redisClient;
};

module.exports = {
  connectRedis,
  getRedisClient
};
