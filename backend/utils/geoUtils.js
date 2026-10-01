const geolib = require('geolib');

/**
 * Calculate distance between two geographical points
 * @param {Object} point1 - {latitude, longitude}
 * @param {Object} point2 - {latitude, longitude}
 * @returns {number} - Distance in kilometers
 */
const calculateDistance = (point1, point2) => {
  try {
    const distance = geolib.getDistance(point1, point2);
    return parseFloat((distance / 1000).toFixed(2)); // Convert to km and round to 2 decimal places
  } catch (error) {
    console.error('Error calculating distance:', error);
    return 0;
  }
};

/**
 * Calculate estimated duration for a trip
 * @param {number} distance - Distance in kilometers
 * @param {string} vehicleType - Type of vehicle (bike, car, auto)
 * @returns {number} - Estimated duration in minutes
 */
const calculateEstimatedDuration = (distance, vehicleType = 'car') => {
  const averageSpeeds = {
    bike: 25,    // km/h
    car: 30,     // km/h
    auto: 20     // km/h
  };

  const speed = averageSpeeds[vehicleType] || averageSpeeds.car;
  const duration = (distance / speed) * 60; // Convert to minutes
  
  // Add buffer time for traffic and stops (20% extra)
  return Math.round(duration * 1.2);
};

/**
 * Check if a point is within a given radius of another point
 * @param {Object} center - Center point {latitude, longitude}
 * @param {Object} point - Point to check {latitude, longitude}
 * @param {number} radiusKm - Radius in kilometers
 * @returns {boolean} - True if point is within radius
 */
const isWithinRadius = (center, point, radiusKm) => {
  const distance = calculateDistance(center, point);
  return distance <= radiusKm;
};

/**
 * Find the closest point from an array of points
 * @param {Object} referencePoint - Reference point {latitude, longitude}
 * @param {Array} points - Array of points with latitude and longitude
 * @returns {Object} - Closest point with distance
 */
const findClosestPoint = (referencePoint, points) => {
  if (!points || points.length === 0) return null;

  let closestPoint = null;
  let minDistance = Infinity;

  points.forEach(point => {
    const distance = calculateDistance(referencePoint, point);
    if (distance < minDistance) {
      minDistance = distance;
      closestPoint = { ...point, distance };
    }
  });

  return closestPoint;
};

/**
 * Convert degrees to radians
 * @param {number} degrees
 * @returns {number} - Radians
 */
const degreesToRadians = (degrees) => {
  return degrees * (Math.PI / 180);
};

/**
 * Calculate bearing between two points
 * @param {Object} point1 - Start point {latitude, longitude}
 * @param {Object} point2 - End point {latitude, longitude}
 * @returns {number} - Bearing in degrees (0-360)
 */
const calculateBearing = (point1, point2) => {
  const lat1 = degreesToRadians(point1.latitude);
  const lat2 = degreesToRadians(point2.latitude);
  const deltaLng = degreesToRadians(point2.longitude - point1.longitude);

  const x = Math.sin(deltaLng) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  const bearing = Math.atan2(x, y);
  return (bearing * (180 / Math.PI) + 360) % 360; // Convert to degrees and normalize
};

/**
 * Generate bounding box coordinates for a given center and radius
 * @param {Object} center - Center point {latitude, longitude}
 * @param {number} radiusKm - Radius in kilometers
 * @returns {Object} - Bounding box with north, south, east, west coordinates
 */
const generateBoundingBox = (center, radiusKm) => {
  const earthRadius = 6371; // Earth's radius in kilometers
  const lat = degreesToRadians(center.latitude);
  const lng = degreesToRadians(center.longitude);
  const d = radiusKm / earthRadius;

  const minLat = center.latitude - (d * (180 / Math.PI));
  const maxLat = center.latitude + (d * (180 / Math.PI));
  
  const deltaLng = Math.asin(Math.sin(d) / Math.cos(lat)) * (180 / Math.PI);
  const minLng = center.longitude - deltaLng;
  const maxLng = center.longitude + deltaLng;

  return {
    north: maxLat,
    south: minLat,
    east: maxLng,
    west: minLng
  };
};

/**
 * Validate geographical coordinates
 * @param {number} latitude
 * @param {number} longitude
 * @returns {boolean} - True if valid coordinates
 */
const validateCoordinates = (latitude, longitude) => {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
};

module.exports = {
  calculateDistance,
  calculateEstimatedDuration,
  isWithinRadius,
  findClosestPoint,
  degreesToRadians,
  calculateBearing,
  generateBoundingBox,
  validateCoordinates
};
