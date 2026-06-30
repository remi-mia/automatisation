"""Endpoint Vercel (Python) qui déclenche la veille appels d'offres.

Appelé par une requête planifiée depuis Make. Protégé par un token : la requête
doit fournir le bon VEILLE_TOKEN (header `x-veille-token` ou query `?token=`).

Méthodes : GET ou POST. Paramètres optionnels :
  - token  : le secret VEILLE_TOKEN (sinon 401)
  - window : fenêtre en heures (défaut 24)

Les modules de la veille vivent dans veille-appels-offres/ ; on les rend
importables via sys.path (le dossier est inclus au déploiement, cf. vercel.json).
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Rend importables les modules de la veille (config, main, sources, …).
_VEILLE_DIR = os.path.join(os.path.dirname(__file__), "..", "veille-appels-offres")
if _VEILLE_DIR not in sys.path:
    sys.path.insert(0, _VEILLE_DIR)


def _autorise(headers, query) -> bool:
    attendu = os.environ.get("VEILLE_TOKEN")
    if not attendu:
        return False  # pas de token configuré => on refuse par sécurité
    fourni = headers.get("x-veille-token") or (query.get("token", [None])[0])
    return fourni == attendu


class handler(BaseHTTPRequestHandler):
    def _run(self):
        query = parse_qs(urlparse(self.path).query)
        if not _autorise(self.headers, query):
            return self._json(401, {"error": "Non autorisé"})
        try:
            window = int(query.get("window", ["24"])[0])
        except ValueError:
            window = 24
        # nostate=1 : rejoue sans tenir compte de l'état ET sans marquer comme vus
        # (utile pour tester / forcer un renvoi). Par défaut, état actif.
        nostate = query.get("nostate", ["0"])[0] in ("1", "true", "yes")

        import main as veille  # import paresseux (après ajout du sys.path)
        stats = veille.run(window_hours=window, envoyer_slack=True, utiliser_etat=not nostate)
        # On n'inclut pas l'aperçu complet dans la réponse HTTP.
        stats.pop("apercu", None)
        return self._json(200 if stats.get("ok") else 500, stats)

    def do_GET(self):
        self._run()

    def do_POST(self):
        self._run()

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
