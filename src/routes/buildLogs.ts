import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import { PassThrough } from 'stream';

const router = Router();

// Store active log streams by pluginName
const activeStreams: Map<string, Set<PassThrough>> = new Map();

/**
 * Register a new log message to be sent to all active clients
 * @param pluginName Name of the plugin
 * @param logMessage Log message to broadcast
 */
export function broadcastLogMessage(pluginName: string, logMessage: string) {
  const streams = activeStreams.get(pluginName);
  if (streams && streams.size > 0) {
    const data = `data: ${JSON.stringify({timestamp: new Date().toISOString(), message: logMessage})}\n\n`;
    streams.forEach(stream => {
      try {
        stream.write(data);
      } catch (error) {
        logger.error(`Error writing to stream for ${pluginName}: ${error}`);
      }
    });
  }
}

/**
 * SSE endpoint to stream build logs for a specific plugin
 * @route GET /api/build-logs/:pluginName
 */
router.get('/:pluginName', (req: Request, res: Response) => {
  const { pluginName } = req.params;
  const pluginDir = path.resolve(process.cwd(), pluginName);
  
  // Check if plugin directory exists
  if (!fs.existsSync(pluginDir)) {
    return res.status(404).json({
      success: false,
      message: 'Plugin not found'
    });
  }
  
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
  
  // Create a PassThrough stream for this client
  const stream = new PassThrough();
  
  // Register the stream
  if (!activeStreams.has(pluginName)) {
    activeStreams.set(pluginName, new Set());
  }
  activeStreams.get(pluginName)?.add(stream);
  
  // Send initial message
  stream.write(`data: ${JSON.stringify({timestamp: new Date().toISOString(), message: "Connected to log stream"})}\n\n`);
  
  // Send any existing logs
  const buildLogPath = path.join(pluginDir, 'build.log');
  if (fs.existsSync(buildLogPath)) {
    try {
      const existingLogs = fs.readFileSync(buildLogPath, 'utf8').split('\n');
      existingLogs.forEach(line => {
        if (line.trim()) {
          stream.write(`data: ${JSON.stringify({timestamp: new Date().toISOString(), message: line})}\n\n`);
        }
      });
    } catch (error) {
      logger.error(`Error reading existing logs for ${pluginName}: ${error}`);
    }
  }
  
  // Pipe the stream to the response
  stream.pipe(res);
  
  // Handle client disconnect
  req.on('close', () => {
    const streams = activeStreams.get(pluginName);
    if (streams) {
      streams.delete(stream);
      if (streams.size === 0) {
        activeStreams.delete(pluginName);
      }
    }
    stream.end();
    logger.info(`Client disconnected from log stream for ${pluginName}`);
  });
  
  logger.info(`Client connected to log stream for ${pluginName}`);
});

export default router;