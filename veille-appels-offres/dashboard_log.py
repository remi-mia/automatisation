"""Journalisation OPTIONNELLE de l'exécution vers le dashboard Supabase.

Si SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont définies, on insère une ligne
dans la table automatisation.executions (même base que les autres automatisations,
pour apparaître dans le tableau de bord). Sinon, no-op silencieux.
"""
from __future__ import annotations

import logging
import os

import requests

log = logging.getLogger("dashboard")

AUTOMATION_ID = "veille-ao"


def journaliser(status: str, duration_ms: int, error: str | None = None, meta: dict | None = None) -> None:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return
    try:
        requests.post(
            f"{url}/rest/v1/executions",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Content-Profile": "automatisation",  # schéma dédié
                "Prefer": "return=minimal",
            },
            json={
                "automation_id": AUTOMATION_ID,
                "status": status,
                "error": (error or None) and str(error)[:2000],
                "duration_ms": duration_ms,
                "meta": meta,
            },
            timeout=15,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Journalisation dashboard échouée : %s", e)
