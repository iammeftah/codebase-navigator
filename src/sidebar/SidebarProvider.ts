import * as vscode from 'vscode';
import { scanWorkspace } from '../analyzer/fileScanner';
import { buildIndex } from '../analyzer/indexer';
import { ProjectIndex } from '../analyzer/types';
import { buildSystemPrompt, buildRagUserMessage, trimHistory, isConversational } from './contextBuilder';
import { ModelManager, ModelProfile, DEFAULT_GROQ_ID } from './modelManager';
import { VectorStore } from '../rag/vectorStore';

import { retrieve } from '../rag/retriever';
import { embedFiles } from '../rag/embedder';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const KNOWN_PROVIDERS = [
  { name: 'Groq',        baseUrl: 'https://api.groq.com/openai',                               format: 'openai'    },
  { name: 'OpenAI',      baseUrl: 'https://api.openai.com',                                    format: 'openai'    },
  { name: 'Anthropic',   baseUrl: 'https://api.anthropic.com',                                 format: 'anthropic' },
  { name: 'OpenRouter',  baseUrl: 'https://openrouter.ai/api',                                 format: 'openai'    },
  { name: 'Gemini',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',   format: 'openai'    },
  { name: 'Ollama',      baseUrl: 'http://localhost:11434',                                     format: 'ollama'    },
  { name: 'Custom',      baseUrl: '',                                                           format: 'openai'    },
] as const;

export class NavigatorSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebaseNavigator.sidebar';
  private _view?: vscode.WebviewView;
  private _index?: ProjectIndex;
  private _diagramPanel?: vscode.WebviewPanel;
  private _chatHistory: ChatMessage[] = [];
  private _modelManager: ModelManager;
  private _activeProfileId: string | null = null;

  // ── RAG state ──────────────────────────────────────────────────────────────
  private _vectorStore: VectorStore = new VectorStore();
  private _embeddingReady = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._modelManager = new ModelManager(context.secrets, context.globalState);
    // activeProfileId is already set by extension.ts before this constructor runs
    this._activeProfileId = context.globalState.get<string>('codebaseNavigator.activeProfileId') ?? DEFAULT_GROQ_ID;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();
    this._pushModels();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {

        case 'analyze': {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders) { this._post({ command: 'error', message: 'No workspace open.' }); return; }
          const root = folders[0].uri;
          const prog = (m: string) => this._post({ command: 'progress', message: m });
          prog('Scanning files…');
          const files = await scanWorkspace(root, prog);
          const index = buildIndex(root.fsPath, files);
          this._index = index;
          this._chatHistory = [];

          // Reset RAG state for fresh index
          this._vectorStore.clear();
          this._embeddingReady = false;

          this._post({ command: 'indexed', data: index });
          this._openDiagramPanel(index);

          // Build embeddings async — non-blocking, chat still works via fallback
          this._buildEmbeddings(index, prog);
          break;
        }

        case 'openFile':
          vscode.window.showTextDocument(vscode.Uri.file(msg.path));
          break;

        case 'showDiagram':
          if (this._index) { this._openDiagramPanel(this._index); }
          break;

        // ── Model CRUD ──────────────────────────────────────────────────────
        case 'addModel': {
          const profile: ModelProfile = {
            id: `m-${Date.now()}`,
            label:     msg.label.trim(),
            baseUrl:   msg.baseUrl.trim(),
            apiFormat: msg.apiFormat,
          };
          await this._modelManager.addProfile(profile, msg.apiKey ?? '');
          this._setActive(profile.id);
          this._pushModels();
          this._post({ command: 'modelSaved' });
          break;
        }

        case 'updateModel': {
          const existing = this._modelManager.getProfiles().find(p => p.id === msg.id);
          if (!existing) { break; }
          const updated: ModelProfile = {
            ...existing,
            label:     msg.label.trim(),
            baseUrl:   msg.baseUrl.trim(),
            apiFormat: msg.apiFormat,
          };
          await this._modelManager.updateProfile(updated, msg.apiKey || undefined);
          this._pushModels();
          this._post({ command: 'modelSaved' });
          break;
        }

        case 'removeModel':
          await this._modelManager.removeProfile(msg.id);
          if (this._activeProfileId === msg.id) {
            const remaining = this._modelManager.getProfiles();
            this._setActive(remaining[0]?.id ?? null);
          }
          this._pushModels();
          break;

        case 'selectModel':
          this._setActive(msg.id);
          break;

        case 'saveGroqKey': {
          await this._modelManager.saveGroqKey(msg.key.trim());
          // Auto-activate the default if it wasn't already selected
          if (!this._activeProfileId) { this._setActive(DEFAULT_GROQ_ID); }
          this._post({ command: 'groqKeySaved' });
          break;
        }

        // ── Chat ────────────────────────────────────────────────────────────
        case 'chat':
          await this._handleChat(msg.question);
          break;

        case 'clearChat':
          this._chatHistory = [];
          break;
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _post(message: object) { this._view?.webview.postMessage(message); }

  private _setActive(id: string | null) {
    this._activeProfileId = id;
    this.context.globalState.update('codebaseNavigator.activeProfileId', id);
  }

  private _pushModels() {
    const profiles = this._modelManager.getProfiles();
    if (this._activeProfileId && !profiles.find(p => p.id === this._activeProfileId)) {
      this._setActive(profiles[0]?.id ?? null);
    }
    // Send groqKeySet flag so the webview can show "key saved ✓" vs the input
    this._modelManager.getGroqKey().then(key => {
      this._post({
        command: 'modelsUpdated',
        profiles,
        activeId: this._activeProfileId,
        providers: KNOWN_PROVIDERS,
        groqKeySet: key.length > 0,
      });
    });
  }

  // ── RAG: build embeddings after indexing ───────────────────────────────────

  private async _buildEmbeddings(index: ProjectIndex, prog: (m: string) => void): Promise<void> {
    if (!this._activeProfileId) {
      prog('⚠ No model selected — add a model to enable semantic search.');
      return;
    }
    const profile = this._modelManager.getProfiles().find(p => p.id === this._activeProfileId);
    if (!profile) { return; }
    const apiKey = await this._modelManager.getApiKey(this._activeProfileId);

    try {
      prog(`Building semantic index for ${index.totalFiles} files…`);
      const results = await embedFiles(index.files, profile, apiKey, prog);
      this._vectorStore.clear();
      this._vectorStore.addMany(results.map((r: { relativePath: any; text: any; vector: any; }) => ({ relativePath: r.relativePath, text: r.text, vector: r.vector })));
      this._embeddingReady = true;
      prog(`✓ Semantic index ready — ${this._vectorStore.size} files embedded.`);
    } catch (e: any) {
      this._embeddingReady = false;
      // Non-fatal: chat falls back to keyword heuristic automatically
      prog(`⚠ Embedding failed (${e.message}) — using keyword fallback.`);
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  private async _handleChat(question: string) {
    if (!this._index) {
      this._post({ command: 'chatResponse', text: '⚠️ Analyze the workspace first.' });
      return;
    }
    if (!this._activeProfileId) {
      this._post({ command: 'chatResponse', text: '⚠️ Add and select a model first.' });
      return;
    }

    this._chatHistory.push({ role: 'user', content: question });
    this._post({ command: 'chatStreaming' }); // spinner on, send button disabled

    try {
      const profile = this._modelManager.getProfiles().find(p => p.id === this._activeProfileId);
      if (!profile) { throw new Error('Profile not found.'); }
      const apiKey = await this._modelManager.getApiKey(this._activeProfileId!);

      // ── RAG retrieval — skip for casual/conversational messages ────────────
      // isConversational() catches "hey", "thanks", "how are you" etc.
      // Running retrieval on those injects random files and breaks the response.
      let retrievedFiles: import('../analyzer/types').FileEntry[] = [];
      let usedEmbeddings = false;

      if (!isConversational(question)) {
        const result = await retrieve(
          question, this._index, this._vectorStore, profile, apiKey,
        );
        retrievedFiles  = result.files;
        usedEmbeddings  = result.usedEmbeddings;
      }

      const ragUserMessage = buildRagUserMessage(question, retrievedFiles, usedEmbeddings);

      const historyForSend: ChatMessage[] = [
        ...trimHistory(this._chatHistory.slice(0, -1)),
        { role: 'user', content: ragUserMessage },
      ];

      const system = buildSystemPrompt(this._index);

      // ── Stream: send each chunk to the webview as it arrives ────────────
      // The webview appends chunks to a live bubble instead of waiting.
      this._post({ command: 'chatChunkStart' }); // tells UI to open a new bubble

      const fullText = await this._modelManager.chatStream(
        this._activeProfileId!,
        system,
        historyForSend,
        (chunk) => {
          if (chunk === null) {
            // Stream finished — send the final ragMeta so the badge renders
            this._post({
              command: 'chatChunkEnd',
              ragMeta: {
                fileCount:      retrievedFiles.length,
                usedEmbeddings,
                files:          retrievedFiles.map(f => f.relativePath),
              },
            });
          } else {
            // Partial chunk — append to the live bubble
            this._post({ command: 'chatChunk', text: chunk });
          }
        },
      );

      // Save the full accumulated response to history for future context
      this._chatHistory.push({ role: 'assistant', content: fullText });

    } catch (e: any) {
      this._chatHistory.pop();
      // Dismiss any open streaming bubble and show the error
      this._post({ command: 'chatResponse', text: `⚠️ ${e.message}` });
    }
  }

  // ── Diagram panel ──────────────────────────────────────────────────────────

  private _openDiagramPanel(index: ProjectIndex) {
    if (this._diagramPanel) {
      this._diagramPanel.reveal(vscode.ViewColumn.Beside);
      this._diagramPanel.webview.postMessage({ command: 'update', data: index });
      return;
    }
    this._diagramPanel = vscode.window.createWebviewPanel(
      'codebaseNavigator.diagram', '⬡ Architecture Map',
      vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true }
    );
    this._diagramPanel.webview.html = this._getDiagramHtml(index);
    this._diagramPanel.webview.onDidReceiveMessage(m => {
      if (m.command === 'openFile') { vscode.window.showTextDocument(vscode.Uri.file(m.path)); }
    });
    this._diagramPanel.onDidDispose(() => { this._diagramPanel = undefined; });
  }

  private _getDiagramHtml(index: ProjectIndex): string {
    const safeJson = JSON.stringify(index).replace(/<\/script>/gi, '<\\/script>');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--surface:#161b22;--surface2:#21262d;--border:#30363d;--accent:#58a6ff;--text:#e6edf3;--muted:#8b949e;--ok:#3fb950}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden}
#app{display:flex;flex-direction:column;height:100vh}

/* ── Top bar ── */
.topbar{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;gap:6px}
.tl{display:flex;align-items:center;gap:7px;overflow:hidden;min-width:0;flex:1}
.ttl{font-size:13px;font-weight:600;white-space:nowrap}
.pill{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;white-space:nowrap;border:1px solid transparent;flex-shrink:0}
.pa{background:#1f3a5f;color:var(--accent);border-color:#2a4a7f}
.pn{background:var(--surface2);color:var(--muted);border-color:var(--border)}
.tr{display:flex;gap:4px;align-items:center;flex-shrink:0}
.btn{font-size:11px;padding:3px 8px;border-radius:5px;cursor:pointer;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:inherit;white-space:nowrap;transition:background .1s}
.btn:hover{background:var(--border)}
.btn.active{background:#1f3a5f;border-color:#2a4a7f;color:var(--accent)}
#zl{font-size:11px;color:var(--muted);min-width:32px;text-align:center}

/* ── Layer filter bar ── */
#filter-bar{display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
.ftag{font-size:10.5px;padding:2px 8px;border-radius:10px;cursor:pointer;border:1px solid transparent;display:inline-flex;align-items:center;gap:4px;transition:opacity .12s,border-color .12s;white-space:nowrap}
.ftag .fdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.ftag.off{opacity:.28;border-color:transparent!important}
.ftag:hover{opacity:1!important}

/* ── Canvas ── */
.canvas{flex:1;position:relative;overflow:hidden;background:var(--bg);
  background-image:radial-gradient(circle at 50% 30%,#0f1e30 0%,transparent 60%),radial-gradient(#21262d 1px,transparent 1px);
  background-size:100% 100%,28px 28px}

/* SVG edge overlay — sits on top of #vp, pointer-events:none so pan/click still work */
#edge-svg{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible}

#vp{position:absolute;top:0;left:0;transform-origin:0 0;cursor:grab;user-select:none;padding:36px;display:flex;flex-direction:column;align-items:stretch}
#vp.grab{cursor:grabbing}

/* ── Cards ── */
.lc{border-radius:10px;border:1px solid var(--border);background:var(--surface);margin-bottom:14px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,.45);transition:opacity .2s,box-shadow .15s}
.lc:hover{box-shadow:0 4px 24px rgba(0,0,0,.65)}
.lc.hidden{display:none}
.lh{display:flex;align-items:center;gap:9px;padding:9px 13px;border-bottom:1px solid var(--border);background:var(--surface2)}
.ld{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.ln{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;flex:1}
.lct{font-size:10px;color:var(--muted);background:var(--surface);padding:1px 7px;border-radius:10px;border:1px solid var(--border)}
.fg{display:flex;flex-wrap:wrap;gap:5px;padding:9px 11px 11px}
.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:5px;cursor:pointer;background:var(--surface2);border:1px solid var(--border);font-size:11.5px;max-width:190px;overflow:hidden;transition:border-color .1s,background .1s,box-shadow .1s;white-space:nowrap}
.chip:hover{border-color:var(--accent);background:#12243a}
.chip.lit{border-color:#f78166;background:#2a1a16;box-shadow:0 0 0 1px #f78166}
.chip.dim{opacity:.25}
.cn{overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.ce{font-size:10px;color:var(--muted);flex-shrink:0;background:var(--surface);padding:1px 4px;border-radius:3px;border:1px solid var(--border)}
.cm{display:inline-flex;align-items:center;padding:3px 9px;border-radius:5px;font-size:11px;color:var(--muted);border:1px dashed var(--border);cursor:default}

/* ── Status bar ── */
.sb{height:22px;background:#1a2d42;border-top:1px solid var(--border);display:flex;align-items:center;padding:0 12px;gap:14px;flex-shrink:0}
.sb>span{font-size:11px;color:var(--accent)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;margin-right:5px}

/* ── Tooltip ── */
#tip{position:fixed;background:var(--surface);border:1px solid var(--border);color:var(--text);font-size:11px;padding:4px 8px;border-radius:5px;pointer-events:none;display:none;z-index:100;max-width:260px;word-break:break-all}
</style>
</head>
<body>
<div id="app">

  <div class="topbar">
    <div class="tl">
      <span class="ttl">⬡ Architecture Map</span>
      <span class="pill pa" id="fw">—</span>
      <span class="pill pn" id="fc">—</span>
    </div>
    <div class="tr">
      <button class="btn" id="edge-btn" onclick="toggleEdges()" title="Toggle import edges">Edges</button>
      <button class="btn" onclick="zBy(-.15)">−</button>
      <span id="zl">100%</span>
      <button class="btn" onclick="zBy(.15)">+</button>
      <button class="btn" onclick="fit()">Fit</button>
      <button class="btn" onclick="rst()">Reset</button>
    </div>
  </div>

  <div id="filter-bar"></div>

  <div class="canvas" id="cv">
    <svg id="edge-svg"><defs>
      <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M2 1L8 5L2 9" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </marker>
    </defs></svg>
    <div id="vp"></div>
  </div>

  <div class="sb">
    <span><span class="dot"></span><span id="si">Indexed</span></span>
    <span id="edge-info">Edges off</span>
    <span>Drag to pan · Scroll to zoom · Click chip to open</span>
  </div>

</div>
<div id="tip"></div>

<script>
const vscode = acquireVsCodeApi();

const LC = {controllers:'#2ea043',middleware:'#d29922',requests:'#58a6ff',models:'#bc8cff',
  services:'#f78166',repositories:'#79c0ff',jobs:'#ffa657',events:'#ff7b72',policies:'#a5d6ff',
  providers:'#7ee787',console:'#56d364',seeders:'#e3b341',routes:'#d2a8ff',views:'#ffa198',
  frontend:'#79c0ff',styles:'#6e7681',tests:'#3fb950',config:'#8b949e',app:'#58a6ff',
  components:'#f0883e',pages:'#79c0ff',hooks:'#d2a8ff',state:'#ffa657',utils:'#8b949e',other:'#484f58'};

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

let INDEX = null;
let hiddenLayers = new Set();
let showEdges = false;
let chipMap = {};

// ── Render ──────────────────────────────────────────────────────────────────
function render(idx) {
  INDEX = idx;
  chipMap = {};
  document.getElementById('fw').textContent = idx.framework;
  document.getElementById('fc').textContent = idx.totalFiles + ' files';

  buildFilterBar(idx);

  const vp = document.getElementById('vp');
  vp.innerHTML = '';

  const ents = Object.entries(idx.layers).filter(([,f]) => f.length);
  let tot = 0;

  for (const [layer, files] of ents) {
    tot += files.length;
    const col = LC[layer] || LC.other;

    const card = document.createElement('div');
    card.className = 'lc' + (hiddenLayers.has(layer) ? ' hidden' : '');
    card.dataset.layer = layer;
    card.innerHTML =
      '<div class="lh"><div class="ld" style="background:'+col+'"></div>' +
      '<span class="ln">'+esc(layer)+'</span>' +
      '<span class="lct">'+files.length+'</span></div>';

    const grid = document.createElement('div');
    grid.className = 'fg';

    const MAX = 18;
    const visible = files.slice(0, MAX);
    const hidden  = files.length - visible.length;

    for (const rel of visible) {
      const full = idx.root + '/' + rel;
      const name = rel.split('/').pop() || rel;
      const dot  = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext  = dot > 0 ? name.slice(dot) : '';

      const ch = document.createElement('div');
      ch.className = 'chip';
      ch.title = rel;
      ch.dataset.rel = rel;
      ch.innerHTML =
        '<span class="cn">'+esc(base)+'</span>' +
        (ext ? '<span class="ce">'+esc(ext)+'</span>' : '');

      ch.addEventListener('click', () => {
        vscode.postMessage({ command: 'openFile', path: full });
        highlightFile(rel);
      });

      ch.addEventListener('mouseenter', () => showTip(ch, rel));
      ch.addEventListener('mouseleave', hideTip);

      chipMap[rel] = ch;
      grid.appendChild(ch);
    }

    if (hidden > 0) {
      const m = document.createElement('div');
      m.className = 'cm';
      m.textContent = '+' + hidden + ' more';
      grid.appendChild(m);
    }

    card.appendChild(grid);
    vp.appendChild(card);
  }

  document.getElementById('si').textContent = ents.length + ' layers · ' + tot + ' files mapped';

  fit();
  if (showEdges) { requestAnimationFrame(drawEdges); }
}

// ── Filter bar ───────────────────────────────────────────────────────────────
function buildFilterBar(idx) {
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = '';
  const layers = Object.keys(idx.layers).filter(l => idx.layers[l].length);

  for (const layer of layers) {
    const col = LC[layer] || LC.other;
    const tag = document.createElement('span');
    tag.className = 'ftag' + (hiddenLayers.has(layer) ? ' off' : '');
    tag.dataset.layer = layer;
    tag.style.borderColor = col + '55';
    tag.style.background  = col + '18';
    tag.style.color       = col;
    tag.innerHTML = '<span class="fdot" style="background:'+col+'"></span>' + esc(layer);
    tag.addEventListener('click', () => toggleLayer(layer));
    bar.appendChild(tag);
  }
}

function toggleLayer(layer) {
  if (hiddenLayers.has(layer)) {
    hiddenLayers.delete(layer);
  } else {
    hiddenLayers.add(layer);
  }
  document.querySelectorAll('.lc[data-layer]').forEach(card => {
    card.classList.toggle('hidden', hiddenLayers.has(card.dataset.layer));
  });
  document.querySelectorAll('.ftag[data-layer]').forEach(tag => {
    tag.classList.toggle('off', hiddenLayers.has(tag.dataset.layer));
  });
  if (showEdges) { requestAnimationFrame(drawEdges); }
}

// ── Edges ────────────────────────────────────────────────────────────────────
function toggleEdges() {
  showEdges = !showEdges;
  document.getElementById('edge-btn').classList.toggle('active', showEdges);
  if (showEdges) {
    requestAnimationFrame(drawEdges);
  } else {
    clearEdges();
    document.getElementById('edge-info').textContent = 'Edges off';
  }
}

function clearEdges() {
  const svg = document.getElementById('edge-svg');
  svg.querySelectorAll('path,line').forEach(el => el.remove());
}

function chipCenter(chipEl) {
  const cvRect  = document.getElementById('cv').getBoundingClientRect();
  const chipRect = chipEl.getBoundingClientRect();
  return {
    x: (chipRect.left + chipRect.width  / 2 - cvRect.left),
    y: (chipRect.top  + chipRect.height / 2 - cvRect.top),
  };
}

function drawEdges() {
  if (!INDEX || !showEdges) { return; }
  clearEdges();

  const svg = document.getElementById('edge-svg');
  const cv = document.getElementById('cv');
  svg.setAttribute('width',  cv.clientWidth);
  svg.setAttribute('height', cv.clientHeight);

  let drawn = 0;
  const MAX_EDGES = 120;

  for (const file of INDEX.files) {
    if (!file.imports || !file.imports.length) { continue; }

    const fromEl = chipMap[file.relativePath];
    if (!fromEl) { continue; }
    const fromCard = fromEl.closest('.lc');
    if (fromCard && fromCard.classList.contains('hidden')) { continue; }

    for (const imp of file.imports) {
      if (drawn >= MAX_EDGES) { break; }

      const resolved = resolveImport(file.relativePath, imp);
      if (!resolved) { continue; }

      const toEl = chipMap[resolved];
      if (!toEl) { continue; }
      const toCard = toEl.closest('.lc');
      if (toCard && toCard.classList.contains('hidden')) { continue; }

      const from = chipCenter(fromEl);
      const to   = chipCenter(toEl);

      if (Math.abs(from.x - to.x) < 2 && Math.abs(from.y - to.y) < 2) { continue; }

      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2 - 30;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M'+from.x+','+from.y+' Q'+mx+','+my+' '+to.x+','+to.y);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#58a6ff');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('stroke-opacity', '0.35');
      path.setAttribute('marker-end', 'url(#arr)');
      svg.appendChild(path);
      drawn++;
    }
    if (drawn >= MAX_EDGES) { break; }
  }

  document.getElementById('edge-info').textContent = drawn + ' import edges';
}

function resolveImport(fromRel, imp) {
  if (!imp.startsWith('.')) { return null; }

  const fromParts = fromRel.replace(/\\\\/g, '/').split('/');
  fromParts.pop();
  const impParts = imp.replace(/\\\\/g, '/').split('/');

  const stack = [...fromParts];
  for (const seg of impParts) {
    if (seg === '..') { stack.pop(); }
    else if (seg !== '.') { stack.push(seg); }
  }

  const base = stack.join('/');

  for (const ext of ['.ts','.tsx','.js','.jsx','.vue','.php','.py','']) {
    const candidate = base + ext;
    if (chipMap[candidate]) { return candidate; }
  }

  for (const ext of ['.ts','.tsx','.js','.jsx']) {
    const candidate = base + '/index' + ext;
    if (chipMap[candidate]) { return candidate; }
  }

  return null;
}

// ── Highlight on click ───────────────────────────────────────────────────────
function highlightFile(rel) {
  Object.entries(chipMap).forEach(([r, el]) => {
    el.classList.toggle('lit', r === rel);
    el.classList.toggle('dim', r !== rel);
  });
  setTimeout(() => {
    Object.values(chipMap).forEach(el => { el.classList.remove('lit','dim'); });
  }, 1800);

  if (showEdges) { requestAnimationFrame(() => highlightEdges(rel)); }
}

function highlightEdges(rel) {
  if (!INDEX) { return; }
  clearEdges();
  const svg = document.getElementById('edge-svg');
  const cv = document.getElementById('cv');
  svg.setAttribute('width', cv.clientWidth);
  svg.setAttribute('height', cv.clientHeight);

  const file = INDEX.files.find(f => f.relativePath === rel);
  if (!file) { drawEdges(); return; }

  drawEdges();

  const fromEl = chipMap[rel];
  if (!fromEl) { return; }
  for (const imp of (file.imports || [])) {
    const resolved = resolveImport(rel, imp);
    if (!resolved) { continue; }
    const toEl = chipMap[resolved];
    if (!toEl) { continue; }
    const from = chipCenter(fromEl);
    const to   = chipCenter(toEl);
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2 - 30;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M'+from.x+','+from.y+' Q'+mx+','+my+' '+to.x+','+to.y);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#f78166');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-opacity', '0.9');
    path.setAttribute('marker-end', 'url(#arr)');
    svg.appendChild(path);
  }
}

// ── Tooltip ──────────────────────────────────────────────────────────────────
const tip = document.getElementById('tip');
function showTip(el, text) {
  tip.textContent = text;
  tip.style.display = 'block';
  const r = el.getBoundingClientRect();
  tip.style.left = r.left + 'px';
  tip.style.top  = (r.bottom + 4) + 'px';
}
function hideTip() { tip.style.display = 'none'; }

// ── Pan / zoom ───────────────────────────────────────────────────────────────
let sc=1, px=40, py=40, pan=false, sx=0, sy=0;

function aT() {
  document.getElementById('vp').style.transform = 'translate('+px+'px,'+py+'px) scale('+sc+')';
  document.getElementById('zl').textContent = Math.round(sc*100)+'%';
  if (showEdges) { requestAnimationFrame(drawEdges); }
}

function zBy(d) { sc = Math.min(3, Math.max(.1, sc+d)); aT(); }
function fit() {
  const c=document.getElementById('cv'), v=document.getElementById('vp');
  const cw=c.clientWidth, ch=c.clientHeight, vw=v.scrollWidth, vh=v.scrollHeight;
  if (!vw||!vh) { return; }
  const pad=44;
  sc = Math.min((cw-pad*2)/vw, (ch-pad*2)/vh, 1.4);
  px = (cw - vw*sc) / 2;
  py = pad;
  aT();
}
function rst() { sc=1; px=40; py=40; aT(); }

const cv = document.getElementById('cv');
cv.addEventListener('mousedown', ev => {
  if (ev.target.closest('.chip')) { return; }
  pan=true; sx=ev.clientX-px; sy=ev.clientY-py;
  document.getElementById('vp').classList.add('grab');
});
window.addEventListener('mousemove', ev => {
  if (!pan) { return; }
  px=ev.clientX-sx; py=ev.clientY-sy; aT();
});
window.addEventListener('mouseup', () => {
  pan=false;
  document.getElementById('vp').classList.remove('grab');
});
cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  const rect = cv.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const delta = ev.deltaY < 0 ? 0.1 : -0.1;
  const newSc = Math.min(3, Math.max(0.1, sc + delta));
  px = mx - (mx - px) * (newSc / sc);
  py = my - (my - py) * (newSc / sc);
  sc = newSc;
  aT();
}, { passive: false });

window.addEventListener('resize', () => { fit(); });

// ── Boot ─────────────────────────────────────────────────────────────────────
render(${safeJson});
window.addEventListener('message', ev => {
  if (ev.data.command === 'update') { render(ev.data.data); }
});
</script>
</body>
</html>`;
  }

  // ── Sidebar HTML ───────────────────────────────────────────────────────────

  private getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;height:100vh;overflow:hidden;font-size:12px}

/* ── Layout ── */
#top{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:9px;min-height:0}
#chat-wrap{display:flex;flex-direction:column;flex-shrink:0;border-top:1px solid var(--vscode-editorWidget-border,#444)}

/* ── Resize handle ── */
#resizer{height:5px;cursor:ns-resize;background:transparent;flex-shrink:0;position:relative;z-index:10}
#resizer:hover,#resizer.dragging{background:var(--vscode-focusBorder,#007acc);opacity:.5}

/* ── Headings / text ── */
h2{font-size:13px;font-weight:600}
.muted{opacity:.6;line-height:1.5}
.sec{font-size:10.5px;font-weight:700;opacity:.45;text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px}
.divider{border:none;border-top:1px solid var(--vscode-editorWidget-border,#444);opacity:.3}

/* ── Buttons ── */
.btn{width:100%;padding:6px 10px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit;background:var(--vscode-button-background);color:var(--vscode-button-foreground);transition:opacity .1s;text-align:center}
.btn:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-o{background:transparent!important;border:1px solid var(--vscode-button-background)!important;color:var(--vscode-button-background)!important}
.btn-g{background:transparent!important;border:1px solid var(--vscode-editorWidget-border,#555)!important;color:var(--vscode-foreground)!important;opacity:.65}
.btn-g:hover:not(:disabled){opacity:1!important;background:var(--vscode-list-hoverBackground)!important}

/* ── Status ── */
#status{font-size:11px;opacity:.6;min-height:14px}

/* ── Layer results ── */
#results{display:none}
.meta{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.layer{margin-bottom:6px}
.llabel{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;opacity:.4;margin-bottom:2px}
.file{font-size:11.5px;padding:2px 5px;cursor:pointer;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.file:hover{background:var(--vscode-list-hoverBackground);opacity:1}

/* ════════════════════════════
   MODEL MANAGER
════════════════════════════ */
#model-area{display:flex;flex-direction:column;gap:7px}

/* ── Groq pinned card ── */
.groq-card{border-radius:7px;border:1px solid var(--vscode-focusBorder,#007acc);background:var(--vscode-editorWidget-background,#1e2233);padding:9px 11px;display:flex;flex-direction:column;gap:7px}
.groq-card.active-card{border-color:#3fb950;box-shadow:0 0 0 1px #3fb95033}
.groq-header{display:flex;align-items:center;justify-content:space-between;gap:6px}
.groq-title{display:flex;align-items:center;gap:6px;overflow:hidden;min-width:0;flex:1}
.groq-dot{width:7px;height:7px;border-radius:50%;background:#f97316;flex-shrink:0}
.groq-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.groq-tag{font-size:10px;padding:1px 6px;border-radius:8px;background:#1c3a1c;color:#3fb950;border:1px solid #2d5a2d;white-space:nowrap;flex-shrink:0}
.groq-sel-btn{font-size:11px;padding:3px 10px;border-radius:12px;cursor:pointer;border:1px solid var(--vscode-button-background);background:transparent;color:var(--vscode-button-background);font-family:inherit;white-space:nowrap;flex-shrink:0;transition:background .1s,color .1s}
.groq-sel-btn:hover{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.groq-sel-btn.active-btn{background:#3fb950;border-color:#3fb950;color:#0d1117;font-weight:700}
.groq-key-row{display:flex;gap:5px;align-items:center}
.groq-key-row input{flex:1;padding:5px 7px;font-size:12px;border-radius:4px;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#555);font-family:inherit}
.groq-key-row input:focus{outline:1px solid var(--vscode-focusBorder,#007acc)}
.groq-key-save{padding:5px 10px;font-size:12px;border-radius:4px;cursor:pointer;border:none;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-family:inherit;white-space:nowrap;flex-shrink:0}
.groq-key-save:hover{background:var(--vscode-button-hoverBackground)}
.groq-key-ok{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:#3fb950}
.groq-key-change{font-size:11px;background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:.45;padding:0;font-family:inherit}
.groq-key-change:hover{opacity:1}
.groq-hint{font-size:10.5px;opacity:.45;line-height:1.4}
.ext-link{color:var(--vscode-textLink-foreground,#4daafc);text-decoration:none}
.ext-link:hover{text-decoration:underline}

/* ── Custom models section ── */
#custom-model-area{display:flex;flex-direction:column;gap:5px}
.add-custom-toggle{width:100%;padding:5px 8px;border-radius:5px;font-size:11.5px;cursor:pointer;border:1px dashed var(--vscode-editorWidget-border,#555);background:transparent;color:var(--vscode-foreground);opacity:.55;font-family:inherit;text-align:left;transition:opacity .1s,border-color .1s}
.add-custom-toggle:hover{opacity:1;border-color:var(--vscode-focusBorder,#007acc)}
.add-custom-toggle.open{opacity:.9;border-style:solid;border-color:var(--vscode-focusBorder,#007acc)}

/* Model chips (for user-added models) */
#model-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.mchip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px 3px 9px;border-radius:20px;font-size:11.5px;cursor:pointer;border:1px solid var(--vscode-editorWidget-border,#444);background:var(--vscode-editorWidget-background,#252526);transition:border-color .12s;white-space:nowrap;max-width:160px}
.mchip .mlbl{overflow:hidden;text-overflow:ellipsis;flex:1}
.mchip .mdel{font-size:13px;line-height:1;opacity:0;background:none;border:none;cursor:pointer;color:var(--vscode-foreground);padding:0 0 0 3px;flex-shrink:0;transition:opacity .1s}
.mchip:hover .mdel{opacity:.5}
.mchip .mdel:hover{opacity:1!important;color:#fc8181}
.mchip.active{border-color:var(--vscode-focusBorder,#007acc);background:var(--vscode-list-activeSelectionBackground,#094771);color:var(--vscode-list-activeSelectionForeground,#fff)}
.mchip .medit{font-size:11px;line-height:1;opacity:0;background:none;border:none;cursor:pointer;color:var(--vscode-foreground);padding:0 0 0 2px;flex-shrink:0;transition:opacity .1s}
.mchip:hover .medit{opacity:.45}
.mchip .medit:hover{opacity:1!important}

/* Model form */
#model-form{display:none;flex-direction:column;gap:7px;padding:9px;border-radius:6px;border:1px solid var(--vscode-focusBorder,#007acc);background:var(--vscode-editorWidget-background,#252526)}
#model-form.open{display:flex}
#model-form .ftitle{font-size:11px;font-weight:700;opacity:.5;text-transform:uppercase;letter-spacing:.06em}
#prov-row{display:flex;flex-wrap:wrap;gap:3px}
.pbtn{padding:3px 8px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid var(--vscode-editorWidget-border,#444);background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-foreground);font-family:inherit;white-space:nowrap;transition:border-color .1s}
.pbtn:hover{border-color:var(--vscode-focusBorder,#007acc)}
.pbtn.sel{border-color:var(--vscode-focusBorder,#007acc);background:var(--vscode-list-activeSelectionBackground,#094771);color:#fff}
.field{display:flex;flex-direction:column;gap:2px}
.field label{font-size:10.5px;opacity:.55}
.field input,.field select{padding:5px 7px;font-size:12px;border-radius:4px;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#555);font-family:inherit;width:100%}
.field input:focus,.field select:focus{outline:1px solid var(--vscode-focusBorder,#007acc)}
.field .hint{font-size:10.5px;opacity:.4}
.ferr{font-size:11px;color:#fc8181;min-height:14px}
.frow{display:flex;gap:5px}
.frow .btn{flex:1}

/* ════════════════════════════
   CHAT
════════════════════════════ */
#chat-header{display:flex;align-items:center;justify-content:space-between;padding:5px 10px 3px;flex-shrink:0}
#chat-header span{font-size:11px;font-weight:700;opacity:.4;text-transform:uppercase;letter-spacing:.06em}
#clr{font-size:10px;opacity:.4;background:none;border:none;cursor:pointer;color:var(--vscode-foreground);padding:2px 5px;border-radius:3px}
#clr:hover{opacity:1;background:var(--vscode-list-hoverBackground)}
#chat-log{flex:1;overflow-y:auto;padding:0 10px 6px;display:flex;flex-direction:column;gap:6px;min-height:0}
.msg{font-size:12px;line-height:1.55}
.mu{align-self:flex-end;text-align:right;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:5px 10px;border-radius:10px 10px 2px 10px;max-width:90%}
.ma{align-self:flex-start;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-editorWidget-border,#444);padding:7px 10px;border-radius:2px 10px 10px 10px;max-width:100%;word-break:break-word}
.ma code{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;background:rgba(255,255,255,.07);padding:1px 4px;border-radius:3px}
.fl{color:var(--vscode-textLink-foreground,#4daafc);cursor:pointer;text-decoration:underline;font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.fl:hover{opacity:.8}
.msp{opacity:.45;font-size:12px;padding:4px 10px}
#inp-row{display:flex;gap:5px;padding:5px 10px 10px;align-items:flex-end;flex-shrink:0}
#chat-inp{flex:1;padding:6px 8px;font-size:12px;border-radius:4px;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);font-family:var(--vscode-font-family);line-height:1.4;max-height:80px;overflow-y:auto}
#chat-inp:focus{outline:1px solid var(--vscode-focusBorder)}
#send{padding:6px 11px;border-radius:4px;cursor:pointer;font-size:13px;border:none;background:var(--vscode-button-background);color:var(--vscode-button-foreground);flex-shrink:0;align-self:flex-end}
#send:hover{background:var(--vscode-button-hoverBackground)}
#send:disabled{opacity:.4;cursor:not-allowed}

/* ── RAG badge ── */
.rag-badge{display:block;margin-top:5px;font-size:10px;color:var(--vscode-descriptionForeground,#8b949e);opacity:.7;cursor:default}

/* ── Streaming cursor ── */
.scursor{display:inline-block;width:2px;height:13px;background:var(--vscode-foreground);opacity:.7;margin-left:1px;vertical-align:text-bottom;animation:blink .7s step-end infinite}
@keyframes blink{0%,100%{opacity:.7}50%{opacity:0}}
</style>
</head>
<body>

<!-- ═══ SCROLLABLE TOP SECTION ═══ -->
<div id="top">
  <div>
    <h2 style="margin-bottom:3px">Codebase Navigator</h2>
    <p class="muted">Analyze your project to map its architecture.</p>
  </div>

  <button class="btn" id="analyze-btn" onclick="analyze()">Analyze Workspace</button>
  <button class="btn btn-o" id="diag-btn" onclick="showDiag()" style="display:none">⬡ Open Architecture Map</button>
  <div id="status"></div>

  <div id="results">
    <div class="meta" id="meta"></div>
    <div class="sec">Layers</div>
    <div id="layers"></div>
  </div>

  <hr class="divider">

  <!-- ── Model area ── -->
  <div id="model-area">
    <div class="sec">AI Model</div>

    <!-- ══ Default: Groq (always visible, pinned) ══ -->
    <div class="groq-card" id="groq-card">
      <div class="groq-header">
        <div class="groq-title">
          <span class="groq-dot"></span>
          <span class="groq-name">llama-3.3-70b-versatile</span>
          <span class="groq-tag">Groq · Free</span>
        </div>
        <button class="groq-sel-btn" id="groq-sel" onclick="selectGroq()">Use</button>
      </div>
      <!-- Inline API key entry -->
      <div class="groq-key-row" id="groq-key-row">
        <input id="groq-key-inp" type="password" placeholder="Paste your Groq key  gsk_…" autocomplete="off"/>
        <button class="groq-key-save" onclick="saveGroqKey()">Save</button>
      </div>
      <div class="groq-key-ok" id="groq-key-ok" style="display:none">
        <span>🔑 Key saved</span>
        <button class="groq-key-change" onclick="changeGroqKey()">Change</button>
      </div>
      <div class="groq-hint">Free at <a href="https://console.groq.com/keys" class="ext-link">console.groq.com</a> — no credit card needed.</div>
    </div>

    <!-- ══ Custom models (collapsible) ══ -->
    <div id="custom-model-area">
      <button class="add-custom-toggle" id="add-toggle" onclick="toggleCustom()">＋ Add custom model</button>

      <div id="custom-section" style="display:none">
        <div id="model-chips" style="margin-bottom:6px">
          <!-- user-added model chips rendered here -->
        </div>

        <!-- Add / Edit form -->
        <div id="model-form">
          <div class="ftitle" id="form-title">Add model</div>

          <div class="field">
            <label>Provider shortcut</label>
            <div id="prov-row"></div>
          </div>

          <div class="field">
            <label>Model name</label>
            <input id="f-label" type="text" placeholder="e.g. claude-sonnet-4-20250514"/>
          </div>

          <div class="field">
            <label>Base URL</label>
            <input id="f-url" type="text" placeholder="https://api.anthropic.com"/>
          </div>

          <div class="field">
            <label>API format</label>
            <select id="f-fmt">
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>

          <div class="field">
            <label>API Key <span class="hint" id="key-hint"></span></label>
            <input id="f-key" type="password" placeholder="sk-…"/>
          </div>

          <div class="ferr" id="ferr"></div>

          <div class="frow">
            <button class="btn btn-g" onclick="closeForm()">Cancel</button>
            <button class="btn" id="fsave" onclick="saveForm()">Add Model</button>
          </div>
        </div>

        <button class="btn btn-g" id="add-chip" onclick="openForm(null)" style="margin-top:4px">＋ Add another</button>
      </div>
    </div>

  </div>

</div><!-- /#top -->

<!-- ═══ RESIZER ═══ -->
<div id="resizer"></div>

<!-- ═══ CHAT (resizable bottom panel) ═══ -->
<div id="chat-wrap" style="height:260px">
  <div id="chat-header">
    <span>Ask about your codebase</span>
    <button id="clr" onclick="clearChat()">Clear</button>
  </div>
  <div id="chat-log"></div>
  <div id="inp-row">
    <textarea id="chat-inp" rows="1" placeholder="Ask anything about the codebase…"></textarea>
    <button id="send" onclick="doSend()">↑</button>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// ═══ STATE ═══
let profiles  = [];
let providers = [];
let activeId  = null;
let editingId = null;

// ═══ RESTORE ═══
(function(){
  const s = vscode.getState() || {};
  if (s.indexData)    { renderIndex(s.indexData); }
  if (s.chatMsgs)     { s.chatMsgs.forEach(m => appendMsg(m.role, m.html, false)); }
})();

function ss(p){ vscode.setState({...(vscode.getState()||{}),...p}); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══ ANALYZE ═══
function analyze(){
  document.getElementById('status').textContent='Starting...';
  document.getElementById('results').style.display='none';
  document.getElementById('diag-btn').style.display='none';
  document.getElementById('analyze-btn').disabled=true;
  ss({indexData:null});
  vscode.postMessage({command:'analyze'});
}
function showDiag(){ vscode.postMessage({command:'showDiagram'}); }

function renderIndex(data){
  document.getElementById('status').textContent='✓ Done.';
  document.getElementById('analyze-btn').disabled=false;
  document.getElementById('diag-btn').style.display='block';
  document.getElementById('meta').innerHTML=
    '<span class="badge">'+esc(data.framework)+'</span>'+
    '<span class="badge">'+data.totalFiles+' files</span>';
  const le=document.getElementById('layers'); le.innerHTML='';
  for(const [layer,files] of Object.entries(data.layers)){
    if(!files.length) continue;
    const d=document.createElement('div'); d.className='layer';
    d.innerHTML='<div class="llabel">'+esc(layer)+' ('+files.length+')</div>';
    files.forEach(f=>{
      const el=document.createElement('div'); el.className='file';
      el.textContent=f; el.title=f;
      el.onclick=()=>vscode.postMessage({command:'openFile',path:data.root+'/'+f});
      d.appendChild(el);
    });
    le.appendChild(d);
  }
  document.getElementById('results').style.display='block';
}

// ═══ MODEL AREA ═══
let groqKeySet = false;
let customOpen = false;

function updateGroqCard(isActive){
  const btn = document.getElementById('groq-sel');
  const card = document.getElementById('groq-card');
  if(isActive){
    btn.textContent='✓ Active';
    btn.classList.add('active-btn');
    card.classList.add('active-card');
  } else {
    btn.textContent='Use';
    btn.classList.remove('active-btn');
    card.classList.remove('active-card');
  }
}

function setGroqKeyUI(isSet){
  groqKeySet = isSet;
  document.getElementById('groq-key-row').style.display = isSet ? 'none' : 'flex';
  document.getElementById('groq-key-ok').style.display  = isSet ? 'flex' : 'none';
}

function saveGroqKey(){
  const k = document.getElementById('groq-key-inp').value.trim();
  if(!k){ return; }
  vscode.postMessage({command:'saveGroqKey', key:k});
}

function changeGroqKey(){
  setGroqKeyUI(false);
  document.getElementById('groq-key-inp').value='';
  document.getElementById('groq-key-inp').focus();
}

function selectGroq(){
  vscode.postMessage({command:'selectModel', id:'builtin-groq-llama'});
  activeId='builtin-groq-llama';
  updateGroqCard(true);
  renderChips(); // deactivate any custom chip
}

// Allow Enter key in the Groq key input to save
document.getElementById('groq-key-inp').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ e.preventDefault(); saveGroqKey(); }
});

// ═══ CUSTOM MODEL TOGGLE ═══
function toggleCustom(){
  customOpen = !customOpen;
  document.getElementById('custom-section').style.display = customOpen ? 'block' : 'none';
  document.getElementById('add-toggle').classList.toggle('open', customOpen);
  if(customOpen){ buildProviderRow(); }
}

// ═══ MODEL CHIPS (user-added models only) ═══
function renderChips(){
  const row = document.getElementById('model-chips');
  row.querySelectorAll('.mchip').forEach(el=>el.remove());

  // Only show user-added profiles (not the builtin default)
  const custom = profiles.filter(p => p.id !== 'builtin-groq-llama');

  for(const p of custom){
    const chip = document.createElement('div');
    chip.className = 'mchip' + (p.id===activeId?' active':'');
    chip.dataset.id = p.id;
    chip.innerHTML =
      '<span class="mlbl" title="'+esc(p.label)+'">'+esc(p.label)+'</span>'+
      '<button class="medit" title="Edit" data-id="'+esc(p.id)+'">✎</button>'+
      '<button class="mdel"  title="Remove" data-id="'+esc(p.id)+'">×</button>';

    chip.addEventListener('click', ev => {
      const t = ev.target;
      if(t.classList.contains('mdel')){ ev.stopPropagation(); vscode.postMessage({command:'removeModel',id:t.dataset.id}); return; }
      if(t.classList.contains('medit')){ ev.stopPropagation(); openForm(t.dataset.id); return; }
      vscode.postMessage({command:'selectModel',id:p.id});
      activeId=p.id; updateGroqCard(false); renderChips();
    });

    row.appendChild(chip);
  }

  // Show/hide the custom section toggle label
  const toggle = document.getElementById('add-toggle');
  toggle.textContent = customOpen
    ? '▾ Custom models'
    : (custom.length > 0 ? '▸ Custom models (' + custom.length + ')' : '＋ Add custom model');
}

// ═══ ADD / EDIT FORM ═══
function buildProviderRow(){
  const row=document.getElementById('prov-row'); row.innerHTML='';
  for(const pv of providers){
    const b=document.createElement('button'); b.className='pbtn'; b.textContent=pv.name;
    b.onclick=()=>{
      document.getElementById('f-url').value=pv.baseUrl;
      document.getElementById('f-fmt').value=pv.format;
      document.getElementById('key-hint').textContent=pv.format==='ollama'?'(not needed)':'';
      document.querySelectorAll('.pbtn').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel');
    };
    row.appendChild(b);
  }
}

function openForm(id){
  editingId = id;
  document.getElementById('ferr').textContent='';
  document.querySelectorAll('.pbtn').forEach(x=>x.classList.remove('sel'));

  if(id){
    const p=profiles.find(x=>x.id===id);
    if(!p) return;
    document.getElementById('form-title').textContent='Edit model';
    document.getElementById('f-label').value=p.label;
    document.getElementById('f-url').value=p.baseUrl;
    document.getElementById('f-fmt').value=p.apiFormat;
    document.getElementById('f-key').value='';
    document.getElementById('f-key').placeholder='leave blank to keep existing key';
    document.getElementById('fsave').textContent='Update';
  } else {
    document.getElementById('form-title').textContent='Add model';
    document.getElementById('f-label').value='';
    document.getElementById('f-url').value='';
    document.getElementById('f-fmt').value='openai';
    document.getElementById('f-key').value='';
    document.getElementById('f-key').placeholder='sk-…';
    document.getElementById('fsave').textContent='Add Model';
  }

  document.getElementById('model-form').classList.add('open');
  document.getElementById('add-chip').style.display='none';
  document.getElementById('f-label').focus();
}

function closeForm(){
  document.getElementById('model-form').classList.remove('open');
  document.getElementById('add-chip').style.display='';
  editingId=null;
}

function saveForm(){
  const label  = document.getElementById('f-label').value.trim();
  const url    = document.getElementById('f-url').value.trim();
  const fmt    = document.getElementById('f-fmt').value;
  const apiKey = document.getElementById('f-key').value.trim();

  if(!label){ document.getElementById('ferr').textContent='Model name is required.'; return; }
  if(!url)  { document.getElementById('ferr').textContent='Base URL is required.'; return; }
  if(fmt!=='ollama' && !editingId && !apiKey){ document.getElementById('ferr').textContent='API key is required.'; return; }

  if(editingId){
    vscode.postMessage({command:'updateModel', id:editingId, label, baseUrl:url, apiFormat:fmt, apiKey});
  } else {
    vscode.postMessage({command:'addModel', label, baseUrl:url, apiFormat:fmt, apiKey});
  }
}

// ═══ RESIZABLE CHAT ═══
(function(){
  const resizer   = document.getElementById('resizer');
  const chatWrap  = document.getElementById('chat-wrap');
  let dragging=false, startY=0, startH=0;

  resizer.addEventListener('mousedown', ev=>{
    dragging=true; startY=ev.clientY; startH=chatWrap.offsetHeight;
    resizer.classList.add('dragging');
    document.body.style.userSelect='none';
  });
  window.addEventListener('mousemove', ev=>{
    if(!dragging) return;
    const delta = startY - ev.clientY;
    const newH  = Math.min(Math.max(startH+delta, 120), window.innerHeight-200);
    chatWrap.style.height = newH+'px';
  });
  window.addEventListener('mouseup', ()=>{
    dragging=false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect='';
  });
})();

// ═══ CHAT ═══
let chatMsgs=[];

// ── Streaming state ──────────────────────────────────────────────────────────
// _streamBubble: the live .ma div being built token-by-token
// _streamRaw:    accumulated plain text (used for save + file-link post-process)
let _streamBubble = null;
let _streamRaw    = '';

function fmtAss(text){
  const root=(vscode.getState()?.indexData?.root)||'';
  let h=esc(text);
  h=h.replace(/\\n\\n/g,'<br><br>').replace(/\\n/g,'<br>');
  h=h.replace(/\`([^\`]+)\`/g,(_,inner)=>{
    const isFile=/[\\/.]/.test(inner)&&!/\\s/.test(inner);
    if(isFile&&root){
      const fp=root+'/'+inner.replace(/\\\\/g,'/');
      return '<span class="fl" data-path="'+esc(fp)+'">'+esc(inner)+'</span>';
    }
    return '<code>'+esc(inner)+'</code>';
  });
  return h;
}

function appendMsg(role,html,save=true){
  const log=document.getElementById('chat-log');
  const d=document.createElement('div'); d.className='msg '+(role==='user'?'mu':'ma');
  d.innerHTML=html;
  d.querySelectorAll('.fl').forEach(el=>{
    el.addEventListener('click',()=>vscode.postMessage({command:'openFile',path:el.dataset.path}));
  });
  log.appendChild(d); log.scrollTop=log.scrollHeight;
  if(save){ chatMsgs.push({role,html}); ss({chatMsgs}); }
}

function rmSpinner(){ document.getElementById('msg-spin')?.remove(); }

// ── Open a live streaming bubble ─────────────────────────────────────────────
function openStreamBubble(){
  rmSpinner();
  const log=document.getElementById('chat-log');
  _streamBubble = document.createElement('div');
  _streamBubble.className = 'msg ma streaming';
  _streamBubble.innerHTML = '<span class="scursor"></span>'; // blinking cursor
  log.appendChild(_streamBubble);
  log.scrollTop = log.scrollHeight;
  _streamRaw = '';
}

// ── Append a chunk to the live bubble ───────────────────────────────────────
// We render incrementally by re-running fmtAss on the full accumulated text
// each time. For normal response lengths this is imperceptible.
function appendChunk(text){
  if(!_streamBubble){ openStreamBubble(); }
  _streamRaw += text;
  _streamBubble.innerHTML = fmtAss(_streamRaw) + '<span class="scursor"></span>';
  _streamBubble.querySelectorAll('.fl').forEach(el=>{
    el.addEventListener('click',()=>vscode.postMessage({command:'openFile',path:el.dataset.path}));
  });
  const log=document.getElementById('chat-log');
  log.scrollTop=log.scrollHeight;
}

// ── Finalise the bubble: remove cursor, add RAG badge, save to history ───────
function closeStreamBubble(ragMeta){
  if(!_streamBubble){ return; }
  let html = fmtAss(_streamRaw);
  if(ragMeta && ragMeta.fileCount > 0){
    const icon  = ragMeta.usedEmbeddings ? '🔍' : '📂';
    const label = ragMeta.usedEmbeddings ? 'semantic' : 'keyword';
    html += '<span class="rag-badge" title="'+esc(ragMeta.files.join('\\n'))+'">'+icon+' '+ragMeta.fileCount+' files · '+label+'</span>';
  }
  _streamBubble.innerHTML = html;
  _streamBubble.classList.remove('streaming');
  _streamBubble.querySelectorAll('.fl').forEach(el=>{
    el.addEventListener('click',()=>vscode.postMessage({command:'openFile',path:el.dataset.path}));
  });
  chatMsgs.push({role:'assistant', html}); ss({chatMsgs});
  _streamBubble = null;
  _streamRaw    = '';
  document.getElementById('send').disabled=false;
}

function doSend(){
  const inp=document.getElementById('chat-inp');
  const q=inp.value.trim(); if(!q) return;
  inp.value=''; inp.style.height='auto';
  appendMsg('user',esc(q));
  const log=document.getElementById('chat-log');
  const sp=document.createElement('div'); sp.id='msg-spin'; sp.className='msp'; sp.textContent='…';
  log.appendChild(sp); log.scrollTop=log.scrollHeight;
  document.getElementById('send').disabled=true;
  vscode.postMessage({command:'chat',question:q});
}

function clearChat(){
  chatMsgs=[]; document.getElementById('chat-log').innerHTML='';
  _streamBubble=null; _streamRaw='';
  ss({chatMsgs:[]}); vscode.postMessage({command:'clearChat'});
}

document.getElementById('chat-inp').addEventListener('input',function(){
  this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,80)+'px';
});
document.getElementById('chat-inp').addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); doSend(); }
});

// ═══ MESSAGE BUS ═══
window.addEventListener('message', ev=>{
  const msg=ev.data;

  if(msg.command==='modelsUpdated'){
    profiles=msg.profiles; providers=msg.providers; activeId=msg.activeId;
    const isGroqActive = activeId === 'builtin-groq-llama';
    updateGroqCard(isGroqActive);
    setGroqKeyUI(msg.groqKeySet);
    buildProviderRow();
    renderChips();
  }
  if(msg.command==='groqKeySaved'){
    setGroqKeyUI(true);
    // Auto-activate Groq now that it has a key
    activeId='builtin-groq-llama';
    updateGroqCard(true);
    renderChips();
  }
  if(msg.command==='modelSaved')  { closeForm(); }
  if(msg.command==='progress')    { document.getElementById('status').textContent=msg.message; }
  if(msg.command==='error')       { document.getElementById('status').textContent='⚠ '+msg.message; document.getElementById('analyze-btn').disabled=false; }
  if(msg.command==='indexed')     { ss({indexData:msg.data}); renderIndex(msg.data); }

  // ── Streaming protocol ───────────────────────────────────────────────────
  // chatStreaming  → spinner on (already handled by doSend)
  // chatChunkStart → open a live bubble (replaces the spinner)
  // chatChunk      → append text to the live bubble
  // chatChunkEnd   → finalise bubble, show RAG badge, re-enable send
  // chatResponse   → fallback for errors / non-streaming path (keeps working)

  if(msg.command==='chatChunkStart'){ openStreamBubble(); }
  if(msg.command==='chatChunk')     { appendChunk(msg.text); }
  if(msg.command==='chatChunkEnd')  { closeStreamBubble(msg.ragMeta); }

  if(msg.command==='chatResponse'){
    // Error path or any future non-streaming fallback
    rmSpinner();
    if(_streamBubble){ _streamBubble.remove(); _streamBubble=null; _streamRaw=''; }
    document.getElementById('send').disabled=false;
    const ragMeta = msg.ragMeta;
    if(ragMeta && ragMeta.fileCount > 0){
      const icon  = ragMeta.usedEmbeddings ? '🔍' : '📂';
      const label = ragMeta.usedEmbeddings ? 'semantic' : 'keyword';
      const badge = '<span class="rag-badge" title="'+esc(ragMeta.files.join('\\n'))+'">'+icon+' '+ragMeta.fileCount+' files · '+label+'</span>';
      appendMsg('assistant', fmtAss(msg.text) + badge);
    } else {
      appendMsg('assistant', fmtAss(msg.text));
    }
  }
});
</script>
</body>
</html>`;
  }
}