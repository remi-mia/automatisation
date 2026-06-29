"""Session HTTP robuste : timeout par défaut + retry avec backoff exponentiel."""
from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import config


def make_session() -> requests.Session:
    """Crée une session requests avec retry automatique sur erreurs transitoires."""
    session = requests.Session()
    retry = Retry(
        total=config.HTTP_RETRIES,
        backoff_factor=config.HTTP_BACKOFF,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def get_json(session: requests.Session, url: str, **kwargs) -> dict:
    kwargs.setdefault("timeout", config.HTTP_TIMEOUT)
    resp = session.get(url, **kwargs)
    resp.raise_for_status()
    return resp.json()


def post_json(session: requests.Session, url: str, json_body: dict, **kwargs) -> dict:
    kwargs.setdefault("timeout", config.HTTP_TIMEOUT)
    resp = session.post(url, json=json_body, **kwargs)
    resp.raise_for_status()
    return resp.json()
