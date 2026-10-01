const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const { authenticateToken, requireCustomer } = require('../middleware/auth');
const { validateCoordinates, calculateDistance } = require('../utils/geoUtils');
const { Logger } = require('../middleware/logger');

const router = express.Router();

/**
 * @swagger
 * /customers/location:
 *   put:
 *     summary: Update customer location
 *     description: Update customer's current location for better service
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - latitude
 *               - longitude
 *             properties:
 *               latitude:
 *                 type: number
 *                 description: Latitude coordinate
 *                 example: 37.7749
 *               longitude:
 *                 type: number
 *                 description: Longitude coordinate
 *                 example: -122.4194
 *     responses:
 *       200:
 *         description: Location updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 location:
 *                   type: object
 *                   properties:
 *                     latitude:
 *                       type: number
 *                     longitude:
 *                       type: number
 *                 lastUpdate:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid coordinates
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Customer access required
 */
// Update customer location (Customer only)
router.put('/location', authenticateToken, requireCustomer, async (req, res) => {
  try {
    let latitude, longitude;
    
    // Support multiple coordinate formats
    if (req.body.latitude && req.body.longitude) {
      // Format: { latitude: 37.7749, longitude: -122.4194 }
      latitude = req.body.latitude;
      longitude = req.body.longitude;
    } else if (req.body.location && req.body.location.coordinates) {
      // Format: { location: { coordinates: [lng, lat] } }
      const coords = req.body.location.coordinates;
      if (Array.isArray(coords) && coords.length >= 2) {
        longitude = coords[0];
        latitude = coords[1];
      }
    } else if (req.body.coordinates && Array.isArray(req.body.coordinates)) {
      // Format: { coordinates: [lng, lat] }
      longitude = req.body.coordinates[0];
      latitude = req.body.coordinates[1];
    }

    const customerId = req.user._id;

    if (!latitude || !longitude || !validateCoordinates(latitude, longitude)) {
      return res.status(400).json({
        message: 'Invalid coordinates provided. Send either {latitude, longitude} or {location: {coordinates: [lng, lat]}} or {coordinates: [lng, lat]}',
        received: req.body
      });
    }

    // Update customer location in customerDetails
    const updatedUser = await User.findByIdAndUpdate(
      customerId,
      {
        'customerDetails.currentLocation.coordinates': [longitude, latitude],
        'customerDetails.lastLocationUpdate': new Date()
      },
      { new: true, upsert: true }
    );

    // Emit location update to connected clients for real-time tracking
    if (req.io) {
      req.io.emit('customer_location_update', {
        customerId: customerId.toString(),
        location: { latitude, longitude },
        timestamp: new Date()
      });
    }

    Logger.info('Customer location updated', {
      customerId: customerId.toString(),
      latitude,
      longitude,
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    res.json({
      message: 'Location updated successfully',
      location: { latitude, longitude },
      lastUpdate: updatedUser.customerDetails?.lastLocationUpdate || new Date()
    });

  } catch (error) {
    Logger.error('Update customer location error', error, {
      customerId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Update customer location error:', error);
    res.status(500).json({
      message: 'Failed to update location',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /customers/location:
 *   get:
 *     summary: Get customer location
 *     description: Get customer's current location
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Customer location retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 location:
 *                   type: object
 *                   properties:
 *                     latitude:
 *                       type: number
 *                     longitude:
 *                       type: number
 *                 lastUpdate:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Customer access required
 *       404:
 *         description: Location not found
 */
// Get customer location (Customer only)
router.get('/location', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user._id;
    
    const user = await User.findById(customerId).select('customerDetails');
    
    if (!user?.customerDetails?.currentLocation) {
      return res.status(404).json({
        message: 'Location not found. Please update your location first.'
      });
    }

    const coordinates = user.customerDetails.currentLocation.coordinates;
    const location = {
      latitude: coordinates[1],
      longitude: coordinates[0]
    };

    Logger.info('Customer location fetched', {
      customerId: customerId.toString(),
      hasLocation: !!user.customerDetails.currentLocation,
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    res.json({
      location,
      lastUpdate: user.customerDetails.lastLocationUpdate || null
    });

  } catch (error) {
    Logger.error('Get customer location error', error, {
      customerId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Get customer location error:', error);
    res.status(500).json({
      message: 'Failed to retrieve location',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /customers/profile:
 *   get:
 *     summary: Get customer profile
 *     description: Get customer's profile information including location data
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Customer profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Customer access required
 *       404:
 *         description: User not found
 */
// Get customer profile (Customer only)
router.get('/profile', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    
    if (!user) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    // Add location info if available
    let locationInfo = null;
    if (user.customerDetails?.currentLocation) {
      const coordinates = user.customerDetails.currentLocation.coordinates;
      locationInfo = {
        latitude: coordinates[1],
        longitude: coordinates[0],
        lastUpdate: user.customerDetails.lastLocationUpdate
      };
    }

    Logger.info('Customer profile fetched', {
      customerId: user._id.toString(),
      hasLocation: !!locationInfo,
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    res.json({
      user: {
        ...user.toObject(),
        currentLocation: locationInfo
      }
    });

  } catch (error) {
    Logger.error('Get customer profile error', error, {
      customerId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Customer profile fetch error:', error);
    res.status(500).json({
      message: 'Failed to fetch profile',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /customers/nearby-drivers:
 *   get:
 *     summary: Get nearby available drivers
 *     description: Get available drivers near the customer's location
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: latitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Customer's current latitude
 *       - in: query
 *         name: longitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Customer's current longitude
 *       - in: query
 *         name: radius
 *         schema:
 *           type: number
 *           default: 5
 *         description: Search radius in kilometers
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *           default: 10
 *         description: Maximum number of drivers to return
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
 *                     $ref: '#/components/schemas/User'
 *                 count:
 *                   type: number
 *                 radius:
 *                   type: number
 */
// Get nearby available drivers (Customer only)
router.get('/nearby-drivers', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const { latitude, longitude, radius = 5, limit = 10 } = req.query;
    const customerId = req.user._id;

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

    // Find available drivers within radius
    const drivers = await User.find({
      userType: 'driver',
      'driverDetails.isAvailable': true,
      'driverDetails.currentLocation': {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lng, lat]
          },
          $maxDistance: radius * 1000 // Convert km to meters
        }
      }
    })
    .select('name phone driverDetails.rating driverDetails.vehicleType driverDetails.vehicleNumber driverDetails.currentLocation')
    .limit(parseInt(limit));

    // Calculate distances and format response
    const driversWithDistance = drivers.map(driver => {
      const driverCoords = driver.driverDetails.currentLocation.coordinates;
      const distance = calculateDistance(lat, lng, driverCoords[1], driverCoords[0]);
      
      return {
        _id: driver._id,
        name: driver.name,
        phone: driver.phone,
        rating: driver.driverDetails.rating,
        vehicleType: driver.driverDetails.vehicleType,
        vehicleNumber: driver.driverDetails.vehicleNumber,
        location: {
          latitude: driverCoords[1],
          longitude: driverCoords[0]
        },
        distanceFromCustomer: Math.round(distance * 100) / 100, // Round to 2 decimals
        estimatedArrival: Math.ceil(distance * 2) // Rough estimate: 2 minutes per km
      };
    });

    Logger.info('Nearby drivers fetched', {
      customerId: customerId.toString(),
      latitude: lat,
      longitude: lng,
      radius: radius,
      driversFound: drivers.length,
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    res.json({
      drivers: driversWithDistance,
      count: drivers.length,
      radius: parseFloat(radius),
      customerLocation: { latitude: lat, longitude: lng },
      message: drivers.length === 0 ? 'No drivers available in your area' : undefined
    });

  } catch (error) {
    Logger.error('Get nearby drivers error', error, {
      customerId: req.user._id.toString(),
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
    console.error('Get nearby drivers error:', error);
    res.status(500).json({
      message: 'Failed to retrieve nearby drivers',
      error: error.message
    });
  }
});

module.exports = router;
