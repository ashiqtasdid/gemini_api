import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

router.get('/:pluginName', async (req, res: Response) => {
  try {
    const { pluginName } = req.params;
    const pluginDir = path.resolve(process.cwd(), pluginName);
    
    // Check if directory exists
    if (!fs.existsSync(pluginDir)) {
      return res.status(404).json({
        success: false,
        message: 'Plugin not found'
      });
    }
    
    // Check if build_result.json exists
    const buildResultPath = path.join(pluginDir, 'build_result.json');
    if (fs.existsSync(buildResultPath)) {
      const buildResult = JSON.parse(fs.readFileSync(buildResultPath, 'utf8'));
      return res.status(200).json({
        success: true,
        buildComplete: true,
        buildResult
      });
    }
    
    // Check if build is in progress
    const buildLogPath = path.join(pluginDir, 'build.log');
    if (fs.existsSync(buildLogPath)) {
      return res.status(200).json({
        success: true,
        buildComplete: false,
        message: 'Build in progress',
        logFile: buildLogPath
      });
    }
    
    return res.status(200).json({
      success: true,
      buildComplete: false,
      message: 'Build not started'
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to check build status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;