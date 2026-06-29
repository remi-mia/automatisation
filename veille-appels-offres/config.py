"""Configuration centrale de la veille appels d'offres.

Tout ce qui est « métier » et ajustable est ici : codes CPV, mots-clés,
priorité géographique, seuils, fenêtre temporelle. Pour adapter la veille,
on ne touche qu'à ce fichier.
"""
from __future__ import annotations

# --- Codes CPV cibles (préfixes) ---------------------------------------------
# On raisonne en préfixes : un code CPV plus précis (ex. 80531200) est considéré
# comme correspondant s'il commence par l'un de ces préfixes.
CPV_CODES = [
    "80000000",  # Services d'enseignement et de formation
    "80500000",  # Services de formation
    "72000000",  # Technologies de l'information : conseil, développement logiciel…
    "72200000",  # Programmation et conseil en logiciels
    "72600000",  # Assistance et conseil informatiques
    "79400000",  # Conseil en affaires et en gestion
]

# --- Mots-clés (recherchés dans le titre et l'objet) -------------------------
KEYWORDS = [
    "intelligence artificielle",
    "IA",
    "machine learning",
    "data",
    "automatisation",
    "RAG",
    "agent",
    "LLM",
    "formation IA",
    "transformation numérique",
]

# --- Priorité géographique ----------------------------------------------------
# Départements d'Auvergne-Rhône-Alpes (mis en avant en priorité 1).
AURA_DEPARTEMENTS = {
    "01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74",
}
# Termes textuels permettant de repérer AURA quand le code département manque
# (cas TED notamment, où l'on n'a pas le département).
AURA_TERMES = [
    "auvergne", "rhône-alpes", "rhone-alpes", "lyon", "grenoble", "clermont",
    "saint-étienne", "saint-etienne", "annecy", "chambéry", "chambery",
    "valence", "bourg-en-bresse", "roanne", "vienne", "aurillac", "le puy",
]

# Priorités : 1 = AURA, 2 = reste France, 3 = UE/autre. Sert au tri secondaire.
PRIO_AURA = 1
PRIO_FRANCE = 2
PRIO_UE = 3

# --- Seuils et limites --------------------------------------------------------
SCORE_MIN = 50          # on ne garde que les avis avec score >= 50
SLACK_TOP_N = 10        # nombre d'avis détaillés dans le message Slack
WINDOW_HOURS = 24       # fenêtre de récupération (dernières 24 h)
MAX_TO_SCORE = 80       # garde-fou : nb max d'avis envoyés au scoring par exécution

# --- TED ----------------------------------------------------------------------
TED_COUNTRIES = ["FRA"]   # pays ciblés (ISO alpha-3). Étendre à l'UE : voir README.
TED_SCOPE = "ALL"          # "ALL" = tous les avis ; voir doc TED pour d'autres scopes.

# --- Modèle de scoring --------------------------------------------------------
ANTHROPIC_MODEL = "claude-sonnet-4-6"

# --- Réseau -------------------------------------------------------------------
HTTP_TIMEOUT = 30        # secondes
HTTP_RETRIES = 3
HTTP_BACKOFF = 1.5       # facteur de backoff entre tentatives

# --- Description de l'entreprise (contexte fourni au scoring) -----------------
ENTREPRISE_CONTEXTE = (
    "Made in AI est une société de conseil et de formation en intelligence "
    "artificielle, certifiée Qualiopi, basée à Lyon. Elle cible les PME et ETI "
    "industrielles en Auvergne-Rhône-Alpes et au-delà. Ses offres : formation IA, "
    "conseil IA, audit IA, développement IA (agents, RAG, LLM), automatisation et "
    "transformation numérique."
)
