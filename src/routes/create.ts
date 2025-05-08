import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { extractPluginName, writeFilesToDisk } from '../utils/fileUtils';
import path from 'path';
import fs from 'fs';
import { addBuildJob } from '../services/buildQueue';

// Add this interface near the top of your file
interface PluginMetadata {
  name: string;
  version: string;
  apiVersion: string;
  description: string;
  author: string;
}

// Load environment variables from .env file
dotenv.config();

// Initialize the Gemini API client
const API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(API_KEY);

const router = Router();

const MODEL_CONFIG = {
  flash: {
    name: "gemini-2.5-flash-preview-04-17",
    precision: { temperature: 0.1, topP: 0.95, topK: 64 },
    creative: { temperature: 1.5, topP: 0.95, topK: 64 }  
  },
  pro: {
    name: "gemini-2.5-pro-preview-03-25",
    precision: { temperature: 0.1, topP: 0.95, topK: 64 },
    creative: { temperature: 0.2, topP: 0.95, topK: 64 }
  }
};

/**
 * Parse generated code and extract files
 * @param generatedCode Raw generated code with Markdown headings and code blocks
 * @returns Object with filenames as keys and content as values
 */
function parseGeneratedCode(generatedCode: string): Record<string, string> {
  const files: Record<string, string> = {};
  
  // Split by Markdown headers (## filename)
  const fileBlocks = generatedCode.split(/(?=^##\s+[\w\.\/]+)/m);
  
  fileBlocks.forEach(block => {
    if (!block.trim()) return;
    
    // Extract filename from header
    const headerMatch = block.match(/^##\s+([\w\.\/]+)/m);
    if (!headerMatch) return;
    
    // Replace com/example with com/pegasus in file paths
    let filename = headerMatch[1].trim().replace(/com\/example/g, 'com/pegasus');
    
    // Make sure Java files are in correct Maven structure if not already
    if (filename.endsWith('.java') && !filename.startsWith('src/')) {
      filename = `src/main/java/${filename}`;
    }
    
    // Make sure plugin.yml is in the correct Maven resources directory
    if (filename === 'plugin.yml' || filename === 'config.yml') {
      filename = `src/main/resources/${filename}`;
    }
    
    // Extract code content - look for code blocks
    const codeMatch = block.match(/```(?:java|yml|xml)?\s*\n([\s\S]*?)```/);
    
    let content = '';
    if (codeMatch) {
      // Extract just the content without backticks and language identifiers
      content = codeMatch[1].trim();
    } else {
      // If no code block found, use everything after the header line
      content = block.replace(/^##\s+[\w\.\/]+\s*\n/m, '').trim();
      // Remove any backticks that might be in the text
      content = content.replace(/```\w*|```/g, '').trim();
    }
    
    // Replace com.example with com.pegasus in package declarations and imports
    content = content.replace(/com\.example/g, 'com.pegasus');
    
    files[filename] = content;
  });
  
  return files;
}

/**
 * Validate Java code for common issues
 * @param code Java code to validate
 * @returns Array of issues found or empty array if code is valid
 */
async function validateJavaCode(code: string): Promise<string[]> {
  const validator = genAI.getGenerativeModel({ 
    model: MODEL_CONFIG.flash.name,
    generationConfig: { temperature: 0.1 }
  });
  
  const validationPrompt = `
  You are a Java and Minecraft Bukkit/Spigot expert. Review this Java code for a Minecraft plugin and identify any issues:
  
  ${code}
  
  Focus on these aspects:
  1. Syntax errors
  2. Logic errors
  3. Minecraft API usage errors
  4. Best practices violations
  5. Performance concerns
  
  Format your response as a JSON array of strings, each string describing one issue.
  If no issues are found, return an empty array.
  IMPORTANT: Return ONLY the raw JSON array without any markdown formatting, code blocks, or backticks.
  `;
  
  try {
    const result = await validator.generateContent(validationPrompt);
    const issuesText = await result.response.text();
    
    // Clean up the response to remove any markdown formatting
    let cleanedText = issuesText.trim();
    
    // Remove markdown code blocks if present
    if (cleanedText.startsWith("```") && cleanedText.endsWith("```")) {
      cleanedText = cleanedText
        .replace(/^```(?:json)?\s*\n?/, '')
        .replace(/\n?```$/, '');
    }
    
    // Fallback if we can't parse JSON
    try {
      return JSON.parse(cleanedText);
    } catch (parseError) {
      console.error('Failed to parse validation result as JSON:', parseError);
      
      // Return empty array as fallback
      return [];
    }
  } catch (error) {
    console.error('Validation error:', error);
    return [];
  }
}

/**
 * Create endpoint
 * @route POST /create
 * @desc Generate Minecraft plugin based on user requirements
 */
router.post('/', async (req, res: Response) => {
  try {
    // Extract plugin requirements from request body
    const { prompt } = req.body;
    
    // Validate prompt exists
    if (!prompt) {
      return res.status(400).json({
        success: false,
        message: 'Plugin requirements are required'
      });
    }
    
    // Check if API key is configured
    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Gemini API key not configured'
      });
    }

    // AGENT 0: Metadata Extractor - Extract basic plugin metadata
    const metadataModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.flash.name,
      generationConfig: { ...MODEL_CONFIG.flash.precision, temperature: 0.05 }
    });
    
    const metadataPrompt = `
    As a Minecraft plugin expert, generate basic metadata for a plugin based on this description:
    "${prompt}"
    
    Return ONLY a JSON object with these fields:
    - name: A creative and appropriate name for the plugin (CamelCase, no spaces)
    - version: A semantic version (e.g., "1.0.0")
    - apiVersion: Recommended Minecraft API version (e.g., "1.19")
    - description: A one-sentence description
    - author: A placeholder author name
    
    Format as valid JSON without comments or backticks.
    `;
    
    const metadataResult = await metadataModel.generateContent(metadataPrompt);
    let metadata: PluginMetadata;

    try {
      const metadataText = await metadataResult.response.text();
      // Clean up any markdown formatting
      const cleanedText = metadataText.replace(/```json|```/g, '').trim();
      metadata = JSON.parse(cleanedText) as PluginMetadata;
      console.log("Generated metadata:", metadata);
    } catch (error) {
      console.error("Failed to parse metadata:", error);
      metadata = {
        name: "MinecraftPlugin",
        version: "1.0.0",
        apiVersion: "1.19",
        description: "A Minecraft plugin",
        author: "PluginGenerator"
      };
    }

    // AGENT 1: Requirements Analyst - Refine the plugin requirements
    const refineModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.flash.name,
      generationConfig: MODEL_CONFIG.flash.precision
    });
    
    const refinementPrompt = `
    Act as a Minecraft plugin development expert. I need you to refine the following plugin requirements into a clear, 
    structured specification for a Minecraft plugin.
    
    PLUGIN NAME: ${metadata.name}
    PLUGIN VERSION: ${metadata.version}
    API VERSION: ${metadata.apiVersion}
    DESCRIPTION: ${metadata.description}
    AUTHOR: ${metadata.author}
    
    ORIGINAL REQUIREMENTS: ${prompt}
    
    Please create a refined specification with:
    1. Plugin name suggestion (use "${metadata.name}" unless you have a much better alternative)
    2. Clear functionality description
    3. Required commands and permissions
    4. Key classes needed with detailed descriptions of their roles and responsibilities
    5. Any dependencies (e.g., specific Minecraft API version)
    6. Event handlers needed
    7. Data structures required
    
    Format the output as a structured specification only, no introductory text.
    `;
    
    const refinementResult = await refineModel.generateContent(refinementPrompt);
    const refinedSpec = await refinementResult.response.text();
    
    // AGENT 2: Architect - Design the code structure with Maven support
    const architectModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.pro.name,
      generationConfig: { ...MODEL_CONFIG.pro.precision, temperature: 0.05 }
    });
    
    const architecturePrompt = `
    As a Minecraft plugin architecture expert, design the structure for this plugin specification:
    
    ${refinedSpec}
    
    Design the plugin following Maven conventions with proper package structure.
    List all required files with their purpose and relationship to other files, including:
    1. Maven pom.xml file with all required dependencies
    2. The proper Maven directory structure (src/main/java, src/main/resources)
    3. Resources like plugin.yml in the correct Maven location
    
    For each Java class, provide:
    1. Package name
    2. Class name
    3. Fields
    4. Methods with parameters and return types
    5. Interfaces implemented
    
    Format your response as a structured outline. Make sure all Bukkit/Spigot APIs are used correctly.
    `;
    
    const architectureResult = await architectModel.generateContent(architecturePrompt);
    const architecture = await architectureResult.response.text();
    
    // AGENT 3: Coder - Generate the actual plugin code with Maven support
    const codeModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.pro.name,
      generationConfig: MODEL_CONFIG.pro.precision
    });
    
    const codeGenerationPrompt = `
    As a senior Minecraft plugin developer, generate high-quality, production-ready code files for this plugin using Maven:
    
    SPECIFICATION:
    ${refinedSpec}
    
    ARCHITECTURE:
    ${architecture}
    
    Requirements:
    1. Generate ALL necessary files for a complete Maven project:
       - pom.xml with proper Bukkit/Spigot dependencies
       - Java source files in the src/main/java directory
       - Resources (plugin.yml, config.yml if needed) in the src/main/resources directory
    2. Follow Bukkit/Spigot best practices
    3. Include comprehensive JavaDoc comments
    4. Include error handling
    5. Implement null checks where appropriate
    6. Use efficient algorithms and data structures
    7. Format each file with the filename as a Markdown header (e.g., "## pom.xml") followed by the file content in a code block
    8. Replace all instances of "com.example" with "com.pegasus" in both file paths and code content
    
    The pom.xml must:
    - Include the Spigot/Bukkit API dependency
    - Set up the Maven Shade plugin to create a runnable JAR
    - Configure resource filtering
    - Set Java version to at least 8
    
    Focus on creating working, well-commented code that follows best practices and would pass a code review.
    `;
    
    const codeResult = await codeModel.generateContent(codeGenerationPrompt);
    const generatedCode = await codeResult.response.text();
    
    // Parse generated code into structured format
    const files = parseGeneratedCode(generatedCode);
    
    // AGENT 4: Quality Assurance - Validate the generated code
    const issues: Record<string, string[]> = {};
    for (const [filename, content] of Object.entries(files)) {
      if (filename.endsWith('.java')) {
        issues[filename] = await validateJavaCode(content);
      }
    }
    
    // Extract plugin name for folder creation
    const pluginName = extractPluginName(refinedSpec, files, metadata);    
    // Write files to disk
    const fileWriteResult = await writeFilesToDisk(pluginName, files);
    
    // After writing files to disk
    if (fileWriteResult.success) {
      const pluginDir = path.resolve(process.cwd(), pluginName);
      
      // Add build job to queue
      const job = await addBuildJob(pluginDir);
      console.log(`Build job added to queue: ${job.id}`);
      
      // You could save the job ID to allow checking build status later
    }
    
    // Return the results with metadata
    return res.status(200).json({ 
      success: true,
      originalRequirements: prompt,
      metadata: metadata,
      refinedSpecification: refinedSpec,
      pluginName: pluginName,
      files: files,
      codeQuality: Object.keys(issues).length > 0 ? issues : "No issues found",
      fileSystem: fileWriteResult
    });
    
  } catch (error) {
    console.error('Plugin generation failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;