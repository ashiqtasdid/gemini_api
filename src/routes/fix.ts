import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize the Gemini API client
const API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(API_KEY);

const router = Router();

/**
 * Fix endpoint
 * @route POST /api/fix
 * @desc Fix compilation errors in Minecraft plugin code
 */
router.post('/', async (req, res: Response) => {
  try {
    const { buildErrors, files } = req.body;
    
    if (!buildErrors || !files) {
      return res.status(400).json({
        status: 'error',
        message: 'Build errors and files are required'
      });
    }
    
    // Get the model for fixing code
    const fixer = genAI.getGenerativeModel({ 
      model: "gemini-2.5-pro-preview-03-25",
      generationConfig: { temperature: 0.1, topP: 0.95, topK: 64 }
    });
    
    // Find Java files with compilation errors
    const fixedFiles: Record<string, string> = {};
    
    // Process each file to see if it needs fixing
    for (const [filename, content] of Object.entries(files)) {
      // Focus on Java files
      if (!filename.endsWith('.java')) continue;
      
      // Check if this file has errors mentioned in the build errors
      // This is a simplistic check - you might want to improve this logic
      if (buildErrors.includes(filename)) {
        const fixPrompt = `
        You are an expert Java developer focusing on Minecraft Bukkit/Spigot plugins.
        Fix the following Java code that has compilation errors:
        
        ${content}
        
        The build system reported these errors:
        ${buildErrors}
        
        Please provide ONLY the fixed code without any comments or explanations.
        Do not wrap your response in markdown code blocks.
        `;
        
        const result = await fixer.generateContent(fixPrompt);
        const fixedContent = await result.response.text();
        
        // Add the fixed content to our result
        fixedFiles[filename] = fixedContent;
      }
    }
    
    // Check for Maven configuration issues in pom.xml
    if (buildErrors.includes('pom.xml') && files['pom.xml']) {
      const pomFixPrompt = `
      You are an expert Maven configuration specialist.
      Fix the following pom.xml file that has errors:
      
      ${files['pom.xml']}
      
      The build system reported these errors:
      ${buildErrors}
      
      Please provide ONLY the fixed pom.xml content without any comments or explanations.
      Do not wrap your response in markdown code blocks.
      `;
      
      const pomResult = await fixer.generateContent(pomFixPrompt);
      const fixedPom = await pomResult.response.text();
      
      fixedFiles['pom.xml'] = fixedPom;
    }
    
    return res.status(200).json({
      status: 'success',
      data: fixedFiles
    });
    
  } catch (error) {
    console.error('Error fixing code:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fix code',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;