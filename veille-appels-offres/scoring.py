"""Qualification des avis via l'API OpenAI (modèle gpt-5.4-mini).

Pour chaque avis, on demande un score de pertinence 0-100 et une justification
d'une phrase, du point de vue « Made in AI pourrait-elle raisonnablement
candidater à ce marché ? ».
"""
from __future__ import annotations

import json
import logging
import os
import re

from openai import OpenAI

import config
from models import Avis

log = logging.getLogger("scoring")

SYSTEM = (
    "Tu évalues si un appel d'offres public concerne DIRECTEMENT l'intelligence "
    "artificielle — IA générative, machine learning, deep learning, LLM, RAG, MCP, "
    "agents IA, NLP, vision par ordinateur, data science — pour de la FORMATION IA, "
    "un AUDIT IA, du CONSEIL IA, ou la MISE EN PLACE d'une solution IA.\n"
    "Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour : "
    "{\"score\": <entier 0-100>, \"justification\": \"<une phrase en français>\"}.\n"
    "Barème STRICT :\n"
    "- 80-100 : cœur de cible — l'objet du marché est explicitement l'IA "
    "(formation/audit/conseil/développement IA, agents, RAG, LLM, MCP, data science).\n"
    "- 65-79 : l'IA est clairement présente mais l'objet est plus large, ou le "
    "secteur/la zone est éloigné de Made in AI.\n"
    "- 0-64 : PAS réellement de l'IA. Mets ce score à tout marché d'informatique "
    "générique, développement logiciel non-IA, infogérance, maintenance, "
    "dématérialisation, site web, formation NON-IA, conseil généraliste, ou simple "
    "« transformation numérique » sans IA explicite.\n"
    "En cas de doute, choisis le score bas. Ne récompense PAS la simple présence du "
    "mot « données », « numérique » ou « agent » : il faut de l'IA au sens propre."
)

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY manquante.")
        _client = OpenAI(api_key=key)
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
        resp = _get_client().chat.completions.create(
            model=config.SCORING_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": _prompt(avis)},
            ],
            response_format={"type": "json_object"},
        )
        texte = resp.choices[0].message.content or ""
        avis.score, avis.justification = _parse(texte)
    except Exception as e:  # noqa: BLE001
        log.error("Scoring échoué pour %s : %s", avis.cle_etat, e)
        avis.score = 0
        avis.justification = "Scoring indisponible (erreur API)."
    return avis


def scorer_lot(avis_list: list[Avis]) -> list[Avis]:
    """Score une liste d'avis en parallèle (garde-fou sur le volume).

    Le scoring parallèle réduit fortement le temps total (important pour tenir
    sous la limite de durée d'une fonction serverless Vercel)."""
    from concurrent.futures import ThreadPoolExecutor

    a_scorer = avis_list[: config.MAX_TO_SCORE]
    if len(avis_list) > config.MAX_TO_SCORE:
        log.warning(
            "Volume d'avis (%d) > plafond de scoring (%d) : seuls les %d premiers "
            "sont scorés.", len(avis_list), config.MAX_TO_SCORE, config.MAX_TO_SCORE
        )
    if not a_scorer:
        return a_scorer
    with ThreadPoolExecutor(max_workers=config.SCORING_CONCURRENCY) as pool:
        list(pool.map(scorer, a_scorer))
    log.info("Scoring terminé : %d avis.", len(a_scorer))
    return a_scorer
