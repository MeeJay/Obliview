# Documentation Obliview pour BookStack

Ce dossier contient la documentation complète du projet **Obliview**, prête à être
publiée dans **BookStack**, dans l'étagère **ObliTools**.

La documentation est structurée exactement selon la hiérarchie BookStack :

```
Étagère : ObliTools
└── Livre : Obliview
    ├── Chapitre  → Page(s) Markdown
    └── …
```

## Contenu du dossier

| Fichier / dossier          | Rôle                                                                 |
|----------------------------|------------------------------------------------------------------------|
| `Obliview/`                 | Les pages Markdown, un sous-dossier par chapitre, un fichier par page |
| `manifest.json`             | Arborescence étagère → livre → chapitres → pages (ordre + titres)     |
| `push-to-bookstack.mjs`     | Script de publication **idempotent** via l'API BookStack             |
| `README.md`                 | Ce fichier                                                            |

> Les fichiers `.md` ne contiennent volontairement **pas** de titre de niveau 1 :
> le nom de la page dans BookStack (défini dans `manifest.json`) fait office de titre.

## Plan de la documentation

Le livre **Obliview** est organisé en 14 chapitres :

1. **Présentation** — vue d'ensemble, concepts clés, rôles, panorama fonctionnel
2. **Architecture technique** — stack, monorepo, serveur, client, temps réel (Socket.io & WS agent)
3. **Installation & configuration** — dev local Windows, variables d'environnement, build & packaging
4. **Authentification & SSO** — auth locale & 2FA, SSO Obligate, multi-tenance
5. **Groupes & héritage des réglages** — closure table, héritage des paramètres et des notifications
6. **Modèle de données** — schéma PostgreSQL (migrations Knex), par domaine
7. **Référence API REST** — endpoints exhaustifs par domaine
8. **Monitoring** — BaseMonitorWorker, les 13 types de moniteurs, push monitors
9. **Notifications** — les 10 plugins, canaux/bindings, debounce & cooldown
10. **Système d'agent** — agent Go, canal WebSocket, capteurs matériels, seuils, cycle de vie
11. **ObliTools (launcher desktop)** — multi-fenêtres, barre d'onglets, intégrations cross-app
12. **Administration** — utilisateurs, RBAC, fenêtres de maintenance, remédiation
13. **Exploitation & sécurité** — headers de sécurité, alertes live, rétention, i18n
14. **Release & déploiement** — signature de code, packaging Windows, build multi-plateforme

Le détail exact (titres et ordre des pages) fait foi dans `manifest.json`.

## Publier dans BookStack (recommandé — via l'API)

1. Dans BookStack, crée un **jeton d'API** : *Profil utilisateur → Jetons d'API →
   Créer un jeton*. Note l'**identifiant** et le **secret**. Le compte doit avoir le
   droit de créer étagères / livres / chapitres / pages.
2. Renseigne les variables d'environnement et lance le script (Node 18+) :

   **PowerShell**
   ```powershell
   $env:BOOKSTACK_URL      = 'https://wiki.mondomaine.fr'
   $env:BOOKSTACK_TOKEN_ID = 'votre_token_id'
   $env:BOOKSTACK_TOKEN_SECRET = 'votre_token_secret'
   node .\push-to-bookstack.mjs --dry-run   # simulation d'abord
   node .\push-to-bookstack.mjs             # publication réelle
   ```

   **bash**
   ```bash
   BOOKSTACK_URL=https://wiki.mondomaine.fr \
   BOOKSTACK_TOKEN_ID=votre_token_id \
   BOOKSTACK_TOKEN_SECRET=votre_token_secret \
   node push-to-bookstack.mjs
   ```

Le script est **idempotent** : il crée l'étagère, le livre, les chapitres et les
pages s'ils n'existent pas, et met à jour titres/contenus/ordre à chaque exécution
(correspondance **par nom**). Aucun doublon n'est créé si on le relance.

## Publier manuellement (sans API)

Dans BookStack : crée l'étagère **ObliTools** (ou réutilise-la si elle existe déjà,
par exemple partagée avec Obliplan/Obligate), puis un livre **Obliview**, puis un
chapitre par entrée du plan ci-dessus, et pour chaque page utilise l'éditeur en mode
**Markdown** en collant le contenu du fichier `.md` correspondant (le nom de la page
est donné par `manifest.json`).

---

*Documentation générée à partir du code source (`D:\Obliview`). Pour la régénérer
après une évolution du code, relancer la génération puis republier avec le script.*
