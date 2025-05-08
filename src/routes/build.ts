import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { broadcastLogMessage } from './buildLogs';

const router = Router();

// Improved build process
router.post('/', async (req, res: Response) => {
  try {
    const { pluginDir } = req.body;
    
    if (!pluginDir) {
      return res.status(400).json({
        success: false,
        message: 'Plugin directory is required'
      });
    }
    
    // Validate the directory exists
    if (!fs.existsSync(pluginDir)) {
      return res.status(404).json({
        success: false,
        message: 'Plugin directory not found'
      });
    }
    
    // Check for pom.xml
    if (!fs.existsSync(path.join(pluginDir, 'pom.xml'))) {
      return res.status(400).json({
        success: false,
        message: 'No pom.xml found in plugin directory'
      });
    }
    
    // Create build status file to indicate build is in progress
    const statusFilePath = path.join(pluginDir, 'build_status.json');
    fs.writeFileSync(statusFilePath, JSON.stringify({
      status: 'in_progress',
      startTime: new Date().toISOString(),
      pluginDir
    }));
    
    // Return response immediately
    res.status(200).json({
      success: true,
      message: 'Build process started',
      pluginDir: pluginDir
    });
    
    // Execute build in background after response is sent
    const buildProcess = spawn('bash', [
      path.join(process.cwd(), 'bash.sh'),
      pluginDir,
      "local-build-token",
      `http://localhost:${process.env.PORT || 3001}`,
      '--verbose'
    ]);
    
    logger.info(`Build process started for: ${path.basename(pluginDir)}`);
    
    // Create or clear the build log file
    const buildLogPath = path.join(pluginDir, 'build.log');
    fs.writeFileSync(buildLogPath, `Build started at ${new Date().toISOString()}\n`);
    
    // Stream stdout to both log file, application logs, and connected clients
    buildProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        logger.info(`Build output [${path.basename(pluginDir)}]: ${output}`);
        fs.appendFileSync(buildLogPath, `${output}\n`);
        
        // Broadcast to connected clients
        broadcastLogMessage(path.basename(pluginDir), output);
      }
    });
    
    // Stream stderr to both log file, application logs, and connected clients
    buildProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        // Only log as warning if it's actual stderr content
        if (!output.includes('[INFO]') && !output.includes('[SUCCESS]')) {
          logger.warn(`Build error [${path.basename(pluginDir)}]: ${output}`);
        } else {
          logger.info(`Build log [${path.basename(pluginDir)}]: ${output}`);
        }
        fs.appendFileSync(buildLogPath, `${output}\n`);
        
        // Broadcast to connected clients
        broadcastLogMessage(path.basename(pluginDir), output);
      }
    });
    
    // Set a timeout to kill the process if it takes too long (15 minutes)
    const timeout = setTimeout(() => {
      if (buildProcess.killed === false) {
        logger.error(`Build timed out for ${path.basename(pluginDir)} after 15 minutes`);
        buildProcess.kill();
        
        // Update status file
        fs.writeFileSync(statusFilePath, JSON.stringify({
          status: 'failed',
          endTime: new Date().toISOString(),
          error: 'Build process timed out after 15 minutes'
        }));
      }
    }, 15 * 60 * 1000);
    
    // Handle build completion
    buildProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        logger.info(`Build completed successfully for ${path.basename(pluginDir)}`);
        
        // Check if build_result.json exists
        const buildResultPath = path.join(pluginDir, 'build_result.json');
        if (!fs.existsSync(buildResultPath)) {
          // Create a minimal success result if it doesn't exist
          const targetDir = path.join(pluginDir, 'target');
          let jarPath = '';
          
          // Find jar file
          if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            const jarFiles = files.filter(file => file.endsWith('.jar') && !file.includes('original'));
            if (jarFiles.length > 0) {
              jarPath = path.join(targetDir, jarFiles[0]);
            }
          }
          
          // Write build result file
          fs.writeFileSync(buildResultPath, JSON.stringify({
            success: true,
            jarPath: jarPath,
            message: 'Build completed successfully'
          }));
        }
        
        // Update build status
        fs.writeFileSync(statusFilePath, JSON.stringify({
          status: 'completed',
          success: true,
          endTime: new Date().toISOString()
        }));
        
      } else {
        logger.error(`Build failed for ${path.basename(pluginDir)} with code ${code}`);
        
        // Create a minimal failure result if it doesn't exist
        const buildResultPath = path.join(pluginDir, 'build_result.json');
        if (!fs.existsSync(buildResultPath)) {
          fs.writeFileSync(buildResultPath, JSON.stringify({
            success: false,
            error: `Build failed with exit code ${code}`,
            buildLog: buildLogPath
          }));
        }
        
        // Update build status
        fs.writeFileSync(statusFilePath, JSON.stringify({
          status: 'failed',
          success: false,
          exitCode: code,
          endTime: new Date().toISOString()
        }));
      }
    });
    
    // Handle unexpected errors
    buildProcess.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(`Build error for ${path.basename(pluginDir)}: ${err.message}`);
      
      // Update build status
      fs.writeFileSync(statusFilePath, JSON.stringify({
        status: 'failed',
        success: false,
        error: err.message,
        endTime: new Date().toISOString()
      }));
      
      // Create a minimal failure result
      const buildResultPath = path.join(pluginDir, 'build_result.json');
      fs.writeFileSync(buildResultPath, JSON.stringify({
        success: false,
        error: err.message
      }));
    });
    
  } catch (error) {
    logger.error('Build process failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;