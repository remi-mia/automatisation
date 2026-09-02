// Accès Supabase (schéma automatisation) pour l'automatisation réponses-email :
// comptes Gmail connectés + déduplication des messages traités.
const TIMEOUT = 20000;

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Configuration Supabase manquante.");
  return { url, key };
}

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Accept-Profile": "automatisation",
    "Content-Profile": "automatisation",
    "Content-Type": "application/json",
    ...extra,
  };
}

// Enregistre (ou met à jour) un compte Gmail connecté.
export async function saveAccount({ email, name, refresh_token }) {
  const { url, key } = cfg();
  const resp = await fetch(`${url}/rest/v1/gmail_accounts`, {
    method: "POST",
    headers: headers(key, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ email, name, refresh_token, active: true }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`saveAccount ${resp.status}: ${await resp.text()}`);
}

// Liste les comptes actifs.
export async function listAccounts() {
  const { url, key } = cfg();
  const resp = await fetch(
    `${url}/rest/v1/gmail_accounts?select=email,name,refresh_token&active=eq.true`,
    { headers: headers(key), signal: AbortSignal.timeout(TIMEOUT) }
  );
  if (!resp.ok) throw new Error(`listAccounts ${resp.status}`);
  return resp.json();
}

// Tente de marquer un message comme traité. Renvoie true si c'est un NOUVEAU
// message (insertion effective), false s'il était déjà traité (doublon).
export async function claimMessage(messageId, accountEmail) {
  const { url, key } = cfg();
  const resp = await fetch(`${url}/rest/v1/email_processed`, {
    method: "POST",
    headers: headers(key, { Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify({ message_id: messageId, account_email: accountEmail }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`claimMessage ${resp.status}: ${await resp.text()}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0; // [] si doublon ignoré
}

// Récupère une boîte connectée précise (ou null si absente/inactive).
export async function getAccount(email) {
  const { url, key } = cfg();
  const resp = await fetch(
    `${url}/rest/v1/gmail_accounts?select=email,name,refresh_token&active=eq.true&email=eq.${encodeURIComponent(email)}`,
    { headers: headers(key), signal: AbortSignal.timeout(TIMEOUT) }
  );
  if (!resp.ok) throw new Error(`getAccount ${resp.status}`);
  const rows = await resp.json();
  return rows[0] || null;
}
