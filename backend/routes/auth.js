const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { Logger } = require('../middleware/logger');

const router = express.Router();

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user (customer or driver)
 *     description: Create a new user account. For drivers, additional vehicle information is required.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *           examples:
 *             customer:
 *               summary: Customer registration
 *               value:
 *                 name: "John Doe"
 *                 email: "john@example.com"
 *                 password: "password123"
 *                 phone: "+1234567890"
 *                 userType: "customer"
 *             driver:
 *               summary: Driver registration
 *               value:
 *                 name: "Jane Smith"
 *                 email: "jane@example.com"
 *                 password: "password123"
 *                 phone: "+1234567891"
 *                 userType: "driver"
 *                 licenseNumber: "DL1234567890"
 *                 vehicleNumber: "AB12CD3456"
 *                 vehicleType: "car"
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "User registered successfully"
 *                 userId:
 *                   type: string
 *                   example: "64a1b2c3d4e5f6789abcdef0"
 *       400:
 *         description: Bad request - missing or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: User already exists
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

// Register new user (driver or customer)
router.post('/register', async (req, res) => {
  const registrationStartTime = Date.now();
  const ip = req.ip || req.connection.remoteAddress;
  
  try {
    const {
      name,
      email,
      password,
      phone,
      userType,
      licenseNumber,
      vehicleNumber,
      vehicleType
    } = req.body;

    Logger.auth('Registration attempt started', {
      email,
      userType,
      ip,
      userAgent: req.get('user-agent'),
      hasRequiredFields: !!(name && email && password && phone && userType)
    });

    // Validate required fields
    if (!name || !email || !password || !phone || !userType) {
      Logger.auth('Registration failed - missing required fields', {
        email,
        userType,
        ip,
        missingFields: {
          name: !name,
          email: !email,
          password: !password,
          phone: !phone,
          userType: !userType
        }
      });
      return res.status(400).json({
        message: 'Please provide all required fields'
      });
    }

    // Validate userType
    if (!['customer', 'driver', 'admin'].includes(userType)) {
      Logger.auth('Registration failed - invalid user type', {
        email,
        userType,
        ip,
        validTypes: ['customer', 'driver', 'admin']
      });
      return res.status(400).json({
        message: 'Invalid user type. Must be either customer, driver, or admin'
      });
    }

    // Additional validation for drivers
    if (userType === 'driver') {
      if (!licenseNumber || !vehicleNumber || !vehicleType) {
        Logger.auth('Driver registration failed - missing vehicle info', {
          email,
          userType,
          ip,
          missingFields: {
            licenseNumber: !licenseNumber,
            vehicleNumber: !vehicleNumber,
            vehicleType: !vehicleType
          }
        });
        return res.status(400).json({
          message: 'Driver registration requires license number, vehicle number, and vehicle type'
        });
      }

      if (!['bike', 'car', 'auto'].includes(vehicleType)) {
        Logger.auth('Driver registration failed - invalid vehicle type', {
          email,
          userType,
          vehicleType,
          ip,
          validVehicleTypes: ['bike', 'car', 'auto']
        });
        return res.status(400).json({
          message: 'Invalid vehicle type. Must be bike, car, or auto'
        });
      }
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (existingUser) {
      Logger.auth('Registration failed - user already exists', {
        email,
        phone,
        existingUserType: existingUser.userType,
        existingUserId: existingUser._id,
        ip
      });
      return res.status(400).json({
        message: 'User with this email or phone already exists'
      });
    }

    // Create user object
    const userData = {
      name,
      email,
      password,
      phone,
      userType
    };

    // Add driver-specific data
    if (userType === 'driver') {
      userData.driverDetails = {
        licenseNumber,
        vehicleNumber,
        vehicleType,
        isAvailable: false, // Driver starts as unavailable
        currentLocation: {
          type: 'Point',
          coordinates: [0, 0] // Default coordinates, to be updated later
        }
      };
    }

    // Create new user
    const user = new User(userData);
    await user.save();

    Logger.auth('User registered successfully', {
      userId: user._id,
      email: user.email,
      userType: user.userType,
      name: user.name,
      phone: user.phone,
      ip,
      registrationDuration: `${Date.now() - registrationStartTime}ms`,
      hasDriverDetails: userType === 'driver'
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, userType: user.userType },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      message: 'User registered successfully',
      user: userResponse,
      token
    });

  } catch (error) {
    Logger.error('Registration failed with database error', error, {
      email,
      userType,
      ip,
      registrationDuration: `${Date.now() - registrationStartTime}ms`
    });
    console.error('Registration error:', error);
    res.status(500).json({
      message: 'Registration failed',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     description: Authenticate user and return JWT token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *           example:
 *             email: "john@example.com"
 *             password: "password123"
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       400:
 *         description: Missing email or password
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid credentials
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
// Login user
router.post('/login', async (req, res) => {
  const loginStartTime = Date.now();
  const ip = req.ip || req.connection.remoteAddress;
  
  try {
    const { email, password } = req.body;

    Logger.auth('Login attempt started', {
      email,
      ip,
      userAgent: req.get('user-agent'),
      hasEmail: !!email,
      hasPassword: !!password
    });

    if (!email || !password) {
      Logger.auth('Login failed - missing credentials', {
        email,
        ip,
        missingEmail: !email,
        missingPassword: !password
      });
      return res.status(400).json({
        message: 'Please provide email and password'
      });
    }

    // Find user by email
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      Logger.auth('Login failed - user not found', {
        email,
        ip,
        userAgent: req.get('user-agent')
      });
      return res.status(401).json({
        message: 'Invalid credentials'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      Logger.auth('Login failed - account deactivated', {
        email,
        userId: user._id,
        userType: user.userType,
        ip,
        userAgent: req.get('user-agent')
      });
      return res.status(401).json({
        message: 'Account is deactivated'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      Logger.auth('Login failed - invalid password', {
        email,
        userId: user._id,
        userType: user.userType,
        ip,
        userAgent: req.get('user-agent'),
        loginDuration: `${Date.now() - loginStartTime}ms`
      });
      return res.status(401).json({
        message: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, userType: user.userType },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Log successful login
    Logger.auth('Login successful', {
      userId: user._id,
      email: user.email,
      userType: user.userType,
      name: user.name,
      ip,
      userAgent: req.get('user-agent'),
      loginDuration: `${Date.now() - loginStartTime}ms`,
      tokenExpiry: process.env.JWT_EXPIRES_IN
    });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.json({
      message: 'Login successful',
      user: userResponse,
      token
    });

  } catch (error) {
    Logger.error('Login failed with database error', error, {
      email,
      ip,
      userAgent: req.get('user-agent'),
      loginDuration: `${Date.now() - loginStartTime}ms`
    });
    console.error('Login error:', error);
    res.status(500).json({
      message: 'Login failed',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/profile:
 *   get:
 *     summary: Get user profile
 *     description: Retrieve the authenticated user's profile information
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
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
// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    
    if (!user) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    // Add location info for customers (fallback support)
    let locationInfo = null;
    if (user.userType === 'customer' && user.customerDetails?.currentLocation) {
      const coordinates = user.customerDetails.currentLocation.coordinates;
      locationInfo = {
        latitude: coordinates[1],
        longitude: coordinates[0],
        lastUpdate: user.customerDetails.lastLocationUpdate
      };
    } else if (user.userType === 'driver' && user.driverDetails?.currentLocation) {
      const coordinates = user.driverDetails.currentLocation.coordinates;
      locationInfo = {
        latitude: coordinates[1],
        longitude: coordinates[0],
        lastUpdate: user.driverDetails.lastLocationUpdate
      };
    }

    res.json({
      user: {
        ...user.toObject(),
        currentLocation: locationInfo
      }
    });

  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({
      message: 'Failed to fetch profile',
      error: error.message
    });
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const allowedUpdates = ['name', 'phone'];
    const updates = {};

    // Only allow certain fields to be updated
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // Driver-specific updates
    if (req.user.userType === 'driver') {
      const driverAllowedUpdates = ['vehicleNumber', 'vehicleType'];
      driverAllowedUpdates.forEach(field => {
        if (req.body[field] !== undefined) {
          updates[`driverDetails.${field}`] = req.body[field];
        }
      });

      // Location update for drivers (fallback support) - handle multiple formats
      let latitude, longitude;
      
      if (req.body.latitude !== undefined && req.body.longitude !== undefined) {
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

      if (latitude !== undefined && longitude !== undefined) {
        const { validateCoordinates } = require('../utils/geoUtils');
        if (validateCoordinates(latitude, longitude)) {
          updates['driverDetails.currentLocation.coordinates'] = [longitude, latitude];
          updates['driverDetails.lastLocationUpdate'] = new Date();
        }
      }
    }

    // Customer-specific updates (fallback support)
    if (req.user.userType === 'customer') {
      const customerAllowedUpdates = ['preferredPaymentMethod'];
      customerAllowedUpdates.forEach(field => {
        if (req.body[field] !== undefined) {
          updates[`customerDetails.${field}`] = req.body[field];
        }
      });

      // Location update for customers (fallback support) - handle multiple formats
      let latitude, longitude;
      
      if (req.body.latitude !== undefined && req.body.longitude !== undefined) {
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

      if (latitude !== undefined && longitude !== undefined) {
        const { validateCoordinates } = require('../utils/geoUtils');
        if (validateCoordinates(latitude, longitude)) {
          updates['customerDetails.currentLocation.coordinates'] = [longitude, latitude];
          updates['customerDetails.lastLocationUpdate'] = new Date();
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        message: 'No valid fields to update'
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      message: 'Profile updated successfully',
      user
    });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      message: 'Failed to update profile',
      error: error.message
    });
  }
});

// Change password
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: 'Please provide current and new password'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: 'New password must be at least 6 characters long'
      });
    }

    const user = await User.findById(req.user._id).select('+password');
    
    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({
      message: 'Failed to change password',
      error: error.message
    });
  }
});

// Refresh token
router.post('/refresh-token', authenticateToken, async (req, res) => {
  try {
    const newToken = jwt.sign(
      { userId: req.user._id, userType: req.user.userType },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      message: 'Token refreshed successfully',
      token: newToken
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      message: 'Failed to refresh token',
      error: error.message
    });
  }
});

module.exports = router;
