import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const router = Router();

/**
 * Download endpoint
 * @route GET /api/download/:pluginName
 * @desc Download the compiled plugin JAR file
 */
router.get('/:pluginName', async (req, res: Response) => {
  try {
    const { pluginName } = req.params;
    const pluginDir = path.resolve(process.cwd(), pluginName);
    
    logger.info(`Download requested for plugin: ${pluginName}`);
    
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
    if (!fs.existsSync(buildResultPath)) {
      logger.warn(`Build result not found for plugin: ${pluginName}`);
      return res.status(404).json({
        success: false,
        message: 'Build result not found. The plugin may not be built yet.'
      });
    }
    
    // Read build result to get JAR path
    const buildResult = JSON.parse(fs.readFileSync(buildResultPath, 'utf8'));
    
    if (!buildResult.success || !buildResult.jarPath) {
      logger.warn(`No JAR path in build result for plugin: ${pluginName}`);
      return res.status(404).json({
        success: false,
        message: 'Plugin JAR file not found. The build may have failed.',
        buildResult
      });
    }
    
    // Resolve JAR path (could be absolute or relative to plugin directory)
    const jarPath = path.isAbsolute(buildResult.jarPath) 
      ? buildResult.jarPath 
      : path.join(pluginDir, buildResult.jarPath);
    
    // Check if JAR file exists
    if (!fs.existsSync(jarPath)) {
      logger.warn(`JAR file not found at path: ${jarPath}`);
      return res.status(404).json({
        success: false,
        message: 'Plugin JAR file not found at the expected location.'
      });
    }
    
    // Get JAR filename
    const jarFileName = path.basename(jarPath);
    
    logger.info(`Sending JAR file: ${jarFileName} (${fs.statSync(jarPath).size} bytes)`);
    
    // Set headers for file download
    res.set({
      'Content-Disposition': `attachment; filename="${jarFileName}"`,
      'Content-Type': 'application/java-archive'
    });
    
    // Stream the file
    const fileStream = fs.createReadStream(jarPath);
    fileStream.pipe(res);
    
  } catch (error) {
    logger.error('Download failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to download plugin',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;