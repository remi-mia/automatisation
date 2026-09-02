# Factures Notion → Sinao

Depuis Notion, un **bouton** déclenche instantanément un webhook qui :
1. génère l'**échéancier de facturation** d'un contrat (base « Factures ») ;
2. pousse chaque échéance en **brouillon de facture** dans Sinao.

Rien n'est jamais finalisé : Sinao reçoit toujours un `status: draft`.

```
Notion — base Contrat            Notion — base Factures
  [Préparer la facturation] ─┐     [Envoyer vers Sinao] ─┐
                             ▼                            ▼
        POST /api/notion-facturation?action=preparer   ...?action=envoyer
                             │                            │
                    crée les échéances            crée le BROUILLON Sinao
                    (60/40, 50/40/10…)            + réécrit statut/n°/lien
```

## Structure Notion

**Base « Factures »** (`NOTION_DB_FACTURES`) — 1 ligne = 1 facture à émettre :
`Référence` (titre) · `Contrat` (relation) · `Type` (Acompte / Échéance intermédiaire /
Solde / Facture unique) · `Pourcentage (%)` · `Montant HT` · `Date prévue` ·
**`Envoyer vers Sinao`** (case = déclencheur) · `Statut` · `N° facture Sinao` ·
`Lien Sinao` · `Message`.

**Base « Contrat »** — propriétés ajoutées :
**`Préparer la facturation`** (case = déclencheur) · `Cas de facturation` (select) ·
`Sans acompte` (case) · `Factures` (relation inverse).

## Règles d'échéancier

| Cas de facturation | Échéances générées |
|---|---|
| Société / Direct (60-40) | Acompte 60 % à la signature + Solde 40 % à la prestation |
| Chambre d'hôtes (60-40) | idem, solde daté du 1er jour d'arrivée |
| Mariage (50-40-10) | 50 % signature · 40 % à J-90 · 10 % à J-21 |
| Booking.com (facture unique) | 100 % du **montant total** (la commission Booking est une charge à part) |
| Rétrocommission 10 % (facture unique) | 10 % du montant, sans acompte |
| Collectivité / OT (solde seul) | Solde 100 % après prestation |

**Détermination automatique** : `Sans acompte` coché → solde seul. Sinon le select
`Cas de facturation` s'il est renseigné. Sinon déduit de `Client.Type de client`
(*Office de Tourisme, Communauté de communes, Mairie* → solde seul ; les autres → 60/40).
Le cas retenu est réécrit dans le select pour rester lisible.

**Montants** : `Contrat.Montant vente HT` × pourcentage.
**Lignes Sinao** : une facture à 100 % détaille les `Prestations` du contrat ; une
échéance partielle produit une ligne unique « Acompte 60 % — {description} ».

## Configuration des boutons Notion

Sur chaque base, créer un **bouton de base de données** avec l'action **« Envoyer un webhook »** :

| Bouton | Base | URL | Header |
|---|---|---|---|
| Préparer la facturation | Contrat | `https://automatisation-six.vercel.app/api/notion-facturation?action=preparer` | `x-webhook-secret: <NOTION_WEBHOOK_SECRET>` |
| Envoyer vers Sinao | Factures | `https://automatisation-six.vercel.app/api/notion-facturation?action=envoyer` | `x-webhook-secret: <NOTION_WEBHOOK_SECRET>` |

Le webhook n'a besoin que de l'**ID de la page** : il relit ensuite toutes les données
via l'API Notion. Le format précis du payload des automatisations Notion n'étant pas
documenté, l'extraction de l'ID est volontairement tolérante.

**Diagnostic** : ajouter `&debug=1` à l'URL renvoie le payload reçu sans rien exécuter.

## Entités et applications Sinao

Une clé API Sinao n'ouvre **qu'une seule application**. Le routage se fait sur
`Projets.Entité` :

| Entité | Variables | État |
|---|---|---|
| Moneverest | `SINAO_APP_MONEVEREST`, `SINAO_KEY_MONEVEREST` | ✅ configuré (app 52607) |
| Prestalp | `SINAO_APP_PRESTALP`, `SINAO_KEY_PRESTALP` | ⏳ à fournir |

Un contrat Prestalp échoue avec un message explicite tant que la clé n'est pas posée.

## Détails API Sinao (validés en réel)

- Authentification : header **`Api-Key`** (et non `Authorization: Bearer`).
- Création : `POST /v1/apps/{appId}/invoices?expand[]=content`, `status: "draft"`.
- Montants : `amount_accurately` = **euros × 100 × 1000** (1 000 € → 100 000 000).
- TVA : `vat_percent` = **pourcentage × 100** (20 % → 2000).
- Type de ligne : `product` (l'énumération est `section | description | product`).
- Client : `contact_infos: {id}` si trouvé dans `/organizations`, sinon `{new: true, …}`.
- Compte comptable : `SINAO_SALES_ACCOUNT_ID` (défaut **55** = 706 Prestations de services).

## Variables d'environnement

`NOTION_TOKEN` · `NOTION_WEBHOOK_SECRET` · `NOTION_DB_FACTURES` ·
`SINAO_APP_MONEVEREST` · `SINAO_KEY_MONEVEREST` · `SINAO_SALES_ACCOUNT_ID` ·
(à venir) `SINAO_APP_PRESTALP` · `SINAO_KEY_PRESTALP`

## Fichiers

| Fichier | Rôle |
|---|---|
| `api/notion-facturation.js` | Webhook (`?action=preparer` / `?action=envoyer`, `&debug=1`) |
| `lib/facturation.js` | Règles d'échéancier + orchestration Notion↔Sinao |
| `lib/notion.js` | Client API Notion, lecture typée, extraction de l'ID de page |
| `lib/sinao.js` | Client Sinao, conversions d'unités, recherche client |
