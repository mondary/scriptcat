# Extension Chrome - ScriptCat Sync Bidirectionnel

## Installation rapide

1. **Ouvrez Chrome** et allez à `chrome://extensions/`
2. **Activez "Mode développeur"** (en haut à droite)
3. **Cliquez sur "Charger décompressé"**
4. **Sélectionnez le dossier** : `/Users/clm/Documents/GitHub/PROJECTS/VS_pkscriptcatws/extensions/chrome/src/`

## Fichiers inclus

- `simple_manifest.json` : Manifest modifié avec permission WebSocket
- `service_worker_sync.js` : Service worker avec synchronisation bidirectionnelle
- `popup.html` : Interface simple pour gérer la connexion

## Fonctionnalités

- 🔗 **Connexion WebSocket** à VS Code
- 📥 **Pull** scripts depuis VS Code
- 📤 **Push** scripts vers VS Code
- 🔄 **Synchronisation** en temps réel
- 📊 **Interface** de gestion simple

## Configuration

L'extension se connecte automatiquement à `ws://localhost:8642` quand VS Code est démarré.

## Tests

1. Démarrez l'extension VS Code
2. Ouvrez l'extension Chrome et vérifiez la connexion
3. Testez la synchronisation via le popup
