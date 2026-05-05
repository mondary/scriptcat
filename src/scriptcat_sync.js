// Script pour gérer la synchronisation bidirectionnelle
// Ce script doit être exécuté dans le contexte de l'extension

class ScriptCatVSCodeSync {
  constructor() {
    this.initializeConnection();
  }

  initializeConnection() {
    const vscodeUrl = 'ws://localhost:8642';
    this.ws = new WebSocket(vscodeUrl);
    
    this.ws.onopen = () => {
      console.log('🔗 Connected to VS Code ScriptCat extension');
      this.sendLocalScripts();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleVSCodeMessage(message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('🔌 Disconnected from VS Code');
      setTimeout(() => this.initializeConnection(), 5000);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  async sendLocalScripts() {
    try {
      // Récupérer les scripts locaux depuis chrome.scripting
      const scripts = await chrome.scripting.getAllScripts();
      const scriptList = scripts.map(script => ({
        id: script.id,
        name: script.name || 'Unknown Script',
        code: script.function?.toString() || '',
        meta: script.meta || {},
        updated: Date.now()
      }));

      this.sendToVSCode({
        type: 'script_list',
        data: scriptList,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error getting local scripts:', error);
    }
  }

  handleVSCodeMessage(message) {
    switch (message.type) {
      case 'script_update':
        this.updateScript(message.data.script);
        break;
      case 'script_delete':
        this.deleteScript(message.data.scriptId);
        break;
      case 'script_request':
        this.sendScript(message.data.scriptId);
        break;
    }
  }

  async updateScript(scriptInfo) {
    try {
      // Convertir la chaîne de fonction en fonction
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
    try {
      await chrome.scripting.unregisterScript({ ids: [scriptId] });
      console.log('🗑️ Script deleted from VS Code:', scriptId);
    } catch (error) {
      console.error('Error deleting script:', error);
    }
  }

  async sendScript(scriptId) {
    try {
      const scripts = await chrome.scripting.getScripts({ ids: [scriptId] });
      if (scripts.length > 0) {
        const script = scripts[0];
        this.sendToVSCode({
          type: 'script_list',
          data: [{
            id: script.id,
            name: script.name || 'Unknown Script',
            code: script.function?.toString() || '',
            meta: script.meta || {},
            updated: Date.now()
          }],
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Error sending script:', error);
    }
  }

  sendToVSCode(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

// Initialiser la synchronisation
if (typeof chrome !== 'undefined' && chrome.scripting) {
  new ScriptCatVSCodeSync();
} else {
  console.log('ScriptCat Sync: Chrome scripting API not available');
}