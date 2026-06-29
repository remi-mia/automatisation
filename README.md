# Automatisations

Serveur d'automatisations (webhooks uniquement, pas de front).
Hébergé sur Vercel, déclenché par des webhooks.

## Automatisation 1 — Brief Charles Paris

Quelqu'un envoie le formulaire **Tally** → Tally appelle le webhook → l'app génère
un **brief `.docx`** à partir du template Word → l'envoie **par email** (SMTP) à une
adresse fixe.

```
Tally  ──POST──▶  /api/tally-webhook  ──▶  docx (Docxtemplater)  ──▶  email (nodemailer)
```

### Structure

| Fichier | Rôle |
|---|---|
| `api/tally-webhook.js` | Endpoint webhook (fonction serverless Vercel) |
| `lib/tally.js` | Parsing du payload Tally + mapping vers les variables du template |
| `lib/docx.js` | Génération du `.docx` (balises `{{variable}}`) |
| `lib/mailer.js` | Envoi SMTP |
| `templates/BRIEF_Charles_Paris_template.docx` | Le template Word |
| `docs_mapping.md` | Correspondance questions Tally ↔ variables docx |
| `scripts/test-local.js` | Test local de génération (sans email) |

## Test en local

```bash
npm install
node scripts/test-local.js          # génère scripts/out/Brief_*.docx
```

Pour tester avec tes propres données, copie un vrai payload Tally dans un fichier JSON
et lance `node scripts/test-local.js mon-payload.json`.

Pour tester l'endpoint complet en local (avec email), crée un `.env` à partir de
`.env.example` puis :

```bash
npm run dev                         # vercel dev, sert /api/tally-webhook
```

## Variables d'environnement

Voir `.env.example`. À définir aussi dans Vercel (Settings → Environment Variables).

| Variable | Description |
|---|---|
| `SMTP_HOST` | ex. `smtp.gmail.com` |
| `SMTP_PORT` | `465` (SSL) ou `587` (STARTTLS) |
| `SMTP_USER` | identifiant SMTP / adresse |
| `SMTP_PASS` | **mot de passe d'application** Gmail (pas le mot de passe du compte) |
| `MAIL_FROM` | expéditeur affiché (optionnel, défaut = `SMTP_USER`) |
| `MAIL_TO` | destinataire fixe du brief |
| `TALLY_SIGNING_SECRET` | (optionnel) secret de signature Tally pour sécuriser le webhook |

### Gmail : mot de passe d'application

1. Active la **validation en 2 étapes** sur le compte Google.
2. https://myaccount.google.com/apppasswords → crée un mot de passe d'application.
3. Utilise ce mot de passe (16 caractères) comme `SMTP_PASS`, avec
   `SMTP_HOST=smtp.gmail.com` et `SMTP_PORT=465`.

## Déploiement

### 1. Pousser sur GitHub

```bash
git init
git add .
git commit -m "Automatisation Tally -> brief docx -> email"
git branch -M main
gh repo create automatisations --private --source=. --push
# ou : créer le repo sur github.com puis git remote add origin ... && git push -u origin main
```

### 2. Déployer sur Vercel

- Vercel → **Add New → Project** → importe le repo GitHub.
- Framework preset : **Other** (aucun build, fonctions dans `/api`).
- Renseigne les variables d'environnement (section ci-dessus).
- Déploie. L'URL du webhook sera :
  `https://<ton-projet>.vercel.app/api/tally-webhook`

### 3. Brancher Tally

- Formulaire Tally → **Integrations → Webhooks** → **Add webhook**.
- URL : l'URL Vercel ci-dessus.
- (Optionnel) Active la signature et copie le **Signing secret** dans
  `TALLY_SIGNING_SECRET` côté Vercel.
- Envoie une réponse de test ; le brief doit arriver sur `MAIL_TO`.

## Ajouter une 2e automatisation

Créer un nouveau fichier dans `api/` (ex. `api/autre-webhook.js`) avec son propre
handler. Chaque fichier d'`api/` devient automatiquement un endpoint sur Vercel.

## Notes de mapping

- Le matching des questions Tally se fait **par libellé** (tolérant aux accents/casse).
  Si un libellé de ton formulaire diffère, ajuste les `pick(...)` dans `lib/tally.js`.
- `{{dimensions}}` / `{{dimensions_pouces}}` sont composées selon le type de produit
  (Lampe vs Lampadaire) à partir des cotes Longueur/Largeur/Diamètre/Hauteur.
- `{{adv}}` et `{{temperature}}` n'ont pas de source Tally → laissés **vides**.
- Voir `docs_mapping.md` pour le détail et les points de divergence à arbitrer.
```
