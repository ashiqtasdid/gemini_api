import fs from 'fs';
import path from 'path';

/**
 * Extract plugin name from metadata, refined specification, or plugin.yml
 * @param refinedSpec The refined plugin specification
 * @param files Generated files object
 * @param metadata Optional metadata object from AI 
 * @returns Plugin name or default name if not found
 */
export function extractPluginName(
  refinedSpec: string, 
  files: Record<string, string>,
  metadata?: { name?: string }
): string {
  // First try to get from metadata if available
  if (metadata?.name) {
    return metadata.name.trim();
  }
  
  // Try to extract from specification
  const nameMatch = refinedSpec.match(/Plugin Name Suggestion:[\s\n]*([A-Za-z0-9_]+)/i);
  if (nameMatch && nameMatch[1]) {
    return nameMatch[1].trim();
  }
  
  // Try to extract from plugin.yml in either location (Maven or non-Maven)
  for (const possiblePath of ['plugin.yml', 'src/main/resources/plugin.yml']) {
    if (files[possiblePath]) {
      const pluginYmlNameMatch = files[possiblePath].match(/name:\s*([A-Za-z0-9_]+)/);
      if (pluginYmlNameMatch && pluginYmlNameMatch[1]) {
        return pluginYmlNameMatch[1].trim();
      }
    }
  }
  
  // Default name
  return 'MinecraftPlugin';
}

/**
 * Create directory recursively if it doesn't exist
 * @param dirPath Directory path to create
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Write generated files to disk
 * @param pluginName Name of the plugin
 * @param files Generated files object
 * @param basePath Optional base path to write files to (defaults to current working directory)
 * @returns Object with status and paths of created files
 */
export async function writeFilesToDisk(
  pluginName: string, 
  files: Record<string, string>,
  basePath: string = process.cwd()
): Promise<{
  success: boolean;
  createdFiles: string[];
  error?: string;
}> {
  try {
    const pluginDir = path.resolve(basePath, pluginName);
    ensureDirectoryExists(pluginDir);
    
    const createdFiles: string[] = [];
    
    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(pluginDir, filename);
      const fileDir = path.dirname(filePath);
      
      // Create directory structure if it doesn't exist
      ensureDirectoryExists(fileDir);
      
      // Write file
      fs.writeFileSync(filePath, content);
      createdFiles.push(filePath);
    }
    
    return { success: true, createdFiles };
  } catch (error) {
    console.error('Error writing files:', error);
    return { 
      success: false, 
      createdFiles: [],
      error: error instanceof Error ? error.message : 'Unknown error writing files'
    };
  }
}