// Serveur MCP « Post-call Monego » — accès par token dans l'URL.
// Pour Claude web / Claude Cowork, dont le connecteur personnalisé n'accepte
// qu'une URL (aucun header personnalisé possible).
//
// URL à coller dans le connecteur :
//   https://automatisation-six.vercel.app/mcp/<MCP_URL_TOKEN>
//
// ⚠️ Le token EST l'authentification : quiconque possède l'URL a un accès complet
// (lecture des transcripts, création de brouillons, envoi de mails). En cas de
// fuite, changer MCP_URL_TOKEN dans Vercel puis redéployer révoque l'accès.
import crypto from "node:crypto";
import { servir } from "../../lib/mcpServer.js";

function comparaisonConstante(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return servir(req, res);
  const attendu = process.env.MCP_URL_TOKEN;
  const fourni = req.query?.token;
  if (!attendu || !fourni || !comparaisonConstante(fourni, attendu)) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  return servir(req, res);
}
