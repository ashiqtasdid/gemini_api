import morgan from 'morgan';
import logger from '../utils/logger';

// Create a stream for Morgan that writes to our Winston logger
const stream = {
  write: (message: string) => {
    // Remove newline
    const logMessage = message.trim();
    logger.http(logMessage);
  },
};

// Create middleware using Morgan
export const httpLogger = morgan(
  // Define log format
  ':remote-addr :method :url :status :res[content-length] - :response-time ms',
  { stream }
);