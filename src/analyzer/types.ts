export interface FileEntry {
  path: string;
  relativePath: string;
  language: string;
  layer: string;
  imports: string[];
  exports: string[];
  size: number;
}

export interface ProjectIndex {
  root: string;
  framework: string;
  totalFiles: number;
  files: FileEntry[];
  layers: Record<string, string[]>;
}

export type MessageToExtension =
  | { command: 'analyze' }
  | { command: 'openFile'; path: string }
  | { command: 'chat'; question: string }
  | { command: 'saveApiKey'; key: string };

export type MessageToWebview =
  | { command: 'indexed'; data: ProjectIndex }
  | { command: 'chatResponse'; text: string }
  | { command: 'error'; message: string }
  | { command: 'progress'; message: string };