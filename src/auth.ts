/**
 * ClawRoute Authentication Middleware
 *
 * Simple token-based authentication for the proxy.
 * If CLAWROUTE_TOKEN is set, requires Bearer token or query param.
 */

import { Context, Next } from 'hono';
import { ClawRouteConfig } from './types.js';

/**
 * Create authentication middleware.
 *
 * @param config - The ClawRoute configuration
 * @returns Hono middleware function
 */
export function createAuthMiddleware(config: ClawRouteConfig) {
    return async (c: Context, next: Next) => {
        // If no auth token configured, accept all requests
        if (!config.authToken) {
            return next();
        }

        // Check Authorization header
        const authHeader = c.req.header('Authorization');
        if (authHeader) {
            const [type, token] = authHeader.split(' ');
            if (type?.toLowerCase() === 'bearer' && token === config.authToken) {
                return next();
            }
        }

        // Check query parameter
        const queryToken = c.req.query('token');
        if (queryToken === config.authToken) {
            return next();
        }

        // Authentication failed
        return c.json(
            {
                error: {
                    message: 'Unauthorized. Provide Bearer token in Authorization header or token query param.',
                    type: 'authentication_error',
                    code: 'unauthorized',
                },
            },
            401
        );
    };
}

/**
 * Log a warning if no auth token is configured.
 *
 * @param config - The ClawRoute configuration
 */
export function logAuthWarning(config: ClawRouteConfig): void {
    if (!config.authToken) {
        console.warn(
            '⚠️  Warning: No CLAWROUTE_TOKEN set. The proxy is accessible to any process on localhost.'
        );
        console.warn('   Set CLAWROUTE_TOKEN for added security, especially if exposing beyond localhost.');
    }
}
