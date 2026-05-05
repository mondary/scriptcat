// Service Worker modifié pour synchronisation bidirectionnelle avec VS Code
// Version simplifiée sans dépendances complexes

class VSCodeSync {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.pendingScripts = new Map();
    this.initConnection();
  }

  initConnection() {
    if (this.ws) return;
    
    try {
      const vscodeUrl = `ws://localhost:8642`;
      this.ws = new WebSocket(vscodeUrl);
      
      this.ws.onopen = () => {
        console.log('🔗 Connected to VS Code');
        this.reconnectAttempts = 0;
        this.sendScriptList();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleVSCodeMessage(message);
        } catch (error) {
          console.error('Error parsing VS Code message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('🔌 Disconnected from VS Code');
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Failed to connect to VS Code:', error);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`🔄 Reconnecting to VS Code (attempt ${this.reconnectAttempts})...`);
      
      setTimeout(() => {
        this.initConnection();
      }, 2000 * this.reconnectAttempts);
    }
  }

  async sendScriptList() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      // Obtenir tous les scripts enregistrés
      const scripts = await chrome.scripting.getAllScripts();
      const scriptList = scripts.map(script => ({
        id: script.id,
        name: script.name || 'Unknown Script',
        code: script.function?.toString() || '',
        meta: script.meta || {},
        updated: Date.now()
      }));

      this.ws.send(JSON.stringify({
        type: 'script_list',
        data: scriptList,
        timestamp: Date.now()
      }));
      
      console.log('📤 Sent script list to VS Code:', scriptList.length, 'scripts');
    } catch (error) {
      console.error('Error getting scripts:', error);
    }
  }

  handleVSCodeMessage(message) {
    console.log('📥 Received message from VS Code:', message.type);

    switch (message.type) {
      case 'script_update':
        this.updateScript(message.data?.script);
        break;
      case 'script_delete':
        this.deleteScript(message.data?.scriptId);
        break;
    }
  }

  async updateScript(scriptInfo) {
    if (!scriptInfo || !scriptInfo.id) return;

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
      
      console.log('✅ Script updated from VS Code:', scriptInfo.name);
    } catch (error) {
      console.error('Error updating script:', error);
    }
  }

  async deleteScript(scriptId) {
    if (!scriptId) return;

    try {
      await chrome.scripting.unregisterScript({ ids: [scriptId] });
      console.log('🗑️ Script deleted from VS Code:', scriptId);
    } catch (error) {
      console.error('Error deleting script:', error);
    }
  }

  pushScript(scriptInfo) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Stocker en attente
      this.pendingScripts.set(scriptInfo.id, scriptInfo);
      console.log('⏳ Script queued for VS Code:', scriptInfo.name);
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'script_update',
      data: { script: scriptInfo },
      timestamp: Date.now()
    }));
  }
}

// Initialiser la synchronisation quand le service worker démarre
let vscodeSync;

chrome.runtime.onStartup.addListener(() => {
  vscodeSync = new VSCodeSync();
});

chrome.runtime.onInstalled.addListener(() => {
  vscodeSync = new VSCodeSync();
});

// Surveiller les changements de scripts
chrome.scripting.onScriptRegistered.addListener((script) => {
  if (vscodeSync) {
    vscodeSync.pushScript({
      id: script.id,
      name: script.name || 'Unknown Script',
      code: script.function?.toString() || '',
      meta: script.meta || {},
      updated: Date.now()
    });
  }
});

chrome.scripting.onScriptUnregistered.addListener((scriptId) => {
  if (vscodeSync && vscodeSync.ws) {
    vscodeSync.ws.send(JSON.stringify({
      type: 'script_delete',
      data: { scriptId },
      timestamp: Date.now()
    }));
  }
});

// Garder le service worker en vie
setInterval(() => {
  if (vscodeSync && vscodeSync.ws && vscodeSync.ws.readyState === WebSocket.OPEN) {
    // Envoyer les scripts en attente
    for (const [scriptId, scriptInfo] of vscodeSync.pendingScripts) {
      vscodeSync.ws.send(JSON.stringify({
        type: 'script_update',
        data: { script: scriptInfo },
        timestamp: Date.now()
      }));
      vscodeSync.pendingScripts.delete(scriptId);
    }
  }
}, 5000);

// Importer les fonctionnalités originales du service worker
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

migrate();
migrateChromeStorage();

const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";

let creating = null;

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
          creating = true;
        });
      creating = promise;
    }
    await creating;
  }
}

function main() {
  cleanInvalidKeys();
  
  const message = new ExtensionMessage(true);
  const loggerCore = new LoggerCore({
    writer: new DBWriter(new LoggerDAO()),
    labels: { env: "service_worker" },
  });
  loggerCore.logger().debug("service worker start");
  
  const server = new Server("serviceWorker", message);
  const messageQueue = new MessageQueue();
  const manager = new ServiceWorkerManager(server, messageQueue, new ServiceWorkerMessageSend());
  
  manager.initManager();
  setupOffscreenDocument();
}

main();