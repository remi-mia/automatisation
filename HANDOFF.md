# HANDOFF — Projet AUTOMATISATION (Made in AI)

> Point de reprise pour continuer dans une autre conversation.
> Dernière mise à jour : session du 2026-07-17.
> ⚠️ Aucun secret dans ce fichier : les clés/tokens sont dans **Vercel → Env Variables** et dans `veille-appels-offres/.env` (local, gitignoré).

## But du projet
App qui héberge plusieurs **automatisations** (webhooks + endpoints), sans front dédié sauf un **dashboard de suivi**. Déployée sur Vercel, données sur Supabase.

## Infra commune
| Élément | Valeur |
|---|---|
| Repo GitHub | `github.com/remi-mia/automatisation` (branche `main`) |
| Vercel | projet `automatisation`, compte `remi-4993`, prod : `https://automatisation-six.vercel.app` |
| Plan Vercel | **Hobby** → cron limité à 1×/jour (⇒ déclenchements fréquents faits par **Make**) |
| Déploiement | `npx vercel@latest --prod --yes` (le CLI local est trop vieux, toujours préfixer `@latest`) |
| Supabase | compte `maximilien@made-in-ai.fr`, org « Personel » (free, **2 projets max**). Projet **MIA-Whisper-Clipper** = `fbywkloqrxcdxrqbahxr` |
| Schéma Supabase | `automatisation` (exposé à PostgREST). Accès serveur via clé `service_role` |
| Tables | `automations`, `executions`, vue `automation_stats`, `veille_seen`, `gmail_accounts`, `email_processed` |

### Dashboard
- `/` = `index.html` (dark, KPIs + cartes par automatisation + exécutions récentes).
- Auth **Google restreinte @made-in-ai.fr** ; endpoints `/api/me`, `/api/stats`, `/api/auth/{login,callback,logout}` (`lib/auth.js`).
- Chaque automatisation logge ses exécutions via `lib/db.js` → table `executions`.

### Variables d'env (toutes sur Vercel prod ; valeurs NON reproduites ici)
`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `MAIL_TO`, `TALLY_SIGNING_SECRET` (optionnel),
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_DOMAIN`, `AUTH_BASE_URL`,
`OPENAI_API_KEY`, `SLACK_WEBHOOK_URL`, `VEILLE_TOKEN`,
`CORTEX_URL`, `CORTEX_TOKEN`, `CRON_SECRET`,
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
(optionnel) `INTERNAL_DOMAINS`.

---

## Automatisation 1 — Brief Charles Paris (`tally-brief`) — ✅ EN PROD
Formulaire **Tally** → webhook → génère un `.docx` → l'envoie par email.
- Fichiers : `api/tally-webhook.js`, `lib/tally.js` (mapping), `lib/docx.js` (Docxtemplater, balises `{{}}`), `lib/mailer.js` (SMTP Gmail), `templates/BRIEF_Charles_Paris_template.docx`.
- Webhook Tally : `https://automatisation-six.vercel.app/api/tally-webhook`.
- Expéditeur `remi@made-in-ai.fr` ; destinataires : `remi@made-in-ai.fr`, `carolina@charles-paris.com`, `nathalie@charles-paris.com`.
- **À faire / à valider** : tester avec un **vrai payload Tally** (le mapping se fait par libellé de question dans `lib/tally.js` — ajuster les `pick(...)` si des champs sortent vides). Les champs **Lampadaire** (voltage, driver, J-BOX…) ne sont pas mappés (pas de case dans la fiche). Signature Tally (`TALLY_SIGNING_SECRET`) non activée.

---

## Automatisation 2 — Veille appels d'offres (`veille-ao`) — ✅ EN PROD, 1 point ouvert
Chaque jour : **BOAMP + TED** → scoring **OpenAI gpt-5.4-mini** (strict IA) → **Slack** (via webhook Make).
- Code : dossier `veille-appels-offres/` (Python 3.11+). Exposé en endpoint **`api/veille.py`** (runtime Python Vercel ; `requirements.txt` racine ; `vercel.json` `includeFiles: veille-appels-offres/**`).
- Modules : `main.py` (`run()` + CLI), `sources/boamp.py`, `sources/ted.py`, `scoring.py`, `slack.py`, `state.py` (état Supabase `veille_seen`), `dashboard_log.py`, `config.py`, `models.py`, `http_util.py`.
- **Déclenchement** : Make (GET `https://automatisation-six.vercel.app/api/veille`, header `x-veille-token: <VEILLE_TOKEN>`). Params : `?window=H` (défaut 24), `?nostate=1` (rejoue sans marquer, pour tests).
- **GitHub Actions cron = DÉSACTIVÉ** (`.github/workflows/veille.yml`, bloc `schedule` commenté ; `workflow_dispatch` manuel conservé).
- Filtrage : mots-clés **strictement IA** (config.py `KEYWORDS`, PAS les CPV génériques ; « agentique » exclu = bruit de stemming BOAMP). Scoring **strict** (`config.SCORE_MIN = 65`). Scoring parallélisé (`SCORING_CONCURRENCY = 8`), `MAX_TO_SCORE = 150`.
- Détails API validés :
  - BOAMP : OpenDataSoft v2.1, `where` ODSQL plein-texte (indexe le champ `donnees`), tri `dateparution desc`, filtre `dateparution >= date'…'` (= date de **publication**). CPV extrait de `donnees` (chemins variables type `codeCPV/objetPrincipal/classPrincipale`).
  - TED : `POST api.ted.europa.eu/v3/notices/search`, sans clé. Plein-texte = **clauses `FT ~ "terme"` combinées par OR** (⚠️ `FT ~ (a OR b)` NE marche PAS). Filtre `organisation-country-buyer IN (FRA)` + `publication-date>=YYYYMMDD`.
- Sortie Slack : payload au webhook Make avec `type:"veille"` + champ **`message`** (mrkdwn complet, mappé sur `{{1.message}}` dans le module Slack, canal `C0B6V2G65QC`). Affiche « Publié le : … · Date limite : … ».
- **🔧 POINT OUVERT (à finir) — les AO retournés sont parfois DÉJÀ FERMÉS.** Travail commencé, NON terminé :
  - Cause : BOAMP/TED publient aussi des **avis d'attribution** (marché déjà attribué) et **rectificatifs**, en plus des vrais appels d'offres.
  - À implémenter :
    1. **BOAMP** : ne garder que `nature = 'APPEL_OFFRE'` (exclure `ATTRIBUTION`, `RECTIFICATIF`, etc.). Champ `nature` disponible dans chaque record. (Vérifier les valeurs exactes via `group_by=nature`.)
    2. **TED** : filtrer `notice-type` sur les avis de mise en concurrence (ex. `cn-*` / contract notice) et exclure les avis d'attribution (`can-*`).
    3. **Les deux** : **exclure les AO dont la date limite (`date_limite`) est déjà passée** (`< aujourd'hui`), quand elle est connue.
  - Fichiers à modifier : `sources/boamp.py` (`_build_where` / `_to_avis`), `sources/ted.py` (`_build_query` / champs demandés + `_to_avis`), et le filtre final dans `main.py` (`run()`).
- Idée optionnelle proposée, non faite : n'envoyer un message Slack QUE s'il y a ≥ 1 AO (silencieux les jours vides).

---

## Automatisation 3 — Réponses email (`reponses-email`) — ⚙️ CODÉ, DÉPLOYÉ & OAUTH MONEGO CONFIGURÉ
Mails non lus des boîtes connectées → **API Cortex** (génère la réponse) → **brouillon Gmail** dans le thread.
- Lien de connexion partageable : **`https://automatisation-six.vercel.app/connexion-gmail`** (`connexion-gmail.html`).
- OAuth Gmail offline : `api/gmail/connect.js` + `api/gmail/callback.js` (`lib/gmailAuth.js`, scope `gmail.modify`, refresh_token → table `gmail_accounts`).
- Poller : `api/releve-mails.js` (protégé par `CRON_SECRET` en `Authorization: Bearer` OU `VEILLE_TOKEN` via `?token=`). Modules `lib/gmailApi.js`, `lib/emailStore.js`, `lib/cortex.js`.
- Idempotence : table `email_processed` (claim-first). **Ignore les mails internes** : `estInterne()` (env `INTERNAL_DOMAINS`, défaut `monego`, + la boîte elle-même).
- **Brouillon uniquement** (jamais d'envoi auto). Cortex : `{from, subject, body}` → `{hasAiResponse, draft}` ; brouillon créé si `hasAiResponse !== false`.
- **Déclenchement prévu** : Make (GET `/api/releve-mails` toutes les 15 min, header `Authorization: Bearer <CRON_SECRET>`).
- **OAuth Monego configuré le 2026-07-17 :** `GMAIL_CLIENT_ID` et `GMAIL_CLIENT_SECRET` sont posés comme variables sensibles dans Vercel Production. Redéploiement effectué et contrôlé : `/api/gmail/connect` utilise bien le client dédié, le callback public et le scope `gmail.modify` (aucune valeur secrète stockée dans le dépôt).
- **🔴 RESTE À FAIRE côté Google / exploitation :**
  1. **Google Cloud Console** : confirmer sur ce client OAuth que le redirect URI `https://automatisation-six.vercel.app/api/gmail/callback` est autorisé, que le scope `.../auth/gmail.modify` est configuré et que les comptes concernés ont accès à l'application.
  2. **Connecter les 3 boîtes** via le lien `/connexion-gmail` et vérifier la page de confirmation pour chacune.
  3. **Créer le scénario Make** (planning 15 min) qui ping `/api/releve-mails`.
- Non testé de bout en bout (aucune boîte connectée pour l'instant ; endpoints vérifiés : page 200, `/api/gmail/connect` 302 vers Google, poller 401 sans auth / 200 avec `CRON_SECRET`).

---

## Automatisation 4 — Post-call Monego (`postcall-monego`) — ✅ CODÉ, DÉPLOYÉ & TESTÉ
Appels du **callbot investisseurs ElevenLabs** → webhook → base → traitement depuis Claude Code via **serveur MCP**.
- Doc dédiée : **`POSTCALL-MONEGO.md`** (à lire en premier).
- Webhook : `api/elevenlabs-webhook.js` → `https://automatisation-six.vercel.app/api/elevenlabs-webhook`.
  Signature `ElevenLabs-Signature: t=…,v0=…` = HMAC-SHA256 sur `{t}.{corps brut}`, tolérance 30 min (`ELEVENLABS_WEBHOOK_SECRET`). ✅ vérifié en prod : le corps brut EST lisible sur Vercel (mauvaise signature → 401, bonne → 200).
- MCP HTTP : `api/mcp.js` (auth) + `lib/mcpServer.js` (cœur JSON-RPC). **Deux voies d'accès, une seule fonction** (limite Hobby = 12 fonctions serverless, on y est pile) :
  - Claude Code → `POST /api/mcp` + header `Authorization: Bearer MCP_TOKEN` ; déclaré dans `.mcp.json` du dépôt via `${POSTCALL_MCP_TOKEN}`.
  - Claude web / Cowork → `POST /mcp/<MCP_URL_TOKEN>` (réécriture vercel.json vers `/api/mcp?token=:token`) car le connecteur custom n'accepte **qu'une URL**, pas de header. Token distinct, révocable séparément. ⚠️ token dans l'URL = accès complet (envoi de mails inclus) : choix assumé par l'utilisateur après signalement du risque.
- 6 outils (`lib/mcpTools.js`) : `lister_conversations`, `lire_conversation`, `lister_boites`, `creer_brouillon`, `envoyer_email`, `terminer_conversation`.
- **Rétention** : pas de purge par date — une conversation reste `nouveau` jusqu'à l'appel de `terminer_conversation` (→ `traite`).
- **Pièces jointes** : `content_base64` OU `url` (le serveur télécharge — à préférer, évite le contexte). Max 8 Mo.
- **Garde-fou** : tout destinataire doit être dans `POSTCALL_ALLOWED_DOMAINS` (défaut `monego.fr`). Envoi depuis `POSTCALL_SEND_FROM` = `contact@monego.fr`. Pour ouvrir aux appelants externes plus tard → élargir cette variable.
- Tables : `postcall_conversations`, `postcall_actions` (audit).
- Testé en prod : webhook signé, les 6 outils, brouillon **avec pièce jointe** créé dans `contact@monego.fr`, clôture. Données de test purgées.
- **⚠️ NON testé** : `envoyer_email` (envoi réel volontairement pas déclenché).
- **🔴 RESTE À FAIRE** :
  1. ✅ FAIT (2026-09-02) : le **vrai secret ElevenLabs** est posé dans `ELEVENLABS_WEBHOOK_SECRET` (Vercel prod) et vérifié en production (signature valide → 200, ancien secret → 401). Reste à coller l'URL `https://automatisation-six.vercel.app/api/elevenlabs-webhook` dans l'agent ElevenLabs (post-call webhook, type `post_call_transcription`).
  2. `export POSTCALL_MCP_TOKEN=<MCP_TOKEN>` (ou `claude mcp add …`) pour utiliser le MCP depuis Claude Code.
  3. Supprimer le brouillon de test dans `contact@monego.fr` (objet « … (TEST) »).

---


## Questions ouvertes / prochaines étapes prioritaires
1. **Veille** : finir le filtrage « AO ouverts uniquement » (type d'avis + date limite non passée) — cf. section Automatisation 2.
2. **Réponses email** : confirmer la configuration du client dans Google Cloud → connecter les 3 boîtes → brancher Make.
3. **Tally** : valider le mapping avec un vrai payload.

## Commandes utiles
```bash
# Déployer
npx vercel@latest --prod --yes

# Tester la veille (sans marquer l'état) — remplacer <VEILLE_TOKEN>
curl -H "x-veille-token: <VEILLE_TOKEN>" "https://automatisation-six.vercel.app/api/veille?window=240&nostate=1"

# Tester le poller email — remplacer <CRON_SECRET>
curl -H "Authorization: Bearer <CRON_SECRET>" "https://automatisation-six.vercel.app/api/releve-mails"

# Veille en local (dossier veille-appels-offres, .env requis)
.venv/bin/python main.py --test --no-state --window 72   # scoring réel, sans Slack
.venv/bin/python main.py --dry-fetch --window 72          # récup seule, sans scoring
```

## Mémoire persistante
Un résumé infra est aussi dans la mémoire Claude : `memory/automatisation-app-infra.md` (index `memory/MEMORY.md`).
