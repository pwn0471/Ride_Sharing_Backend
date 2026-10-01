const { getRedisClient } = require('../config/redis');
const User = require('../models/User');
const Order = require('../models/Order');
const { calculateDistance } = require('../utils/geoUtils');

class OrderAssignmentService {
  constructor(io) {
    this.io = io;
    this.redisClient = getRedisClient();
  }

  /**
   * Find nearby available drivers for an order
   * @param {Object} pickupLocation - {longitude, latitude}
   * @param {number} radiusKm - Search radius in kilometers
   * @returns {Array} - Array of nearby drivers
   */
  async findNearbyDrivers(pickupLocation, radiusKm = 5) {
    try {
      const drivers = await User.find({
        userType: 'driver',
        isActive: true,
        'driverDetails.isAvailable': true,
        'driverDetails.currentLocation': {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [pickupLocation.longitude, pickupLocation.latitude]
            },
            $maxDistance: radiusKm * 1000 // Convert km to meters
          }
        }
      }).select('name phone driverDetails');

      // Calculate actual distance and add to driver object
      return drivers.map(driver => {
        const driverLocation = {
          latitude: driver.driverDetails.currentLocation.coordinates[1],
          longitude: driver.driverDetails.currentLocation.coordinates[0]
        };
        
        const distance = calculateDistance(
          { latitude: pickupLocation.latitude, longitude: pickupLocation.longitude },
          driverLocation
        );

        return {
          ...driver.toObject(),
          distanceToPickup: distance
        };
      }).sort((a, b) => a.distanceToPickup - b.distanceToPickup);
    } catch (error) {
      console.error('Error finding nearby drivers:', error);
      throw error;
    }
  }

  /**
   * Assign order to the best available driver
   * @param {string} orderId - Order ID
   * @returns {Object} - Assignment result
   */
  async assignOrder(orderId) {
    try {
      const order = await Order.findOne({ orderId }).populate('customer');
      if (!order) {
        throw new Error('Order not found');
      }

      if (order.status !== 'pending') {
        throw new Error('Order is not in pending status');
      }

      // Check if order is already being processed
      const lockKey = `order_assignment:${orderId}`;
      const isLocked = await this.redisClient.get(lockKey);
      if (isLocked) {
        throw new Error('Order assignment already in progress');
      }

      // Lock the assignment process
      await this.redisClient.setEx(lockKey, 300, 'locked'); // 5 minutes lock

      try {
        const pickupLocation = {
          longitude: order.pickupLocation.coordinates.coordinates[0],
          latitude: order.pickupLocation.coordinates.coordinates[1]
        };

        // Find nearby drivers
        const nearbyDrivers = await this.findNearbyDrivers(pickupLocation);
        
        if (nearbyDrivers.length === 0) {
          await this.redisClient.del(lockKey);
          throw new Error('No available drivers found nearby');
        }

        // Try to assign to drivers one by one
        for (const driver of nearbyDrivers.slice(0, 5)) { // Try top 5 closest drivers
          const assignmentResult = await this.offerOrderToDriver(order, driver);
          if (assignmentResult.success) {
            await this.redisClient.del(lockKey);
            return assignmentResult;
          }
        }

        await this.redisClient.del(lockKey);
        throw new Error('No driver accepted the order');

      } catch (error) {
        await this.redisClient.del(lockKey);
        throw error;
      }
    } catch (error) {
      console.error('Error assigning order:', error);
      throw error;
    }
  }

  /**
   * Offer order to a specific driver
   * @param {Object} order - Order object
   * @param {Object} driver - Driver object
   * @returns {Object} - Offer result
   */
  async offerOrderToDriver(order, driver) {
    try {
      const driverLockKey = `driver_lock:${driver._id}`;
      const orderLockKey = `order_lock:${order.orderId}`;

      // Check if driver is already handling another order
      const driverLock = await this.redisClient.get(driverLockKey);
      if (driverLock) {
        return { success: false, reason: 'Driver is busy with another order' };
      }

      // Check if order is already locked by another driver
      const orderLock = await this.redisClient.get(orderLockKey);
      if (orderLock && orderLock !== driver._id.toString()) {
        return { success: false, reason: 'Order is locked by another driver' };
      }

      // Lock the driver and order for this assignment attempt
      const lockTimeout = parseInt(process.env.ORDER_LOCK_TIMEOUT) || 300; // 5 minutes
      await this.redisClient.setEx(driverLockKey, lockTimeout, order.orderId);
      await this.redisClient.setEx(orderLockKey, lockTimeout, driver._id.toString());

      // Update order lock in database
      order.lockForDriver(driver._id, lockTimeout / 60);
      await order.save();

      // Add to assignment attempts
      order.assignmentAttempts.push({
        driverId: driver._id,
        response: 'pending'
      });
      await order.save();

      // Send real-time notification to driver
      this.io.to(`driver:${driver._id}`).emit('new_order_offer', {
        orderId: order.orderId,
        orderDetails: {
          pickupAddress: order.pickupLocation.address,
          dropoffAddress: order.dropoffLocation.address,
          estimatedDistance: order.estimatedDistance,
          estimatedDuration: order.estimatedDuration,
          fare: order.fare,
          customerName: order.customer.name,
          distanceToPickup: driver.distanceToPickup,
          orderType: order.orderType
        },
        expiresIn: lockTimeout
      });

      console.log(`Order ${order.orderId} offered to driver ${driver._id}`);

      return {
        success: true,
        driverId: driver._id,
        lockTimeout: lockTimeout,
        message: 'Order offered to driver'
      };

    } catch (error) {
      console.error('Error offering order to driver:', error);
      return { success: false, reason: 'Failed to offer order to driver' };
    }
  }

  /**
   * Handle driver's response to order offer
   * @param {string} orderId - Order ID
   * @param {string} driverId - Driver ID
   * @param {string} response - 'accept' or 'decline'
   * @returns {Object} - Response result
   */
  async handleDriverResponse(orderId, driverId, response) {
    try {
      const order = await Order.findOne({ orderId }).populate('customer');
      if (!order) {
        throw new Error('Order not found');
      }

      const driverLockKey = `driver_lock:${driverId}`;
      const orderLockKey = `order_lock:${orderId}`;

      // Verify the locks
      const driverLock = await this.redisClient.get(driverLockKey);
      const orderLock = await this.redisClient.get(orderLockKey);

      if (driverLock !== orderId || orderLock !== driverId) {
        throw new Error('Invalid or expired lock');
      }

      // Update assignment attempt
      const attemptIndex = order.assignmentAttempts.findIndex(
        attempt => attempt.driverId.toString() === driverId && attempt.response === 'pending'
      );

      if (attemptIndex !== -1) {
        order.assignmentAttempts[attemptIndex].response = response === 'accept' ? 'accepted' : 'declined';
        order.assignmentAttempts[attemptIndex].respondedAt = new Date();
      }

      if (response === 'accept') {
        // Driver accepted - assign the order
        order.updateStatus('accepted', driverId);
        order.releaseLock();
        await order.save();

        // Update driver availability
        await User.findByIdAndUpdate(driverId, {
          'driverDetails.isAvailable': false
        });

        // Clear locks
        await this.redisClient.del(driverLockKey);
        await this.redisClient.del(orderLockKey);

        // Notify customer
        this.io.to(`customer:${order.customer._id}`).emit('order_accepted', {
          orderId: order.orderId,
          driverInfo: await User.findById(driverId).select('name phone driverDetails.rating driverDetails.vehicleNumber')
        });

        // Notify driver
        this.io.to(`driver:${driverId}`).emit('order_assignment_confirmed', {
          orderId: order.orderId,
          message: 'Order assigned successfully'
        });

        console.log(`Order ${orderId} accepted by driver ${driverId}`);

        return {
          success: true,
          message: 'Order accepted successfully',
          orderId: orderId
        };

      } else {
        // Driver declined - try next driver or mark as unassigned
        order.releaseLock();
        await order.save();

        // Clear locks
        await this.redisClient.del(driverLockKey);
        await this.redisClient.del(orderLockKey);

        // Check retry count to prevent infinite loops
        const currentAttempts = order.assignmentAttempts.filter(attempt => attempt.response !== 'pending').length;
        const maxRetries = 10; // Maximum number of drivers to try

        if (currentAttempts < maxRetries) {
          // Try to assign to next available driver after a delay
          setTimeout(() => {
            this.assignOrder(orderId).catch(error => {
              console.error(`Failed to reassign order ${orderId}:`, error.message);
              // Mark order as failed after max retries
              this.markOrderAsFailed(orderId, 'No drivers available');
            });
          }, 2000); // Increased delay to prevent rapid retries
        } else {
          // Max retries reached, mark order as failed
          await this.markOrderAsFailed(orderId, 'Maximum assignment attempts reached');
        }

        console.log(`Order ${orderId} declined by driver ${driverId} (attempt ${currentAttempts})`);

        return {
          success: true,
          message: 'Order declined, trying next driver'
        };
      }

    } catch (error) {
      console.error('Error handling driver response:', error);
      throw error;
    }
  }

  /**
   * Clean up expired locks
   */
  async cleanupExpiredLocks() {
    try {
      const expiredOrders = await Order.find({
        isLocked: true,
        lockExpiration: { $lt: new Date() }
      });

      for (const order of expiredOrders) {
        order.releaseLock();
        // Mark the assignment attempt as timeout
        const lastAttempt = order.assignmentAttempts[order.assignmentAttempts.length - 1];
        if (lastAttempt && lastAttempt.response === 'pending') {
          lastAttempt.response = 'timeout';
          lastAttempt.respondedAt = new Date();
        }
        await order.save();

        // Clear Redis locks
        await this.redisClient.del(`driver_lock:${order.lockedBy}`);
        await this.redisClient.del(`order_lock:${order.orderId}`);

        console.log(`Cleaned up expired lock for order ${order.orderId}`);
      }
    } catch (error) {
      console.error('Error cleaning up expired locks:', error);
    }
  }

  /**
   * Mark an order as failed when no drivers are available
   * @param {string} orderId - Order ID
   * @param {string} reason - Failure reason
   */
  async markOrderAsFailed(orderId, reason) {
    try {
      const order = await Order.findOne({ orderId }).populate('customer');
      if (order) {
        order.updateStatus('failed', null, reason);
        order.releaseLock();
        await order.save();

        // Notify customer
        this.io.to(`customer:${order.customer._id}`).emit('order_failed', {
          orderId: order.orderId,
          reason: reason,
          message: 'Sorry, no drivers are available at the moment. Please try again later.'
        });

        console.log(`Order ${orderId} marked as failed: ${reason}`);
      }
    } catch (error) {
      console.error(`Error marking order ${orderId} as failed:`, error);
    }
  }
}

module.exports = OrderAssignmentService;
