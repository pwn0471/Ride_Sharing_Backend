// Authentication and Token Management Utility
class AuthManager {
    constructor() {
        this.tokenKey = 'rideshare_token';
        this.userKey = 'rideshare_user';
        this.apiBaseUrl = 'http://localhost:3000/api';
        this.token = this.getStoredToken();
        this.user = this.getStoredUser();
    }

    // Store token with expiration tracking
    storeToken(token) {
        try {
            // Store in localStorage for persistence across sessions
            sessionStorage.setItem(this.tokenKey, token);
            this.token = token;
            console.log('✅ Token stored successfully');
            return true;
        } catch (error) {
            console.error('❌ Failed to store token:', error);
            return false;
        }
    }

    // Store user data
    storeUser(user) {
        try {
            sessionStorage.setItem(this.userKey, JSON.stringify(user));
            this.user = user;
            console.log('✅ User data stored successfully');
            return true;
        } catch (error) {
            console.error('❌ Failed to store user data:', error);
            return false;
        }
    }

    // Get stored token
    getStoredToken() {
        try {
            const token = sessionStorage.getItem(this.tokenKey);
            if (token && this.isTokenValid(token)) {
                return token;
            }
            // Remove invalid token
            if (token) {
                this.clearAuth();
            }
            return null;
        } catch (error) {
            console.error('❌ Failed to retrieve token:', error);
            return null;
        }
    }

    // Get stored user data
    getStoredUser() {
        try {
            const userData = sessionStorage.getItem(this.userKey);
            return userData ? JSON.parse(userData) : null;
        } catch (error) {
            console.error('❌ Failed to retrieve user data:', error);
            return null;
        }
    }

    // Check if token is valid (not expired)
    isTokenValid(token) {
        if (!token) return false;
        
        try {
            // Decode JWT token to check expiration
            const payload = JSON.parse(atob(token.split('.')[1]));
            const currentTime = Math.floor(Date.now() / 1000);
            
            // Check if token is expired
            if (payload.exp && payload.exp < currentTime) {
                console.log('⚠️ Token expired');
                return false;
            }
            
            return true;
        } catch (error) {
            console.error('❌ Invalid token format:', error);
            return false;
        }
    }

    // Check if user is authenticated
    isAuthenticated() {
        return !!(this.token && this.user && this.isTokenValid(this.token));
    }

    // Get authorization header
    getAuthHeader() {
        return this.token ? { 'Authorization': `Bearer ${this.token}` } : {};
    }

    // Clear authentication data
    clearAuth() {
        sessionStorage.removeItem(this.tokenKey);
        sessionStorage.removeItem(this.userKey);
        this.token = null;
        this.user = null;
        console.log('🔄 Authentication cleared');
    }

    // Login function
    async login(email, password) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (response.ok) {
                // Store token and user data
                this.storeToken(data.token);
                this.storeUser(data.user);
                console.log('✅ Login successful:', data.user.name);
                return { success: true, user: data.user };
            } else {
                console.error('❌ Login failed:', data.message);
                return { success: false, message: data.message };
            }
        } catch (error) {
            console.error('❌ Login error:', error);
            return { success: false, message: 'Network error occurred' };
        }
    }

    // Register function
    async register(userData) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(userData)
            });

            const data = await response.json();

            if (response.ok) {
                console.log('✅ Registration successful');
                return { success: true, message: data.message };
            } else {
                console.error('❌ Registration failed:', data.message);
                return { success: false, message: data.message };
            }
        } catch (error) {
            console.error('❌ Registration error:', error);
            return { success: false, message: 'Network error occurred' };
        }
    }

    // Make authenticated API calls
    async apiCall(endpoint, options = {}) {
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                ...this.getAuthHeader(),
                ...options.headers
            }
        };

        try {
            const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
                ...defaultOptions,
                ...options
            });

            // Handle unauthorized responses
            if (response.status === 401) {
                console.warn('⚠️ Unauthorized request - clearing auth data');
                this.clearAuth();
                // Don't redirect automatically - let the calling component handle it
                throw new Error('UNAUTHORIZED');
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || `HTTP error! status: ${response.status}`);
            }

            return { success: true, data };
        } catch (error) {
            if (error.message === 'UNAUTHORIZED') {
                return { success: false, error: 'UNAUTHORIZED' };
            }
            console.error(`❌ API call failed (${endpoint}):`, error);
            return { success: false, error: error.message };
        }
    }

    // Logout function
    logout() {
        this.clearAuth();
        // Redirect to main page
        window.location.href = 'index.html';
    }

    // Auto-refresh token if needed (simplified version)
    async refreshTokenIfNeeded() {
        if (!this.token) return false;
        
        try {
            const payload = JSON.parse(atob(this.token.split('.')[1]));
            const currentTime = Math.floor(Date.now() / 1000);
            const timeToExpiry = payload.exp - currentTime;
            
            // If token expires in less than 5 minutes, we should refresh
            // For now, we'll just log it - you can implement refresh endpoint later
            if (timeToExpiry < 300) {
                console.warn('⚠️ Token expires soon. Consider implementing refresh mechanism.');
            }
            
            return timeToExpiry > 0;
        } catch (error) {
            console.error('❌ Token refresh check failed:', error);
            return false;
        }
    }
}

// Utility functions for UI
class UIUtils {
    static showLoading(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = 'Loading...';
            element.disabled = true;
        }
    }

    static hideLoading(elementId, originalText) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = originalText;
            element.disabled = false;
        }
    }

    static showMessage(message, type = 'info') {
        // Create or update message element
        let messageEl = document.getElementById('message-display');
        if (!messageEl) {
            messageEl = document.createElement('div');
            messageEl.id = 'message-display';
            messageEl.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                max-width: 300px;
                padding: 1rem;
                border-radius: 5px;
                z-index: 1000;
                font-weight: bold;
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            `;
            document.body.appendChild(messageEl);
        }

        // Set message and style based on type
        messageEl.textContent = message;
        switch (type) {
            case 'success':
                messageEl.style.background = '#4CAF50';
                messageEl.style.color = 'white';
                break;
            case 'error':
                messageEl.style.background = '#f44336';
                messageEl.style.color = 'white';
                break;
            case 'warning':
                messageEl.style.background = '#ff9800';
                messageEl.style.color = 'white';
                break;
            default:
                messageEl.style.background = '#2196F3';
                messageEl.style.color = 'white';
        }

        // Auto-hide after 5 seconds
        setTimeout(() => {
            if (messageEl && messageEl.parentNode) {
                messageEl.parentNode.removeChild(messageEl);
            }
        }, 5000);
    }

    static formatDate(dateString) {
        return new Date(dateString).toLocaleString();
    }

    static formatDistance(meters) {
        if (meters < 1000) {
            return `${Math.round(meters)}m`;
        }
        return `${(meters / 1000).toFixed(1)}km`;
    }
}

// Create global instance
window.authManager = new AuthManager();
window.uiUtils = UIUtils;
