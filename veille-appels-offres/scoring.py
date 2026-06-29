"""Qualification des avis via l'API Anthropic (modèle claude-sonnet-4-6).

Pour chaque avis, on demande un score de pertinence 0-100 et une justification
d'une phrase, du point de vue « Made in AI pourrait-elle raisonnablement
candidater à ce marché ? ».
"""
from __future__ import annotations

import json
import logging
import os
import re

from anthropic import Anthropic

import config
from models import Avis

log = logging.getLogger("scoring")

SYSTEM = (
    "Tu es un assistant qui évalue la pertinence d'appels d'offres publics pour "
    "une entreprise donnée. Tu réponds UNIQUEMENT par un objet JSON valide, sans "
    "texte autour, au format : {\"score\": <entier 0-100>, \"justification\": "
    "\"<une phrase en français>\"}. Le score reflète la probabilité que "
    "l'entreprise puisse raisonnablement et utilement candidater."
)

_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY manquante.")
        _client = Anthropic(api_key=key)
    return _client


def _prompt(avis: Avis) -> str:
    return (
        f"Entreprise :\n{config.ENTREPRISE_CONTEXTE}\n\n"
        f"Appel d'offres à évaluer :\n"
        f"- Titre : {avis.titre}\n"
        f"- Acheteur : {avis.acheteur}\n"
        f"- Lieu : {avis.lieu}\n"
        f"- Codes CPV : {', '.join(avis.code_cpv) or 'non précisé'}\n"
        f"- Source : {avis.source}\n\n"
        "Donne le score de pertinence (0-100) et une justification d'une phrase."
    )


def _parse(texte: str) -> tuple[int, str]:
    """Extrait {score, justification} de la réponse, de façon défensive."""
    m = re.search(r"\{.*\}", texte, re.S)
    if not m:
        raise ValueError(f"Réponse non-JSON : {texte[:120]}")
    obj = json.loads(m.group(0))
    score = int(obj.get("score", 0))
    score = max(0, min(100, score))
    return score, str(obj.get("justification", "")).strip()


def scorer(avis: Avis) -> Avis:
    """Renseigne avis.score et avis.justification. En cas d'erreur, score=0."""
    try:
        resp = _get_client().messages.create(
            model=config.ANTHROPIC_MODEL,
            max_tokens=200,
            system=SYSTEM,
            messages=[{"role": "user", "content": _prompt(avis)}],
        )
        texte = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        avis.score, avis.justification = _parse(texte)
    except Exception as e:  # noqa: BLE001
        log.error("Scoring échoué pour %s : %s", avis.cle_etat, e)
        avis.score = 0
        avis.justification = "Scoring indisponible (erreur API)."
    return avis


def scorer_lot(avis_list: list[Avis]) -> list[Avis]:
    """Score une liste d'avis (séquentiel, avec garde-fou sur le volume)."""
    a_scorer = avis_list[: config.MAX_TO_SCORE]
    if len(avis_list) > config.MAX_TO_SCORE:
        log.warning(
            "Volume d'avis (%d) > plafond de scoring (%d) : seuls les %d premiers "
            "sont scorés.", len(avis_list), config.MAX_TO_SCORE, config.MAX_TO_SCORE
        )
    for i, a in enumerate(a_scorer, 1):
        scorer(a)
        log.info("  scoré %d/%d : %s -> %s", i, len(a_scorer), a.cle_etat, a.score)
    return a_scorer
