const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    unique: true,
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  pickupLocation: {
    address: {
      type: String,
      required: true
    },
    coordinates: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true
      }
    }
  },
  dropoffLocation: {
    address: {
      type: String,
      required: true
    },
    coordinates: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true
      }
    }
  },
  orderType: {
    type: String,
    enum: ['ride', 'delivery'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'pickup_started', 'picked_up', 'in_transit', 'delivered', 'cancelled'],
    default: 'pending'
  },
  estimatedDistance: {
    type: Number, // in kilometers
    required: true
  },
  estimatedDuration: {
    type: Number, // in minutes
    required: true
  },
  fare: {
    baseFare: Number,
    distanceFare: Number,
    totalFare: Number
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'refunded'],
    default: 'pending'
  },
  specialInstructions: String,
  // Tracking timestamps
  timestamps: {
    orderPlaced: {
      type: Date,
      default: Date.now
    },
    accepted: Date,
    pickupStarted: Date,
    pickedUp: Date,
    delivered: Date,
    cancelled: Date
  },
  // Assignment tracking
  assignmentAttempts: [{
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    attemptedAt: {
      type: Date,
      default: Date.now
    },
    response: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'timeout']
    },
    respondedAt: Date
  }],
  isLocked: {
    type: Boolean,
    default: false
  },
  lockedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lockExpiration: Date
}, {
  timestamps: true
});

// Create geospatial indexes
orderSchema.index({ 'pickupLocation.coordinates': '2dsphere' });
orderSchema.index({ 'dropoffLocation.coordinates': '2dsphere' });

// Index for efficient queries
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ driver: 1, createdAt: -1 });
// orderId already has unique index from schema definition

// Calculate fare based on distance
orderSchema.methods.calculateFare = function() {
  const baseFare = 30; // Base fare in currency units
  const farePerKm = 12; // Fare per kilometer
  
  this.fare = {
    baseFare: baseFare,
    distanceFare: this.estimatedDistance * farePerKm,
    totalFare: baseFare + (this.estimatedDistance * farePerKm)
  };
  
  return this.fare;
};

// Update order status with timestamp
orderSchema.methods.updateStatus = function(newStatus, driverId = null) {
  const oldStatus = this.status;
  this.status = newStatus;
  
  // Update timestamps
  switch (newStatus) {
    case 'accepted':
      this.timestamps.accepted = new Date();
      this.driver = driverId;
      break;
    case 'pickup_started':
      this.timestamps.pickupStarted = new Date();
      break;
    case 'picked_up':
      this.timestamps.pickedUp = new Date();
      break;
    case 'delivered':
      this.timestamps.delivered = new Date();
      this.paymentStatus = 'paid';
      break;
    case 'cancelled':
      this.timestamps.cancelled = new Date();
      break;
  }
  
  return { oldStatus, newStatus };
};

// Lock order for driver acceptance
orderSchema.methods.lockForDriver = function(driverId, timeoutMinutes = 5) {
  this.isLocked = true;
  this.lockedBy = driverId;
  this.lockExpiration = new Date(Date.now() + timeoutMinutes * 60 * 1000);
};

// Release lock
orderSchema.methods.releaseLock = function() {
  this.isLocked = false;
  this.lockedBy = null;
  this.lockExpiration = null;
};

// Check if lock is expired
orderSchema.methods.isLockExpired = function() {
  return this.isLocked && this.lockExpiration && new Date() > this.lockExpiration;
};

module.exports = mongoose.model('Order', orderSchema);
