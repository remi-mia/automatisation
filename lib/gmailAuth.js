// OAuth Google pour connecter une boîte Gmail (accès hors-ligne = refresh token).
// Scope gmail.modify : lire les messages, créer des brouillons, marquer comme lu.
import crypto from "node:crypto";

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
];

const STATE_COOKIE = "gmail_oauth_state";

// Réutilise le client OAuth du dashboard par défaut ; override possible via GMAIL_*.
function clientId() {
  return process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
}
function clientSecret() {
  return process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
}

function baseUrl(req) {
  if (process.env.AUTH_BASE_URL) return process.env.AUTH_BASE_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return `${baseUrl(req)}/api/gmail/callback`;
}

export function buildConnectUrl(req, res) {
  if (!clientId()) throw new Error("GOOGLE_CLIENT_ID/GMAIL_CLIENT_ID non défini.");
  const state = crypto.randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",       // pour obtenir un refresh_token
    prompt: "consent",            // force le refresh_token à chaque connexion
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function cookieState(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === STATE_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

// Échange le code d'autorisation : renvoie { email, name, refresh_token }.
export async function exchangeCode(req) {
  const url = new URL(req.url, baseUrl(req));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw new Error("Code OAuth manquant.");
  if (!state || state !== cookieState(req)) throw new Error("State OAuth invalide.");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!resp.ok) throw new Error(`Échange de token échoué (${resp.status}).`);
  const tokens = await resp.json();
  if (!tokens.refresh_token) {
    throw new Error("Pas de refresh_token reçu (réautorise en révoquant l'accès précédent).");
  }
  const claims = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")
  );
  return {
    email: (claims.email || "").toLowerCase(),
    name: claims.name || "",
    refresh_token: tokens.refresh_token,
  };
}

// Obtient un access_token frais à partir d'un refresh_token.
export async function getAccessToken(refreshToken) {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`Rafraîchissement du token échoué (${resp.status}).`);
  return (await resp.json()).access_token;
}
