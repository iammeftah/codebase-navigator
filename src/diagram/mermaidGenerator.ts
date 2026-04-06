import { ProjectIndex } from '../analyzer/types';

export function generateMermaid(index: ProjectIndex): string {
  const lines: string[] = ['graph TD'];

  // Group files by layer, then by subfolder within that layer
  const groups: Record<string, Record<string, ProjectIndex['files'][number][]>> = {};

  for (const file of index.files) {
    const layer = file.layer;
    // extract subfolder — e.g. components/ui, components/common
    const parts = file.relativePath.split('/');
    const subfolder = parts.length > 2 ? parts[1] + '/' + parts[2] : parts[1] || 'root';

    if (!groups[layer]) { groups[layer] = {}; }
    if (!groups[layer][subfolder]) { groups[layer][subfolder] = []; }
    groups[layer][subfolder].push(file);
  }

  let subgraphIndex = 0;

  for (const [layer, subfolders] of Object.entries(groups)) {
    if (layer === 'other') { continue; } // skip noise
    if (layer === 'config') { continue; } // too granular for diagram

    lines.push(`  subgraph ${layer.toUpperCase()}`);

    for (const [subfolder, files] of Object.entries(subfolders)) {
      if (files.length > 6) {
        // too many files — show as a summary node
        const nodeId = `node_${subgraphIndex++}`;
        const label = `${subfolder}\\n(${files.length} files)`;
        lines.push(`    ${nodeId}["${label}"]`);
      } else {
        for (const file of files) {
          const nodeId = `node_${subgraphIndex++}`;
          const name = file.relativePath.split('/').pop() || file.relativePath;
          const label = name.replace(/"/g, "'");
          lines.push(`    ${nodeId}["${label}"]`);
          // store nodeId on file for edge generation
          (file as any)._nodeId = nodeId;
        }
      }
    }

    lines.push('  end');
  }

  return lines.join('\n');
}