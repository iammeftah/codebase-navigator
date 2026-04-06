import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry } from './types';

// ── Glob-level ignore (passed to findFiles as exclusion) ──────────────────────
// These never even reach our code — VS Code filters them at the FS level.
const GLOB_IGNORE = [
  // Universal dependency folders
  '**/node_modules/**',
  '**/vendor/**',           // PHP Composer, Ruby gems, etc.
  // Build / compiled output
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/public/build/**',     // Laravel Vite/Mix compiled assets
  // Cache & generated
  '**/bootstrap/cache/**',  // Laravel framework cache
  '**/__pycache__/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/tmp/**',
  '**/.tmp/**',
];

// ── Path-level filter (checked after findFiles) ───────────────────────────────
// Applied against the relative path. If any segment matches, file is skipped.
const IGNORED_SEGMENTS = new Set([
  // Dependency managers (belt-and-suspenders after glob)
  'node_modules', 'vendor',
  // IDE / tooling
  '.idea', '.vscode', '.vs',
  // Build artifacts
  'dist', 'build', 'out', 'target', 'bin', 'obj',
  // Cache
  '.cache', 'tmp', 'temp',
  // Framework-generated (Laravel)
  'bootstrap',   // bootstrap/app.php is human, but bootstrap/cache is already glob-ignored
  'storage',     // logs, compiled views, sessions — all generated
]);

// ── Filename-level filter ─────────────────────────────────────────────────────
// Files whose exact name (without extension) signals they are generated/config noise.
const IGNORED_FILENAMES = new Set([
  // Lock files
  'package-lock', 'yarn.lock', 'composer.lock', 'Pipfile.lock', 'poetry.lock',
  'Gemfile.lock', 'cargo.lock',
  // IDE & tooling config (not authored architecture)
  '.eslintrc', '.prettierrc', '.babelrc', '.editorconfig', '.nvmrc', '.npmrc',
  '.phpcs', 'phpunit', 'jest.config', 'vitest.config', 'webpack.config',
  'rollup.config', 'postcss.config', 'tailwind.config',
  // CI / deployment
  'Dockerfile', 'docker-compose', '.travis', '.github', '.gitlab-ci',
  // Environment
  '.env', '.env.example', '.env.test', '.env.local',
  // Generated manifests
  'mix-manifest', 'vite.config', 'hot',
  // PHP framework boilerplate that ships with Laravel itself
  'artisan',
]);

// ── Extension-level filter ────────────────────────────────────────────────────
// We only care about human-authored source file types.
const ALLOWED_EXTENSIONS = new Set([
  // Web
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
  // Backend
  '.php', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c',
  // Styles (authored, not compiled)
  '.css', '.scss', '.sass', '.less',
  // Templates / views
  '.blade.php', '.html', '.htm', '.twig', '.ejs', '.hbs',
  // Data / schema (human-written)
  '.graphql', '.gql', '.prisma', '.sql',
  // Config that humans write (not generated)
  '.json',   // will be filtered further below
  '.yaml', '.yml',
  // Docs
  '.md',
]);

// ── Migration file pattern ────────────────────────────────────────────────────
// Laravel/Django/Rails migration files are auto-numbered and not meaningful in diagrams.
// Pattern: starts with a timestamp like 2025_11_18_011657_ or 20250101000000_
const MIGRATION_PATTERN = /^\d{4}[_\-]\d{2}[_\-]\d{2}[_\-]\d+[_\-]/;

// ── JSON files that are generated noise ──────────────────────────────────────
const IGNORED_JSON_NAMES = new Set([
  'package-lock', 'composer', 'tsconfig', 'jsconfig',
  'manifest', 'mix-manifest', '.phpunit.result.cache',
]);

// ── File size cap ─────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 300_000; // 300 KB — generated files are often huge

// ─────────────────────────────────────────────────────────────────────────────

function isHumanWritten(relativePath: string, size: number): boolean {
  const parts   = relativePath.split(/[/\\]/);
  const filename = parts[parts.length - 1];
  const ext      = path.extname(filename).toLowerCase();
  const stem     = filename.slice(0, -ext.length).toLowerCase();

  // 1. Size gate
  if (size > MAX_FILE_SIZE) { return false; }

  // 2. Any path segment is a known generated folder
  for (const seg of parts.slice(0, -1)) {
    if (IGNORED_SEGMENTS.has(seg.toLowerCase())) { return false; }
  }

  // 3. Extension must be in our allowed set
  //    Handle .blade.php as a special case
  const isBlade = filename.endsWith('.blade.php');
  if (!isBlade && !ALLOWED_EXTENSIONS.has(ext)) { return false; }

  // 4. Filename is a known noise file
  if (IGNORED_FILENAMES.has(stem)) { return false; }

  // 5. Migration pattern — skip timestamped migration files
  if (MIGRATION_PATTERN.test(filename)) { return false; }

  // 6. JSON-specific: skip generated JSON files
  if (ext === '.json' && IGNORED_JSON_NAMES.has(stem)) { return false; }

  // 7. Hidden files/dirs (dotfiles not already caught above)
  if (parts.some(p => p.startsWith('.') && p.length > 1)) { return false; }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

function detectLanguage(filePath: string): string {
  const f = filePath.toLowerCase();
  if (f.endsWith('.blade.php')) { return 'blade'; }
  const ext = path.extname(f);
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.php': 'php',       '.py': 'python',
    '.vue': 'vue',       '.svelte': 'svelte',
    '.rb': 'ruby',       '.go': 'go',
    '.rs': 'rust',       '.java': 'java',
    '.css': 'css',       '.scss': 'scss',
    '.graphql': 'graphql', '.prisma': 'prisma',
    '.sql': 'sql',       '.md': 'markdown',
    '.html': 'html',     '.yaml': 'yaml', '.yml': 'yaml',
    '.json': 'json',
  };
  return map[ext] || 'other';
}

function detectLayer(relativePath: string): string {
  const p = relativePath.toLowerCase().replace(/\\/g, '/');

  // Laravel-specific layers
  if (p.startsWith('app/http/controllers'))        { return 'controllers'; }
  if (p.startsWith('app/http/middleware'))         { return 'middleware'; }
  if (p.startsWith('app/http/requests'))           { return 'requests'; }
  if (p.startsWith('app/models'))                  { return 'models'; }
  if (p.startsWith('app/services'))                { return 'services'; }
  if (p.startsWith('app/repositories'))            { return 'repositories'; }
  if (p.startsWith('app/jobs'))                    { return 'jobs'; }
  if (p.startsWith('app/events') || p.startsWith('app/listeners')) { return 'events'; }
  if (p.startsWith('app/policies'))               { return 'policies'; }
  if (p.startsWith('app/providers'))              { return 'providers'; }
  if (p.startsWith('app/console'))                { return 'console'; }
  if (p.startsWith('database/seeders'))           { return 'seeders'; }
  if (p.startsWith('routes/'))                    { return 'routes'; }
  if (p.startsWith('resources/views'))            { return 'views'; }
  if (p.startsWith('resources/js') || p.startsWith('resources/ts')) { return 'frontend'; }
  if (p.startsWith('resources/css') || p.startsWith('resources/sass')) { return 'styles'; }
  if (p.startsWith('tests/'))                     { return 'tests'; }
  if (p.startsWith('config/'))                    { return 'config'; }
  if (p.startsWith('app/'))                       { return 'app'; }

  // Generic framework-agnostic layers
  if (p.includes('/components/') || p.includes('/ui/'))            { return 'components'; }
  if (p.includes('/pages/') || p.includes('/views/'))              { return 'pages'; }
  if (p.includes('/hooks/'))                                        { return 'hooks'; }
  if (p.includes('/services/') || p.includes('/api/'))             { return 'services'; }
  if (p.includes('/models/') || p.includes('/types/') || p.includes('/interfaces/')) { return 'models'; }
  if (p.includes('/utils/') || p.includes('/helpers/') || p.includes('/lib/')) { return 'utils'; }
  if (p.includes('/store/') || p.includes('/redux/') || p.includes('/context/')) { return 'state'; }
  if (p.includes('/tests/') || p.includes('/spec/') || p.includes('__tests__')) { return 'tests'; }
  if (p.includes('config') || p.includes('.env'))                  { return 'config'; }

  return 'other';
}

function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];
  if (['typescript', 'javascript', 'vue'].includes(language)) {
    const re = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[1].startsWith('.')) { imports.push(m[1]); }
    }
  }
  if (language === 'php' || language === 'blade') {
    const re = /use\s+(App\\[A-Za-z\\]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) { imports.push(m[1]); }
  }
  if (language === 'python') {
    const re = /from\s+(\S+)\s+import|^import\s+(\S+)/gm;
    let m;
    while ((m = re.exec(content)) !== null) { imports.push(m[1] || m[2]); }
  }
  return imports;
}

function extractExports(content: string, language: string): string[] {
  const exports: string[] = [];
  if (['typescript', 'javascript'].includes(language)) {
    const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][^\s({<]*)/g;
    let m;
    while ((m = re.exec(content)) !== null) { exports.push(m[1]); }
  }
  if (language === 'php' || language === 'blade') {
    const re = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/m;
    const m  = re.exec(content);
    if (m) { exports.push(m[1]); }
  }
  return exports;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function scanWorkspace(
  workspaceRoot: vscode.Uri,
  onProgress: (msg: string) => void
): Promise<FileEntry[]> {

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, '**/*'),
    `{${GLOB_IGNORE.join(',')}}`
  );

  onProgress(`Found ${files.length} files. Filtering...`);

  const entries: FileEntry[] = [];
  let skipped = 0;

  for (const fileUri of files) {
    try {
      const stat        = await vscode.workspace.fs.stat(fileUri);
      const relativePath = path.relative(workspaceRoot.fsPath, fileUri.fsPath);

      // Smart human-written filter
      if (!isHumanWritten(relativePath, stat.size)) {
        skipped++;
        continue;
      }

      const language = detectLanguage(fileUri.fsPath);
      const layer    = detectLayer(relativePath);

      let imports: string[] = [];
      let exports: string[] = [];

      const parseable = ['typescript', 'javascript', 'vue', 'python', 'php', 'blade'];
      if (parseable.includes(language)) {
        const raw     = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(raw).toString('utf8');
        imports = extractImports(content, language);
        exports = extractExports(content, language);
      }

      entries.push({
        path: fileUri.fsPath,
        relativePath,
        language,
        layer,
        imports,
        exports,
        size: stat.size,
      });
    } catch {
      // skip unreadable files silently
    }
  }

  onProgress(`Indexed ${entries.length} files (${skipped} generated files skipped).`);
  return entries;
}