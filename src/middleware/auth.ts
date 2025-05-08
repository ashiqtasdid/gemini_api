import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import logger from '../utils/logger';

dotenv.config();

// Array of valid tokens (in production, use a database or auth service)
const VALID_TOKENS = [
  process.env.API_TOKEN || 'default-token', 
  'local-build-token' // Used by build script
];

export const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  // Get auth header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    logger.warn(`Authentication failed: No token provided [${req.ip}] ${req.method} ${req.path}`);
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required: No token provided'
    });
  }
  
  // Simple token validation
  if (!VALID_TOKENS.includes(token)) {
    logger.warn(`Authentication failed: Invalid token [${req.ip}] ${req.method} ${req.path}`);
    return res.status(403).json({ 
      success: false, 
      message: 'Authentication failed: Invalid or expired token'
    });
  }
  
  logger.debug(`Authenticated request from [${req.ip}]`);
  next();
};