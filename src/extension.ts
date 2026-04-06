import * as vscode from 'vscode';
import { NavigatorSidebarProvider } from './sidebar/SidebarProvider';
import { ModelManager, DEFAULT_GROQ_ID, DEFAULT_GROQ_PROFILE } from './sidebar/modelManager';
import { getEnv } from './envLoader';

export async function activate(context: vscode.ExtensionContext) {

  // ── 1. Read .env and pre-load the Groq key into VS Code secret storage ───
  //       This runs once on every extension startup.
  //       If the key is already stored (from a previous session) and the .env
  //       has the same value, the write is a harmless no-op.
  const groqKey = getEnv(context.extensionPath, 'GROQ_API_KEY');

  const modelManager = new ModelManager(context.secrets, context.globalState);
  await modelManager.ensureDefaults();

  if (groqKey) {
    await modelManager.saveGroqKey(groqKey);
    // Auto-select the Groq default if the user hasn't picked anything else
    const currentActive = context.globalState.get<string>('codebaseNavigator.activeProfileId');
    if (!currentActive) {
      await context.globalState.update('codebaseNavigator.activeProfileId', DEFAULT_GROQ_ID);
    }
  }

  // ── 2. Register the sidebar (it reads the now-seeded state) ─────────────
  const provider = new NavigatorSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NavigatorSidebarProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    )
  );
}

export function deactivate() {}