const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  phone: {
    type: String,
    required: true,
    unique: true
  },
  userType: {
    type: String,
    enum: ['customer', 'driver', 'admin'],
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Driver-specific fields
  driverDetails: {
    licenseNumber: String,
    vehicleNumber: String,
    vehicleType: {
      type: String,
      enum: ['bike', 'car', 'auto']
    },
    rating: {
      type: Number,
      default: 5.0,
      min: 0,
      max: 5
    },
    totalDeliveries: {
      type: Number,
      default: 0
    },
    isAvailable: {
      type: Boolean,
      default: false
    },
    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      }
    },
    lastLocationUpdate: {
      type: Date,
      default: Date.now
    }
  },
  // Customer-specific fields
  customerDetails: {
    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      }
    },
    lastLocationUpdate: {
      type: Date,
      default: Date.now
    },
    preferredPaymentMethod: {
      type: String,
      enum: ['cash', 'card', 'upi'],
      default: 'cash'
    },
    totalOrders: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

// Create geospatial index for location queries
userSchema.index({ 'driverDetails.currentLocation': '2dsphere' });
userSchema.index({ 'customerDetails.currentLocation': '2dsphere' });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Update user location
userSchema.methods.updateLocation = function(longitude, latitude) {
  if (this.userType === 'driver') {
    this.driverDetails.currentLocation.coordinates = [longitude, latitude];
    this.driverDetails.lastLocationUpdate = new Date();
  } else if (this.userType === 'customer') {
    this.customerDetails.currentLocation.coordinates = [longitude, latitude];
    this.customerDetails.lastLocationUpdate = new Date();
  }
};

module.exports = mongoose.model('User', userSchema);
