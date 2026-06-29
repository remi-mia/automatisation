"""Orchestrateur de la veille appels d'offres.

Enchaînement : récupération (BOAMP + TED) → normalisation → déduplication →
filtrage des avis déjà vus → scoring OpenAI → filtrage par score → tri →
message Slack → mise à jour de l'état → journalisation.

Deux points d'entrée :
- `run(...)` : fonction réutilisable (appelée par l'endpoint Vercel /api/veille).
- CLI `python main.py [--test] [--dry-fetch] [--window N] [--no-state]`.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

import config
import state
import scoring
import slack
import dashboard_log
from models import deduplicate
from sources import boamp, ted

log = logging.getLogger("main")


def run(window_hours: int = config.WINDOW_HOURS,
        envoyer_slack: bool = True,
        utiliser_etat: bool = True) -> dict:
    """Exécute la veille et renvoie un dict de stats.

    - envoyer_slack=False : ne poste rien (mode test), renvoie le message en console.
    - utiliser_etat=False : ignore l'état (rejoue tout).
    """
    t0 = time.time()
    try:
        # 1) Récupération des deux sources (chacune défensive).
        avis = boamp.recuperer(window_hours) + ted.recuperer(window_hours)
        nb_recus = len(avis)

        # 2) Déduplication.
        avis = deduplicate(avis)

        # 3) Filtrage des avis déjà traités.
        seen = set() if not utiliser_etat else state.charger()
        nouveaux = [a for a in avis if a.cle_etat not in seen]
        log.info("Reçus=%d, dédupliqués=%d, nouveaux=%d", nb_recus, len(avis), len(nouveaux))

        # 4) Scoring OpenAI (parallélisé).
        scores = scoring.scorer_lot(nouveaux)

        # 5) Filtrage par score puis tri (score desc, AURA d'abord).
        retenus = [a for a in scores if (a.score or 0) >= config.SCORE_MIN]
        retenus.sort(key=lambda a: (-(a.score or 0), a.prio_geo))
        log.info("Retenus (score >= %d) : %d", config.SCORE_MIN, len(retenus))

        apercu = slack.rendre_console(retenus)

        # 6) Envoi.
        if envoyer_slack:
            slack.envoyer(slack.construire_payload(retenus))

        # 7) Mise à jour de l'état (tous les avis scorés).
        if utiliser_etat:
            state.marquer_vus([a.cle_etat for a in scores])

        duree = int((time.time() - t0) * 1000)
        stats = {
            "ok": True,
            "recus": nb_recus,
            "dedupliques": len(avis),
            "nouveaux": len(nouveaux),
            "retenus": len(retenus),
            "envoyes": len(retenus) if envoyer_slack else 0,
            "duree_ms": duree,
            "apercu": apercu,
        }
        if envoyer_slack:
            dashboard_log.journaliser("success", duree, meta={
                "recus": nb_recus, "retenus": len(retenus), "envoyes": len(retenus),
            })
        log.info("Terminé en %d ms — %s", duree, {k: stats[k] for k in ("recus", "retenus", "envoyes")})
        return stats

    except Exception as e:  # noqa: BLE001
        duree = int((time.time() - t0) * 1000)
        log.exception("Échec de l'exécution : %s", e)
        if envoyer_slack:
            dashboard_log.journaliser("error", duree, error=str(e))
        return {"ok": False, "erreur": str(e), "duree_ms": duree}


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Veille appels d'offres (BOAMP + TED → Slack).")
    parser.add_argument("--test", action="store_true", help="N'envoie pas sur Slack, affiche en console.")
    parser.add_argument("--dry-fetch", action="store_true", help="Récupère seulement (sans scoring ni Slack).")
    parser.add_argument("--window", type=int, default=config.WINDOW_HOURS, help="Fenêtre en heures (défaut 24).")
    parser.add_argument("--no-state", action="store_true", help="Ignore l'état (rejoue tout).")
    args = parser.parse_args()

    _setup_logging()
    # Chargement du .env pour les exécutions locales (sur Vercel, les variables
    # sont déjà injectées dans l'environnement).
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    if args.dry_fetch:
        avis = deduplicate(boamp.recuperer(args.window) + ted.recuperer(args.window))
        for a in avis[:15]:
            log.info("  [%s] %s | %s | CPV=%s | %s", a.source, a.titre[:65],
                     a.acheteur[:35], ",".join(a.code_cpv[:3]), a.lieu)
        log.info("--dry-fetch : %d avis (arrêt avant scoring).", len(avis))
        return 0

    stats = run(window_hours=args.window, envoyer_slack=not args.test, utiliser_etat=not args.no_state)
    if args.test:
        print("\n" + "=" * 70 + "\n" + stats.get("apercu", "") + "\n" + "=" * 70 + "\n")
    return 0 if stats.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
