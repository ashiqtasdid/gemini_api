import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const router = Router();

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
    
    // Create temporary token
    const tempToken = "local-build-token";
    
    // Execute build in background and return immediately
    exec(`bash "${path.join(process.cwd(), 'bash.sh')}" "${pluginDir}" "${tempToken}" http://localhost:${process.env.PORT || 3001} --verbose`, 
      (error, stdout, stderr) => {
        console.log("Build completed for:", pluginDir);
        console.log("Build output:", stdout);
        if (stderr) console.error("Build errors:", stderr);
      });
    
    return res.status(200).json({
      success: true,
      message: 'Build process started',
      pluginDir: pluginDir
    });
    
  } catch (error) {
    console.error('Build process failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;