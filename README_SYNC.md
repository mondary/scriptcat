# ScriptCat Bidirectional Fork

Ce fork de ScriptCat ajoute la synchronisation bidirectionnelle avec VS Code via WebSocket.

## 🆕 Nouveautés

### 🔗 Synchronisation Bidirectionnelle
- **Push** : Les scripts modifiés dans ScriptCat sont envoyés vers VS Code
- **Pull** : Les scripts ajoutés/modifiés dans VS Code sont récupérés dans ScriptCat  
- **Sync en temps réel** via WebSocket
- **Reconnexion automatique** si la connexion est perdue

### 📡 Communication WebSocket
- **URL** : `ws://localhost:8642` (configurable)
- **Protocole** : JSON message exchange
- **Types de messages** :
  - `script_list` : Liste des scripts disponibles
  - `script_request` : Demande spécifique d'un script
  - `script_update` : Mise à jour d'un script
  - `script_delete` : Suppression d'un script

## 🛠️ Installation

### Extension Chrome
1. Téléchargez la version buildée depuis `chrome/releases/`
2. Installez l'extension dans Chrome
3. Configurez la connexion VS Code dans les options

### VS Code Extension
```bash
cd vscode/src
npm install
vsce package
code --install-extension vs-pkscriptcatws.vsix
```

## ⚙️ Configuration

### Dans ScriptCat
- **VSCode URL** : `ws://localhost:8642`
- **Auto Connect** : Activé par défaut
- **Sync Delete** : Activé pour la suppression bidirectionnelle

### Dans VS Code
- **Port** : 8642 (modifiable)
- **Auto Connect** : Activé par défaut
- **Dossier Scripts** : `/snippets/`

## 🔄 Protocole de communication

```typescript
interface Message {
  type: 'script_list' | 'script_request' | 'script_update' | 'script_delete';
  data?: any;
  timestamp?: number;
}
```

## 📦 Structure

```
chrome/src/
├── src/
│   ├── service_worker_bidirectional.ts  # Service worker modifié
│   ├── scriptcat_sync.js                # Script de synchronisation
│   └── manifest.json                    # Manifest modifié
└── releases/                           # Versions buildées
```

## 🚀 Build

```bash
cd chrome/src
npm install
npm run build
npm run pack
```

## 🐛 Dépannage

1. **Connexion échouée** : Vérifiez que le serveur VS Code est démarré
2. **Scripts non synchronisés** : Vérifiez les permissions WebSocket
3. **Erreurs de parsing** : Consultez la console développeur

## 🔗 Liens

- Repository original : [scriptscat/scriptcat](https://github.com/scriptscat/scriptcat)
- Documentation : [scriptcat.org](https://scriptcat.org/)