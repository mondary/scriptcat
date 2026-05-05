// Service Worker simplifié pour synchronisation bidirectionnelle
class VSCodeSync {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.initConnection();
  }

  initConnection() {
    if (this.ws) return;
    
    try {
      const vscodeUrl = `ws://localhost:8643`;
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
    } catch (error) {
      console.error('Failed to connect to VS Code:', error);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < 5) {
      this.reconnectAttempts++;
      setTimeout(() => this.initConnection(), 2000 * this.reconnectAttempts);
    }
  }

  async sendScriptList() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      if (!chrome.scripting || typeof chrome.scripting.getAllScripts !== 'function') {
        console.warn('chrome.scripting.getAllScripts unavailable; sending empty list');
        this.ws.send(JSON.stringify({
          type: 'script_list',
          data: [],
          timestamp: Date.now()
        }));
        return;
      }
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
    } catch (error) {
      console.error('Error getting scripts:', error);
    }
  }

  handleVSCodeMessage(message) {
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
    if (!scriptInfo?.id) return;

    try {
      if (!chrome.scripting || typeof chrome.scripting.registerScript !== 'function') {
        console.warn('chrome.scripting.registerScript unavailable; skip update');
        return;
      }
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
      if (!chrome.scripting || typeof chrome.scripting.unregisterScript !== 'function') {
        console.warn('chrome.scripting.unregisterScript unavailable; skip delete');
        return;
      }
      await chrome.scripting.unregisterScript({ ids: [scriptId] });
      console.log('🗑️ Script deleted:', scriptId);
    } catch (error) {
      console.error('Error deleting script:', error);
    }
  }
}

// Initialiser la synchronisation
let vscodeSync;

function ensureSync() {
  if (!vscodeSync) {
    vscodeSync = new VSCodeSync();
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureSync();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureSync();
});

// Init immédiate au chargement du worker
ensureSync();

// Garder le service worker en vie
setInterval(() => {
  if (vscodeSync?.ws?.readyState !== WebSocket.OPEN) {
    vscodeSync?.initConnection();
  }
}, 10000);
