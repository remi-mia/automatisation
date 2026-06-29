"""Fichier d'état local (seen_ids.json) pour garantir l'idempotence :
un avis déjà envoyé ne sera jamais renvoyé sur une exécution ultérieure.
"""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger("state")

STATE_FILE = os.path.join(os.path.dirname(__file__), "seen_ids.json")


def charger() -> set[str]:
    if not os.path.exists(STATE_FILE):
        return set()
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return set(json.load(f))
    except Exception as e:  # noqa: BLE001
        log.warning("Lecture de %s impossible (%s) : on repart d'un état vide.", STATE_FILE, e)
        return set()


def sauvegarder(ids: set[str]) -> None:
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(ids), f, ensure_ascii=False, indent=0)
    except Exception as e:  # noqa: BLE001
        log.error("Écriture de %s impossible : %s", STATE_FILE, e)
