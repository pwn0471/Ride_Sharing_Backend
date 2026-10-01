const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Order = require('../models/Order');
const User = require('../models/User');
const { authenticateToken, requireCustomer, requireDriver } = require('../middleware/auth');
const OrderAssignmentService = require('../services/orderAssignmentService');
const OrderCacheService = require('../services/orderCacheService');
const { calculateDistance, calculateEstimatedDuration, validateCoordinates } = require('../utils/geoUtils');
const { Logger } = require('../middleware/logger');
const { 
    ordersRateLimit, 
    conditionalMiddleware, 
    cacheControlMiddleware,
    deduplicationMiddleware,
    pollingOptimizationMiddleware 
} = require('../middleware/optimization');

// Initialize cache service (will be injected via app.js)
let orderCacheService;

// Middleware to inject cache service
const injectCacheService = (req, res, next) => {
    if (!orderCacheService && req.app.locals.orderCacheService) {
        orderCacheService = req.app.locals.orderCacheService;
    }
    next();
};

const router = express.Router();

/**
 * @swagger
 * /orders:
 *   post:
 *     summary: Create a new ride order
 *     description: Create a new ride booking order (customers only)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateOrderRequest'
 *     responses:
 *       201:
 *         description: Order created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Order created successfully"
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized or not a customer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Create new order (Customer only)
router.post('/', authenticateToken, requireCustomer, async (req, res) => {
  const orderCreationStartTime = Date.now();
  const ip = req.ip || req.connection.remoteAddress;
  
  try {
    const {
      pickupAddress,
      pickupLatitude,
      pickupLongitude,
      dropoffAddress,
      dropoffLatitude,
      dropoffLongitude,
      orderType,
      specialInstructions
    } = req.body;

    Logger.info('Order creation attempt started', {
      customerId: req.user.userId,
      customerEmail: req.user.email,
      orderType,
      pickupAddress,
      dropoffAddress,
      hasCoordinates: !!(pickupLatitude && pickupLongitude && dropoffLatitude && dropoffLongitude),
      ip,
      userAgent: req.get('user-agent')
    });

    // Validate required fields
    if (!pickupAddress || !dropoffAddress || !orderType) {
      Logger.warn('Order creation failed - missing required fields', {
        customerId: req.user.userId,
        ip,
        missingFields: {
          pickupAddress: !pickupAddress,
          dropoffAddress: !dropoffAddress,
          orderType: !orderType
        }
      });
      return res.status(400).json({
        message: 'Please provide pickup address, dropoff address, and order type'
      });
    }

    // Validate coordinates
    if (!validateCoordinates(pickupLatitude, pickupLongitude) ||
        !validateCoordinates(dropoffLatitude, dropoffLongitude)) {
      Logger.warn('Order creation failed - invalid coordinates', {
        customerId: req.user.userId,
        ip,
        coordinates: {
          pickup: { lat: pickupLatitude, lng: pickupLongitude },
          dropoff: { lat: dropoffLatitude, lng: dropoffLongitude }
        }
      });
      return res.status(400).json({
        message: 'Invalid coordinates provided'
      });
    }

    // Validate order type
    if (!['ride', 'delivery'].includes(orderType)) {
      return res.status(400).json({
        message: 'Invalid order type. Must be ride or delivery'
      });
    }

    // Calculate distance and duration
    const pickupLocation = { latitude: pickupLatitude, longitude: pickupLongitude };
    const dropoffLocation = { latitude: dropoffLatitude, longitude: dropoffLongitude };
    
    const distance = calculateDistance(pickupLocation, dropoffLocation);
    const estimatedDuration = calculateEstimatedDuration(distance);

    // Check minimum distance
    if (distance < 0.5) {
      return res.status(400).json({
        message: 'Minimum distance for orders is 0.5 km'
      });
    }

    // Generate unique order ID
    const orderId = `ORD-${Date.now()}-${uuidv4().substring(0, 8).toUpperCase()}`;

    // Create order
    const order = new Order({
      orderId,
      customer: req.user._id,
      pickupLocation: {
        address: pickupAddress,
        coordinates: {
          type: 'Point',
          coordinates: [pickupLongitude, pickupLatitude]
        }
      },
      dropoffLocation: {
        address: dropoffAddress,
        coordinates: {
          type: 'Point',
          coordinates: [dropoffLongitude, dropoffLatitude]
        }
      },
      orderType,
      estimatedDistance: distance,
      estimatedDuration: estimatedDuration,
      specialInstructions: specialInstructions || ''
    });

    // Calculate fare
    order.calculateFare();
    
    // Save order
    await order.save();

    // Start assignment process asynchronously
    const assignmentService = new OrderAssignmentService(req.io);
    assignmentService.assignOrder(orderId).catch(error => {
      console.error('Order assignment failed:', error);
      // You might want to implement a retry mechanism here
    });

    // Populate customer details for response
    await order.populate('customer', 'name phone');

    res.status(201).json({
      message: 'Order created successfully',
      order: {
        orderId: order.orderId,
        status: order.status,
        pickupAddress: order.pickupLocation.address,
        dropoffAddress: order.dropoffLocation.address,
        orderType: order.orderType,
        estimatedDistance: order.estimatedDistance,
        estimatedDuration: order.estimatedDuration,
        fare: order.fare,
        customer: order.customer,
        timestamps: order.timestamps
      }
    });

  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({
      message: 'Failed to create order',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: Get orders for the authenticated user (Optimized with caching and rate limiting)
 *     description: Retrieve orders with industry-standard optimizations including caching, rate limiting, and conditional requests
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 20
 *         description: Number of orders per page (max 50 for efficiency)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, assigned, in_progress, completed, cancelled]
 *         description: Filter by order status
 *       - in: header
 *         name: If-None-Match
 *         schema:
 *           type: string
 *         description: ETag for conditional requests
 *     responses:
 *       200:
 *         description: List of orders with optimization headers
 *         headers:
 *           X-Poll-Interval:
 *             description: Recommended polling interval in seconds
 *             schema:
 *               type: string
 *           X-Prefer-WebSocket:
 *             description: Recommendation to use WebSocket for real-time updates
 *             schema:
 *               type: string
 *           X-Max-Poll-Frequency:
 *             description: Maximum allowed polling frequency
 *             schema:
 *               type: string
 *           ETag:
 *             description: ETag for caching
 *             schema:
 *               type: string
 *           Cache-Control:
 *             description: Cache control directives
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orders:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Order'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     pages:
 *                       type: integer
 *                 performance:
 *                   type: object
 *                   properties:
 *                     fromCache:
 *                       type: boolean
 *                     queryTime:
 *                       type: number
 *                     recommendedPolling:
 *                       type: object
 *       304:
 *         description: Not Modified - cached version is still valid
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too Many Requests - rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 retryAfter:
 *                   type: integer
 *                 recommendation:
 *                   type: string
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get orders (OPTIMIZED VERSION with caching and rate limiting)
router.get('/', 
    authenticateToken,
    injectCacheService,
    ordersRateLimit, // Industry-standard rate limiting
    conditionalMiddleware, // ETag support for conditional requests
    cacheControlMiddleware, // Proper cache headers
    deduplicationMiddleware, // Request deduplication
    pollingOptimizationMiddleware, // Polling recommendations
    async (req, res) => {
        const startTime = Date.now();
        
        try {
            const { status, page = 1, limit = 20 } = req.query;
            const maxLimit = Math.min(parseInt(limit), 50); // Cap at 50 for performance
            const currentPage = Math.max(1, parseInt(page));
            const skip = (currentPage - 1) * maxLimit;

            // Try to get from cache first
            let cachedResult = null;
            if (orderCacheService) {
                cachedResult = await orderCacheService.getCachedOrders(
                    req.user.userId || req.user._id, 
                    req.user.userType, 
                    req.query
                );
            }

            if (cachedResult) {
                const queryTime = Date.now() - startTime;
                return res.json({
                    ...cachedResult,
                    performance: {
                        fromCache: true,
                        queryTime,
                        recommendedPolling: {
                            interval: req.user.userType === 'driver' ? 15 : 60, // seconds
                            maxFrequency: req.user.userType === 'driver' ? 20 : 10 // per minute
                        }
                    }
                });
            }

            // Build optimized query
            let query = {};
            let populateFields = '';

            if (req.user.userType === 'customer') {
                query.customer = req.user._id;
                populateFields = 'driver';
            } else if (req.user.userType === 'driver') {
                query.driver = req.user._id;
                populateFields = 'customer';
            }

            // Filter by status if provided
            if (status) {
                if (Array.isArray(status)) {
                    query.status = { $in: status };
                } else {
                    query.status = status;
                }
            }

            // Optimized database query with lean() for better performance
            const orders = await Order.find(query)
                .populate(populateFields, 'name phone')
                .select('-__v') // Exclude version field
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(maxLimit)
                .lean(); // Use lean() for better performance

            // Get total count efficiently
            const total = await Order.countDocuments(query);
            const totalPages = Math.ceil(total / maxLimit);

            // Format response optimized
            const result = {
                orders: orders.map(order => ({
                    orderId: order.orderId,
                    status: order.status,
                    pickupAddress: order.pickupLocation?.address,
                    dropoffAddress: order.dropoffLocation?.address,
                    orderType: order.orderType,
                    estimatedDistance: order.estimatedDistance,
                    estimatedDuration: order.estimatedDuration,
                    fare: order.fare,
                    customer: order.customer,
                    driver: order.driver,
                    timestamps: order.timestamps,
                    createdAt: order.createdAt
                })),
                pagination: {
                    page: currentPage,
                    limit: maxLimit,
                    total,
                    pages: totalPages,
                    hasNextPage: currentPage < totalPages,
                    hasPrevPage: currentPage > 1
                }
            };

            // Cache the result
            if (orderCacheService) {
                await orderCacheService.setCachedOrders(
                    req.user.userId || req.user._id, 
                    req.user.userType, 
                    req.query, 
                    result
                );
            }

            // Add performance metrics
            const queryTime = Date.now() - startTime;
            result.performance = {
                fromCache: false,
                queryTime,
                recommendedPolling: {
                    interval: req.user.userType === 'driver' ? 15 : 60,
                    maxFrequency: req.user.userType === 'driver' ? 20 : 10
                }
            };

            Logger.info('Orders retrieved', {
                userId: req.user.userId || req.user._id,
                userType: req.user.userType,
                ordersCount: orders.length,
                page: currentPage,
                queryTime,
                fromCache: false
            });

            res.json(result);
        } catch (error) {
            Logger.error('Get orders error', {
                error: error.message,
                userId: req.user.userId || req.user._id,
                userType: req.user.userType,
                queryTime: Date.now() - startTime
            });
            
            res.status(500).json({
                message: 'Failed to retrieve orders',
                error: error.message,
                performance: {
                    queryTime: Date.now() - startTime,
                    fromCache: false
                }
            });
        }
    });

/**
 * @swagger
 * /orders/{orderId}:
 *   get:
 *     summary: Get specific order by ID
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 *       404:
 *         description: Order not found
 */
// Get specific order by ID
router.get('/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId })
      .populate('customer', 'name phone')
      .populate('driver', 'name phone driverDetails.rating driverDetails.vehicleNumber driverDetails.vehicleType');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Check authorization
    const isCustomer = req.user.userType === 'customer' && order.customer._id.toString() === req.user._id.toString();
    const isDriver = req.user.userType === 'driver' && order.driver && order.driver._id.toString() === req.user._id.toString();

    if (!isCustomer && !isDriver) {
      return res.status(403).json({
        message: 'Access denied'
      });
    }

    res.json({ order });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      message: 'Failed to retrieve order',
      error: error.message
    });
  }
});

// Accept order (Driver only)
router.put('/:orderId/accept', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const driverId = req.user._id.toString();

    const assignmentService = new OrderAssignmentService(req.io);
    const result = await assignmentService.handleDriverResponse(orderId, driverId, 'accept');

    res.json(result);

  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({
      message: 'Failed to accept order',
      error: error.message
    });
  }
});

// Decline order (Driver only)
router.put('/:orderId/decline', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const driverId = req.user._id.toString();

    const assignmentService = new OrderAssignmentService(req.io);
    const result = await assignmentService.handleDriverResponse(orderId, driverId, 'decline');

    res.json(result);

  } catch (error) {
    console.error('Decline order error:', error);
    res.status(500).json({
      message: 'Failed to decline order',
      error: error.message
    });
  }
});

// Update order status (Driver only)
router.put('/:orderId/status', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['pickup_started', 'picked_up', 'in_transit', 'delivered'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const order = await Order.findOne({ orderId }).populate('customer');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Check if driver is assigned to this order
    if (!order.driver || order.driver.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: 'You are not assigned to this order'
      });
    }

    // Check if status transition is valid
    const statusFlow = {
      'accepted': ['pickup_started'],
      'pickup_started': ['picked_up'],
      'picked_up': ['in_transit'],
      'in_transit': ['delivered']
    };

    if (!statusFlow[order.status] || !statusFlow[order.status].includes(status)) {
      return res.status(400).json({
        message: `Cannot change status from ${order.status} to ${status}`
      });
    }

    // Update status
    const statusUpdate = order.updateStatus(status);
    await order.save();

    // If order is delivered, make driver available again
    if (status === 'delivered') {
      await User.findByIdAndUpdate(req.user._id, {
        'driverDetails.isAvailable': true,
        $inc: { 'driverDetails.totalDeliveries': 1 }
      });
    }

    // Send real-time update to customer
    req.io.to(`customer:${order.customer._id}`).emit('order_status_update', {
      orderId: order.orderId,
      status: order.status,
      timestamp: new Date()
    });

    res.json({
      message: `Order status updated to ${status}`,
      order: {
        orderId: order.orderId,
        status: order.status,
        timestamps: order.timestamps
      }
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      message: 'Failed to update order status',
      error: error.message
    });
  }
});

// Cancel order (Customer only, with conditions)
router.put('/:orderId/cancel', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findOne({ orderId }).populate('driver');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Check if customer owns this order
    if (order.customer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: 'You can only cancel your own orders'
      });
    }

    // Check if order can be cancelled
    const nonCancellableStatuses = ['delivered', 'cancelled'];
    if (nonCancellableStatuses.includes(order.status)) {
      return res.status(400).json({
        message: 'Order cannot be cancelled in its current status'
      });
    }

    // Check if order is in progress (picked up or in transit)
    const inProgressStatuses = ['picked_up', 'in_transit'];
    if (inProgressStatuses.includes(order.status)) {
      return res.status(400).json({
        message: 'Order cannot be cancelled as it is already in progress'
      });
    }

    // Update order status
    order.updateStatus('cancelled');
    if (reason) {
      order.specialInstructions = `${order.specialInstructions ? order.specialInstructions + ' | ' : ''}Cancellation reason: ${reason}`;
    }
    await order.save();

    // If driver was assigned, make them available again and notify
    if (order.driver) {
      await User.findByIdAndUpdate(order.driver._id, {
        'driverDetails.isAvailable': true
      });

      // Notify driver about cancellation
      req.io.to(`driver:${order.driver._id}`).emit('order_cancelled', {
        orderId: order.orderId,
        message: 'Order has been cancelled by the customer',
        reason: reason
      });
    }

    res.json({
      message: 'Order cancelled successfully',
      order: {
        orderId: order.orderId,
        status: order.status,
        timestamps: order.timestamps
      }
    });

  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      message: 'Failed to cancel order',
      error: error.message
    });
  }
});

// Get order tracking info
router.get('/:orderId/tracking', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId })
      .populate('customer', 'name phone')
      .populate('driver', 'name phone driverDetails.rating driverDetails.vehicleNumber driverDetails.vehicleType driverDetails.currentLocation');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Check authorization
    const isCustomer = req.user.userType === 'customer' && order.customer._id.toString() === req.user._id.toString();
    const isDriver = req.user.userType === 'driver' && order.driver && order.driver._id.toString() === req.user._id.toString();

    if (!isCustomer && !isDriver) {
      return res.status(403).json({
        message: 'Access denied'
      });
    }

    const trackingInfo = {
      orderId: order.orderId,
      status: order.status,
      pickupLocation: order.pickupLocation,
      dropoffLocation: order.dropoffLocation,
      timestamps: order.timestamps,
      customer: order.customer,
      driver: order.driver,
      estimatedDistance: order.estimatedDistance,
      estimatedDuration: order.estimatedDuration
    };

    // Add driver location if order is accepted and driver is available
    if (order.driver && order.driver.driverDetails.currentLocation) {
      trackingInfo.driverCurrentLocation = {
        latitude: order.driver.driverDetails.currentLocation.coordinates[1],
        longitude: order.driver.driverDetails.currentLocation.coordinates[0],
        lastUpdate: order.driver.driverDetails.lastLocationUpdate
      };
    }

    res.json({ tracking: trackingInfo });

  } catch (error) {
    console.error('Get tracking error:', error);
    res.status(500).json({
      message: 'Failed to retrieve tracking information',
      error: error.message
    });
  }
});

module.exports = router;
