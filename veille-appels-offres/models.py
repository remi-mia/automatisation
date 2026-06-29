"""Schéma commun normalisé pour un avis, et utilitaires de normalisation/dédup."""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, asdict
from typing import Optional

import config


@dataclass
class Avis:
    """Schéma commun aux deux sources (BOAMP, TED)."""
    id: str
    source: str                 # "BOAMP" ou "TED"
    titre: str
    acheteur: str
    objet: str
    code_cpv: list[str]
    lieu: str
    date_publication: str       # ISO ou JJ/MM/AAAA
    date_limite: Optional[str]
    montant_estime: Optional[str]
    url: str
    # Champs calculés (remplis plus tard)
    prio_geo: int = config.PRIO_UE
    score: Optional[int] = None
    justification: Optional[str] = None

    @property
    def cle_unique(self) -> str:
        """Clé de déduplication : titre + acheteur normalisés."""
        return f"{_norm(self.titre)}|{_norm(self.acheteur)}"

    @property
    def cle_etat(self) -> str:
        """Clé stable pour le fichier d'état (source + identifiant natif)."""
        return f"{self.source}:{self.id}"

    def to_dict(self) -> dict:
        return asdict(self)


def _norm(s: str) -> str:
    """Minuscule, sans accents, espaces compressés — pour comparaison."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def deduplicate(avis_list: list[Avis]) -> list[Avis]:
    """Supprime les doublons (même titre+acheteur). En cas de doublon BOAMP/TED,
    on garde le premier rencontré (l'ordre d'insertion privilégie BOAMP)."""
    vus: dict[str, Avis] = {}
    for a in avis_list:
        if a.cle_unique not in vus:
            vus[a.cle_unique] = a
    return list(vus.values())


def priorite_geographique(departements: list[str], texte: str) -> int:
    """Détermine la priorité géo : 1 AURA, 2 France, 3 UE.

    - Si un code département AURA est présent -> AURA.
    - Sinon, si un terme AURA apparaît dans le texte -> AURA.
    - departements non vide (donc France connue) -> France.
    - sinon -> UE/inconnu.
    """
    if departements and any(d in config.AURA_DEPARTEMENTS for d in departements):
        return config.PRIO_AURA
    t = _norm(texte)
    if any(_norm(term) in t for term in config.AURA_TERMES):
        return config.PRIO_AURA
    if departements:
        return config.PRIO_FRANCE
    return config.PRIO_FRANCE  # par défaut France (les deux sources sont FR-centrées)
