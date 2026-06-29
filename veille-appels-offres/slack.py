"""Construction du message Slack (Block Kit) et envoi via webhook.

L'URL du webhook vient TOUJOURS de la variable d'environnement SLACK_WEBHOOK_URL
(jamais codée en dur). Ici la destination est un webhook Make qui route puis
poste sur Slack : le payload contient donc un champ "type": "veille" pour le
routage, en plus du message Slack prêt à l'emploi (blocks) et des données
structurées (avis).
"""
from __future__ import annotations

import datetime as dt
import logging
import os

import config
from http_util import make_session
from models import Avis

log = logging.getLogger("slack")


def _fmt_date(value: str | None) -> str:
    """Formate une date ISO en JJ/MM/AAAA ; renvoie '—' si vide/illisible."""
    if not value:
        return "—"
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%d/%m/%Y")
    except Exception:
        # déjà au format court ou inattendu
        return value[:10]


def _ligne_avis(a: Avis, rang: int) -> dict:
    titre = a.titre if len(a.titre) <= 180 else a.titre[:177] + "…"
    montant = f" Montant estimé : {a.montant_estime}." if a.montant_estime else ""
    texte = (
        f"*Avis {rang} (score {a.score}, {a.source})*\n"
        f"*<{a.url}|{_md(titre)}>*\n"
        f"Acheteur : {_md(a.acheteur)} — {_md(a.lieu)}\n"
        f"_Pourquoi :_ {_md(a.justification or '')}\n"
        f"Date limite : {_fmt_date(a.date_limite)}.{montant}"
    )
    return {"type": "section", "text": {"type": "mrkdwn", "text": texte}}


def _md(s: str) -> str:
    """Échappe les caractères spéciaux mrkdwn de Slack."""
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def construire_message(retenus: list[Avis], date_str: str | None = None) -> dict:
    """Construit le payload Slack (blocks + texte de repli)."""
    date_str = date_str or dt.date.today().strftime("%d/%m/%Y")
    n = len(retenus)

    if n == 0:
        txt = f"Veille appels d'offres du {date_str} : aucun avis pertinent aujourd'hui."
        return {
            "text": txt,
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": f":mag: {txt}"}}],
        }

    titre = f"Veille appels d'offres du {date_str} : {n} avis pertinent{'s' if n > 1 else ''}"
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": titre, "emoji": True}}
    ]
    top = retenus[: config.SLACK_TOP_N]
    for i, a in enumerate(top, 1):
        blocks.append({"type": "divider"})
        blocks.append(_ligne_avis(a, i))

    if n > config.SLACK_TOP_N:
        reste = n - config.SLACK_TOP_N
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"… et {reste} autre(s) avis pertinent(s) non détaillé(s)."}],
        })

    return {"text": titre, "blocks": blocks}


def _avis_dict(a: Avis) -> dict:
    """Vue structurée d'un avis pour le payload Make (mapping facile dans Slack)."""
    return {
        "rang": None,  # renseigné dans construire_payload
        "source": a.source,
        "score": a.score,
        "titre": a.titre,
        "url": a.url,
        "acheteur": a.acheteur,
        "lieu": a.lieu,
        "justification": a.justification or "",
        "date_limite": _fmt_date(a.date_limite),
        "montant_estime": a.montant_estime or "",
    }


def construire_payload(retenus: list[Avis], date_str: str | None = None) -> dict:
    """Payload complet envoyé au webhook Make :
    - type : "veille" (pour le routage Make)
    - date, count : métadonnées
    - text, blocks : message Slack prêt à poster (Block Kit)
    - avis : top N en données structurées (mapping libre dans Make)
    """
    date_str = date_str or dt.date.today().strftime("%d/%m/%Y")
    msg = construire_message(retenus, date_str)
    avis = []
    for i, a in enumerate(retenus[: config.SLACK_TOP_N], 1):
        d = _avis_dict(a)
        d["rang"] = i
        avis.append(d)
    return {
        "type": "veille",
        "date": date_str,
        "count": len(retenus),
        "text": msg["text"],
        "blocks": msg["blocks"],
        "avis": avis,
    }


def envoyer(payload: dict) -> None:
    """Envoie le payload au webhook (Make). Lève en cas d'échec."""
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        raise RuntimeError("SLACK_WEBHOOK_URL manquante.")
    session = make_session()
    resp = session.post(url, json=payload, timeout=config.HTTP_TIMEOUT)
    resp.raise_for_status()
    log.info("Payload veille envoyé au webhook (type=%s, %d bloc(s)).",
             payload.get("type"), len(payload.get("blocks", [])))


def rendre_console(retenus: list[Avis], date_str: str | None = None) -> str:
    """Rendu texte lisible du message (mode test, sans envoi)."""
    date_str = date_str or dt.date.today().strftime("%d/%m/%Y")
    n = len(retenus)
    if n == 0:
        return f"Veille appels d'offres du {date_str} : aucun avis pertinent aujourd'hui."
    lignes = [f"Veille appels d'offres du {date_str} : {n} avis pertinent(s)", ""]
    for i, a in enumerate(retenus[: config.SLACK_TOP_N], 1):
        montant = f" Montant estimé : {a.montant_estime}." if a.montant_estime else ""
        lignes += [
            f"Avis {i} (score {a.score}, {a.source})",
            f"  {a.titre}",
            f"  Acheteur : {a.acheteur} — {a.lieu}",
            f"  Pourquoi : {a.justification or ''}",
            f"  Date limite : {_fmt_date(a.date_limite)}.{montant}",
            f"  Lien : {a.url}",
            "",
        ]
    if n > config.SLACK_TOP_N:
        lignes.append(f"… et {n - config.SLACK_TOP_N} autre(s) avis non détaillé(s).")
    return "\n".join(lignes)
