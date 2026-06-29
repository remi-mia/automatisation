// Authentification Google (OAuth 2.0, code flow) restreinte à un domaine,
// + session signée stockée dans un cookie httpOnly.
import crypto from "node:crypto";

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "made-in-ai.fr";
const SESSION_COOKIE = "session";
const STATE_COOKIE = "oauth_state";
const SESSION_TTL = 60 * 60 * 12; // 12 h

// --- Cookies ---
export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    "Secure",
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader("Set-Cookie");
  const list = Array.isArray(prev) ? prev : prev ? [prev] : [];
  list.push(parts.join("; "));
  res.setHeader("Set-Cookie", list);
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

// --- Session (token signé HMAC) ---
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET non défini.");
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function createSession(res, user) {
  const payload = b64url(
    JSON.stringify({
      email: user.email,
      name: user.name || "",
      picture: user.picture || "",
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    })
  );
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  setCookie(res, SESSION_COOKIE, `${payload}.${sig}`, { maxAge: SESSION_TTL });
}

export function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

export function destroySession(res) {
  clearCookie(res, SESSION_COOKIE);
}

// Garde d'accès pour les endpoints protégés. Renvoie l'utilisateur ou répond 401.
export function requireAuth(req, res) {
  const user = readSession(req);
  if (!user) {
    res.status(401).json({ error: "Non authentifié" });
    return null;
  }
  return user;
}

// --- Google OAuth ---
function baseUrl(req) {
  if (process.env.AUTH_BASE_URL) return process.env.AUTH_BASE_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return `${baseUrl(req)}/api/auth/callback`;
}

export function buildGoogleAuthUrl(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID non défini.");
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, STATE_COOKIE, state, { maxAge: 600 });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    hd: ALLOWED_DOMAIN, // indice de domaine (non contraignant, revérifié au callback)
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Échange le code, vérifie le domaine, renvoie l'utilisateur autorisé (ou throw).
export async function handleGoogleCallback(req) {
  const url = new URL(req.url, baseUrl(req));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw new Error("Code OAuth manquant.");

  const expectedState = parseCookies(req)[STATE_COOKIE];
  if (!state || !expectedState || state !== expectedState) {
    throw new Error("State OAuth invalide.");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Échange de token échoué (${tokenRes.status}).`);
  }
  const tokens = await tokenRes.json();
  // id_token reçu directement de Google via TLS : on décode le payload.
  const claims = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")
  );

  const email = (claims.email || "").toLowerCase();
  const domainOk =
    claims.hd === ALLOWED_DOMAIN || email.endsWith(`@${ALLOWED_DOMAIN}`);
  if (!claims.email_verified || !domainOk) {
    const err = new Error(`Accès réservé au domaine @${ALLOWED_DOMAIN}.`);
    err.code = "FORBIDDEN_DOMAIN";
    throw err;
  }

  return { email, name: claims.name, picture: claims.picture };
}
