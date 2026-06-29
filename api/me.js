// Renvoie l'utilisateur connecté (ou 401). Utilisé par le front pour l'état de session.
import { readSession } from "../lib/auth.js";

export default function handler(req, res) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ authenticated: false });
  return res.status(200).json({
    authenticated: true,
    email: user.email,
    name: user.name,
    picture: user.picture,
  });
}
