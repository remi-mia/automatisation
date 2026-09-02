// Serveur MCP « Post-call Monego ». Une seule fonction, deux voies d'accès :
//
//  1) Header — pour Claude Code :
//       POST /api/mcp   avec   Authorization: Bearer <MCP_TOKEN>
//
//  2) Token dans l'URL — pour Claude web / Claude Cowork, dont le connecteur
//     personnalisé n'accepte qu'une URL (aucun header possible) :
//       POST /mcp/<MCP_URL_TOKEN>
//     (réécrit vers /api/mcp?token=<MCP_URL_TOKEN> — cf. vercel.json)
//
// ⚠️ Sur la voie 2, le token EST l'authentification : quiconque possède l'URL a
// un accès complet (transcripts, brouillons, envoi de mails). Pour révoquer :
// changer MCP_URL_TOKEN dans Vercel puis redéployer.
import crypto from "node:crypto";
import { servir } from "../lib/mcpServer.js";

function memeValeur(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function autorise(req) {
  // Voie 1 : header Authorization
  const attenduHeader = process.env.MCP_TOKEN;
  const fourniHeader = req.headers["authorization"] || "";
  if (attenduHeader && fourniHeader === `Bearer ${attenduHeader}`) return true;

  // Voie 2 : token dans l'URL
  const attenduUrl = process.env.MCP_URL_TOKEN;
  const fourniUrl = req.query?.token;
  if (attenduUrl && fourniUrl && memeValeur(fourniUrl, attenduUrl)) return true;

  return false;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return servir(req, res);
  if (!autorise(req)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Non autorisé" });
  }
  return servir(req, res);
}
