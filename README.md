# Codebase Navigator — VS Code Extension

## The Problem
When joining a 60–70% complete project, getting into context is painful.
You don't know where models are defined, which file owns which component,
or what breaks if you touch something. The only way to learn is to read
every file manually or interrupt a teammate.

## The Solution
A VS Code extension that:
1. **Maps the project** — reads the workspace, understands the structure,
   and renders a visual Mermaid diagram of the architecture (layers, dependencies, relationships)
2. **Answers questions** — an AI chat panel that knows the entire codebase
   and answers "where is X defined?", "what calls this?", "what breaks if I change Y?"
   — with a clickable file path that jumps directly to the line

---

## Current State (as of session end)

### What is done
- [x] VS Code extension scaffolded (TypeScript, unbundled)
- [x] Sidebar panel registered in `package.json` under `contributes.views`
- [x] `NavigatorSidebarProvider` class implements `vscode.WebviewViewProvider`
- [x] Sidebar renders HTML UI with "Analyze Workspace" button
- [x] Button click sends `postMessage({ command: 'analyze' })` to the extension host
- [x] Extension host receives the message and reads `vscode.workspace.workspaceFolders`
- [x] Notification confirms the correct workspace path is detected
- [x] Tested on a real project (`/home/meftah/amnesia`) — working correctly

### What is NOT done yet (next steps)
- [ ] Phase 2: File system scanner — read all files, build the index
- [ ] Phase 2: Parse imports/exports per file using tree-sitter or regex
- [ ] Phase 3: Generate Mermaid diagram from the index
- [ ] Phase 3: Render Mermaid inside the webview, clickable nodes open files
- [ ] Phase 4: AI chat — send index to Claude API, stream answers
- [ ] Phase 4: RAG pipeline for large repos (embed file summaries, retrieve top-k)
- [ ] Phase 5: File watcher — incremental re-index on file change
- [ ] Phase 6: Publish to VS Code Marketplace

---

## Project Structure

```
codebase-navigator/
├── src/
│   └── extension.ts        ← main entry point, all logic lives here for now
├── out/                    ← compiled JS (auto-generated, don't edit)
├── package.json            ← extension manifest: commands, views, activation
├── tsconfig.json           ← TypeScript config
└── README.md               ← this file
```

---

## Key Files Explained

### `package.json` — the extension manifest
Declares everything VS Code needs to know:
- `contributes.viewsContainers` — registers the icon in the activity bar
- `contributes.views` — registers the sidebar panel of type `webview`
- `contributes.commands` — registers the `Analyze Workspace` command
- `activationEvents: []` — extension activates immediately on VS Code start

### `src/extension.ts` — the brain
- `NavigatorSidebarProvider` class — implements `vscode.WebviewViewProvider`
  - `resolveWebviewView()` — called once when the sidebar panel is opened
    - sets `enableScripts: true` on the webview
    - attaches `onDidReceiveMessage` handler (catches button clicks from the UI)
    - sets the HTML content of the panel
  - `getHtml()` — returns the full HTML string rendered inside the sidebar
    - uses `acquireVsCodeApi()` inside the webview to send messages back
- `activate()` — registers the provider with VS Code on extension startup
- `deactivate()` — cleanup (empty for now)

### Message passing pattern (critical to understand)
The sidebar UI (HTML/JS) and the extension host (Node.js) are isolated.
They communicate via `postMessage`:
- UI → Extension: `vscode.postMessage({ command: 'analyze' })`
- Extension → UI: `webviewView.webview.postMessage({ command: 'result', data: ... })`
- Extension listens: `webviewView.webview.onDidReceiveMessage(msg => { ... })`
- UI listens: `window.addEventListener('message', e => { const msg = e.data; ... })`

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension runtime | Node.js + TypeScript |
| VS Code API | `vscode` npm package |
| UI (sidebar) | HTML + CSS + vanilla JS inside WebviewPanel |
| File reading | `vscode.workspace.fs` + `vscode.workspace.findFiles` |
| AST parsing | `tree-sitter` (Phase 2) |
| Diagram rendering | `mermaid.js` loaded via CDN in webview (Phase 3) |
| AI layer | Anthropic Claude API — `claude-sonnet-4-20250514` (Phase 4) |
| RAG / embeddings | Voyage AI or OpenAI embeddings + in-memory vector search (Phase 4) |
| Dev workflow | `npm run compile` → `F5` to launch Extension Development Host |

---

## How to Run (dev mode)

```bash
# 1. Install dependencies (already done)
npm install

# 2. Compile TypeScript
npm run compile

# 3. Press F5 in VS Code (from the codebase-navigator project window)
#    This opens the Extension Development Host — a second VS Code window
#    running your extension live

# 4. In the Extension Development Host:
#    - Open any project folder (File > Open Folder)
#    - Click the map icon in the left activity bar
#    - Your sidebar panel appears
#    - Click "Analyze Workspace"
```

---

## Next Immediate Task — Phase 2: File Scanner

When the "Analyze Workspace" button is clicked, instead of just showing
the path, the extension should:

1. Call `vscode.workspace.findFiles('**/*', '**/node_modules/**')` to get all files
2. For each file, read its content with `vscode.workspace.fs.readFile(uri)`
3. Extract: language (from extension), imports, exports, file size
4. Build an index object:
```typescript
interface FileEntry {
  path: string;         // relative path from workspace root
  language: string;     // 'typescript' | 'javascript' | 'python' | etc.
  imports: string[];    // files this file imports
  exports: string[];    // named exports from this file
  size: number;         // bytes
}

type ProjectIndex = {
  root: string;
  framework: string;    // detected: 'react' | 'vue' | 'next' | 'express' | etc.
  files: FileEntry[];
};
```
5. Send the index back to the webview:
```typescript
webviewView.webview.postMessage({ command: 'indexed', data: index });
```
6. Display file count + detected framework in the sidebar

---

## Phase 3 Plan — Mermaid Diagram

From the `ProjectIndex`, group files into semantic layers:
- **Components** — files in `/components`, `/views`, `/pages`
- **Services** — files in `/services`, `/api`, `/hooks`  
- **Models** — files in `/models`, `/types`, `/interfaces`
- **Config** — `*.config.*`, `.env`, root-level configs
- **Utils** — files in `/utils`, `/helpers`, `/lib`

Generate a Mermaid `graph TD` string, render it in the webview using:
```html
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
```
Make each node clickable — clicking sends the file path back to the extension,
which opens it with `vscode.window.showTextDocument(uri)`.

---

## Phase 4 Plan — AI Chat

System prompt to send with every request:
```
You are a codebase guide. Below is the index of the current project.
For every answer, provide:
1. The exact file path
2. The line range (if known)
3. A one-sentence explanation of why that's the right place

If the user asks what would break if they change something,
list all files that import or depend on it.

Project index:
{JSON.stringify(index)}
```

For large projects (>200 files): use RAG.
- Embed each file summary using an embeddings API
- On each question, retrieve top-5 most relevant files
- Send only those to Claude, not the full index

Stream the response and render it progressively in the chat UI.
Make file paths in the response clickable (open the file on click).

---

## Environment Variables Needed (Phase 4)

The extension will need the user to provide their Anthropic API key.
Store it using VS Code's secret storage (not plaintext):
```typescript
await context.secrets.store('ANTHROPIC_API_KEY', key);
const key = await context.secrets.get('ANTHROPIC_API_KEY');
```
Add a settings UI in the sidebar to enter and save the key.

---

## Current `extension.ts` (full, working version)

```typescript
import * as vscode from 'vscode';

class NavigatorSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebaseNavigator.sidebar';

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'analyze') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage('No workspace open. Please open a project folder first.');
          return;
        }
        vscode.window.showInformationMessage(`Analyzing: ${workspaceFolders[0].uri.fsPath}`);
      }
    });

    webviewView.webview.html = this.getHtml();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
        h2 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
        p  { font-size: 12px; opacity: 0.7; }
        button {
          width: 100%;
          padding: 8px;
          margin-top: 12px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
      </style>
    </head>
    <body>
      <h2>Codebase Navigator</h2>
      <p>Analyze your project to generate an architecture map and enable smart search.</p>
      <button onclick="analyze()">Analyze Workspace</button>
      <script>
        const vscode = acquireVsCodeApi();
        function analyze() {
          vscode.postMessage({ command: 'analyze' });
        }
      </script>
    </body>
    </html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new NavigatorSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NavigatorSidebarProvider.viewType,
      provider
    )
  );
}

export function deactivate() {}
```
# codebase-navigator
