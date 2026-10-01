const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const { authenticateToken, requireDriver } = require('../middleware/auth');
const { validateCoordinates, calculateDistance } = require('../utils/geoUtils');
const { Logger } = require('../middleware/logger');

const router = express.Router();

/**
 * @swagger
 * /drivers/nearby:
 *   get:
 *     summary: Get nearby drivers
 *     description: Find available drivers within a specified radius
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: latitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Latitude coordinate
 *       - in: query
 *         name: longitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Longitude coordinate  
 *       - in: query
 *         name: radius
 *         schema:
 *           type: number
 *           default: 5
 *         description: Search radius in kilometers
 *     responses:
 *       200:
 *         description: Nearby drivers found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 drivers:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/User'
 *                       - type: object
 *                         properties:
 *                           distanceKm:
 *                             type: number
 *                             example: 2.5
 *                 total:
 *                   type: integer
 *                   example: 5
 *                 searchRadius:
 *                   type: number
 *                   example: 5
 *       400:
 *         description: Invalid coordinates
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
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

// Get nearby drivers (for admin/debugging purposes)
router.get('/nearby', authenticateToken, async (req, res) => {
  try {
    const { latitude, longitude, radius = 5 } = req.query;

    if (!validateCoordinates(parseFloat(latitude), parseFloat(longitude))) {
      return res.status(400).json({
        message: 'Invalid coordinates provided'
      });
    }

    const drivers = await User.find({
      userType: 'driver',
      isActive: true,
      'driverDetails.isAvailable': true,
      'driverDetails.currentLocation': {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(longitude), parseFloat(latitude)]
          },
          $maxDistance: radius * 1000 // Convert km to meters
        }
      }
    }).select('name phone driverDetails');

    // Calculate distance for each driver
    const driversWithDistance = drivers.map(driver => {
      const driverLocation = {
        latitude: driver.driverDetails.currentLocation.coordinates[1],
        longitude: driver.driverDetails.currentLocation.coordinates[0]
      };
      
      const distance = calculateDistance(
        { latitude: parseFloat(latitude), longitude: parseFloat(longitude) },
        driverLocation
      );

      return {
        ...driver.toObject(),
        distanceKm: distance
      };
    }).sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({
      drivers: driversWithDistance,
      total: driversWithDistance.length,
      searchRadius: radius
    });

  } catch (error) {
    console.error('Get nearby drivers error:', error);
    res.status(500).json({
      message: 'Failed to find nearby drivers',
      error: error.message
    });
  }
});

// Update driver location (Driver only)
router.put('/location', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    if (!validateCoordinates(latitude, longitude)) {
      return res.status(400).json({
        message: 'Invalid coordinates provided'
      });
    }

    // Update driver location
    await User.findByIdAndUpdate(req.user._id, {
      'driverDetails.currentLocation.coordinates': [longitude, latitude],
      'driverDetails.lastLocationUpdate': new Date()
    });

    // Emit location update to connected clients if needed
    req.io.emit('driver_location_update', {
      driverId: req.user._id,
      location: { latitude, longitude },
      timestamp: new Date()
    });

    res.json({
      message: 'Location updated successfully',
      location: { latitude, longitude },
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({
      message: 'Failed to update location',
      error: error.message
    });
  }
});

// Update driver availability status (Driver only)
router.put('/status', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { isAvailable } = req.body;

    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({
        message: 'isAvailable must be a boolean value'
      });
    }

    // Check if driver has any active orders
    if (isAvailable) {
      const activeOrders = await Order.countDocuments({
        driver: req.user._id,
        status: { $nin: ['delivered', 'cancelled'] }
      });

      if (activeOrders > 0) {
        return res.status(400).json({
          message: 'Cannot set availability to true while having active orders'
        });
      }
    }

    // Update driver availability
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { 'driverDetails.isAvailable': isAvailable },
      { new: true }
    ).select('-password');

    res.json({
      message: `Driver status updated to ${isAvailable ? 'available' : 'unavailable'}`,
      isAvailable: updatedUser.driverDetails.isAvailable,
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({
      message: 'Failed to update status',
      error: error.message
    });
  }
});

// Get driver stats (Driver only)
router.get('/stats', authenticateToken, requireDriver, async (req, res) => {
  try {
    const driverId = req.user._id;

    // Get driver info
    const driver = await User.findById(driverId).select('driverDetails');

    // Get order statistics
    const totalOrders = await Order.countDocuments({ driver: driverId });
    const completedOrders = await Order.countDocuments({ 
      driver: driverId, 
      status: 'delivered' 
    });
    const cancelledOrders = await Order.countDocuments({ 
      driver: driverId, 
      status: 'cancelled' 
    });
    const activeOrders = await Order.countDocuments({ 
      driver: driverId, 
      status: { $nin: ['delivered', 'cancelled'] } 
    });

    // Calculate completion rate
    const completionRate = totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(2) : 0;

    // Get earnings (simplified calculation)
    const completedOrdersList = await Order.find({
      driver: driverId,
      status: 'delivered'
    }).select('fare');

    const totalEarnings = completedOrdersList.reduce((sum, order) => {
      return sum + (order.fare?.totalFare || 0);
    }, 0);

    // Get recent orders
    const recentOrders = await Order.find({ driver: driverId })
      .populate('customer', 'name')
      .sort({ createdAt: -1 })
      .limit(10)
      .select('orderId status pickupLocation dropoffLocation fare timestamps');

    res.json({
      stats: {
        totalOrders,
        completedOrders,
        cancelledOrders,
        activeOrders,
        completionRate: parseFloat(completionRate),
        totalEarnings: totalEarnings.toFixed(2),
        rating: driver.driverDetails.rating,
        totalDeliveries: driver.driverDetails.totalDeliveries,
        isAvailable: driver.driverDetails.isAvailable,
        lastLocationUpdate: driver.driverDetails.lastLocationUpdate
      },
      recentOrders: recentOrders.map(order => ({
        orderId: order.orderId,
        status: order.status,
        pickupAddress: order.pickupLocation.address,
        dropoffAddress: order.dropoffLocation.address,
        customerName: order.customer?.name,
        fare: order.fare?.totalFare,
        createdAt: order.createdAt,
        completedAt: order.timestamps.delivered
      }))
    });

  } catch (error) {
    console.error('Get driver stats error:', error);
    res.status(500).json({
      message: 'Failed to retrieve driver statistics',
      error: error.message
    });
  }
});

// Get driver earnings by date range (Driver only)
router.get('/earnings', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    const driverId = req.user._id;

    let matchQuery = {
      driver: driverId,
      status: 'delivered'
    };

    // Add date filter if provided
    if (startDate || endDate) {
      matchQuery['timestamps.delivered'] = {};
      if (startDate) {
        matchQuery['timestamps.delivered']['$gte'] = new Date(startDate);
      }
      if (endDate) {
        matchQuery['timestamps.delivered']['$lte'] = new Date(endDate);
      }
    }

    // Define grouping format based on groupBy parameter
    let dateFormat;
    switch (groupBy) {
      case 'hour':
        dateFormat = {
          year: { $year: '$timestamps.delivered' },
          month: { $month: '$timestamps.delivered' },
          day: { $dayOfMonth: '$timestamps.delivered' },
          hour: { $hour: '$timestamps.delivered' }
        };
        break;
      case 'month':
        dateFormat = {
          year: { $year: '$timestamps.delivered' },
          month: { $month: '$timestamps.delivered' }
        };
        break;
      case 'year':
        dateFormat = {
          year: { $year: '$timestamps.delivered' }
        };
        break;
      default: // day
        dateFormat = {
          year: { $year: '$timestamps.delivered' },
          month: { $month: '$timestamps.delivered' },
          day: { $dayOfMonth: '$timestamps.delivered' }
        };
    }

    const earnings = await Order.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: dateFormat,
          totalEarnings: { $sum: '$fare.totalFare' },
          orderCount: { $sum: 1 },
          avgOrderValue: { $avg: '$fare.totalFare' }
        }
      },
      { $sort: { '_id': 1 } }
    ]);

    // Calculate totals
    const totals = earnings.reduce(
      (acc, item) => ({
        totalEarnings: acc.totalEarnings + item.totalEarnings,
        totalOrders: acc.totalOrders + item.orderCount
      }),
      { totalEarnings: 0, totalOrders: 0 }
    );

    res.json({
      earnings: earnings.map(item => ({
        date: item._id,
        earnings: parseFloat(item.totalEarnings.toFixed(2)),
        orders: item.orderCount,
        avgOrderValue: parseFloat(item.avgOrderValue.toFixed(2))
      })),
      summary: {
        totalEarnings: parseFloat(totals.totalEarnings.toFixed(2)),
        totalOrders: totals.totalOrders,
        avgOrderValue: totals.totalOrders > 0 ? 
          parseFloat((totals.totalEarnings / totals.totalOrders).toFixed(2)) : 0
      },
      groupBy
    });

  } catch (error) {
    console.error('Get driver earnings error:', error);
    res.status(500).json({
      message: 'Failed to retrieve driver earnings',
      error: error.message
    });
  }
});

// Get all drivers (Admin endpoint - you might want to add admin auth)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      isAvailable, 
      vehicleType,
      minRating 
    } = req.query;

    const skip = (page - 1) * limit;
    let query = { userType: 'driver', isActive: true };

    // Apply filters
    if (isAvailable !== undefined) {
      query['driverDetails.isAvailable'] = isAvailable === 'true';
    }

    if (vehicleType) {
      query['driverDetails.vehicleType'] = vehicleType;
    }

    if (minRating) {
      query['driverDetails.rating'] = { $gte: parseFloat(minRating) };
    }

    const drivers = await User.find(query)
      .select('-password')
      .sort({ 'driverDetails.rating': -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);

    res.json({
      drivers: drivers.map(driver => ({
        id: driver._id,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        vehicleType: driver.driverDetails.vehicleType,
        vehicleNumber: driver.driverDetails.vehicleNumber,
        rating: driver.driverDetails.rating,
        totalDeliveries: driver.driverDetails.totalDeliveries,
        isAvailable: driver.driverDetails.isAvailable,
        lastLocationUpdate: driver.driverDetails.lastLocationUpdate,
        joinedAt: driver.createdAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get drivers error:', error);
    res.status(500).json({
      message: 'Failed to retrieve drivers',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /drivers/orders:
 *   get:
 *     summary: Get driver's orders
 *     description: Retrieve orders assigned to the authenticated driver
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of orders per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [assigned, accepted, in-progress, completed, cancelled]
 *         description: Filter orders by status
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
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
 *       401:
 *         description: Unauthorized or not a driver
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
// Get driver orders (Driver only)
router.get('/orders', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (page - 1) * limit;
    const driverId = req.user._id;

    let query = { driver: driverId };
    
    if (status) {
      query.status = status;
    }

    const orders = await Order.find(query)
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    Logger.info('Driver orders fetched', {
      driverId: driverId.toString(),
      ordersCount: orders.length,
      status: status || 'all',
      page: parseInt(page)
    });

    res.json({
      orders: orders.map(order => ({
        _id: order._id,
        orderId: order.orderId,
        status: order.status,
        pickupLocation: order.pickupLocation?.address || order.pickupLocation,
        destination: order.dropoffLocation?.address || order.dropoffLocation,
        vehicleType: order.vehicleType,
        estimatedPrice: order.estimatedPrice,
        fare: order.fare?.totalFare,
        distance: order.distance,
        customer: order.customer,
        notes: order.notes,
        createdAt: order.createdAt,
        timestamps: order.timestamps
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    Logger.error('Get driver orders error', error, {
      driverId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Get driver orders error:', error);
    res.status(500).json({
      message: 'Failed to retrieve orders',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /drivers/nearby-orders:
 *   get:
 *     summary: Get nearby available orders
 *     description: Get pending orders near the driver's location that can be picked up
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: latitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Driver's current latitude
 *       - in: query
 *         name: longitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Driver's current longitude
 *       - in: query
 *         name: radius
 *         schema:
 *           type: number
 *           default: 10
 *         description: Search radius in kilometers
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *           default: 20
 *         description: Maximum number of orders to return
 *     responses:
 *       200:
 *         description: Nearby available orders
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orders:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Order'
 *                 count:
 *                   type: number
 *                 radius:
 *                   type: number
 */
// Get nearby available orders (Driver only)
router.get('/nearby-orders', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { latitude, longitude, radius = 10, limit = 20 } = req.query;
    const driverId = req.user._id;

    // Validate coordinates
    if (!latitude || !longitude) {
      return res.status(400).json({
        message: 'Latitude and longitude are required'
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (!validateCoordinates(lat, lng)) {
      return res.status(400).json({
        message: 'Invalid coordinates provided'
      });
    }

    // Find pending orders (not assigned to any driver) within radius
    const query = {
      status: 'pending', // Only pending orders
      $or: [
        { driver: { $exists: false } }, // Field doesn't exist
        { driver: null }                 // Field exists but is null
      ],
      'pickupLocation.coordinates': {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lng, lat]
          },
          $maxDistance: radius * 1000 // Convert km to meters
        }
      }
    };

    const orders = await Order.find(query)
      .populate('customer', 'name phone rating')
      .sort({ createdAt: -1 }) // Newest first
      .limit(parseInt(limit));

    // Calculate distances and add to response
    const ordersWithDistance = orders.map(order => {
      const pickupCoords = order.pickupLocation.coordinates;
      const distance = calculateDistance(lat, lng, pickupCoords[1], pickupCoords[0]);
      
      return {
        _id: order._id,
        orderId: order.orderId,
        status: order.status,
        pickupLocation: {
          address: order.pickupLocation.address,
          coordinates: order.pickupLocation.coordinates
        },
        dropoffLocation: {
          address: order.dropoffLocation.address,
          coordinates: order.dropoffLocation.coordinates
        },
        orderType: order.orderType,
        estimatedDistance: order.estimatedDistance,
        estimatedDuration: order.estimatedDuration,
        fare: order.fare,
        customer: order.customer,
        createdAt: order.createdAt,
        distanceFromDriver: Math.round(distance * 100) / 100, // Round to 2 decimals
        priority: order.priority || 'normal'
      };
    });

    // Update driver's last seen location
    await User.findByIdAndUpdate(driverId, {
      'driverDetails.currentLocation.coordinates': [lng, lat],
      'driverDetails.lastLocationUpdate': new Date()
    });

    Logger.info('Nearby orders fetched', {
      driverId: driverId.toString(),
      latitude: lat,
      longitude: lng,
      radius: radius,
      ordersFound: orders.length,
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    res.json({
      orders: ordersWithDistance,
      count: orders.length,
      radius: parseFloat(radius),
      driverLocation: { latitude: lat, longitude: lng },
      message: orders.length === 0 ? 'No orders available in your area' : undefined
    });

  } catch (error) {
    Logger.error('Get nearby orders error', error, {
      driverId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Get nearby orders error:', error);
    res.status(500).json({
      message: 'Failed to retrieve nearby orders',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /drivers/availability:
 *   put:
 *     summary: Update driver availability
 *     description: Toggle driver online/offline status
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isAvailable
 *             properties:
 *               isAvailable:
 *                 type: boolean
 *                 description: Driver availability status
 *                 example: true
 *     responses:
 *       200:
 *         description: Availability updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Driver availability updated to online"
 *                 isAvailable:
 *                   type: boolean
 *                   example: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid request - isAvailable must be boolean
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized or not a driver
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
// Update driver availability (Driver only)
router.put('/availability', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { isAvailable } = req.body;
    const driverId = req.user._id;

    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({
        message: 'isAvailable must be a boolean value'
      });
    }

    await User.findByIdAndUpdate(driverId, {
      'driverDetails.isAvailable': isAvailable,
      'driverDetails.lastAvailabilityUpdate': new Date()
    });

    Logger.info('Driver availability updated', {
      driverId: driverId.toString(),
      isAvailable,
      timestamp: new Date()
    });

    // Emit availability update to connected clients
    req.io.emit('driver_availability_update', {
      driverId: driverId,
      isAvailable,
      timestamp: new Date()
    });

    res.json({
      message: `Driver availability updated to ${isAvailable ? 'online' : 'offline'}`,
      isAvailable,
      timestamp: new Date()
    });

  } catch (error) {
    Logger.error('Update driver availability error', error, {
      driverId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Update availability error:', error);
    res.status(500).json({
      message: 'Failed to update availability',
      error: error.message
    });
  }
});

// Accept order (Driver only)
router.put('/orders/:orderId/accept', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const driverId = req.user._id;

    const order = await Order.findOne({ 
      _id: orderId,
      driver: driverId,
      status: 'assigned'
    }).populate('customer', 'name phone');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or not assigned to you'
      });
    }

    order.status = 'accepted';
    order.timestamps.accepted = new Date();
    await order.save();

    Logger.info('Order accepted by driver', {
      orderId: order.orderId,
      driverId: driverId.toString(),
      customerId: order.customer?._id?.toString()
    });

    // Emit order update to customer
    req.io.emit('order_update', {
      orderId: order.orderId,
      status: 'accepted',
      driverId: driverId,
      timestamp: new Date()
    });

    res.json({
      message: 'Order accepted successfully',
      order: {
        orderId: order.orderId,
        status: order.status,
        customer: order.customer
      }
    });

  } catch (error) {
    Logger.error('Accept order error', error, {
      orderId: req.params.orderId,
      driverId: req.user._id.toString()
    });
    console.error('Accept order error:', error);
    res.status(500).json({
      message: 'Failed to accept order',
      error: error.message
    });
  }
});

// Reject order (Driver only)
router.put('/orders/:orderId/reject', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const driverId = req.user._id;

    const order = await Order.findOne({ 
      _id: orderId,
      driver: driverId,
      status: 'assigned'
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or not assigned to you'
      });
    }

    // Reset order to pending and remove driver assignment
    order.status = 'pending';
    order.driver = null;
    order.timestamps.rejected = new Date();
    await order.save();

    Logger.info('Order rejected by driver', {
      orderId: order.orderId,
      driverId: driverId.toString(),
      customerId: order.customer?.toString()
    });

    // Emit order update
    req.io.emit('order_update', {
      orderId: order.orderId,
      status: 'pending',
      message: 'Driver rejected order, finding new driver',
      timestamp: new Date()
    });

    res.json({
      message: 'Order rejected successfully'
    });

  } catch (error) {
    Logger.error('Reject order error', error, {
      orderId: req.params.orderId,
      driverId: req.user._id.toString()
    });
    console.error('Reject order error:', error);
    res.status(500).json({
      message: 'Failed to reject order',
      error: error.message
    });
  }
});

// Start ride (Driver only)
router.put('/orders/:orderId/start', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const driverId = req.user._id;

    const order = await Order.findOne({ 
      _id: orderId,
      driver: driverId,
      status: 'accepted'
    }).populate('customer', 'name phone');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or not in accepted state'
      });
    }

    order.status = 'in-progress';
    order.timestamps.started = new Date();
    await order.save();

    Logger.info('Ride started by driver', {
      orderId: order.orderId,
      driverId: driverId.toString(),
      customerId: order.customer?._id?.toString()
    });

    // Emit order update to customer
    req.io.emit('order_update', {
      orderId: order.orderId,
      status: 'in-progress',
      message: 'Ride has started',
      timestamp: new Date()
    });

    res.json({
      message: 'Ride started successfully',
      order: {
        orderId: order.orderId,
        status: order.status,
        startTime: order.timestamps.started
      }
    });

  } catch (error) {
    Logger.error('Start ride error', error, {
      orderId: req.params.orderId,
      driverId: req.user._id.toString()
    });
    console.error('Start ride error:', error);
    res.status(500).json({
      message: 'Failed to start ride',
      error: error.message
    });
  }
});

// Complete ride (Driver only)
router.put('/orders/:orderId/complete', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fare } = req.body;
    const driverId = req.user._id;

    const order = await Order.findOne({ 
      _id: orderId,
      driver: driverId,
      status: 'in-progress'
    }).populate('customer', 'name phone');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or not in progress'
      });
    }

    order.status = 'completed';
    order.timestamps.completed = new Date();
    
    // Set fare if provided
    if (fare && typeof fare === 'number' && fare > 0) {
      order.fare = {
        baseFare: fare * 0.8,
        taxes: fare * 0.2,
        totalFare: fare
      };
    }

    await order.save();

    // Update driver stats
    await User.findByIdAndUpdate(driverId, {
      $inc: { 'driverDetails.totalDeliveries': 1 }
    });

    Logger.info('Ride completed by driver', {
      orderId: order.orderId,
      driverId: driverId.toString(),
      customerId: order.customer?._id?.toString(),
      fare: order.fare?.totalFare
    });

    // Emit order update to customer
    req.io.emit('order_update', {
      orderId: order.orderId,
      status: 'completed',
      message: 'Ride completed successfully',
      fare: order.fare,
      timestamp: new Date()
    });

    res.json({
      message: 'Ride completed successfully',
      order: {
        orderId: order.orderId,
        status: order.status,
        completedTime: order.timestamps.completed,
        fare: order.fare
      }
    });

  } catch (error) {
    Logger.error('Complete ride error', error, {
      orderId: req.params.orderId,
      driverId: req.user._id.toString()
    });
    console.error('Complete ride error:', error);
    res.status(500).json({
      message: 'Failed to complete ride',
      error: error.message
    });
  }
});

// Request to accept any available order (Manual Assignment)
router.put('/orders/:orderId/request', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const driverId = req.user._id;

    // Find the order and check if it's available
    const order = await Order.findOne({ 
      _id: orderId,
      $or: [
        { driver: { $exists: false } },
        { driver: null }
      ],
      status: 'pending'
    }).populate('customer', 'name phone');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or no longer available'
      });
    }

    // Assign the order to this driver
    order.driver = driverId;
    order.status = 'accepted';
    order.timestamps.accepted = new Date();
    await order.save();

    // Update driver availability
    await User.findByIdAndUpdate(driverId, {
      'driverDetails.isAvailable': false
    });

    Logger.info('Order manually assigned to driver', {
      orderId: order.orderId,
      driverId: driverId.toString(),
      customerId: order.customer?._id?.toString()
    });

    // Emit order update to customer
    req.io.emit('order_update', {
      orderId: order.orderId,
      status: 'accepted',
      driverId: driverId,
      timestamp: new Date()
    });

    res.json({
      message: 'Order assigned successfully',
      order: {
        orderId: order.orderId,
        status: order.status,
        customer: order.customer,
        pickupAddress: order.pickupLocation.address,
        dropoffAddress: order.dropoffLocation.address,
        fare: order.fare
      }
    });

  } catch (error) {
    Logger.error('Manual order assignment error', error, {
      orderId: req.params.orderId,
      driverId: req.user._id.toString()
    });
    console.error('Manual order assignment error:', error);
    res.status(500).json({
      message: 'Failed to assign order',
      error: error.message
    });
  }
});

module.exports = router;
