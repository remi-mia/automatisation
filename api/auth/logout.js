// Déconnexion : supprime la session et redirige vers /.
import { destroySession } from "../../lib/auth.js";

export default function handler(req, res) {
  destroySession(res);
  res.writeHead(302, { Location: "/" });
  res.end();
}
