"""Client BOAMP (Bulletin officiel des annonces de marchés publics).

API OpenDataSoft v2.1, gratuite et sans clé.
Doc : https://boamp-datadila.opendatasoft.com/explore/dataset/boamp/api/

Points validés par tests réels (voir README, section « hypothèses ») :
- Le moteur ODSQL (paramètre `where`) fait une recherche plein-texte qui INDEXE
  le champ `donnees` (JSON imbriqué). On peut donc filtrer par code CPV ET par
  mots-clés en texte libre : where=("80500000" OR "intelligence artificielle" ...).
- Les codes CPV ne sont PAS un champ plat : ils sont enfouis dans `donnees` à des
  chemins variables (FNSimple/initial/lots/lot[]/codeCPV, .../natureMarche/codeCPV…).
  On les extrait donc par parcours récursif, pour l'affichage et l'enrichissement.
- `dateparution` est une date de publication exploitable pour la fenêtre 24 h.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re

import config
from http_util import make_session, get_json
from models import Avis, priorite_geographique

log = logging.getLogger("boamp")

API_URL = "https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records"
PAGE_SIZE = 100        # max OpenDataSoft v2.1
MAX_RECORDS = 300      # garde-fou sur le nombre total récupéré


def _build_where(since_date: str) -> str:
    """Construit la clause ODSQL : (mots-clés IA…) ET date >= since.

    Recherche pilotée par les mots-clés IA (et non par les CPV, trop génériques :
    ils ramenaient formation/informatique/conseil sans rapport avec l'IA). Les CPV
    restent extraits pour l'affichage et servent au scoring."""
    ors = " OR ".join(f'"{t}"' for t in config.KEYWORDS)
    return f"({ors}) and dateparution >= date'{since_date}'"


_CPV_RE = re.compile(r"\b(\d{8})(?:-\d)?\b")


def _extraire_cpv(donnees) -> list[str]:
    """Collecte les codes CPV depuis `donnees`.

    Les codes vivent dans des sous-arbres dont la clé contient « CPV », à des
    profondeurs variables (ex. codeCPV/objetPrincipal/classPrincipale = "80500000").
    On collecte donc tous les nombres à 8 chiffres présents sous une clé CPV.
    """
    out: list[str] = []

    def collect_codes(o):
        if isinstance(o, dict):
            for v in o.values():
                collect_codes(v)
        elif isinstance(o, list):
            for v in o:
                collect_codes(v)
        elif isinstance(o, (str, int)):
            out.extend(_CPV_RE.findall(str(o)))

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if "CPV" in k.upper():
                    collect_codes(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(donnees)
    # Dédoublonne en conservant l'ordre
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def _extraire_montant(donnees) -> str | None:
    """Recherche best-effort d'un montant estimé dans `donnees`.

    BOAMP n'a pas de champ montant normalisé : selon le formulaire, la valeur peut
    apparaître sous diverses clés (VALEUR, MONTANT, ESTIMATION…). On renvoie la
    première trouvée, ou None. Hypothèse signalée dans le README.
    """
    trouve = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                ku = k.upper()
                if any(x in ku for x in ("VALEUR", "MONTANT", "ESTIMATION")) and isinstance(v, (str, int, float)):
                    s = str(v).strip()
                    try:
                        # On ignore les valeurs nulles ou manifestement non-montants
                        # (ex. compteurs « 1 ») : un montant de marché est >= 1000.
                        garder = float(s.replace(",", ".").replace(" ", "")) >= 1000
                    except ValueError:
                        garder = False
                    if s and garder:
                        trouve.append(s)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(donnees)
    return trouve[0] if trouve else None


def _ville(donnees) -> str:
    try:
        ident = donnees.get("IDENTITE", {})
        ville = ident.get("VILLE") or ""
        return str(ville).strip()
    except Exception:
        return ""


def _to_avis(rec: dict) -> Avis | None:
    objet = (rec.get("objet") or "").strip()
    if not objet:
        return None
    donnees = rec.get("donnees")
    if isinstance(donnees, str):
        try:
            donnees = json.loads(donnees)
        except Exception:
            donnees = {}
    donnees = donnees or {}

    depts = rec.get("code_departement") or []
    if isinstance(depts, str):
        depts = [depts]
    ville = _ville(donnees)
    lieu = ", ".join(filter(None, [ville, "/".join(depts)])) or "France"

    acheteur = (rec.get("nomacheteur") or "").strip()
    avis = Avis(
        id=str(rec.get("idweb") or rec.get("id") or ""),
        source="BOAMP",
        titre=objet,
        acheteur=acheteur,
        objet=objet,
        code_cpv=_extraire_cpv(donnees),
        lieu=lieu,
        date_publication=rec.get("dateparution") or "",
        date_limite=rec.get("datelimitereponse"),
        montant_estime=_extraire_montant(donnees),
        url=rec.get("url_avis") or f"https://www.boamp.fr/pages/avis/?q=idweb:{rec.get('idweb')}",
    )
    avis.prio_geo = priorite_geographique(depts, f"{objet} {acheteur} {ville}")
    return avis


def recuperer(window_hours: int = config.WINDOW_HOURS) -> list[Avis]:
    """Récupère les avis BOAMP publiés dans la fenêtre, filtrés CPV+mots-clés.

    En cas d'erreur, journalise et renvoie une liste vide (ne fait pas planter
    l'orchestrateur, qui continuera avec l'autre source).
    """
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=window_hours)).date().isoformat()
    where = _build_where(since)
    session = make_session()
    avis: list[Avis] = []
    try:
        offset = 0
        while offset < MAX_RECORDS:
            data = get_json(
                session, API_URL,
                params={
                    "where": where,
                    "order_by": "dateparution desc",
                    "limit": PAGE_SIZE,
                    "offset": offset,
                },
            )
            results = data.get("results", [])
            for rec in results:
                a = _to_avis(rec)
                if a:
                    avis.append(a)
            total = data.get("total_count", 0)
            offset += PAGE_SIZE
            if offset >= total or not results:
                break
        log.info("BOAMP : %d avis récupérés (depuis %s)", len(avis), since)
    except Exception as e:  # noqa: BLE001
        log.error("BOAMP : échec de récupération : %s", e)
    return avis
