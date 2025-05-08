import Queue from 'bull';
import { exec } from 'child_process';
import path from 'path';
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
    
    console.log(`Building plugin in directory: ${pluginDir}`);
    
    exec(`bash "${scriptPath}" "${pluginDir}" "${tempToken}" http://localhost:${process.env.PORT || 3001}`, 
      (error, stdout, stderr) => {
        if (error) {
          console.error(`Build failed: ${error.message}`);
          return reject(error);
        }
        
        console.log(`Build completed: ${stdout}`);
        if (stderr) console.error(`Build warnings: ${stderr}`);
        
        // Read build result
        try {
          const buildResultPath = path.join(pluginDir, 'build_result.json');
          const buildResult = require(buildResultPath) as BuildResult;
          resolve(buildResult);
        } catch (parseError) {
          console.error(`Failed to parse build result: ${parseError}`);
          resolve({ success: true, output: stdout });
        }
      });
  });
});

export function addBuildJob(pluginDir: string) {
  return buildQueue.add({ pluginDir });
}

export default buildQueue;