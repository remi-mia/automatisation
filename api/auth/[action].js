// Routes d'authentification Google du dashboard, regroupées en une seule fonction
// (le plan Vercel Hobby plafonne à 12 fonctions serverless).
// URLs inchangées : /api/auth/login, /api/auth/callback, /api/auth/logout
import {
  buildGoogleAuthUrl, handleGoogleCallback, createSession, destroySession,
} from "../../lib/auth.js";

export default async function handler(req, res) {
  const action = req.query?.action;

  if (action === "login") {
    try {
      res.writeHead(302, { Location: buildGoogleAuthUrl(req, res) });
      return res.end();
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (action === "callback") {
    try {
      createSession(res, await handleGoogleCallback(req));
      res.writeHead(302, { Location: "/" });
      return res.end();
    } catch (err) {
      console.error("[auth/callback]", err);
      const dest = err?.code === "FORBIDDEN_DOMAIN" ? "/?error=domain" : "/?error=auth";
      res.writeHead(302, { Location: dest });
      return res.end();
    }
  }

  if (action === "logout") {
    destroySession(res);
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  return res.status(404).json({ error: `Action inconnue : ${action}` });
}
