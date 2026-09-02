# Post-call Monego

Suivi des appels du **callbot investisseurs** (ElevenLabs) : chaque appel terminé
arrive par webhook, est stocké, puis se traite depuis Claude Code via un **serveur MCP**
(consulter l'appel, préparer un brouillon, envoyer un mail, clôturer).

```
ElevenLabs (fin d'appel)
      │  POST /api/elevenlabs-webhook   (signature HMAC vérifiée)
      ▼
Supabase  automatisation.postcall_conversations   (statut = nouveau)
      ▲
      │  MCP HTTP  /api/mcp   (Bearer MCP_TOKEN)
      ▼
Claude Code : lister → lire → creer_brouillon / envoyer_email → terminer
```

## Les 6 outils MCP

| Outil | Rôle |
|---|---|
| `lister_conversations` | Appels à traiter (`statut` : nouveau / traite / tous) |
| `lire_conversation` | Transcript complet, synthèse, données collectées, critères |
| `lister_boites` | Boîtes Gmail connectées + boîte d'envoi + domaines autorisés |
| `creer_brouillon` | Brouillon dans une boîte Monego (**non envoyé**), pièces jointes possibles |
| `envoyer_email` | **Envoie** depuis `contact@monego.fr` (irréversible), pièces jointes possibles |
| `terminer_conversation` | Marque l'appel traité → il sort de la liste (c'est la « purge » logique) |

### Pièces jointes
Deux modes, au choix, dans `attachments` :
- `{"filename": "plaquette.pdf", "content_base64": "..."}` — pour les petits fichiers ;
- `{"filename": "plaquette.pdf", "url": "https://..."}` — **à préférer** : le serveur
  télécharge le fichier lui-même, rien ne transite par le contexte du modèle.

Limite : 8 Mo par pièce jointe.

### Garde-fou destinataires
Tout destinataire (To et Cc) doit appartenir aux domaines de `POSTCALL_ALLOWED_DOMAINS`
(défaut : `monego.fr`). Pour autoriser un jour les appelants externes, ajouter leur
domaine à cette variable — ou la passer à une liste plus large.

## Deux voies d'accès au MCP

Une seule fonction serveur, deux façons de s'authentifier :

| Client | URL | Auth |
|---|---|---|
| **Claude Code** | `https://automatisation-six.vercel.app/api/mcp` | header `Authorization: Bearer <MCP_TOKEN>` |
| **Claude web / Cowork** | `https://automatisation-six.vercel.app/mcp/<MCP_URL_TOKEN>` | le token est **dans l'URL** |

Le connecteur personnalisé de Claude web/Cowork n'accepte qu'une URL (pas de header
personnalisé) : d'où la seconde voie. Les deux tokens sont **distincts**, donc
révocables séparément (changer la variable dans Vercel puis redéployer).

> ⚠️ Sur la voie « URL », le token EST l'authentification : quiconque obtient cette
> URL peut lire les transcripts, créer des brouillons **et envoyer des mails** depuis
> `contact@monego.fr`. À traiter comme un mot de passe (pas de partage, pas de capture
> d'écran). En cas de doute : régénérer `MCP_URL_TOKEN` et redéployer.

## Brancher Claude web / Claude Cowork

Réglages → **Connecteurs** → *Ajouter un connecteur personnalisé* :
- Nom : `Post-call Monego`
- URL : `https://automatisation-six.vercel.app/mcp/<MCP_URL_TOKEN>`
- Laisser les paramètres avancés (OAuth) vides.

## Brancher Claude Code

Le dépôt contient un `.mcp.json` : il suffit d'exposer le token une fois, puis
d'ouvrir le projet avec Claude Code.

```bash
export POSTCALL_MCP_TOKEN="<valeur de MCP_TOKEN dans Vercel>"
```

Alternative sans variable d'environnement (le token est stocké dans la config
utilisateur de Claude Code, pas dans le dépôt) :

```bash
claude mcp add --transport http postcall-monego https://automatisation-six.vercel.app/api/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

## Brancher ElevenLabs

Dans l'agent ElevenLabs → **Webhooks → Post-call webhook** :
- URL : `https://automatisation-six.vercel.app/api/elevenlabs-webhook`
- Type : `post_call_transcription`
- Copier le **secret** fourni par ElevenLabs dans la variable Vercel
  `ELEVENLABS_WEBHOOK_SECRET` (elle contient pour l'instant un secret de test).

La signature est vérifiée (`ElevenLabs-Signature: t=…,v0=…`, HMAC-SHA256 sur
`{timestamp}.{corps brut}`, tolérance 30 min) : une requête non signée est rejetée en 401.

Les webhooks `post_call_audio` et `call_initiation_failure` sont acceptés puis ignorés.

## Variables d'environnement (Vercel)

| Variable | Rôle |
|---|---|
| `ELEVENLABS_WEBHOOK_SECRET` | Secret de signature du webhook ElevenLabs |
| `MCP_TOKEN` | Jeton d'accès MCP par header (Claude Code) |
| `MCP_URL_TOKEN` | Jeton d'accès MCP par URL (Claude web / Cowork) |
| `POSTCALL_SEND_FROM` | Boîte d'envoi (défaut `contact@monego.fr`) |
| `POSTCALL_ALLOWED_DOMAINS` | Domaines destinataires autorisés (défaut `monego.fr`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Base |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | OAuth des boîtes Monego (partagé avec l'automatisation « Réponses email ») |

## Tables Supabase (schéma `automatisation`)

- `postcall_conversations` — une ligne par appel : `statut` (`nouveau` / `traite`),
  appelant, durée, `summary`, `transcript` (jsonb), `analysis`, `dynamic_variables`,
  `note`, `traite_at`.
- `postcall_actions` — audit : brouillon créé / mail envoyé, destinataires, objet.

## Fichiers

| Fichier | Rôle |
|---|---|
| `api/elevenlabs-webhook.js` | Réception + vérification HMAC + stockage |
| `api/mcp.js` | Point d'entrée MCP : authentifie (header **ou** token d'URL) |
| `lib/mcpServer.js` | Cœur JSON-RPC 2.0 partagé par les deux voies |
| `lib/mcpTools.js` | Définition et exécution des 6 outils |
| `lib/postcall.js` | Accès Supabase aux conversations + journal d'actions |
| `lib/gmailApi.js` | MIME multipart (pièces jointes), `createDraftMessage`, `sendMessage` |
| `lib/emailStore.js` | Boîtes Gmail connectées (partagé) |
