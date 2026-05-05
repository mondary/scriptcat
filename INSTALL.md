# Installation du fork ScriptCat bidirectionnel

## 1. Fork du repository officiel

```bash
# Cloner votre fork
cd chrome/src
git remote add fork https://github.com/votre-username/scriptcat.git
git pull fork main
```

## 2. Appliquer les modifications

### Modifications manuelles nécessaires :

1. **Remplacer le service worker** :
   - Copiez `service_worker_bidirectional.ts` vers `src/service_worker.ts`
   - Ou renommez l'original et utilisez la version bidirectionnelle

2. **Ajouter le script de synchronisation** :
   - Copiez `scriptcat_sync.js` vers `src/scriptcat_sync.js`

3. **Mettre à jour le manifest** :
   - Vérifiez que `websocket` est dans les permissions

## 3. Build de l'extension

```bash
cd chrome/src
npm install
npm run build
npm run pack
```

L'extension buildée sera disponible dans `dist/` ou similaire.

## 4. Installation dans Chrome

1. Ouvrez Chrome et allez à `chrome://extensions/`
2. Activez "Mode développeur"
3. Cliquez sur "Charger décompressé"
4. Sélectionnez le dossier `chrome/src/dist/` ou le `.crx` généré

## 5. Configuration de la synchronisation

Dans ScriptCat :
- Allez dans les options
- Configuration VS Code :
  - URL : `ws://localhost:8642`
  - Auto-connect : Activé
  - Sync Delete : Activé

Dans VS Code :
- Installez l'extension `vs-pkscriptcat-snippets`
- Configurez le port : 8642
- Activez auto-connect

## 6. Test de la synchronisation

1. Démarrez le serveur VS Code : `ScriptCat: Start Server`
2. Vérifiez la connexion dans ScriptCat
3. Créez/modifiez un script dans VS Code → devrait apparaître dans ScriptCat
4. Ajoutez un script dans ScriptCat → devrait apparaître dans VS Code

## 📝 Notes importantes

- Assurez-vous que les ports ne sont pas bloqués par des pare-feu
- Les scripts sont sauvegardés avec un timestamp pour éviter les conflits
- La synchronisation est bidirectionnelle mais préserve les scripts locaux existants
- En cas de conflit, le script le plus récent est conservé