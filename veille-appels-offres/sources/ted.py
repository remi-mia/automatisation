"""Client TED (Tenders Electronic Daily, Union européenne).

API v3, gratuite et sans clé d'authentification (validé via la doc officielle
https://docs.ted.europa.eu/api/latest/index.html et par appels réels).

Endpoint validé : POST https://api.ted.europa.eu/v3/notices/search
Corps JSON : { query, fields, limit, page, scope }.

Syntaxe de requête « expert » validée par test réel :
  classification-cpv IN (72000000 80000000 …)
  AND organisation-country-buyer IN (FRA)
  AND publication-date>=YYYYMMDD

Champs (noms eForms exacts, confirmés via l'erreur de validation listant les
valeurs supportées) : publication-number, notice-title, publication-date,
buyer-name, classification-cpv, organisation-country-buyer,
deadline-receipt-tender-date-lot, estimated-value-lot, estimated-value-cur-lot.

Hypothèses signalées (README) :
- Les titres/acheteurs sont multilingues : on prend FR, sinon EN, sinon la 1re valeur.
- TED ne fournit pas de département : la priorité AURA est déduite par heuristique
  textuelle (nom acheteur + titre) via models.priorite_geographique.
- L'URL HTML canonique est https://ted.europa.eu/fr/notice/{publication-number}.
"""
from __future__ import annotations

import datetime as dt
import logging

import config
from http_util import make_session, post_json
from models import Avis, priorite_geographique

log = logging.getLogger("ted")

API_URL = "https://api.ted.europa.eu/v3/notices/search"
PAGE_SIZE = 100
MAX_RECORDS = 300

FIELDS = [
    "publication-number",
    "notice-title",
    "publication-date",
    "buyer-name",
    "classification-cpv",
    "organisation-country-buyer",
    "deadline-receipt-tender-date-lot",
    "estimated-value-lot",
    "estimated-value-cur-lot",
]


def _build_query(since_date: str) -> str:
    cpv = " ".join(config.CPV_CODES)
    pays = " ".join(config.TED_COUNTRIES)
    return (
        f"classification-cpv IN ({cpv}) "
        f"AND organisation-country-buyer IN ({pays}) "
        f"AND publication-date>={since_date}"
    )


def _pick_lang(value) -> str:
    """Extrait une chaîne d'un champ multilingue TED (dict langue->valeur)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [_pick_lang(v) for v in value if v]
        return ", ".join(dict.fromkeys(p for p in parts if p))  # dédoublonne en gardant l'ordre
    if isinstance(value, dict):
        for lang in ("fra", "eng"):
            if value.get(lang):
                return _pick_lang(value[lang])
        # sinon première valeur disponible
        for v in value.values():
            s = _pick_lang(v)
            if s:
                return s
    return str(value)


def _first(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _to_avis(rec: dict) -> Avis | None:
    pubnum = rec.get("publication-number")
    if not pubnum:
        return None
    titre = _pick_lang(rec.get("notice-title")).strip()
    acheteur = _pick_lang(rec.get("buyer-name")).strip()

    cpv = rec.get("classification-cpv") or []
    if isinstance(cpv, str):
        cpv = [cpv]
    cpv = list(dict.fromkeys(str(c) for c in cpv))  # dédoublonne, garde l'ordre

    pays = _pick_lang(rec.get("organisation-country-buyer")) or "FRA"
    lieu = "France" if pays == "FRA" else pays

    pubdate = (rec.get("publication-date") or "")[:10]
    deadline = _first(rec.get("deadline-receipt-tender-date-lot"))
    if isinstance(deadline, str):
        deadline = deadline[:10]

    montant = _first(rec.get("estimated-value-lot"))
    devise = _first(rec.get("estimated-value-cur-lot")) or ""
    try:
        montant_nul = montant is None or float(str(montant)) == 0.0
    except (TypeError, ValueError):
        montant_nul = montant is None
    montant_str = None if montant_nul else f"{montant} {devise}".strip()

    avis = Avis(
        id=str(pubnum),
        source="TED",
        titre=titre or "(sans titre)",
        acheteur=acheteur or "(acheteur non précisé)",
        objet=titre,
        code_cpv=cpv,
        lieu=lieu,
        date_publication=pubdate,
        date_limite=deadline,
        montant_estime=montant_str,
        url=f"https://ted.europa.eu/fr/notice/{pubnum}",
    )
    avis.prio_geo = priorite_geographique([], f"{titre} {acheteur}")
    return avis


def recuperer(window_hours: int = config.WINDOW_HOURS) -> list[Avis]:
    """Récupère les avis TED publiés dans la fenêtre, filtrés CPV + pays.

    En cas d'erreur, journalise et renvoie une liste vide (l'orchestrateur
    continue avec l'autre source)."""
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=window_hours)).strftime("%Y%m%d")
    query = _build_query(since)
    session = make_session()
    avis: list[Avis] = []
    try:
        page = 1
        while len(avis) < MAX_RECORDS:
            data = post_json(session, API_URL, {
                "query": query,
                "fields": FIELDS,
                "limit": PAGE_SIZE,
                "page": page,
                "scope": config.TED_SCOPE,
            })
            notices = data.get("notices", [])
            for rec in notices:
                a = _to_avis(rec)
                if a:
                    avis.append(a)
            total = data.get("totalNoticeCount", 0)
            if page * PAGE_SIZE >= total or not notices:
                break
            page += 1
        log.info("TED : %d avis récupérés (depuis %s)", len(avis), since)
    except Exception as e:  # noqa: BLE001
        log.error("TED : échec de récupération : %s", e)
    return avis
