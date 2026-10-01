const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// Load environment variables
dotenv.config();

// Import configurations
const { connectDB } = require('./config/database');
const { connectRedis } = require('./config/redis');
const { specs, swaggerUi, swaggerOptions } = require('./config/swagger');

// Import routes
const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const driverRoutes = require('./routes/drivers');
const customerRoutes = require('./routes/customers');
const adminRoutes = require('./routes/admin');

// Import middleware
const errorHandler = require('./middleware/errorHandler');
const { Logger, requestLogger, errorLogger } = require('./middleware/logger');
const { 
    securityMiddleware, 
    compressionMiddleware, 
    generalApiRateLimit 
} = require('./middleware/optimization');

// Import services
const EnhancedSocketService = require('./services/enhancedSocketService');
const OrderCacheService = require('./services/orderCacheService');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with enhanced service
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

let redisClient = null;
let orderCacheService = null;
let enhancedSocketService = null;

// Connect to databases and initialize services
async function initializeServices() {
    try {
        await connectDB();
        redisClient = await connectRedis();
        
        // Initialize cache service
        if (redisClient) {
            orderCacheService = new OrderCacheService(redisClient);
            app.locals.orderCacheService = orderCacheService;
            console.log('📊 Order cache service initialized');
        }

        // Initialize enhanced socket service
        enhancedSocketService = new EnhancedSocketService(io, redisClient);
        console.log('🔌 Enhanced socket service initialized');
        
    } catch (error) {
        console.error('❌ Error initializing services:', error);
    }
}

// Initialize all services
initializeServices();

// Industry-standard security and performance middleware
app.use(securityMiddleware);
app.use(compressionMiddleware);

// CORS middleware
app.use(cors());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting for API endpoints
app.use('/api', generalApiRateLimit);

// Add request logging middleware
app.use(requestLogger);

// Make services available to routes
app.use((req, res, next) => {
    req.io = io;
    req.orderCacheService = orderCacheService;
    req.enhancedSocketService = enhancedSocketService;
    next();
});

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, swaggerOptions));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/admin', adminRoutes);

// Health check with enhanced metrics
app.get('/health', (req, res) => {
    const healthData = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        services: {
            database: 'connected',
            redis: redisClient ? 'connected' : 'disconnected',
            socketConnections: enhancedSocketService?.getConnectionStats().totalConnections || 0
        }
    };
    
    res.json(healthData);
});

// Performance monitoring endpoint
app.get('/api/performance', async (req, res) => {
    try {
        const performance = {
            server: {
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage()
            },
            cache: orderCacheService ? await orderCacheService.getCacheStats() : null,
            sockets: enhancedSocketService ? enhancedSocketService.getConnectionStats() : null,
            timestamp: new Date().toISOString()
        };
        
        res.json(performance);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API info endpoint with optimization recommendations
app.get('/api', (req, res) => {
    res.json({
        name: 'RideShare API',
        version: '1.0.0',
        description: 'Optimized ride sharing backend with caching, rate limiting, and real-time features',
        documentation: '/api-docs',
        endpoints: {
            auth: '/api/auth',
            orders: '/api/orders',
            drivers: '/api/drivers',
            health: '/health',
            performance: '/api/performance'
        },
        optimizations: {
            caching: 'Redis-based order caching',
            rateLimiting: 'Industry-standard rate limits',
            realTime: 'WebSocket-based real-time updates',
            compression: 'Response compression enabled',
            security: 'Helmet security headers'
        },
        recommendations: {
            polling: {
                orders: 'Use WebSocket for real-time updates instead of frequent polling',
                customers: 'Poll every 60 seconds maximum',
                drivers: 'Poll every 15 seconds maximum'
            },
            caching: 'ETags supported for conditional requests',
            efficiency: 'Use pagination and status filtering to reduce payload size'
        }
    });
});

// Serve admin dashboard
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// Error handling middleware (order matters - this should be before 404)
app.use(errorLogger);
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
  Logger.warn('Route not found', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent')
  });
  res.status(404).json({ message: 'Route not found' });
});

const PORT = process.env.PORT || 3003;

server.listen(PORT, async () => {
    Logger.info('Server started successfully', {
        port: PORT,
        environment: process.env.NODE_ENV,
        nodeVersion: process.version
    });
    
    console.log(` Server running on port ${PORT}`);
    console.log(` Environment: ${process.env.NODE_ENV}`);
    console.log(` In-memory MongoDB connected: 127.0.0.1`);
    console.log(` API Documentation: http://localhost:${PORT}/api-docs`);
    console.log(` Performance Metrics: http://localhost:${PORT}/api/performance`);
    
    
    if (orderCacheService) {
        console.log('📊 Cache service: Ready');
        await orderCacheService.warmupCache();
    }
    
    if (enhancedSocketService) {
        console.log('🔌 Enhanced WebSocket service: Ready');
    }
    
    // Log optimization recommendations
    console.log('\n🏆 Performance Recommendations:');
    console.log('   • Use WebSocket for real-time order updates');
    console.log('   • Customers: Poll orders max every 60 seconds');
    console.log('   • Drivers: Poll orders max every 15 seconds');
    console.log('   • Use ETags for conditional requests');
    console.log('   • Leverage response caching with proper headers');
});

module.exports = app;
