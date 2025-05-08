import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger';
import { broadcastLogMessage } from './buildLogs';

const router = Router();

/**
 * Get all files in a directory recursively
 * @param dir Directory to scan
 * @param fileList Accumulated file list (for recursion)
 * @returns Array of file paths relative to the provided directory
 */
function getAllFiles(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    
    if (fs.statSync(filePath).isDirectory()) {
      // Skip target, node_modules and hidden directories
      if (file !== 'target' && file !== 'node_modules' && !file.startsWith('.')) {
        fileList = getAllFiles(filePath, fileList);
      }
    } else {
      // Only include source code and configuration files
      if (file.endsWith('.java') || file.endsWith('.xml') || file.endsWith('.yml') || file.endsWith('.properties')) {
        fileList.push(filePath);
      }
    }
  });
  
  return fileList;
}

/**
 * Attempt to fix build errors by sending to the fix API
 * @param pluginDir Plugin directory
 * @param buildErrors Build error output
 * @returns Whether the fix was successful
 */
async function attemptFix(pluginDir: string, buildErrors: string): Promise<boolean> {
  try {
    logger.info(`Attempting to fix build errors for ${path.basename(pluginDir)}`);
    
    // Get all source files from the plugin directory
    const allFiles = getAllFiles(pluginDir);
    
    // Read the content of each file
    const filesContent: Record<string, string> = {};
    for (const filePath of allFiles) {
      try {
        // Create relative path from pluginDir
        const relativePath = path.relative(pluginDir, filePath);
        filesContent[relativePath] = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        logger.error(`Failed to read file ${filePath}:`, error);
      }
    }
    
    // Send the files and build errors to the fix API
    const response = await axios.post('http://localhost:3001/api/fix', {
      buildErrors,
      files: filesContent,
      pluginDir
    });
    
    if (response.data.status === 'success') {
      logger.info(`Successfully fixed ${Object.keys(response.data.data).length} files in ${path.basename(pluginDir)}`);
      return true;
    } else {
      logger.warn(`Fix API failed for ${path.basename(pluginDir)}: ${response.data.message}`);
      return false;
    }
  } catch (error) {
    logger.error(`Error attempting to fix build errors:`, error);
    return false;
  }
}

/**
 * Build process handler
 * @route POST /build
 */
router.post('/', async (req, res: Response) => {
  try {
    const { pluginDir, autoFix = true } = req.body;
    
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
    
    // Track build attempts and errors for auto-fix
    let buildAttempts = 0;
    const maxBuildAttempts = 3;
    let lastBuildErrors = '';
    
    // Function to execute the build process
    const executeBuild = async () => {
      buildAttempts++;
      logger.info(`Starting build attempt ${buildAttempts} for ${path.basename(pluginDir)}`);
      
      // Execute build in background
      const buildProcess = spawn('bash', [
        path.join(process.cwd(), 'bash.sh'),
        pluginDir,
        "local-build-token",
        `http://localhost:${process.env.PORT || 3001}`,
        '--verbose'
      ]);
      
      // Create or clear the build log file
      const buildLogPath = path.join(pluginDir, 'build.log');
      fs.writeFileSync(buildLogPath, `Build attempt ${buildAttempts} started at ${new Date().toISOString()}\n`);
      
      // Collect build errors for potential fixing
      lastBuildErrors = '';
      
      // Stream stdout to log file and broadcast
      buildProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          logger.info(`Build output [${path.basename(pluginDir)}]: ${output}`);
          fs.appendFileSync(buildLogPath, `${output}\n`);
          broadcastLogMessage(path.basename(pluginDir), output);
        }
      });
      
      // Stream stderr to log file and broadcast
      buildProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          // Capture build errors for auto-fix
          if (output.includes('[ERROR]') || output.includes('[FATAL]')) {
            lastBuildErrors += output + '\n';
          }
          
          // Log based on content type
          if (!output.includes('[INFO]') && !output.includes('[SUCCESS]')) {
            logger.warn(`Build error [${path.basename(pluginDir)}]: ${output}`);
          } else {
            logger.info(`Build log [${path.basename(pluginDir)}]: ${output}`);
          }
          
          fs.appendFileSync(buildLogPath, `${output}\n`);
          broadcastLogMessage(path.basename(pluginDir), output);
        }
      });
      
      // Set a timeout to kill the process if it takes too long (10 minutes)
      const timeout = setTimeout(() => {
        if (buildProcess.killed === false) {
          logger.error(`Build timed out for ${path.basename(pluginDir)} after 10 minutes`);
          buildProcess.kill();
          
          // Update status file
          fs.writeFileSync(statusFilePath, JSON.stringify({
            status: 'failed',
            endTime: new Date().toISOString(),
            error: 'Build process timed out after 10 minutes'
          }));
        }
      }, 10 * 60 * 1000);
      
      // Return a promise that resolves when the build completes
      return new Promise<{success: boolean; exit: number | null}>((resolve) => {
        // Handle build completion
        buildProcess.on('close', async (code) => {
          clearTimeout(timeout);
          
          if (code === 0) {
            logger.info(`Build attempt ${buildAttempts} completed successfully for ${path.basename(pluginDir)}`);
            
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
                message: 'Build completed successfully',
                buildAttempts
              }));
            }
            
            // Update build status
            fs.writeFileSync(statusFilePath, JSON.stringify({
              status: 'completed',
              success: true,
              endTime: new Date().toISOString(),
              buildAttempts
            }));
            
            resolve({ success: true, exit: code });
          } else {
            logger.error(`Build attempt ${buildAttempts} failed for ${path.basename(pluginDir)} with code ${code}`);
            
            // If auto-fix is enabled and we haven't reached the max attempts
            if (autoFix && buildAttempts < maxBuildAttempts && lastBuildErrors) {
              broadcastLogMessage(path.basename(pluginDir), `Build failed. Attempting to fix issues automatically...`);
              
              // Try to fix the errors
              const fixResult = await attemptFix(pluginDir, lastBuildErrors);
              
              if (fixResult) {
                broadcastLogMessage(path.basename(pluginDir), `Fixed potential issues. Retrying build...`);
                resolve({ success: false, exit: code });
              } else {
                createFailureResult(code);
                resolve({ success: false, exit: code });
              }
            } else {
              // No more attempts or auto-fix disabled
              createFailureResult(code);
              resolve({ success: false, exit: code });
            }
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
            endTime: new Date().toISOString(),
            buildAttempts
          }));
          
          // Create a minimal failure result
          const buildResultPath = path.join(pluginDir, 'build_result.json');
          fs.writeFileSync(buildResultPath, JSON.stringify({
            success: false,
            error: err.message,
            buildAttempts
          }));
          
          resolve({ success: false, exit: null });
        });
      });
    };
    
    // Helper function to create failure result
    const createFailureResult = (code: number | null) => {
      // Create a minimal failure result if it doesn't exist
      const buildResultPath = path.join(pluginDir, 'build_result.json');
      if (!fs.existsSync(buildResultPath)) {
        fs.writeFileSync(buildResultPath, JSON.stringify({
          success: false,
          error: `Build failed with exit code ${code}`,
          buildLog: path.join(pluginDir, 'build.log'),
          buildAttempts
        }));
      }
      
      // Update build status
      fs.writeFileSync(statusFilePath, JSON.stringify({
        status: 'failed',
        success: false,
        exitCode: code,
        endTime: new Date().toISOString(),
        buildAttempts
      }));
    };
    
    // Start the build loop
    let buildResult;
    while (buildAttempts < maxBuildAttempts) {
      buildResult = await executeBuild();
      
      // If build succeeded or we've reached max attempts, break
      if (buildResult.success || buildAttempts >= maxBuildAttempts) {
        break;
      }
    }
    
    // Log final result
    if (buildResult?.success) {
      logger.info(`Build process completed successfully for ${path.basename(pluginDir)} after ${buildAttempts} attempt(s)`);
    } else {
      logger.error(`Build process failed for ${path.basename(pluginDir)} after ${buildAttempts} attempt(s)`);
    }
    
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