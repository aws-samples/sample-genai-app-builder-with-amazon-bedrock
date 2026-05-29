import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import type { FileMap } from '~/lib/stores/files';
import { createScopedLogger } from './logger';

const logger = createScopedLogger('Download');

/**
 * Creates a zip file from the project files and downloads it
 * @param files The files map from the workbench store
 * @param filename The name of the zip file to download
 */
export async function downloadProjectAsZip(files: FileMap, filename = 'ui.zip'): Promise<void> {
  try {
    logger.info('Creating zip file from project files');
    const zip = new JSZip();
    
    // Add files to the zip
    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        // Remove the leading /home/sandbox/project/ from the path
        const relativePath = filePath.replace(/^\/home\/sandbox\/project\//, '');
        zip.file(relativePath, dirent.content);
      }
    }
    
    // Generate the zip file
    const content = await zip.generateAsync({ type: 'blob' });
    
    // Download the zip file
    saveAs(content, filename);
    logger.info(`Downloaded project as ${filename}`);
    
    return Promise.resolve();
  } catch (error) {
    logger.error('Failed to download project', error);
    return Promise.reject(error);
  }
}
