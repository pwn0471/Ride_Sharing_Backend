class SocketService {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map(); // userId -> socketId
  }

  initialize() {
    this.io.on('connection', (socket) => {
      console.log(`🔌 New connection: ${socket.id}`);

      // Handle user authentication and room joining
      socket.on('authenticate', (data) => {
        const { userId, userType, token } = data;
        
        // TODO: Verify JWT token here
        
        socket.userId = userId;
        socket.userType = userType;
        
        // Join user-specific room
        socket.join(`${userType}:${userId}`);
        
        // Store connection
        this.connectedUsers.set(userId, socket.id);
        
        console.log(`👤 User ${userId} (${userType}) authenticated and joined room`);
        
        socket.emit('authenticated', { message: 'Successfully authenticated' });
      });

      // Handle driver location updates
      socket.on('update_location', async (data) => {
        if (socket.userType === 'driver') {
          const { latitude, longitude } = data;
          
          try {
            const User = require('../models/User');
            await User.findByIdAndUpdate(socket.userId, {
              'driverDetails.currentLocation.coordinates': [longitude, latitude],
              'driverDetails.lastLocationUpdate': new Date()
            });

            // Broadcast location update to relevant customers/admin
            socket.broadcast.emit('driver_location_update', {
              driverId: socket.userId,
              location: { latitude, longitude },
              timestamp: new Date()
            });

          } catch (error) {
            console.error('Error updating driver location:', error);
            socket.emit('error', { message: 'Failed to update location' });
          }
        }
      });

      // Handle order status updates from drivers
      socket.on('update_order_status', async (data) => {
        if (socket.userType === 'driver') {
          const { orderId, status, location } = data;
          
          try {
            const Order = require('../models/Order');
            const order = await Order.findOne({ orderId }).populate('customer');
            
            if (!order || order.driver.toString() !== socket.userId) {
              socket.emit('error', { message: 'Unauthorized or order not found' });
              return;
            }

            order.updateStatus(status);
            await order.save();

            // Notify customer about status update
            this.io.to(`customer:${order.customer._id}`).emit('order_status_update', {
              orderId,
              status,
              driverLocation: location,
              timestamp: new Date(),
              estimatedArrival: this.calculateETA(location, order.dropoffLocation.coordinates.coordinates)
            });

            console.log(`📱 Order ${orderId} status updated to ${status}`);

          } catch (error) {
            console.error('Error updating order status:', error);
            socket.emit('error', { message: 'Failed to update order status' });
          }
        }
      });

      // Handle driver availability toggle
      socket.on('toggle_availability', async (data) => {
        if (socket.userType === 'driver') {
          const { isAvailable } = data;
          
          try {
            const User = require('../models/User');
            await User.findByIdAndUpdate(socket.userId, {
              'driverDetails.isAvailable': isAvailable
            });

            socket.emit('availability_updated', { isAvailable });
            console.log(`🚗 Driver ${socket.userId} availability: ${isAvailable}`);

          } catch (error) {
            console.error('Error updating driver availability:', error);
            socket.emit('error', { message: 'Failed to update availability' });
          }
        }
      });

      // Handle order response from driver
      socket.on('order_response', async (data) => {
        if (socket.userType === 'driver') {
          const { orderId, response } = data; // response: 'accept' or 'decline'
          
          try {
            const OrderAssignmentService = require('./orderAssignmentService');
            const assignmentService = new OrderAssignmentService(this.io);
            
            const result = await assignmentService.handleDriverResponse(
              orderId, 
              socket.userId, 
              response
            );
            
            socket.emit('order_response_processed', result);

          } catch (error) {
            console.error('Error processing order response:', error);
            socket.emit('error', { message: error.message });
          }
        }
      });

      // Handle customer order cancellation
      socket.on('cancel_order', async (data) => {
        if (socket.userType === 'customer') {
          const { orderId } = data;
          
          try {
            const Order = require('../models/Order');
            const order = await Order.findOne({ orderId }).populate('driver');
            
            if (!order || order.customer.toString() !== socket.userId) {
              socket.emit('error', { message: 'Unauthorized or order not found' });
              return;
            }

            if (['delivered', 'cancelled'].includes(order.status)) {
              socket.emit('error', { message: 'Order cannot be cancelled' });
              return;
            }

            order.updateStatus('cancelled');
            await order.save();

            // Notify driver if assigned
            if (order.driver) {
              this.io.to(`driver:${order.driver._id}`).emit('order_cancelled', {
                orderId,
                message: 'Order has been cancelled by customer'
              });

              // Make driver available again
              const User = require('../models/User');
              await User.findByIdAndUpdate(order.driver._id, {
                'driverDetails.isAvailable': true
              });
            }

            socket.emit('order_cancelled', { orderId, message: 'Order cancelled successfully' });

          } catch (error) {
            console.error('Error cancelling order:', error);
            socket.emit('error', { message: 'Failed to cancel order' });
          }
        }
      });

      // Handle chat messages
      socket.on('send_message', async (data) => {
        const { orderId, message, to } = data;
        
        try {
          const Order = require('../models/Order');
          const order = await Order.findOne({ orderId });
          
          if (!order) {
            socket.emit('error', { message: 'Order not found' });
            return;
          }

          // Verify user is part of this order
          const isCustomer = order.customer.toString() === socket.userId;
          const isDriver = order.driver && order.driver.toString() === socket.userId;
          
          if (!isCustomer && !isDriver) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
          }

          const targetUserType = isCustomer ? 'driver' : 'customer';
          const targetUserId = isCustomer ? order.driver : order.customer;

          // Send message to target user
          this.io.to(`${targetUserType}:${targetUserId}`).emit('new_message', {
            orderId,
            from: socket.userId,
            fromType: socket.userType,
            message,
            timestamp: new Date()
          });

          // Confirm message sent
          socket.emit('message_sent', { orderId, message, timestamp: new Date() });

        } catch (error) {
          console.error('Error sending message:', error);
          socket.emit('error', { message: 'Failed to send message' });
        }
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`🔌 Disconnected: ${socket.id}`);
        
        if (socket.userId) {
          this.connectedUsers.delete(socket.userId);
          console.log(`👤 User ${socket.userId} disconnected`);
        }
      });
    });

    // Set up periodic cleanup of expired locks
    setInterval(async () => {
      try {
        const OrderAssignmentService = require('./orderAssignmentService');
        const assignmentService = new OrderAssignmentService(this.io);
        await assignmentService.cleanupExpiredLocks();
      } catch (error) {
        console.error('Error in periodic cleanup:', error);
      }
    }, 120000); // Run every 2 minutes instead of 30 seconds
  }

  // Utility method to calculate ETA
  calculateETA(currentLocation, destination) {
    // Simplified ETA calculation
    // In production, you would use a routing service like Google Maps API
    const avgSpeed = 30; // km/h
    const geolib = require('geolib');
    
    const distance = geolib.getDistance(
      { latitude: currentLocation[1], longitude: currentLocation[0] },
      { latitude: destination[1], longitude: destination[0] }
    ) / 1000; // Convert to km
    
    return Math.round((distance / avgSpeed) * 60); // Return ETA in minutes
  }

  // Method to send notification to specific user
  sendToUser(userId, userType, event, data) {
    this.io.to(`${userType}:${userId}`).emit(event, data);
  }

  // Method to broadcast to all users of a type
  broadcastToUserType(userType, event, data) {
    this.io.emit(event, data);
  }
}

module.exports = SocketService;
