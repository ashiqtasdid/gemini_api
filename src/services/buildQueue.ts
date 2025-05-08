import { exec, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

// Define the build result type
export interface BuildResult {
  success: boolean;
  jarPath?: string;
  error?: string;
  buildLog?: string;
  output?: string;
  fixes?: number;
  noShade?: boolean;
  buildErrors?: string;
}

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
      // Use spawn instead of exec for streaming output
      const buildProcess = spawn('bash', [
        scriptPath, 
        pluginDir, 
        tempToken, 
        apiHost,
        '--verbose' // Add verbose flag to see all output
      ]);
      
      // Stream stdout to application logs
      buildProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) logger.info(`Build output: ${output}`);
      });
      
      // Stream stderr to application logs
      buildProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) logger.warn(`Build error: ${output}`);
      });
      
      // Handle completion
      buildProcess.on('close', (code) => {
        if (code !== 0) {
          logger.error(`Build process exited with code ${code}`);
          reject(new Error(`Build failed with exit code ${code}`));
          return;
        }
        
        try {
          const buildResultPath = path.join(pluginDir, 'build_result.json');
          if (fs.existsSync(buildResultPath)) {
            const buildResult = JSON.parse(fs.readFileSync(buildResultPath, 'utf8'));
            resolve(buildResult as BuildResult);
          } else {
            logger.warn(`No build_result.json found at: ${buildResultPath}`);
            resolve({ 
              success: true, 
              output: 'Build completed but no result file was found'
            });
          }
        } catch (parseError) {
          logger.error(`Failed to parse build result: ${parseError}`);
          reject(parseError);
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