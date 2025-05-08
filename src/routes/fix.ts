import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

// Load environment variables
dotenv.config();

// Initialize the Gemini API client
const API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(API_KEY);

// Model configuration
const MODEL_CONFIG = {
  pro: {
    name: "gemini-2.5-pro-preview-03-25",
    precision: { temperature: 0.1, topP: 0.95, topK: 64 }
  },
  flash: {
    name: "gemini-2.5-flash-preview-04-17",
    precision: { temperature: 0.1, topP: 0.95, topK: 32 }
  }
};

const router = Router();

/**
 * Parse build errors to identify problematic files and specific error messages
 * @param buildErrors The raw build error output
 */
function parseErrors(buildErrors: string): { 
  fileErrors: Record<string, string[]>,
  generalErrors: string[]
} {
  const result = {
    fileErrors: {} as Record<string, string[]>,
    generalErrors: [] as string[]
  };
  
  // Check if buildErrors is a string
  if (typeof buildErrors !== 'string') {
    logger.error('buildErrors is not a string:', typeof buildErrors);
    return result;
  }
  
  // Split errors into lines
  const errorLines = buildErrors.split('\n');
  
  for (let i = 0; i < errorLines.length; i++) {
    const line = errorLines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // Look for file references in error messages
    // Example: "[ERROR] /path/to/file.java:[44,8] error: cannot find symbol"
    const fileErrorMatch = line.match(/\[ERROR\]\s+([^:]+):\[(\d+)(?:,\d+)?\]\s+(.*)/);
    if (fileErrorMatch) {
      const [_, filePath, lineNumber, errorMsg] = fileErrorMatch;
      const fileName = path.basename(filePath);
      
      if (!result.fileErrors[fileName]) {
        result.fileErrors[fileName] = [];
      }
      
      // Add line number info to the error
      result.fileErrors[fileName].push(`Line ${lineNumber}: ${errorMsg}`);
      continue;
    }
    
    // Look for POM errors
    // Example: "[ERROR] Failed to parse plugin descriptor for org.apache.maven.plugins:maven-compiler-plugin"
    if (line.includes('pom.xml') || line.includes('POM') || line.includes('maven')) {
      if (!result.fileErrors['pom.xml']) {
        result.fileErrors['pom.xml'] = [];
      }
      result.fileErrors['pom.xml'].push(line.replace(/\[ERROR\]\s+/, ''));
      continue;
    }
    
    // General errors
    if (line.includes('[ERROR]') || line.includes('[FATAL]')) {
      result.generalErrors.push(line.replace(/\[ERROR\]\s+|\[FATAL\]\s+/, ''));
    }
  }
  
  return result;
}

/**
 * Write fixed files to disk
 * @param fixedFiles Object with file paths and their fixed content
 * @param pluginDir The plugin directory
 */
async function writeFixedFiles(fixedFiles: Record<string, string>, pluginDir: string): Promise<boolean> {
  try {
    for (const [filename, content] of Object.entries(fixedFiles)) {
      const filePath = path.resolve(pluginDir, filename);
      
      // Make sure the directory exists
      const dirName = path.dirname(filePath);
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }
      
      // Write the fixed content
      fs.writeFileSync(filePath, content, 'utf8');
      logger.info(`Fixed file written: ${filename}`);
    }
    return true;
  } catch (error) {
    logger.error(`Error writing fixed files:`, error);
    return false;
  }
}

/**
 * Ensure value is an array or return empty array
 * @param value The value to check
 */
function ensureArray<T>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Fix endpoint
 * @route POST /api/fix
 * @desc Fix compilation errors in Minecraft plugin code
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { buildErrors, files, pluginDir } = req.body;
    
    if (!buildErrors || !files) {
      return res.status(400).json({
        status: 'error',
        message: 'Build errors and files are required'
      });
    }
    
    logger.info(`Received fix request for plugin: ${pluginDir}`);
    
    // Parse the build errors to identify problematic files
    const parsedErrors = parseErrors(buildErrors);
    logger.info(`Parsed errors: ${Object.keys(parsedErrors.fileErrors).length} files have errors, ${parsedErrors.generalErrors.length} general errors`);
    
    // Get the model for fixing code
    const fixer = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.pro.name,
      generationConfig: MODEL_CONFIG.pro.precision
    });
    
    // Files that will be fixed
    const fixedFiles: Record<string, string> = {};
    
    // Process each file to see if it needs fixing
    for (const [filename, content] of Object.entries(files)) {
      // Get errors for this file - ensure it's an array
      const fileErrors = ensureArray<string>(parsedErrors.fileErrors[path.basename(filename)] || []);
      
      // Skip files without errors
      if (fileErrors.length === 0 && !filename.endsWith('pom.xml')) continue;
      
      logger.info(`Fixing file: ${filename} with ${fileErrors.length} errors`);
      
      // Different prompt strategies for different file types
      let fixPrompt = '';
      
      // Ensure generalErrors is an array
      const generalErrors = ensureArray<string>(parsedErrors.generalErrors);
      
      if (filename.endsWith('.java')) {
        fixPrompt = `
        You are an expert Java developer specializing in Minecraft Bukkit/Spigot plugins.
        Fix the following Java code that has compilation errors:
        
        FILE: ${filename}
        \`\`\`java
        ${content}
        \`\`\`
        
        SPECIFIC ERRORS FOR THIS FILE:
        ${fileErrors.join('\n')}
        
        GENERAL BUILD ERRORS:
        ${generalErrors.join('\n')}
        
        Ensure your fix addresses all mentioned errors. Carefully analyze imports, method signatures, 
        and type compatibility. Review class hierarchy and access modifiers.
        
        IMPORTANT REQUIREMENTS:
        1. Return ONLY the fixed Java code without any explanations
        2. Do not wrap your response in markdown code blocks
        3. Do not include the original errors or comments about what you fixed
        4. Keep all existing functionality intact
        5. Ensure code style remains consistent with the original
        `;
      } else if (filename.endsWith('pom.xml')) {
        // Ensure pomErrors is an array
        const pomErrors = ensureArray<string>(parsedErrors.fileErrors['pom.xml']);
        
        fixPrompt = `
        You are an expert Maven configuration specialist for Minecraft plugins.
        Fix the following pom.xml file that has errors:
        
        \`\`\`xml
        ${content}
        \`\`\`
        
        POM ERRORS:
        ${pomErrors.length > 0 ? pomErrors.join('\n') : 'General Maven build failure'}
        
        GENERAL BUILD ERRORS:
        ${generalErrors.join('\n')}
        
        Ensure your fix addresses all mentioned errors. Check dependencies, plugin configurations,
        resource filtering, and Maven project structure.
        
        IMPORTANT REQUIREMENTS:
        1. Return ONLY the fixed pom.xml content without any explanations
        2. Do not wrap your response in markdown code blocks
        3. Include proper Spigot/Bukkit repository and dependency declarations
        4. Set Java source/target compatibility correctly
        5. Configure Maven Shade plugin if needed for packaging
        `;
      } else if (filename.endsWith('plugin.yml')) {
        fixPrompt = `
        You are an expert in Minecraft plugin configuration.
        Fix the following plugin.yml file that has errors:
        
        \`\`\`yaml
        ${content}
        \`\`\`
        
        BUILD ERRORS:
        ${generalErrors.join('\n')}
        
        Ensure your fix addresses any possible plugin.yml issues. Check main class reference,
        command definitions, permissions, and API version.
        
        IMPORTANT REQUIREMENTS:
        1. Return ONLY the fixed plugin.yml content without any explanations
        2. Do not wrap your response in markdown code blocks
        3. Verify the main class matches an existing Java class in the project
        4. Ensure proper YAML formatting with no tabs, only spaces
        `;
      } else {
        // Skip other file types
        continue;
      }
      
      try {
        const result = await fixer.generateContent(fixPrompt);
        const fixedContent = await result.response.text();
        
        // Clean up the response - remove any potential markdown or backticks
        let cleanContent = fixedContent.trim();
        if (cleanContent.startsWith("```") && cleanContent.endsWith("```")) {
          cleanContent = cleanContent.slice(cleanContent.indexOf('\n') + 1, cleanContent.lastIndexOf('```')).trim();
        }
        
        // Add the fixed content to our result
        fixedFiles[filename] = cleanContent;
        logger.info(`Successfully fixed file: ${filename}`);
      } catch (error) {
        logger.error(`Failed to fix ${filename}:`, error);
      }
    }
    
    // If we have a plugin directory, write the fixes to disk
    let writeResult = false;
    if (pluginDir && Object.keys(fixedFiles).length > 0) {
      writeResult = await writeFixedFiles(fixedFiles, pluginDir);
      logger.info(`Write fixed files result: ${writeResult ? 'Success' : 'Failed'}`);
    }
    
    return res.status(200).json({
      status: 'success',
      message: `Fixed ${Object.keys(fixedFiles).length} files`,
      filesWritten: writeResult,
      data: fixedFiles
    });
    
  } catch (error) {
    logger.error('Error fixing code:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fix code',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;