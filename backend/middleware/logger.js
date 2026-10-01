const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Log file paths
const accessLogPath = path.join(logsDir, 'access.log');
const errorLogPath = path.join(logsDir, 'error.log');
const authLogPath = path.join(logsDir, 'auth.log');

// Rate limiting for logs
const logRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_LOGS_PER_WINDOW = 100; // Maximum logs per minute per endpoint

class Logger {
  static formatDate() {
    return new Date().toISOString();
  }

  static formatMessage(level, message, metadata = {}) {
    const timestamp = this.formatDate();
    const logEntry = {
      timestamp,
      level,
      message,
      ...metadata
    };
    return JSON.stringify(logEntry) + '\n';
  }

  static writeToFile(filepath, message) {
    try {
      fs.appendFileSync(filepath, message);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  static shouldRateLimit(key) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    
    if (!logRateLimit.has(key)) {
      logRateLimit.set(key, []);
    }
    
    const timestamps = logRateLimit.get(key);
    
    // Remove old timestamps outside the window
    const validTimestamps = timestamps.filter(timestamp => timestamp > windowStart);
    logRateLimit.set(key, validTimestamps);
    
    // Check if we've exceeded the rate limit
    if (validTimestamps.length >= MAX_LOGS_PER_WINDOW) {
      return true;
    }
    
    // Add current timestamp
    validTimestamps.push(now);
    return false;
  }

  static info(message, metadata = {}) {
    const rateKey = `info:${metadata.endpoint || 'general'}`;
    if (this.shouldRateLimit(rateKey)) {
      return; // Skip logging due to rate limit
    }

    const logMessage = this.formatMessage('INFO', message, metadata);
    console.log(`ℹ️  ${message}`, metadata);
    this.writeToFile(accessLogPath, logMessage);
  }

  static error(message, error = null, metadata = {}) {
    const errorMetadata = {
      ...metadata,
      error: error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : null
    };
    const logMessage = this.formatMessage('ERROR', message, errorMetadata);
    console.error(`❌ ${message}`, errorMetadata);
    this.writeToFile(errorLogPath, logMessage);
  }

  static warn(message, metadata = {}) {
    const logMessage = this.formatMessage('WARN', message, metadata);
    console.warn(`⚠️  ${message}`, metadata);
    this.writeToFile(accessLogPath, logMessage);
  }

  static auth(message, metadata = {}) {
    const logMessage = this.formatMessage('AUTH', message, metadata);
    console.log(`🔐 ${message}`, metadata);
    this.writeToFile(authLogPath, logMessage);
  }
}

// Request logging middleware
const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  const originalSend = res.send;

  // Rate limiting key based on endpoint
  const rateLimitKey = `${req.method}:${req.path}`;

  // Skip logging for high-frequency endpoints if rate limited
  if (Logger.shouldRateLimit(rateLimitKey)) {
    return next();
  }

  // Capture request details
  const requestData = {
    method: req.method,
    url: req.originalUrl,
    path: req.path,
    query: req.query,
    body: req.body ? sanitizeBody(req.body) : {},
    headers: sanitizeHeaders(req.headers),
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    userId: req.user ? req.user.id : null,
    userType: req.user ? req.user.userType : null,
    endpoint: req.path
  };

  Logger.info(`Incoming ${req.method} request`, requestData);

  // Override res.send to capture response
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    // Handle different data types for response size calculation
    let responseSize = 0;
    try {
      if (typeof data === 'string') {
        responseSize = Buffer.byteLength(data);
      } else if (data) {
        // Convert object/array to JSON string for size calculation
        const jsonData = JSON.stringify(data);
        responseSize = Buffer.byteLength(jsonData);
      }
    } catch (error) {
      // Fallback for any conversion errors
      responseSize = 0;
    }
    
    const responseData = {
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      responseSize: responseSize,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip || req.connection.remoteAddress,
      userId: req.user ? req.user.id : null
    };

    if (res.statusCode >= 400) {
      Logger.error(`${req.method} ${req.originalUrl} failed`, null, responseData);
    } else {
      Logger.info(`${req.method} ${req.originalUrl} completed`, responseData);
    }

    originalSend.call(this, data);
  };

  next();
};

// Sanitize sensitive data from logs
function sanitizeBody(body) {
  const sanitized = { ...body };
  const sensitiveFields = ['password', 'token', 'creditCard', 'ssn', 'apiKey'];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '***REDACTED***';
    }
  });
  
  return sanitized;
}

function sanitizeHeaders(headers) {
  const sanitized = { ...headers };
  const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
  
  sensitiveHeaders.forEach(header => {
    if (sanitized[header]) {
      sanitized[header] = '***REDACTED***';
    }
  });
  
  return sanitized;
}

// Error logging middleware
const errorLogger = (err, req, res, next) => {
  const errorData = {
    method: req.method,
    url: req.originalUrl,
    path: req.path,
    query: req.query,
    body: sanitizeBody(req.body || {}),
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    userId: req.user ? req.user.id : null,
    userType: req.user ? req.user.userType : null
  };

  Logger.error('Unhandled error occurred', err, errorData);
  next(err);
};

module.exports = {
  Logger,
  requestLogger,
  errorLogger
};
