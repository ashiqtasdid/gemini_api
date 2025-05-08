import morgan from 'morgan';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

// Define environment - more robust check for Docker environments
const isDevelopment = process.env.NODE_ENV !== 'production';
const isDocker = process.env.DOCKER_ENV === 'true' || process.env.RUNNING_IN_DOCKER === 'true';

// Create colors for development logs (disable in Docker if not explicitly enabled)
const useColors = isDevelopment && !isDocker;
const colors = {
  reset: useColors ? '\x1b[0m' : '',
  red: useColors ? '\x1b[31m' : '',
  green: useColors ? '\x1b[32m' : '',
  yellow: useColors ? '\x1b[33m' : '',
  blue: useColors ? '\x1b[34m' : '',
  magenta: useColors ? '\x1b[35m' : '',
  cyan: useColors ? '\x1b[36m' : '',
  gray: useColors ? '\x1b[37m' : ''
};

// Create a token for request ID
morgan.token('request-id', (req: Request) => {
  // Generate a request ID if not already present
  if (!req.id) {
    req.id = uuidv4();
  }
  return req.id;
});

// Create a token for user identification (if present)
morgan.token('user', (req: Request) => {
  const user = (req as any).user;
  return user ? user.id || user.username || 'authenticated' : 'anonymous';
});

// Create a token for request body (sanitized and truncated)
morgan.token('req-body', (req: Request) => {
  if (!req.body || Object.keys(req.body).length === 0) return '-';
  
  // Create a sanitized copy of the body to avoid logging sensitive data
  const sanitized = { ...req.body };
  
  // Remove sensitive fields
  ['password', 'token', 'authorization', 'key', 'secret'].forEach(field => {
    if (field in sanitized) sanitized[field] = '[REDACTED]';
  });
  
  const json = JSON.stringify(sanitized);
  // Truncate if too long
  return json.length > 200 ? `${json.substring(0, 200)}...` : json;
});

// Create a token for client IP that handles proxies
morgan.token('client-ip', (req: Request) => {
  return req.ip || 
    (req.headers['x-forwarded-for'] as string) || 
    req.connection.remoteAddress || 
    '-';
});

// Create a token for response time color based on threshold
morgan.token('response-time-colored', (req: Request, res: Response, arg?: string | number | boolean) => {
  // Access the response-time directly through the token function
  // Morgan internally calculates this from the request start time
  const start = (req as any)._startAt || process.hrtime();
  const diff = process.hrtime(start);
  const time = diff[0] * 1e3 + diff[1] * 1e-6;
  
  // Format with the specified number of digits
  const digits = typeof arg === 'string' || typeof arg === 'number' ? parseInt(String(arg), 10) : 3;
  const ms = parseInt(time.toFixed(digits), 10);
  
  if (useColors) {
    if (ms < 100) return colors.green + ms + 'ms' + colors.reset;
    if (ms < 500) return colors.yellow + ms + 'ms' + colors.reset;
    return colors.red + ms + 'ms' + colors.reset;
  }
  
  return ms + 'ms';
});

// Create a token for status code color
morgan.token('status-colored', (req: Request, res: Response) => {
  const status = res.statusCode;
  let color = colors.green;
  
  if (useColors) {
    if (status >= 400 && status < 500) color = colors.yellow;
    if (status >= 500) color = colors.red;
    return color + status + colors.reset;
  }
  
  return status.toString();
});

// Create a token for method color
morgan.token('method-colored', (req: Request) => {
  let color;
  
  if (useColors) {
    switch (req.method) {
      case 'GET': color = colors.blue; break;
      case 'POST': color = colors.green; break;
      case 'PUT': color = colors.yellow; break;
      case 'DELETE': color = colors.red; break;
      case 'PATCH': color = colors.magenta; break;
      default: color = colors.gray;
    }
    return color + req.method + colors.reset;
  }
  
  return req.method;
});

// Routes to skip logging (health checks, static files)
// Reduce the list to ensure you're not skipping important routes
const skipRoutes = [
  '/favicon.ico'  // Only skip favicon requests for now
];

// Directly log to console for Docker environments
const getStream = () => {
  if (isDocker) {
    return {
      write: (message: string) => {
        // Remove newline and log directly to console
        const logMessage = message.trim();
        
        // Log directly to console to ensure Docker captures it
        console.log(logMessage);
      }
    };
  }
  
  // Default stream for non-Docker environments
  return {
    write: (message: string) => {
      // Remove newline
      const logMessage = message.trim();
      
      // Log with appropriate level based on status code
      const statusMatch = logMessage.match(/\s(\d{3})\s/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        if (status >= 500) {
          logger.error(logMessage);
        } else if (status >= 400) {
          logger.warn(logMessage);
        } else {
          logger.http(logMessage);
        }
      } else {
        logger.http(logMessage);
      }
    }
  };
};

// Module-level counters instead of static variables
let requestCount = 0;
let debugCount = 0;

// Skip function to ignore certain routes - be less aggressive about skipping
const skip = (req: Request) => {
  // Add debug logging on first few requests
  if (requestCount < 5) {
    console.log(`[DEBUG] Handling request: ${req.method} ${req.url}`);
    requestCount++;
  }
  
  return skipRoutes.some(route => req.url === route); // Only skip exact matches
};

// Define format based on environment
const dockerFormat = [
  '[HTTP]',
  '[:date[iso]]',
  ':request-id',
  ':method',
  ':url',
  ':status',
  ':response-time ms',
  ':remote-addr',
  ':user'
].join(' ');

const developmentFormat = [
  colors.cyan + '[:date[iso]]' + colors.reset,
  ':request-id',
  ':client-ip',
  ':method-colored',
  ':url',
  ':status-colored',
  ':response-time-colored',
  colors.gray + ':user' + colors.reset,
  colors.gray + ':req-body' + colors.reset
].join(' ');

const productionFormat = [
  '[:date[iso]]',
  ':request-id',
  ':client-ip',
  ':method',
  ':url',
  ':status',
  ':response-time ms',
  ':user',
  ':referrer',
  ':user-agent'
].join(' ');

// Get the appropriate format
const getFormat = () => {
  if (isDocker) return dockerFormat;
  return isDevelopment ? developmentFormat : productionFormat;
};

// Middleware to ensure we capture the start time
const startTimeMiddleware = (req: Request, res: Response, next: NextFunction) => {
  (req as any)._startAt = process.hrtime();
  
  // Capture ending time on response finish
  res.on('finish', () => {
    (req as any)._endAt = process.hrtime();
  });
  
  next();
};

// Request ID middleware
const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Generate request ID if not provided
  req.id = req.headers['x-request-id'] as string || uuidv4();
  
  // Add request ID to response headers
  res.setHeader('X-Request-ID', req.id);
  
  // Call next middleware
  next();
};

// Debug middleware to verify logger is working
const debugMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Log the first 5 requests to make sure our logger is working
  if (debugCount < 5) {
    console.log(`[LOGGER-DEBUG] Request received: ${req.method} ${req.url}`);
    debugCount++;
  }
  next();
};

// Export middleware stack
export const httpLogger = [
  debugMiddleware,
  startTimeMiddleware,
  requestIdMiddleware,
  morgan(getFormat(), { 
    stream: getStream(),
    skip
  })
];

// Add request ID to Express Request interface
declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

// Log that the logger has been initialized
console.log('[HTTP-LOGGER] HTTP Logger initialized');