import express from 'express';
import createRoute from './routes/create';
import fixRoute from './routes/fix';
import buildRoute from './routes/build';
import buildStatusRoute from './routes/buildStatus';
import downloadRoute from './routes/download';
import { authenticateToken } from './middleware/auth';
import { httpLogger } from './middleware/httpLogger';
import logger from './utils/logger';
import buildLogsRouter from './routes/buildLogs';

const app = express();

// Configure middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(httpLogger); // Add HTTP request logging

// Define routes
app.get('/', (req, res) => {
  res.json({ message: 'Hello from Gemini API!' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Protected routes with authentication
app.use('/create', authenticateToken, createRoute);
app.use('/api/fix', authenticateToken, fixRoute);
app.use('/api/build', authenticateToken, buildRoute);
app.use('/api/build-status', authenticateToken, buildStatusRoute);
app.use('/api/download', authenticateToken, downloadRoute);
app.use('/api/build-logs', buildLogsRouter);


// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`, { 
    error: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
  });
});

export default app;