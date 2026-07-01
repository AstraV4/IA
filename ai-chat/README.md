# Mon IA — site de chat IA (Pro via Discord)

Un site où les gens créent un compte, discutent avec une IA (Claude), et ont un
quota de messages par mois. Pour passer en **Pro** (plus de messages), l'utilisateur
ajoute le propriétaire sur **Discord** ; le propriétaire l'active ensuite à la main
depuis un **panneau admin**.

## 1) Mettre en ligne (comme ton biolink)

1. Mets le **contenu** de ce dossier dans un dépôt GitHub.
2. Railway : New Project → Deploy from GitHub → choisis le dépôt.
3. Root Directory = le dossier qui contient `server.js` (ici `ai-chat`).
4. Ajoute un **Volume** monté sur `/data` (pour garder les comptes).
5. Mets les **variables** ci-dessous, puis Deploy.
6. Branche un domaine/sous-domaine via Cloudflare.

## 2) Variables d'environnement

**Obligatoires :**
- `DATA_DIR` = `/data`
- `SESSION_SECRET` = une longue phrase secrète au hasard
- `ANTHROPIC_API_KEY` = ta clé API (platform.claude.com, 5 $ offerts)

**Pour gérer le Pro :**
- `ADMIN_EMAIL` = TON e-mail de compte sur le site (te donne accès à `/admin`)
- `DISCORD_HANDLE` = ton pseudo Discord affiché (def: `@lvtm`)

**Optionnelles (réglages) :**
- `SITE_NAME` = nom affiché (def: "Mon IA")
- `AI_MODEL` = `claude-haiku-4-5` (pas cher) / `claude-sonnet-4-6` (meilleur)
- `SYSTEM_PROMPT` = la "personnalité" de l'IA
- `PLAN_FREE_LIMIT` = messages/mois gratuit (def: 30)
- `PLAN_PRO_LIMIT` = messages/mois Pro (def: 1000)

## 3) Comment passer quelqu'un en Pro

1. La personne crée un compte sur le site et t'ajoute sur Discord (`DISCORD_HANDLE`).
2. Elle te donne l'e-mail de son compte.
3. Toi : connecte-toi avec le compte dont l'e-mail = `ADMIN_EMAIL`.
4. Va sur **/admin** (ou bouton "Panneau admin" dans Mon compte).
5. Trouve la personne, clique **Passer Pro**. Voilà 🎉 (clic "Repasser Gratuit" pour annuler.)

## Notes
- Le quota se remet à zéro tous les 30 jours.
- Le code bascule automatiquement sur un dossier local si `/data` n'est pas
  accessible (le site marche quand même), mais **monte un Volume sur /data**
  pour ne pas perdre les comptes à chaque déploiement.

## Conversations multiples
- Chaque compte peut avoir plusieurs conversations (barre de gauche).
- Bouton "＋ Nouvelle conversation", clic sur une conversation pour l'ouvrir,
  icône 🗑 pour la supprimer. Chaque conversation garde son propre historique.

## Trouver l'espace admin
- L'espace admin (/admin) apparaît dans la barre de gauche UNIQUEMENT si tu es
  connecté avec le compte dont l'e-mail == la variable `ADMIN_EMAIL`.
- Donc : mets `ADMIN_EMAIL` = l'e-mail EXACT de ton compte, crée/connecte ce
  compte, et le lien "🛠️ Espace admin" s'affiche (en bas de la barre de gauche).

## PowerPoint & fichiers générés
- Bouton 📊 dans la barre de saisie : l'IA rédige les slides et le serveur
  fabrique un vrai fichier .pptx téléchargeable (librairie pptxgenjs, installée
  automatiquement par `npm install`).
- Les fichiers générés sont stockés dans DATA_DIR/generated (garde un Volume /data).
- Générer une présentation compte comme 1 message dans le quota.
- Bouton "⬇️ Exporter la conversation" : télécharge la discussion en .md.
