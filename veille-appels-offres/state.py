"""État (idempotence) stocké dans Supabase (table automatisation.veille_seen).

Garantit qu'un avis déjà traité n'est jamais renvoyé, y compris en environnement
sans disque persistant (fonction serverless Vercel).

Repli : si Supabase n'est pas configuré, on retombe sur un fichier local
seen_ids.json (utile pour les tests hors ligne).
"""
from __future__ import annotations

import json
import logging
import os

import requests

log = logging.getLogger("state")

STATE_FILE = os.path.join(os.path.dirname(__file__), "seen_ids.json")
_TIMEOUT = 20


def _supabase():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    return (url, key) if (url and key) else (None, None)


def _headers(key: str, extra: dict | None = None) -> dict:
    h = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept-Profile": "automatisation",
        "Content-Profile": "automatisation",
    }
    if extra:
        h.update(extra)
    return h


def charger() -> set[str]:
    """Charge l'ensemble des clés déjà vues."""
    url, key = _supabase()
    if not url:
        return _charger_fichier()
    try:
        out: set[str] = set()
        offset, page = 0, 1000
        while True:
            r = requests.get(
                f"{url}/rest/v1/veille_seen",
                headers=_headers(key, {"Range-Unit": "items", "Range": f"{offset}-{offset+page-1}"}),
                params={"select": "cle"},
                timeout=_TIMEOUT,
            )
            r.raise_for_status()
            rows = r.json()
            out.update(row["cle"] for row in rows)
            if len(rows) < page:
                break
            offset += page
        return out
    except Exception as e:  # noqa: BLE001
        log.error("Lecture état Supabase impossible (%s) : repli fichier.", e)
        return _charger_fichier()


def marquer_vus(cles: list[str]) -> None:
    """Marque une liste de clés comme vues (upsert idempotent)."""
    cles = [c for c in cles if c]
    if not cles:
        return
    url, key = _supabase()
    if not url:
        return _sauvegarder_fichier(charger() | set(cles))
    try:
        requests.post(
            f"{url}/rest/v1/veille_seen",
            headers=_headers(key, {"Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates,return=minimal"}),
            data=json.dumps([{"cle": c} for c in cles]),
            timeout=_TIMEOUT,
        ).raise_for_status()
    except Exception as e:  # noqa: BLE001
        log.error("Écriture état Supabase impossible : %s", e)


# --- Repli fichier local (hors ligne / sans Supabase) ------------------------
def _charger_fichier() -> set[str]:
    if not os.path.exists(STATE_FILE):
        return set()
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:  # noqa: BLE001
        return set()


def _sauvegarder_fichier(ids: set[str]) -> None:
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(ids), f, ensure_ascii=False, indent=0)
    except Exception as e:  # noqa: BLE001
        log.error("Écriture %s impossible : %s", STATE_FILE, e)
