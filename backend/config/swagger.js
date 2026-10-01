const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Ride Sharing API',
            version: '1.0.0',
            description: 'A comprehensive ride-sharing platform API with real-time features, caching, and performance optimizations',
            contact: {
                name: 'API Support',
                email: 'support@ridesharing.com'
            }
        },
        servers: [
            {
                url: 'http://localhost:3000',
                description: 'Development server'
            }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT'
                }
            },
            schemas: {
                User: {
                    type: 'object',
                    required: ['email', 'password', 'name', 'type'],
                    properties: {
                        _id: {
                            type: 'string',
                            description: 'User ID',
                            example: '507f1f77bcf86cd799439011'
                        },
                        email: {
                            type: 'string',
                            format: 'email',
                            description: 'User email address',
                            example: 'john.doe@example.com'
                        },
                        name: {
                            type: 'string',
                            description: 'User full name',
                            example: 'John Doe'
                        },
                        type: {
                            type: 'string',
                            enum: ['customer', 'driver'],
                            description: 'User type',
                            example: 'customer'
                        },
                        phone: {
                            type: 'string',
                            description: 'User phone number',
                            example: '+1234567890'
                        },
                        location: {
                            type: 'object',
                            properties: {
                                latitude: {
                                    type: 'number',
                                    format: 'float',
                                    example: 40.7128
                                },
                                longitude: {
                                    type: 'number',
                                    format: 'float',
                                    example: -74.0060
                                }
                            }
                        },
                        isAvailable: {
                            type: 'boolean',
                            description: 'Driver availability status (drivers only)',
                            example: true
                        },
                        vehicle: {
                            type: 'object',
                            description: 'Vehicle information (drivers only)',
                            properties: {
                                make: { type: 'string', example: 'Toyota' },
                                model: { type: 'string', example: 'Camry' },
                                year: { type: 'number', example: 2020 },
                                licensePlate: { type: 'string', example: 'ABC-123' },
                                color: { type: 'string', example: 'Blue' }
                            }
                        },
                        createdAt: {
                            type: 'string',
                            format: 'date-time',
                            example: '2023-12-01T10:00:00Z'
                        },
                        updatedAt: {
                            type: 'string',
                            format: 'date-time',
                            example: '2023-12-01T10:00:00Z'
                        }
                    }
                },
                Order: {
                    type: 'object',
                    required: ['customerId', 'pickup', 'destination'],
                    properties: {
                        _id: {
                            type: 'string',
                            description: 'Order ID',
                            example: '507f1f77bcf86cd799439012'
                        },
                        orderId: {
                            type: 'string',
                            description: 'Unique order identifier',
                            example: 'ORD-1701421200000-ABC123'
                        },
                        customerId: {
                            type: 'string',
                            description: 'Customer user ID',
                            example: '507f1f77bcf86cd799439011'
                        },
                        driverId: {
                            type: 'string',
                            description: 'Assigned driver ID',
                            example: '507f1f77bcf86cd799439013'
                        },
                        status: {
                            type: 'string',
                            enum: ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'],
                            description: 'Order status',
                            example: 'pending'
                        },
                        pickup: {
                            type: 'object',
                            required: ['address', 'coordinates'],
                            properties: {
                                address: {
                                    type: 'string',
                                    description: 'Pickup address',
                                    example: '123 Main St, New York, NY'
                                },
                                coordinates: {
                                    type: 'object',
                                    properties: {
                                        latitude: { type: 'number', format: 'float', example: 40.7128 },
                                        longitude: { type: 'number', format: 'float', example: -74.0060 }
                                    }
                                }
                            }
                        },
                        destination: {
                            type: 'object',
                            required: ['address', 'coordinates'],
                            properties: {
                                address: {
                                    type: 'string',
                                    description: 'Destination address',
                                    example: '456 Broadway, New York, NY'
                                },
                                coordinates: {
                                    type: 'object',
                                    properties: {
                                        latitude: { type: 'number', format: 'float', example: 40.7614 },
                                        longitude: { type: 'number', format: 'float', example: -73.9776 }
                                    }
                                }
                            }
                        },
                        estimatedPrice: {
                            type: 'number',
                            format: 'float',
                            description: 'Estimated ride price',
                            example: 15.50
                        },
                        actualPrice: {
                            type: 'number',
                            format: 'float',
                            description: 'Actual ride price',
                            example: 16.25
                        },
                        distance: {
                            type: 'number',
                            format: 'float',
                            description: 'Distance in kilometers',
                            example: 5.2
                        },
                        duration: {
                            type: 'number',
                            description: 'Estimated duration in minutes',
                            example: 18
                        },
                        scheduledFor: {
                            type: 'string',
                            format: 'date-time',
                            description: 'Scheduled pickup time',
                            example: '2023-12-01T15:30:00Z'
                        },
                        createdAt: {
                            type: 'string',
                            format: 'date-time',
                            example: '2023-12-01T10:00:00Z'
                        },
                        updatedAt: {
                            type: 'string',
                            format: 'date-time',
                            example: '2023-12-01T10:00:00Z'
                        }
                    }
                },
                AuthTokens: {
                    type: 'object',
                    properties: {
                        accessToken: {
                            type: 'string',
                            description: 'JWT access token',
                            example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
                        },
                        user: {
                            $ref: '#/components/schemas/User'
                        }
                    }
                },
                Error: {
                    type: 'object',
                    properties: {
                        error: {
                            type: 'string',
                            description: 'Error message',
                            example: 'Invalid credentials'
                        },
                        message: {
                            type: 'string',
                            description: 'Detailed error description',
                            example: 'The provided email or password is incorrect'
                        },
                        status: {
                            type: 'number',
                            description: 'HTTP status code',
                            example: 400
                        }
                    }
                },
                ValidationError: {
                    type: 'object',
                    properties: {
                        error: {
                            type: 'string',
                            example: 'Validation failed'
                        },
                        details: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    field: { type: 'string', example: 'email' },
                                    message: { type: 'string', example: 'Email is required' }
                                }
                            }
                        }
                    }
                },
                Performance: {
                    type: 'object',
                    properties: {
                        timestamp: {
                            type: 'string',
                            format: 'date-time',
                            example: '2023-12-01T10:00:00Z'
                        },
                        uptime: {
                            type: 'number',
                            description: 'Server uptime in seconds',
                            example: 3600
                        },
                        memoryUsage: {
                            type: 'object',
                            properties: {
                                rss: { type: 'number', example: 45678592 },
                                heapTotal: { type: 'number', example: 29360128 },
                                heapUsed: { type: 'number', example: 18742392 },
                                external: { type: 'number', example: 1234567 }
                            }
                        },
                        activeConnections: {
                            type: 'number',
                            description: 'Number of active WebSocket connections',
                            example: 42
                        },
                        cacheStats: {
                            type: 'object',
                            properties: {
                                hits: { type: 'number', example: 150 },
                                misses: { type: 'number', example: 25 },
                                hitRate: { type: 'string', example: '85.7%' }
                            }
                        }
                    }
                }
            }
        },
        security: [
            {
                bearerAuth: []
            }
        ]
    },
    apis: ['./backend/routes/*.js', './backend/app.js']
};

const specs = swaggerJsdoc(options);

const swaggerOptions = {
    customCss: `
        .swagger-ui .topbar { display: none; }
        .swagger-ui { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        }
        .swagger-ui .info .title { 
            color: #2c3e50; 
            font-size: 2.5em; 
            font-weight: 600; 
        }
        .swagger-ui .info .description { 
            color: #34495e; 
            font-size: 1.1em; 
            line-height: 1.6; 
        }
        .swagger-ui .scheme-container { 
            background: #ecf0f1; 
            border-radius: 8px; 
            padding: 15px; 
            margin: 20px 0; 
        }
        .swagger-ui .opblock { 
            border-radius: 8px; 
            box-shadow: 0 2px 8px rgba(0,0,0,0.1); 
            margin: 15px 0; 
        }
        .swagger-ui .opblock-tag { 
            font-size: 1.3em; 
            font-weight: 600; 
            color: #2c3e50; 
        }
        .swagger-ui .opblock.opblock-get { 
            border-color: #27ae60; 
            background: rgba(39, 174, 96, 0.05); 
        }
        .swagger-ui .opblock.opblock-post { 
            border-color: #3498db; 
            background: rgba(52, 152, 219, 0.05); 
        }
        .swagger-ui .opblock.opblock-put { 
            border-color: #f39c12; 
            background: rgba(243, 156, 18, 0.05); 
        }
        .swagger-ui .opblock.opblock-delete { 
            border-color: #e74c3c; 
            background: rgba(231, 76, 60, 0.05); 
        }
        .swagger-ui .response-content-type { 
            color: #7f8c8d; 
            font-size: 0.9em; 
        }
        .swagger-ui table { 
            border-collapse: separate; 
            border-spacing: 0; 
            border-radius: 8px; 
            overflow: hidden; 
        }
        .swagger-ui table thead tr th { 
            background: #34495e; 
            color: white; 
            font-weight: 600; 
        }
        .swagger-ui .model-box { 
            border-radius: 8px; 
            border: 1px solid #bdc3c7; 
            background: #fdfdfd; 
        }
        .swagger-ui .model-title { 
            color: #2c3e50; 
            font-weight: 600; 
        }
        .swagger-ui .parameters-container { 
            background: #f8f9fa; 
            border-radius: 8px; 
            padding: 15px; 
        }
        .swagger-ui .responses-wrapper { 
            background: #f8f9fa; 
            border-radius: 8px; 
            padding: 15px; 
        }
    `,
    customSiteTitle: "Ride Sharing API Documentation",
    customfavIcon: "/favicon.ico",
    swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        showExtensions: true,
        showCommonExtensions: true,
        defaultModelExpandDepth: 2,
        defaultModelsExpandDepth: 1,
        displayOperationId: false,
        tryItOutEnabled: true,
        requestSnippetsEnabled: true,
        supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch']
    }
};

module.exports = { specs, swaggerUi, swaggerOptions };
