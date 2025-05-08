import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { extractPluginName, writeFilesToDisk } from '../utils/fileUtils';
import path from 'path';
import fs from 'fs';
import { buildPlugin } from '../services/buildQueue';
import logger from '../utils/logger';

// Add this interface near the top of your file
interface PluginMetadata {
  name: string;
  version: string;
  apiVersion: string;
  description: string;
  author: string;
  features: string[];
  commands: string[];
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
 * Enhanced file validation to ensure all required files are present
 * @param files Generated files
 * @returns Object with validation results
 */
function validateFileStructure(files: Record<string, string>): {
  isValid: boolean;
  missingFiles: string[];
  warnings: string[];
} {
  const result = {
    isValid: true,
    missingFiles: [] as string[],
    warnings: [] as string[]
  };
  
  // Check for essential files
  const essentialFiles = [
    'pom.xml',
    'src/main/resources/plugin.yml'
  ];
  
  essentialFiles.forEach(file => {
    if (!Object.keys(files).some(f => f.endsWith(file))) {
      result.missingFiles.push(file);
      result.isValid = false;
    }
  });
  
  // Check for Java main class
  const mainClassFiles = Object.keys(files).filter(f => 
    f.endsWith('.java') && files[f].includes('extends JavaPlugin')
  );
  
  if (mainClassFiles.length === 0) {
    result.missingFiles.push('Main plugin class extending JavaPlugin');
    result.isValid = false;
  } else if (mainClassFiles.length > 1) {
    result.warnings.push(`Multiple classes extend JavaPlugin: ${mainClassFiles.join(', ')}`);
  }
  
  // Check plugin.yml for correct main class reference
  const pluginYmlFile = Object.keys(files).find(f => f.endsWith('plugin.yml'));
  if (pluginYmlFile) {
    const pluginYml = files[pluginYmlFile];
    const mainClassMatch = pluginYml.match(/main:\s*([^\s]+)/);
    
    if (mainClassMatch) {
      const mainClassRef = mainClassMatch[1];
      
      // Check if the referenced main class exists in files
      const mainClass = mainClassFiles[0];
      if (mainClass) {
        // Extract package and class name from the file
        const fileContent = files[mainClass];
        const packageMatch = fileContent.match(/package\s+([^;]+);/);
        const classNameMatch = fileContent.match(/public class\s+(\w+)/);
        
        if (packageMatch && classNameMatch) {
          const expectedMainClass = `${packageMatch[1]}.${classNameMatch[1]}`;
          if (mainClassRef !== expectedMainClass) {
            result.warnings.push(`Main class in plugin.yml (${mainClassRef}) doesn't match actual main class (${expectedMainClass})`);
          }
        }
      }
    } else {
      result.missingFiles.push('Main class reference in plugin.yml');
      result.isValid = false;
    }
  }
  
  return result;
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
  6. Null pointer exceptions
  7. Thread safety issues
  8. Resource leaks
  
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
      logger.error('Failed to parse validation result as JSON:', parseError);
      
      // Return empty array as fallback
      return [];
    }
  } catch (error) {
    logger.error('Validation error:', error);
    return [];
  }
}

/**
 * Validate all generated files in the plugin
 */
async function crossCheckPlugin(files: Record<string, string>, metadata: PluginMetadata): Promise<{
  isValid: boolean;
  structureIssues: ReturnType<typeof validateFileStructure>;
  codeIssues: Record<string, string[]>;
  consistency: string[];
}> {
  // Validate file structure
  const structureIssues = validateFileStructure(files);
  
  // Validate Java code in each file
  const codeIssues: Record<string, string[]> = {};
  for (const [filename, content] of Object.entries(files)) {
    if (filename.endsWith('.java')) {
      codeIssues[filename] = await validateJavaCode(content);
    }
  }
  
  // Run consistency check across all files
  const consistencyChecker = genAI.getGenerativeModel({ 
    model: MODEL_CONFIG.flash.name,
    generationConfig: { temperature: 0.1 }
  });
  
  // Prepare a summary of files for cross-checking
  const fileSummaries = Object.entries(files).map(([filename, content]) => {
    // For brevity, only include first 300 chars of each file
    return `## ${filename}\n${content.slice(0, 300)}${content.length > 300 ? '...' : ''}`;
  }).join('\n\n');
  
  const consistencyPrompt = `
  You are a Minecraft plugin architecture expert. Analyze these file summaries for a plugin named "${metadata.name}" 
  and identify any cross-file inconsistencies or integration issues:
  
  ${fileSummaries}
  
  Focus on:
  1. Package name consistency
  2. Class references across files
  3. Import statements correctness
  4. Plugin.yml integration with main class
  5. Command registration consistency
  6. Event handler registration
  
  Return a JSON array of consistency issues. If everything is consistent, return an empty array.
  IMPORTANT: Return ONLY the raw JSON array without any markdown formatting, code blocks, or backticks.
  `;
  
  let consistency: string[] = [];
  try {
    const result = await consistencyChecker.generateContent(consistencyPrompt);
    const issuesText = await result.response.text();
    
    // Clean up the response
    let cleanedText = issuesText.trim();
    if (cleanedText.startsWith("```") && cleanedText.endsWith("```")) {
      cleanedText = cleanedText
        .replace(/^```(?:json)?\s*\n?/, '')
        .replace(/\n?```$/, '');
    }
    
    // Parse the JSON response
    consistency = JSON.parse(cleanedText);
  } catch (error) {
    logger.error('Consistency check error:', error);
    consistency = ["Failed to perform consistency check due to error"];
  }
  
  // Determine overall validity
  const isValid = structureIssues.isValid && 
                  Object.values(codeIssues).every(issues => issues.length === 0) &&
                  consistency.length === 0;
  
  return {
    isValid,
    structureIssues,
    codeIssues,
    consistency
  };
}

/**
 * Fix common issues in generated files
 */
async function fixGeneratedFiles(
  files: Record<string, string>, 
  issues: {
    isValid: boolean;
    structureIssues: ReturnType<typeof validateFileStructure>;
    codeIssues: Record<string, string[]>;
    consistency: string[];
  }
): Promise<Record<string, string>> {
  // If no issues to fix, return original files
  if (issues.isValid) {
    return files;
  }
  
  const fixedFiles = { ...files };
  const fixer = genAI.getGenerativeModel({ 
    model: MODEL_CONFIG.pro.name,
    generationConfig: { temperature: 0.1 }
  });
  
  // Fix missing files
  for (const missingFile of issues.structureIssues.missingFiles) {
    if (missingFile === 'pom.xml') {
      // Generate a default pom.xml
      const pomFixPrompt = `
      Create a complete Maven pom.xml file for a Minecraft Spigot plugin with these requirements:
      1. Set up the Spigot/Bukkit API dependency
      2. Configure the Maven Shade plugin to create a runnable JAR
      3. Set up resource filtering
      4. Set Java version to at least 8
      5. Include JUnit for testing
      
      Return ONLY the pom.xml content without any explanation or markdown.
      `;
      
      try {
        const result = await fixer.generateContent(pomFixPrompt);
        const pomContent = await result.response.text();
        fixedFiles['pom.xml'] = pomContent.replace(/```xml|```/g, '').trim();
      } catch (error) {
        logger.error('Failed to generate pom.xml:', error);
      }
    } else if (missingFile === 'src/main/resources/plugin.yml') {
      // Find main class if available
      const mainClass = Object.keys(files).find(f => 
        f.endsWith('.java') && files[f].includes('extends JavaPlugin')
      );
      
      let mainClassName = 'com.pegasus.unknown.UnknownPlugin';
      if (mainClass) {
        const fileContent = files[mainClass];
        const packageMatch = fileContent.match(/package\s+([^;]+);/);
        const classNameMatch = fileContent.match(/public class\s+(\w+)/);
        
        if (packageMatch && classNameMatch) {
          mainClassName = `${packageMatch[1]}.${classNameMatch[1]}`;
        }
      }
      
      // Generate a default plugin.yml
      const pluginName = mainClassName.split('.').pop() || 'UnknownPlugin';
      const pluginYml = `
name: ${pluginName}
version: 1.0.0
main: ${mainClassName}
api-version: 1.19
description: A Minecraft plugin
author: PluginGenerator
commands:
  ${pluginName.toLowerCase()}:
    description: Main command for ${pluginName}
    usage: /${pluginName.toLowerCase()}
    permission: ${pluginName.toLowerCase()}.use
permissions:
  ${pluginName.toLowerCase()}.use:
    description: Allows use of main command
    default: true
      `.trim();
      
      fixedFiles['src/main/resources/plugin.yml'] = pluginYml;
    }
  }
  
  // Fix code issues in Java files
  for (const [filename, fileIssues] of Object.entries(issues.codeIssues)) {
    if (fileIssues.length > 0 && files[filename]) {
      const fixPrompt = `
      Fix these issues in the following Java code for a Minecraft Spigot plugin:
      
      ISSUES:
      ${fileIssues.map((issue: string, i: number) => `${i+1}. ${issue}`).join('\n')}
      
      CODE:
      ${files[filename]}
      
      Return ONLY the corrected code without any explanation or markdown.
      `;
      
      try {
        const result = await fixer.generateContent(fixPrompt);
        const fixedCode = await result.response.text();
        fixedFiles[filename] = fixedCode.replace(/```java|```/g, '').trim();
      } catch (error) {
        logger.error(`Failed to fix code in ${filename}:`, error);
      }
    }
  }
  
  // Fix consistency issues
  if (issues.consistency.length > 0) {
    const consistencyFixPrompt = `
    You are a Minecraft plugin expert. Fix these cross-file consistency issues in the plugin:
    
    ISSUES:
    ${issues.consistency.map((issue: string, i: number) => `${i+1}. ${issue}`).join('\n')}
    
    FILES:
    ${Object.entries(fixedFiles).map(([filename, content]) => 
      `## ${filename}\n${content}`
    ).join('\n\n')}
    
    Return ONLY the files that need to be modified, each with a markdown heading for the filename (e.g., "## pom.xml") 
    followed by the COMPLETE fixed file content. Do not include files that don't need changes.
    `;
    
    try {
      const result = await fixer.generateContent(consistencyFixPrompt);
      const fixedFilesContent = await result.response.text();
      
      // Parse and update only the fixed files
      const updatedFiles = parseGeneratedCode(fixedFilesContent);
      for (const [filename, content] of Object.entries(updatedFiles)) {
        fixedFiles[filename] = content;
      }
    } catch (error) {
      logger.error('Failed to fix consistency issues:', error);
    }
  }
  
  return fixedFiles;
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

    // AGENT 0: Metadata Extractor - Extract comprehensive plugin metadata
    const metadataModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.flash.name,
      generationConfig: { ...MODEL_CONFIG.flash.precision, temperature: 0.05 }
    });
    
    const metadataPrompt = `
    As a Minecraft plugin expert, generate comprehensive metadata for a plugin based on this description:
    "${prompt}"
    
    Return ONLY a JSON object with these fields:
    - name: A creative and appropriate name for the plugin (CamelCase, no spaces)
    - version: A semantic version (e.g., "1.0.0")
    - apiVersion: Recommended Minecraft API version (e.g., "1.19")
    - description: A concise description
    - author: A placeholder author name
    - features: An array of key features (3-5 items)
    - commands: An array of command names the plugin should implement
    
    Format as valid JSON without comments or backticks.
    `;
    
    const metadataResult = await metadataModel.generateContent(metadataPrompt);
    let metadata: PluginMetadata;

    try {
      const metadataText = await metadataResult.response.text();
      // Clean up any markdown formatting
      const cleanedText = metadataText.replace(/```json|```/g, '').trim();
      metadata = JSON.parse(cleanedText) as PluginMetadata;
      logger.info("Generated metadata:", metadata);
    } catch (error) {
      logger.error("Failed to parse metadata:", error);
      metadata = {
        name: "MinecraftPlugin",
        version: "1.0.0",
        apiVersion: "1.19",
        description: "A Minecraft plugin",
        author: "PluginGenerator",
        features: ["Basic functionality"],
        commands: ["minecraftplugin"]
      };
    }

    // AGENT 1: Requirements Analyst - Refine the plugin requirements with specific technical details
    const refineModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.pro.name,  // Using pro model for better requirements analysis
      generationConfig: { ...MODEL_CONFIG.pro.precision, temperature: 0.2 }
    });
    
    const refinementPrompt = `
    Act as a senior Minecraft plugin development expert. I need you to transform the following requirements into a 
    detailed technical specification for a Minecraft plugin.
    
    PLUGIN METADATA:
    - NAME: ${metadata.name}
    - VERSION: ${metadata.version}
    - API VERSION: ${metadata.apiVersion}
    - DESCRIPTION: ${metadata.description}
    - AUTHOR: ${metadata.author}
    - KEY FEATURES: ${metadata.features.join(', ')}
    - COMMANDS: ${metadata.commands.join(', ')}
    
    ORIGINAL REQUIREMENTS: 
    ${prompt}
    
    Create a comprehensive technical specification with:
    1. Core functionality details with technical implementation approach
    2. Data model and persistence strategy if needed
    3. Command structure with parameters and permissions
    4. Event listeners with specific Bukkit/Spigot events to handle
    5. Configuration options and default values
    6. External dependencies or libraries needed
    7. Performance considerations
    8. Potential edge cases and error handling approach
    
    Be highly specific about Bukkit/Spigot API usage, focus on implementation details rather than general descriptions.
    Format the output as a structured specification using appropriate Markdown.
    `;
    
    const refinementResult = await refineModel.generateContent(refinementPrompt);
    const refinedSpec = await refinementResult.response.text();
    
    // AGENT 2: Architect - Design a robust architecture with comprehensive test cases
    const architectModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.pro.name,
      generationConfig: { ...MODEL_CONFIG.pro.precision, temperature: 0.1 }
    });
    
    const architecturePrompt = `
    As a senior Minecraft plugin architect with expertise in clean code and design patterns, create a detailed 
    architecture for this plugin specification:
    
    ${refinedSpec}
    
    Design a robust architecture with:
    1. Proper package structure following clean architecture principles
    2. Clear separation of concerns (commands, listeners, services, data, config)
    3. Dependency injection approach where appropriate
    4. Interface-based design for testability
    5. Complete Maven project structure with essential dependencies
    6. Error handling and logging strategy
    7. Unit test cases for critical components
    8. Configuration management approach
    
    For each component:
    - Define clear responsibilities
    - Specify interfaces and concrete implementations
    - Outline relationships between components
    - Identify potential design patterns to apply
    
    Format your response as a detailed architecture document with class diagrams described in text format.
    Ensure all Bukkit/Spigot APIs are used correctly and the architecture follows current best practices.
    `;
    
    const architectureResult = await architectModel.generateContent(architecturePrompt);
    const architecture = await architectureResult.response.text();
    
    // AGENT 3: Coder - Generate high-quality code with proper error handling and documentation
    const codeModel = genAI.getGenerativeModel({ 
      model: MODEL_CONFIG.pro.name,
      generationConfig: { ...MODEL_CONFIG.pro.precision, temperature: 0.2 }
    });
    
    const codeGenerationPrompt = `
    As a principal Minecraft plugin developer, generate production-ready, high-performance code for this plugin:
    
    DETAILED SPECIFICATION:
    ${refinedSpec}
    
    ARCHITECTURE:
    ${architecture}
    
    Technical requirements:
    1. Generate ALL required files for a complete Maven project following the architecture exactly
    2. Implement proper error handling with try-catch blocks and meaningful error messages
    3. Include comprehensive JavaDoc with @param, @return, @throws tags
    4. Add plugin.yml with all commands, permissions, and dependencies correctly configured
    5. Implement unit tests for core functionality
    6. Use null safety patterns (Objects.requireNonNull, Optional<T> where appropriate)
    7. Apply appropriate design patterns where they improve code quality
    8. Use the latest Bukkit/Spigot API features appropriately for the target version
    9. Include configuration with comments and default values
    10. Replace all instances of "com.example" with "com.pegasus" in both paths and code
    
    Format each file with the filename as a Markdown header (e.g., "## pom.xml") followed by the file content in a code block.
    Ensure all file paths follow Maven conventions (src/main/java, src/main/resources, src/test/java).
    
    The code must be complete, robust, and immediately buildable with Maven without any modifications needed.
    `;
    
    const codeResult = await codeModel.generateContent(codeGenerationPrompt);
    const generatedCode = await codeResult.response.text();
    
    // Parse generated code into structured format
    const files = parseGeneratedCode(generatedCode);
    
    // AGENT 5: Quality Assurance - Cross-check the entire plugin
    logger.info("Running comprehensive cross-check on generated plugin...");
    const crossCheckResult = await crossCheckPlugin(files, metadata);
    
    // Fix any issues found during cross-check
    let finalFiles = files;
    if (!crossCheckResult.isValid) {
      logger.info("Issues found during cross-check, attempting to fix...");
      finalFiles = await fixGeneratedFiles(files, crossCheckResult);
    }
    
    // Extract plugin name for folder creation
    const pluginName = extractPluginName(refinedSpec, finalFiles, metadata);
    
    // Write files to disk
    const fileWriteResult = await writeFilesToDisk(pluginName, finalFiles);
    
    // After writing files to disk
    if (fileWriteResult.success) {
      const pluginDir = path.resolve(process.cwd(), pluginName);
      
      // Add build job to queue
      try {
        logger.info(`Starting build process for: ${pluginName}`);
        buildPlugin(pluginDir).then(result => {
          logger.info(`Build completed for ${pluginName}:`, result.success ? "SUCCESS" : "FAILED");
        }).catch(err => {
          logger.error(`Build error for ${pluginName}:`, err);
        });
      } catch (buildError) {
        logger.error(`Failed to start build process for ${pluginName}:`, buildError);
      }
    }
    
    // Return the results with metadata
    return res.status(200).json({ 
      success: true,
      originalRequirements: prompt,
      metadata: metadata,
      refinedSpecification: refinedSpec,
      pluginName: pluginName,
      fileCount: Object.keys(finalFiles).length,
      qualityCheck: {
        structureIssues: crossCheckResult.structureIssues,
        codeIssuesCount: Object.values(crossCheckResult.codeIssues).flat().length,
        consistencyIssuesCount: crossCheckResult.consistency.length,
        overallValid: crossCheckResult.isValid ? "No critical issues found" : "Issues were found and fixed"
      },
      fileSystem: fileWriteResult
    });
    
  } catch (error) {
    logger.error('Plugin generation failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;