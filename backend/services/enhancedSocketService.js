/**
 * Enhanced WebSocket service for real-time order updates
 * Implements patterns from Uber, Grab, Swiggy for efficient real-time communication
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

class EnhancedSocketService {
    constructor(ioInstance, redisClient) {
        // Use the existing Socket.io instance instead of creating a new one
        this.io = ioInstance;
        
        this.redis = redisClient;
        this.connectedUsers = new Map(); // userId -> { socketId, userType, location }
        this.driverSockets = new Map(); // driverId -> socketId
        this.customerSockets = new Map(); // customerId -> socketId
        this.roomSubscriptions = new Map(); // room -> Set of socketIds
        
        this.setupSocketHandlers();
        this.startPeriodicUpdates();
        this.startConnectionCleanup();
    }

    setupSocketHandlers() {
        this.io.use(this.authenticateSocket.bind(this));
        
        this.io.on('connection', (socket) => {
            console.log(`🔌 User connected: ${socket.userId} (${socket.userType})`);
            
            this.handleUserConnection(socket);
            this.setupSocketEvents(socket);
        });
    }

    async authenticateSocket(socket, next) {
        try {
            const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
            
            if (!token) {
                // Allow anonymous connections for testing/browsing
                socket.userId = 'anonymous';
                socket.userType = 'guest';
                return next();
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
            socket.userId = decoded.id;
            socket.userType = decoded.type;
            
            next();
        } catch (error) {
            // Allow connection but mark as anonymous if token is invalid
            socket.userId = 'anonymous';
            socket.userType = 'guest';
            next();
        }
    }

    handleUserConnection(socket) {
        const { userId, userType } = socket;
        
        // Store user connection
        this.connectedUsers.set(userId, {
            socketId: socket.id,
            userType,
            connectedAt: new Date(),
            lastActivity: new Date()
        });

        // Categorize by user type
        if (userType === 'driver') {
            this.driverSockets.set(userId, socket.id);
            socket.join('drivers'); // Join drivers room
        } else {
            this.customerSockets.set(userId, socket.id);
            socket.join('customers'); // Join customers room
        }

        // Send connection acknowledgment with optimized polling settings
        socket.emit('connected', {
            message: 'Connected to real-time service',
            recommendedPolling: {
                orders: userType === 'driver' ? 30000 : 120000, // 30s for drivers, 2min for customers
                profile: 300000, // 5 minutes
                notifications: 60000 // 1 minute
            },
            features: ['real-time-orders', 'push-notifications', 'location-updates']
        });
    }

    setupSocketEvents(socket) {
        const { userId, userType } = socket;

        // Location updates (for drivers)
        socket.on('location-update', (data) => {
            if (userType === 'driver') {
                this.handleDriverLocationUpdate(userId, data);
            }
        });

        // Subscribe to order updates
        socket.on('subscribe-orders', () => {
            socket.join(`orders:${userId}`);
            socket.emit('subscribed', { channel: 'orders' });
        });

        // Heartbeat to track active connections
        socket.on('heartbeat', () => {
            const userInfo = this.connectedUsers.get(userId);
            if (userInfo) {
                userInfo.lastActivity = new Date();
                this.connectedUsers.set(userId, userInfo);
            }
        });

        // Handle disconnection
        socket.on('disconnect', (reason) => {
            console.log(`🔌 User disconnected: ${userId} (${reason})`);
            this.handleUserDisconnection(userId, userType);
        });

        // Error handling
        socket.on('error', (error) => {
            console.error(`Socket error for user ${userId}:`, error);
        });
    }

    async handleDriverLocationUpdate(driverId, locationData) {
        try {
            const { latitude, longitude, heading } = locationData;
            
            // Store location in Redis for proximity calculations
            await this.redis.hset(
                `driver_locations:${driverId}`,
                'latitude', latitude,
                'longitude', longitude,
                'heading', heading || 0,
                'updated_at', Date.now()
            );

            // Update user info
            const userInfo = this.connectedUsers.get(driverId);
            if (userInfo) {
                userInfo.location = { latitude, longitude, heading };
                userInfo.lastActivity = new Date();
                this.connectedUsers.set(driverId, userInfo);
            }
        } catch (error) {
            console.error('Error updating driver location:', error);
        }
    }

    handleUserDisconnection(userId, userType) {
        this.connectedUsers.delete(userId);
        
        if (userType === 'driver') {
            this.driverSockets.delete(userId);
        } else {
            this.customerSockets.delete(userId);
        }
    }

    // Emit order updates to specific users
    async notifyOrderUpdate(orderId, orderData, targetUsers = []) {
        try {
            if (targetUsers.length === 0) {
                // Broadcast to all connected users
                this.io.emit('order-updated', {
                    orderId,
                    data: orderData,
                    timestamp: new Date().toISOString()
                });
            } else {
                // Send to specific users
                for (const userId of targetUsers) {
                    const userInfo = this.connectedUsers.get(userId);
                    if (userInfo) {
                        this.io.to(userInfo.socketId).emit('order-updated', {
                            orderId,
                            data: orderData,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
        } catch (error) {
            console.error('Error notifying order update:', error);
        }
    }

    // Notify nearby drivers about new orders
    async notifyNearbyDrivers(orderData, radius = 5000) {
        try {
            const { pickupLocation } = orderData;
            const nearbyDrivers = [];

            // Find drivers within radius
            for (const [driverId, socketId] of this.driverSockets) {
                const userInfo = this.connectedUsers.get(driverId);
                if (userInfo?.location) {
                    const distance = this.calculateDistance(
                        pickupLocation.latitude,
                        pickupLocation.longitude,
                        userInfo.location.latitude,
                        userInfo.location.longitude
                    );
                    
                    if (distance <= radius) {
                        nearbyDrivers.push({ driverId, distance, socketId });
                    }
                }
            }

            // Sort by distance and notify
            nearbyDrivers
                .sort((a, b) => a.distance - b.distance)
                .forEach(({ socketId, distance }) => {
                    this.io.to(socketId).emit('new-order-nearby', {
                        ...orderData,
                        distance: Math.round(distance),
                        priority: distance < 2000 ? 'high' : 'normal'
                    });
                });

            return nearbyDrivers.length;
        } catch (error) {
            console.error('Error notifying nearby drivers:', error);
            return 0;
        }
    }

    // Send optimized order list updates
    async sendOrderListUpdate(userId, userType, orders) {
        const userInfo = this.connectedUsers.get(userId);
        if (userInfo) {
            this.io.to(userInfo.socketId).emit('orders-list-updated', {
                orders,
                count: orders.length,
                lastUpdated: new Date().toISOString(),
                userType
            });
        }
    }

    // Periodic cleanup of inactive connections
    startConnectionCleanup() {
        setInterval(() => {
            const now = new Date();
            const inactiveThreshold = 5 * 60 * 1000; // 5 minutes
            
            for (const [userId, userInfo] of this.connectedUsers) {
                if (now - userInfo.lastActivity > inactiveThreshold) {
                    console.log(`🧹 Cleaning up inactive connection: ${userId}`);
                    this.handleUserDisconnection(userId, userInfo.userType);
                }
            }
        }, 60000); // Run every minute
    }

    // Periodic updates for active users
    startPeriodicUpdates() {
        // Send connection stats every 30 seconds
        setInterval(() => {
            const stats = {
                totalConnections: this.connectedUsers.size,
                drivers: this.driverSockets.size,
                customers: this.customerSockets.size,
                timestamp: new Date().toISOString()
            };
            
            // Only send to development environment
            if (process.env.NODE_ENV === 'development') {
                this.io.emit('connection-stats', stats);
            }
        }, 30000);
    }

    // Utility function to calculate distance between two points
    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000; // Earth's radius in meters
        const dLat = this.toRadians(lat2 - lat1);
        const dLon = this.toRadians(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    }

    // Get connection statistics
    getConnectionStats() {
        return {
            totalConnections: this.connectedUsers.size,
            driverConnections: this.driverSockets.size,
            customerConnections: this.customerSockets.size,
            activeRooms: this.io.sockets.adapter.rooms.size,
            connectedUsers: Array.from(this.connectedUsers.entries()).map(([userId, info]) => ({
                userId,
                userType: info.userType,
                connectedAt: info.connectedAt,
                lastActivity: info.lastActivity
            }))
        };
    }
}

module.exports = EnhancedSocketService;
