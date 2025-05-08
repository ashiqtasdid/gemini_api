import Queue from 'bull';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

// Define the build result type
interface BuildResult {
  success: boolean;
  jarPath?: string;
  error?: string;
  buildLog?: string;
  output?: string;
  fixes?: number;
  noShade?: boolean;
  buildErrors?: string;
}

// Create build queue with Redis connection from environment variables
const buildQueue = new Queue<{pluginDir: string}>('plugin-build-queue', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  }
});

// Process build jobs
buildQueue.process(async (job): Promise<BuildResult> => {
  const { pluginDir } = job.data;
  
  return new Promise<BuildResult>((resolve, reject) => {
    const tempToken = "local-build-token";
    const scriptPath = path.join(process.cwd(), 'bash.sh');
    
    // Fix API host for Docker environment
    const apiHost = process.env.DOCKER_ENV === 'true' 
      ? 'http://localhost:3001'  // Inside Docker, use container's own port
      : `http://localhost:${process.env.PORT || 3001}`;
    
    logger.info(`Building plugin in directory: ${pluginDir}`);
    
    // Add debugging
    try {
      // Ensure bash.sh is executable
      fs.chmodSync(scriptPath, '755');
      
      exec(`bash "${scriptPath}" "${pluginDir}" "${tempToken}" ${apiHost}`, 
        (error, stdout, stderr) => {
          if (error) {
            logger.error(`Build failed: ${error.message}`);
            logger.error(`Build command: bash "${scriptPath}" "${pluginDir}" "${tempToken}" ${apiHost}`);
            if (stdout) logger.error(`Build stdout: ${stdout}`);
            if (stderr) logger.error(`Build stderr: ${stderr}`);
            return reject(error);
          }
          
          logger.info(`Build completed: ${stdout.substring(0, 200)}...`);
          if (stderr) logger.warn(`Build warnings: ${stderr.substring(0, 200)}...`);
          
          // Read build result
          try {
            const buildResultPath = path.join(pluginDir, 'build_result.json');
            if (fs.existsSync(buildResultPath)) {
              const buildResult = JSON.parse(fs.readFileSync(buildResultPath, 'utf8'));
              resolve(buildResult as BuildResult);
            } else {
              logger.warn(`No build_result.json found at: ${buildResultPath}`);
              // Default response if no build result file
              resolve({ 
                success: true, 
                output: stdout,
                error: stderr || undefined
              });
            }
          } catch (parseError) {
            logger.error(`Failed to parse build result: ${parseError}`);
            resolve({ success: true, output: stdout });
          }
        });
    } catch (execError) {
      logger.error(`Failed to execute build command: ${execError}`);
      reject(execError);
    }
  });
});

/**
 * Execute a build job directly
 * @param pluginDir Directory of the plugin to build
 * @returns Promise that resolves with build result
 */
export function buildPlugin(pluginDir: string): Promise<BuildResult> {
  return new Promise<BuildResult>((resolve, reject) => {
    const tempToken = "local-build-token";
    const scriptPath = path.join(process.cwd(), 'bash.sh');
    
    // Fix API host for Docker environment
    const apiHost = process.env.DOCKER_ENV === 'true' 
      ? 'http://localhost:3001'  // Inside Docker, use container's own port
      : `http://localhost:${process.env.PORT || 3001}`;
    
    logger.info(`Building plugin in directory: ${pluginDir}`);
    
    try {
      // Ensure bash.sh is executable
      fs.chmodSync(scriptPath, '755');
      
      exec(`bash "${scriptPath}" "${pluginDir}" "${tempToken}" ${apiHost}`, 
        (error, stdout, stderr) => {
          if (error) {
            logger.error(`Build failed: ${error.message}`);
            logger.error(`Build command: bash "${scriptPath}" "${pluginDir}" "${tempToken}" ${apiHost}`);
            if (stdout) logger.error(`Build stdout: ${stdout}`);
            if (stderr) logger.error(`Build stderr: ${stderr}`);
            return reject(error);
          }
          
          logger.info(`Build completed: ${stdout.substring(0, 200)}...`);
          if (stderr) logger.warn(`Build warnings: ${stderr.substring(0, 200)}...`);
          
          // Read build result
          try {
            const buildResultPath = path.join(pluginDir, 'build_result.json');
            if (fs.existsSync(buildResultPath)) {
              const buildResult = JSON.parse(fs.readFileSync(buildResultPath, 'utf8'));
              resolve(buildResult as BuildResult);
            } else {
              logger.warn(`No build_result.json found at: ${buildResultPath}`);
              // Default response if no build result file
              resolve({ 
                success: true, 
                output: stdout,
                error: stderr || undefined
              });
            }
          } catch (parseError) {
            logger.error(`Failed to parse build result: ${parseError}`);
            resolve({ success: true, output: stdout });
          }
        });
    } catch (execError) {
      logger.error(`Failed to execute build command: ${execError}`);
      reject(execError);
    }
  });
}

// Legacy function name for backward compatibility
export function addBuildJob(pluginDir: string): Promise<BuildResult> {
  return buildPlugin(pluginDir);
}

export default buildQueue;