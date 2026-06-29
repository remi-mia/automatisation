"""Orchestrateur de la veille appels d'offres.

Enchaînement : récupération (BOAMP + TED) → normalisation → déduplication →
filtrage des avis déjà vus → scoring OpenAI → filtrage par score → tri →
message Slack → mise à jour de l'état → journalisation.

Usage :
  python main.py                # exécution réelle (envoi Slack)
  python main.py --test         # n'envoie PAS sur Slack : affiche le message en console
  python main.py --dry-fetch    # récupère seulement (counts + échantillon), sans scoring ni Slack
  python main.py --window 48     # fenêtre de 48 h au lieu de 24
  python main.py --no-state      # ignore seen_ids.json (utile pour rejouer un test)
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from dotenv import load_dotenv

import config
import state
import scoring
import slack
import dashboard_log
from models import deduplicate
from sources import boamp, ted


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
    parser.add_argument("--no-state", action="store_true", help="Ignore le fichier d'état seen_ids.json.")
    args = parser.parse_args()

    _setup_logging()
    load_dotenv()
    log = logging.getLogger("main")
    t0 = time.time()

    try:
        # 1) Récupération des deux sources (chacune est défensive : ne plante pas).
        avis = boamp.recuperer(args.window) + ted.recuperer(args.window)
        nb_recus = len(avis)
        log.info("Total brut récupéré : %d avis", nb_recus)

        # 2) Déduplication (BOAMP/TED peuvent publier le même marché).
        avis = deduplicate(avis)
        log.info("Après déduplication : %d avis", len(avis))

        if args.dry_fetch:
            for a in avis[:10]:
                log.info("  [%s] %s | %s | CPV=%s | %s",
                         a.source, a.titre[:70], a.acheteur[:40],
                         ",".join(a.code_cpv[:3]), a.lieu)
            log.info("--dry-fetch : arrêt avant scoring.")
            return 0

        # 3) Filtrage des avis déjà traités (idempotence).
        seen = set() if args.no_state else state.charger()
        nouveaux = [a for a in avis if a.cle_etat not in seen]
        log.info("Nouveaux (non déjà vus) : %d", len(nouveaux))

        # 4) Scoring OpenAI des nouveaux avis.
        scores = scoring.scorer_lot(nouveaux)

        # 5) On ne garde que les avis pertinents (score >= seuil).
        retenus = [a for a in scores if (a.score or 0) >= config.SCORE_MIN]

        # 6) Tri : score décroissant, puis priorité géographique (AURA d'abord).
        retenus.sort(key=lambda a: (-(a.score or 0), a.prio_geo))
        log.info("Retenus (score >= %d) : %d", config.SCORE_MIN, len(retenus))

        # 7) Message Slack (ou console en mode test).
        if args.test:
            print("\n" + "=" * 70)
            print(slack.rendre_console(retenus))
            print("=" * 70 + "\n")
        else:
            slack.envoyer(slack.construire_payload(retenus))

        # 8) Mise à jour de l'état : tous les avis scorés sont marqués « vus »
        #    (évite de les re-scorer ET de les renvoyer ultérieurement).
        if not args.no_state:
            seen.update(a.cle_etat for a in scores)
            state.sauvegarder(seen)

        duree = int((time.time() - t0) * 1000)
        log.info("Terminé en %d ms — reçus=%d, retenus=%d, envoyés=%d",
                 duree, nb_recus, len(retenus), 0 if args.test else len(retenus))
        if not args.test:
            dashboard_log.journaliser(
                "success", duree,
                meta={"recus": nb_recus, "retenus": len(retenus), "envoyes": len(retenus)},
            )
        return 0

    except Exception as e:  # noqa: BLE001
        duree = int((time.time() - t0) * 1000)
        log.exception("Échec de l'exécution : %s", e)
        dashboard_log.journaliser("error", duree, error=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
