# Veille appels d'offres — Made in AI

Outil de production qui, **chaque matin**, détecte les appels d'offres publics
pertinents pour Made in AI (formation / conseil / audit / développement IA,
automatisation), les **qualifie** via l'API OpenAI, et pousse une liste
**priorisée** dans un canal **Slack**.

Sources : **BOAMP** (France) et **TED** (Union européenne).

```
BOAMP ─┐
       ├─▶ normalisation ─▶ dédup ─▶ filtre "déjà vus" ─▶ scoring OpenAI
TED  ──┘                                                      │
                                  score ≥ 50, tri (score puis AURA) ─▶ Slack
```

## Arborescence

| Fichier | Rôle |
|---|---|
| `main.py` | Orchestrateur + interface ligne de commande |
| `sources/boamp.py` | Client BOAMP (OpenDataSoft v2.1, ODSQL) |
| `sources/ted.py` | Client TED (API v3 `notices/search`, requête eForms) |
| `scoring.py` | Scoring OpenAI (`gpt-5.4-mini`) : score 0-100 + justification |
| `slack.py` | Construction Block Kit + envoi webhook + rendu console |
| `state.py` | `seen_ids.json` (idempotence) |
| `dashboard_log.py` | Journalisation optionnelle vers le dashboard Supabase |
| `models.py` | Schéma commun `Avis`, normalisation, dédup, priorité géo |
| `config.py` | **CPV, mots-clés, priorités, seuils — à ajuster ici** |
| `http_util.py` | Session HTTP (timeout + retry/backoff) |
| `requirements.txt`, `.env.example`, `crontab.example` | Dépendances / config / cron |

Le workflow GitHub Actions est à la racine du dépôt : `.github/workflows/veille.yml`.

## Installation

```bash
cd veille-appels-offres
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env      # puis renseigner les clés
```

## Configuration (`.env`)

| Variable | Obligatoire | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | oui | Webhook entrant du canal Slack de destination |
| `OPENAI_API_KEY` | oui | Clé API OpenAI (scoring) |
| `SUPABASE_URL` | non | Active la remontée des exécutions dans le dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | non | idem |

> Aucune valeur sensible n'est codée en dur : tout passe par l'environnement.

## Lancement manuel

```bash
.venv/bin/python main.py --dry-fetch        # récupère seulement (counts + échantillon), sans scoring ni Slack
.venv/bin/python main.py --test             # scoring réel mais AUCUN envoi Slack : affiche le message en console
.venv/bin/python main.py                     # exécution réelle (envoi Slack)
.venv/bin/python main.py --window 48         # élargir la fenêtre à 48 h
.venv/bin/python main.py --no-state          # ignorer seen_ids.json (rejouer un test)
```

## Planification

### Option A — cron (serveur)

Voir `crontab.example` (exécution à 7h30). En résumé :

```cron
30 7 * * * cd /chemin/veille-appels-offres && .venv/bin/python main.py >> veille.log 2>&1
```

### Option B — GitHub Actions

`.github/workflows/veille.yml` exécute la veille tous les jours (~07:30 Paris) et
peut être lancé à la main (onglet **Actions → Run workflow**).

Définir les **secrets** du dépôt (Settings → Secrets and variables → Actions) :
`SLACK_WEBHOOK_URL`, `OPENAI_API_KEY`, et éventuellement `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`.

Le fichier `seen_ids.json` est **commité automatiquement** après chaque run pour
garantir l'idempotence entre exécutions.

## Ajuster la veille

Tout est dans **`config.py`** :

- `CPV_CODES` : préfixes CPV ciblés.
- `KEYWORDS` : mots-clés (titre/objet).
- `AURA_DEPARTEMENTS` / `AURA_TERMES` : périmètre Auvergne-Rhône-Alpes (priorité 1).
- `SCORE_MIN` (défaut 50), `SLACK_TOP_N` (10), `WINDOW_HOURS` (24), `MAX_TO_SCORE` (80).
- `TED_COUNTRIES` : `["FRA"]` par défaut. **Étendre à l'UE** : ajouter des codes
  ISO alpha-3 (ex. `["FRA", "DEU", "BEL"]`) ou vider la contrainte pays dans
  `sources/ted.py` (`_build_query`).

## Hypothèses et points validés (à connaître / arbitrer)

Conformément au brief, voici les points où l'API imposait un choix :

1. **BOAMP — filtrage CPV.** Le CPV n'est pas un champ plat : il est enfoui dans
   `donnees` (ex. `codeCPV/objetPrincipal/classPrincipale`). On ne peut donc pas
   filtrer dessus via un champ dédié. **Validé par test** : le moteur ODSQL fait une
   recherche plein-texte qui **indexe `donnees`** → on filtre via une requête
   `where=("80500000" OR … OR "intelligence artificielle" OR …)`. Les codes CPV sont
   ensuite **extraits** de `donnees` (tous les nombres à 8 chiffres sous une clé CPV).
2. **Filet large volontaire.** Des mots-clés génériques (« data », « agent », « IA »)
   ramènent des avis non pertinents. C'est assumé : le **scoring OpenAI (≥ 50)**
   est le vrai filtre de pertinence.
3. **BOAMP — fenêtre temporelle** sur `dateparution` (date de publication). Pas de
   champ « dernière modification » fiable ; un rectificatif peut republier un avis.
4. **BOAMP — montant** : aucun champ normalisé → extraction best-effort (première
   valeur non nulle sous une clé VALEUR/MONTANT/ESTIMATION). Peut manquer.
5. **TED — endpoint** `POST https://api.ted.europa.eu/v3/notices/search`, **sans clé**
   (confirmé par la doc et testé). Requête « expert » validée :
   `classification-cpv IN (…) AND organisation-country-buyer IN (FRA) AND publication-date>=YYYYMMDD`.
   Noms de champs confirmés via la liste des valeurs supportées renvoyée par l'API.
6. **TED — priorité AURA** : TED ne fournit pas de département. La priorité
   Auvergne-Rhône-Alpes est déduite par **heuristique textuelle** (Lyon, Grenoble,
   « auvergne »…) — moins fiable que les codes département de BOAMP.
7. **TED — multilingue** : titre/acheteur pris en FR, sinon EN, sinon 1re langue.
   URL canonique : `https://ted.europa.eu/fr/notice/{publication-number}`.
8. **Idempotence** : tous les avis **scorés** sont marqués « vus » (pas seulement
   ceux envoyés), pour éviter de les re-scorer ET de les renvoyer. Conséquence : un
   avis mis à jour ne sera pas renvoyé.
9. **Scoring** : un appel OpenAI **par avis** (séquentiel), plafonné à
   `MAX_TO_SCORE` par exécution (garde-fou coût) ; au-delà, les avis excédentaires
   sont ignorés et un avertissement est journalisé.
10. **Date limite** : souvent absente côté TED (`deadline-receipt-tender-date-lot`)
    → affichée « — » le cas échéant.
