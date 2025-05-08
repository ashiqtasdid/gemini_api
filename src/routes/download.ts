import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const router = Router();

/**
 * Build status endpoint
 * @route GET /api/build-status/:pluginName
 * @desc Check the status of a plugin build
 */
router.get('/:pluginName', async (req, res: Response) => {
  try {
    const { pluginName } = req.params;
    const pluginDir = path.resolve(process.cwd(), pluginName);
    
    logger.info(`Checking build status for plugin: ${pluginName}`);
    
    // Check if directory exists
    if (!fs.existsSync(pluginDir)) {
      logger.warn(`Plugin directory not found: ${pluginDir}`);
      return res.status(404).json({
        success: false,
        message: 'Plugin not found'
      });
    }
    
    // Check if build_result.json exists
    const buildResultPath = path.join(pluginDir, 'build_result.json');
    
    if (fs.existsSync(buildResultPath)) {
      try {
        const buildResult = JSON.parse(fs.readFileSync(buildResultPath, 'utf8'));
        logger.info(`Build result found for ${pluginName}: ${JSON.stringify(buildResult)}`);
        return res.status(200).json({
          success: true,
          buildComplete: true,
          buildResult
        });
      } catch (parseError) {
        logger.error(`Error parsing build_result.json: ${parseError}`);
        return res.status(500).json({
          success: false,
          message: 'Error parsing build result file'
        });
      }
    }
    
    // *** NEW CODE: Check if JAR file exists even without build_result.json ***
    // This is a fallback in case build_result.json wasn't created properly
    const targetDir = path.join(pluginDir, 'target');
    if (fs.existsSync(targetDir)) {
      try {
        const files = fs.readdirSync(targetDir);
        const jarFiles = files.filter(file => file.endsWith('.jar') && !file.includes('original'));
        
        if (jarFiles.length > 0) {
          const jarPath = path.join(targetDir, jarFiles[0]);
          logger.info(`JAR file found without build_result.json: ${jarPath}`);
          
          // Create build_result.json since it doesn't exist
          const buildResult = {
            success: true,
            jarPath: jarPath
          };
          
          try {
            fs.writeFileSync(buildResultPath, JSON.stringify(buildResult, null, 2));
            logger.info(`Created missing build_result.json for ${pluginName}`);
          } catch (writeError) {
            logger.warn(`Could not create build_result.json: ${writeError}`);
          }
          
          return res.status(200).json({
            success: true,
            buildComplete: true,
            buildResult
          });
        }
      } catch (readError) {
        logger.warn(`Error checking target directory: ${readError}`);
      }
    }
    
    // Check if build is in progress by looking for build.log
    const buildLogPath = path.join(pluginDir, 'build.log');
    if (fs.existsSync(buildLogPath)) {
      const logMtime = fs.statSync(buildLogPath).mtime;
      const now = new Date();
      const timeDiff = now.getTime() - logMtime.getTime();
      
      // If log was updated in the last 5 minutes, assume build is still in progress
      if (timeDiff < 5 * 60 * 1000) {
        logger.info(`Build appears to be in progress for ${pluginName} (log updated ${timeDiff / 1000}s ago)`);
        return res.status(200).json({
          success: true,
          buildComplete: false,
          message: 'Build in progress',
          logFile: buildLogPath
        });
      } else {
        // If log hasn't been updated in 5 minutes, check if there might be a JAR anyway
        try {
          const targetDir = path.join(pluginDir, 'target');
          if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            const jarFiles = files.filter(file => file.endsWith('.jar') && !file.includes('original'));
            
            if (jarFiles.length > 0) {
              const jarPath = path.join(targetDir, jarFiles[0]);
              logger.info(`JAR file found with stale build log: ${jarPath}`);
              
              return res.status(200).json({
                success: true,
                buildComplete: true,
                buildResult: {
                  success: true,
                  jarPath: jarPath
                }
              });
            }
          }
        } catch (readError) {
          logger.warn(`Error checking target directory: ${readError}`);
        }
        
        logger.warn(`Build log exists but is stale (${timeDiff / 1000}s old) for ${pluginName}`);
        return res.status(200).json({
          success: true,
          buildComplete: false,
          message: 'Build may be stuck or completed without creating build_result.json'
        });
      }
    }
    
    return res.status(200).json({
      success: true,
      buildComplete: false,
      message: 'Build not started or status unknown'
    });
    
  } catch (error) {
    logger.error('Failed to check build status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check build status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;