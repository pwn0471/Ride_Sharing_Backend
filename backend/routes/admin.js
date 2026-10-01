const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Order = require('../models/Order');
const { authenticateToken } = require('../middleware/auth');
const { Logger } = require('../middleware/logger');

/**
 * @swagger
 * components:
 *   schemas:
 *     AdminDashboard:
 *       type: object
 *       properties:
 *         stats:
 *           type: object
 *           properties:
 *             totalOrders:
 *               type: number
 *             activeOrders:
 *               type: number
 *             completedOrders:
 *               type: number
 *             totalDrivers:
 *               type: number
 *             availableDrivers:
 *               type: number
 *             totalCustomers:
 *               type: number
 *         orders:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Order'
 *         drivers:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Driver'
 *         customers:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Customer'
 */

// Middleware to check if user is admin
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const user = await User.findById(req.user._id);
    if (!user || user.userType !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ message: 'Authentication error' });
  }
};

/**
 * @swagger
 * /api/admin/dashboard:
 *   get:
 *     summary: Get admin dashboard data
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Limit number of results
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, assigned, accepted, in_progress, completed, cancelled]
 *         description: Filter orders by status
 *     responses:
 *       200:
 *         description: Admin dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AdminDashboard'
 *       403:
 *         description: Admin access required
 */
router.get('/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit = 50, status } = req.query;
    const limitNum = parseInt(limit);

    // Build order filter
    const orderFilter = {};
    if (status) {
      orderFilter.status = status;
    }

    // Get statistics
    const [
      totalOrders,
      activeOrders,
      completedOrders,
      totalDrivers,
      availableDrivers,
      totalCustomers
    ] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: { $in: ['pending', 'assigned', 'accepted', 'in_progress'] } }),
      Order.countDocuments({ status: 'completed' }),
      User.countDocuments({ userType: 'driver' }),
      User.countDocuments({ userType: 'driver', 'driverDetails.isAvailable': true }),
      User.countDocuments({ userType: 'customer' })
    ]);

    // Get recent orders with customer and driver details
    const orders = await Order.find(orderFilter)
      .populate('customer', 'name email phone customerDetails')
      .populate('driver', 'name email phone driverDetails')
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .lean();

    // Get available drivers
    const drivers = await User.find({ 
      userType: 'driver',
      isActive: true 
    })
      .select('name email phone driverDetails createdAt updatedAt')
      .sort({ 'driverDetails.lastLocationUpdate': -1 })
      .limit(limitNum)
      .lean();

    // Get recent customers
    const customers = await User.find({ 
      userType: 'customer',
      isActive: true 
    })
      .select('name email phone customerDetails createdAt')
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .lean();

    // Add location info for drivers
    const driversWithLocation = drivers.map(driver => ({
      ...driver,
      isAvailable: driver.driverDetails?.isAvailable || false,
      lastLocationUpdate: driver.driverDetails?.lastLocationUpdate,
      rating: driver.driverDetails?.rating || 0,
      totalDeliveries: driver.driverDetails?.totalDeliveries || 0,
      vehicleInfo: {
        type: driver.driverDetails?.vehicleType,
        number: driver.driverDetails?.vehicleNumber
      }
    }));

    // Add order info for customers
    const customersWithStats = await Promise.all(
      customers.map(async (customer) => {
        const customerOrderCount = await Order.countDocuments({ customer: customer._id });
        return {
          ...customer,
          totalOrders: customerOrderCount,
          lastLocationUpdate: customer.customerDetails?.lastLocationUpdate
        };
      })
    );

    const dashboardData = {
      stats: {
        totalOrders,
        activeOrders,
        completedOrders,
        totalDrivers,
        availableDrivers,
        totalCustomers
      },
      orders: orders.map(order => ({
        ...order,
        customerInfo: {
          id: order.customer?._id,
          name: order.customer?.name,
          phone: order.customer?.phone,
          email: order.customer?.email
        },
        driverInfo: order.driver ? {
          id: order.driver._id,
          name: order.driver.name,
          phone: order.driver.phone,
          email: order.driver.email,
          rating: order.driver.driverDetails?.rating,
          vehicleNumber: order.driver.driverDetails?.vehicleNumber
        } : null
      })),
      drivers: driversWithLocation,
      customers: customersWithStats
    };

    Logger.info('Admin dashboard accessed', {
      adminId: req.user._id.toString(),
      ordersCount: orders.length,
      driversCount: drivers.length,
      customersCount: customers.length
    });

    res.json(dashboardData);

  } catch (error) {
    Logger.error('Admin dashboard error', error, {
      adminId: req.user._id?.toString()
    });
    console.error('Admin dashboard error:', error);
    res.status(500).json({
      message: 'Failed to fetch dashboard data',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/admin/orders:
 *   get:
 *     summary: Get detailed orders list for admin
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: customerId
 *         schema:
 *           type: string
 *       - in: query
 *         name: driverId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated orders list
 *       403:
 *         description: Admin access required
 */
router.get('/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, customerId, driverId } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (customerId) filter.customer = customerId;
    if (driverId) filter.driver = driverId;

    const [orders, totalCount] = await Promise.all([
      Order.find(filter)
        .populate('customer', 'name email phone customerDetails')
        .populate('driver', 'name email phone driverDetails')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });

  } catch (error) {
    Logger.error('Admin orders list error', error);
    res.status(500).json({
      message: 'Failed to fetch orders',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/admin/drivers:
 *   get:
 *     summary: Get drivers list for admin
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: available
 *         schema:
 *           type: boolean
 *         description: Filter by availability
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Drivers list
 *       403:
 *         description: Admin access required
 */
router.get('/drivers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { available, limit = 50 } = req.query;
    const limitNum = parseInt(limit);

    // Build filter
    const filter = { userType: 'driver' };
    if (available !== undefined) {
      filter['driverDetails.isAvailable'] = available === 'true';
    }

    const drivers = await User.find(filter)
      .select('name email phone driverDetails createdAt updatedAt')
      .sort({ 'driverDetails.lastLocationUpdate': -1 })
      .limit(limitNum)
      .lean();

    // Get current orders for each driver
    const driversWithOrders = await Promise.all(
      drivers.map(async (driver) => {
        const currentOrders = await Order.find({
          driver: driver._id,
          status: { $in: ['assigned', 'accepted', 'in_progress'] }
        }).select('orderId status pickupLocation dropoffLocation').lean();

        return {
          ...driver,
          currentOrders,
          isAvailable: driver.driverDetails?.isAvailable || false,
          location: driver.driverDetails?.currentLocation,
          lastLocationUpdate: driver.driverDetails?.lastLocationUpdate,
          rating: driver.driverDetails?.rating || 0,
          totalDeliveries: driver.driverDetails?.totalDeliveries || 0,
          vehicleInfo: {
            type: driver.driverDetails?.vehicleType,
            number: driver.driverDetails?.vehicleNumber,
            license: driver.driverDetails?.licenseNumber
          }
        };
      })
    );

    res.json({
      drivers: driversWithOrders,
      count: driversWithOrders.length
    });

  } catch (error) {
    Logger.error('Admin drivers list error', error);
    res.status(500).json({
      message: 'Failed to fetch drivers',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get system statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System statistics
 *       403:
 *         description: Admin access required
 */
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeek = new Date(now.setDate(now.getDate() - 7));
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      todayOrders,
      weekOrders,
      monthOrders,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      ordersByStatus
    ] = await Promise.all([
      Order.countDocuments({ createdAt: { $gte: today } }),
      Order.countDocuments({ createdAt: { $gte: thisWeek } }),
      Order.countDocuments({ createdAt: { $gte: thisMonth } }),
      
      // Revenue calculations
      Order.aggregate([
        { $match: { createdAt: { $gte: today }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$fare.totalFare' } } }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: thisWeek }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$fare.totalFare' } } }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: thisMonth }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$fare.totalFare' } } }
      ]),
      
      // Orders by status
      Order.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    const stats = {
      orders: {
        today: todayOrders,
        thisWeek: weekOrders,
        thisMonth: monthOrders
      },
      revenue: {
        today: todayRevenue[0]?.total || 0,
        thisWeek: weekRevenue[0]?.total || 0,
        thisMonth: monthRevenue[0]?.total || 0
      },
      ordersByStatus: ordersByStatus.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {})
    };

    res.json(stats);

  } catch (error) {
    Logger.error('Admin stats error', error);
    res.status(500).json({
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/admin/customers:
 *   get:
 *     summary: Get customers list
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Limit number of results
 *     responses:
 *       200:
 *         description: Customers list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 customers:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Customer'
 *       403:
 *         description: Admin access required
 */
router.get('/customers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const limitNum = parseInt(limit);

    const customers = await User.find(
      { userType: 'customer' },
      { password: 0, __v: 0 }
    )
    .sort({ createdAt: -1 })
    .limit(limitNum)
    .lean();

    // Get order counts for each customer
    const customerIds = customers.map(c => c._id);
    const orderCounts = await Order.aggregate([
      { $match: { customer: { $in: customerIds } } },
      { $group: { _id: '$customer', totalOrders: { $sum: 1 } } }
    ]);

    const orderCountMap = orderCounts.reduce((acc, item) => {
      acc[item._id.toString()] = item.totalOrders;
      return acc;
    }, {});

    // Add order count to each customer
    const customersWithOrderCount = customers.map(customer => ({
      ...customer,
      totalOrders: orderCountMap[customer._id.toString()] || 0
    }));

    res.json({
      customers: customersWithOrderCount,
      total: customersWithOrderCount.length
    });

  } catch (error) {
    Logger.error('Admin customers error', error);
    res.status(500).json({
      message: 'Failed to fetch customers',
      error: error.message
    });
  }
});

module.exports = router;
