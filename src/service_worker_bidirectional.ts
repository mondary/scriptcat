import ServiceWorkerManager from "./app/service/service_worker";
import LoggerCore from "./app/logger/core";
import DBWriter from "./app/logger/db_writer";
import { LoggerDAO } from "./app/repo/logger";
import { ExtensionMessage } from "@Packages/message/extension_message";
import { Server } from "@Packages/message/server";
import { MessageQueue } from "@Packages/message/message_queue";
import { ServiceWorkerMessageSend } from "@Packages/message/window_message";
import migrate, { migrateChromeStorage } from "./app/migrate";
import { cleanInvalidKeys } from "./app/repo/resource";

// === NOUVELLE FONCTIONNALITÉ BIDIRECTIONNELLE VS CODE ===
interface VSCodeMessage {
  type: 'script_list' | 'script_request' | 'script_update' | 'script_delete';
  data?: any;
  timestamp?: number;
}

interface ScriptInfo {
  id: string;
  name: string;
  code: string;
  meta: any;
  updated: number;
}

class VSCodeSync {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  private pendingScripts: Map<string, ScriptInfo> = new Map();
  private isConnecting = false;

  constructor() {
    this.initConnection();
  }

  private initConnection() {
    if (this.isConnecting || this.ws) return;
    
    this.isConnecting = true;
    
    try {
      const vscodeUrl = `ws://localhost:8642`;
      this.ws = new WebSocket(vscodeUrl);
      
      this.ws.onopen = () => {
        console.log('🔗 Connected to VS Code');
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.sendScriptList();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: VSCodeMessage = JSON.parse(event.data);
          this.handleVSCodeMessage(message);
        } catch (error) {
          console.error('Error parsing VS Code message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('🔌 Disconnected from VS Code');
        this.ws = null;
        this.isConnecting = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
      };
    } catch (error) {
      console.error('Failed to connect to VS Code:', error);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`🔄 Reconnecting to VS Code (attempt ${this.reconnectAttempts})...`);
      
      setTimeout(() => {
        this.initConnection();
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  private sendScriptList() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Envoyer la liste des scripts vers VS Code
    chrome.scripting.getAllScripts().then(scripts => {
      const scriptList = scripts.map(script => ({
        id: script.id,
        name: script.name || 'Unknown Script',
        code: script.function?.toString() || '',
        meta: script.meta || {},
        updated: Date.now()
      }));

      const message: VSCodeMessage = {
        type: 'script_list',
        data: scriptList,
        timestamp: Date.now()
      };

      this.ws!.send(JSON.stringify(message));
      console.log('📤 Sent script list to VS Code:', scriptList.length, 'scripts');
    }).catch(error => {
      console.error('Error getting scripts:', error);
    });
  }

  private handleVSCodeMessage(message: VSCodeMessage) {
    console.log('📥 Received message from VS Code:', message.type);

    switch (message.type) {
      case 'script_request':
        // Demande spécifique d'un script
        if (message.data?.scriptId) {
          this.sendScript(message.data.scriptId);
        }
        break;

      case 'script_update':
        // Mise à jour d'un script depuis VS Code
        if (message.data?.script) {
          this.updateScript(message.data.script);
        }
        break;

      case 'script_delete':
        // Suppression d'un script depuis VS Code
        if (message.data?.scriptId) {
          this.deleteScript(message.data.scriptId);
        }
        break;
    }
  }

  private sendScript(scriptId: string) {
    chrome.scripting.getScripts({ ids: [scriptId] }).then(scripts => {
      if (scripts.length > 0) {
        const script = scripts[0];
        const message: VSCodeMessage = {
          type: 'script_list',
          data: [{
            id: script.id,
            name: script.name || 'Unknown Script',
            code: script.function?.toString() || '',
            meta: script.meta || {},
            updated: Date.now()
          }],
          timestamp: Date.now()
        };
        this.ws!.send(JSON.stringify(message));
      }
    });
  }

  private async updateScript(scriptInfo: ScriptInfo) {
    try {
      // Convertir la chaîne de fonction en fonction réelle
      const functionBody = scriptInfo.code.replace(/^function.*?\{/, '').replace(/\}$/, '');
      const func = new Function(functionBody);
      
      await chrome.scripting.registerScript({
        id: scriptInfo.id,
        func: func,
        meta: scriptInfo.meta || {},
        target: { hostPermissions: ['<all_urls>'] }
      });
      
      console.log('✅ Script updated in Chrome:', scriptInfo.name);
    } catch (error) {
      console.error('Error updating script:', error);
    }
  }

  private async deleteScript(scriptId: string) {
    try {
      await chrome.scripting.unregisterScript({ ids: [scriptId] });
      console.log('🗑️ Script deleted from Chrome:', scriptId);
    } catch (error) {
      console.error('Error deleting script:', error);
    }
  }

  public pushScript(scriptInfo: ScriptInfo) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Stocker en attente si pas connecté
      this.pendingScripts.set(scriptInfo.id, scriptInfo);
      console.log('⏳ Script queued for VS Code:', scriptInfo.name);
      return;
    }

    const message: VSCodeMessage = {
      type: 'script_update',
      data: { script: scriptInfo },
      timestamp: Date.now()
    };

    this.ws.send(JSON.stringify(message));
    console.log('📤 Pushed script to VS Code:', scriptInfo.name);
  }

  public sendQueuedScripts() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const [scriptId, scriptInfo] of this.pendingScripts) {
      const message: VSCodeMessage = {
        type: 'script_update',
        data: { script: scriptInfo },
        timestamp: Date.now()
      };
      this.ws.send(JSON.stringify(message));
      this.pendingScripts.delete(scriptId);
      console.log('📤 Sent queued script to VS Code:', scriptInfo.name);
    }
  }
}

// Migration existante
migrate();
migrateChromeStorage();

const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";

let creating: Promise<void> | null | boolean = null;

async function hasDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });
  return existingContexts.length > 0;
}

async function setupOffscreenDocument() {
  if (typeof chrome.offscreen?.createDocument !== "function") {
    console.error("Your browser does not support chrome.offscreen.createDocument");
    return;
  }
  
  if (!(await hasDocument())) {
    if (!creating) {
      const promise = chrome.offscreen
        .createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: [
            chrome.offscreen.Reason.BLOBS,
            chrome.offscreen.Reason.CLIPBOARD,
            chrome.offscreen.Reason.DOM_SCRAPING,
            chrome.offscreen.Reason.LOCAL_STORAGE,
          ],
          justification: "offscreen page",
        })
        .then(() => {
          if (creating !== promise) {
            console.log("setupOffscreenDocument() calling is invalid.");
            return;
          }
          creating = true;
        });
      creating = promise;
    }
    await creating;
  }
}

function main() {
  cleanInvalidKeys();
  
  // Initialiser la synchronisation bidirectionnelle VS Code
  const vscodeSync = new VSCodeSync();
  
  const message = new ExtensionMessage(true);
  const loggerCore = new LoggerCore({
    writer: new DBWriter(new LoggerDAO()),
    labels: { env: "service_worker" },
  });
  loggerCore.logger().debug("service worker start");
  
  const server = new Server("serviceWorker", message);
  const messageQueue = new MessageQueue();
  const manager = new ServiceWorkerManager(server, messageQueue, new ServiceWorkerMessageSend());
  
  // Surveiller les changements de scripts pour envoyer à VS Code
  chrome.scripting.onScriptRegistered.addListener((script) => {
    vscodeSync.pushScript({
      id: script.id,
      name: script.name || 'Unknown Script',
      code: script.function?.toString() || '',
      meta: script.meta || {},
      updated: Date.now()
    });
  });

  chrome.scripting.onScriptUnregistered.addListener((scriptId) => {
    const message: VSCodeMessage = {
      type: 'script_delete',
      data: { scriptId },
      timestamp: Date.now()
    };
    
    if (vscodeSync['ws'] && vscodeSync['ws'].readyState === WebSocket.OPEN) {
      vscodeSync['ws'].send(JSON.stringify(message));
    }
  });

  manager.initManager();
  setupOffscreenDocument();

  // Envoyer les scripts en attente quand la connexion est établie
  setInterval(() => {
    if (vscodeSync['ws'] && vscodeSync['ws'].readyState === WebSocket.OPEN) {
      vscodeSync.sendQueuedScripts();
    }
  }, 5000);
}

main();