// Callback Google OAuth : vérifie le domaine, ouvre la session, redirige vers /.
import { handleGoogleCallback, createSession } from "../../lib/auth.js";

export default async function handler(req, res) {
  try {
    const user = await handleGoogleCallback(req);
    createSession(res, user);
    res.writeHead(302, { Location: "/" });
    res.end();
  } catch (err) {
    const dest =
      err?.code === "FORBIDDEN_DOMAIN" ? "/?error=domain" : "/?error=auth";
    console.error("[auth/callback]", err);
    res.writeHead(302, { Location: dest });
    res.end();
  }
}
