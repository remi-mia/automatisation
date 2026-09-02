// Appels Gmail API v1 : lister les non-lus, lire un message, créer un brouillon.
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gapi(accessToken, path, options = {}) {
  const resp = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Gmail API ${path} → ${resp.status} ${t.slice(0, 200)}`);
  }
  return resp.json();
}

// Liste les IDs des messages non lus de la boîte de réception (fenêtre récente).
export async function listUnread(accessToken, { maxResults = 15, newerThanDays = 3 } = {}) {
  const q = encodeURIComponent(`is:unread in:inbox newer_than:${newerThanDays}d`);
  const data = await gapi(accessToken, `/messages?q=${q}&maxResults=${maxResults}`);
  return (data.messages || []).map((m) => m.id);
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// Décode récursivement le corps texte (préférence text/plain).
function extractBody(payload) {
  const decode = (data) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  let plain = "";
  let html = "";
  const walk = (part) => {
    if (!part) return;
    const mt = part.mimeType || "";
    if (mt === "text/plain" && part.body?.data) plain += decode(part.body.data);
    else if (mt === "text/html" && part.body?.data) html += decode(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  if (plain.trim()) return plain;
  // repli : HTML nettoyé grossièrement
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseEmailAddress(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

// Récupère un message et le normalise.
export async function getMessage(accessToken, id) {
  const msg = await gapi(accessToken, `/messages/${id}?format=full`);
  const headers = msg.payload?.headers || [];
  const from = header(headers, "From");
  return {
    id: msg.id,
    threadId: msg.threadId,
    from,
    fromEmail: parseEmailAddress(from),
    subject: header(headers, "Subject"),
    messageIdHeader: header(headers, "Message-ID"),
    references: header(headers, "References"),
    body: extractBody(msg.payload),
  };
}

// Construit un message MIME brut (base64url) pour un brouillon de réponse HTML.
function buildRawReply({ toEmail, subject, htmlBody, inReplyTo, references }) {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${toEmail}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references || inReplyTo) lines.push(`References: ${references || inReplyTo}`);
  const raw = `${lines.join("\r\n")}\r\n\r\n${htmlBody}`;
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Crée un brouillon de réponse dans le thread d'origine.
export async function createDraft(accessToken, { toEmail, subject, htmlBody, threadId, inReplyTo, references }) {
  const raw = buildRawReply({ toEmail, subject, htmlBody, inReplyTo, references });
  return gapi(accessToken, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId } }),
  });
}

// Marque un message comme lu (retire le label UNREAD).
export async function markRead(accessToken, id) {
  return gapi(accessToken, `/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
}

// ---------------------------------------------------------------------------
// Composition générique (utilisée par l'automatisation Post-call Monego) :
// brouillon OU envoi, avec CC et pièces jointes.
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Encodage RFC 2047 d'un en-tête (indispensable pour les accents français).
function encodeHeader(value) {
  const s = String(value || "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// Découpe une chaîne base64 en lignes de 76 caractères (RFC 2045).
function wrap76(b64) {
  return (b64.match(/.{1,76}/g) || []).join("\r\n");
}

// Construit un message MIME complet (base64url), avec pièces jointes éventuelles.
// attachments : [{ filename, content_base64, mimeType }]
export function buildMime({ to, cc, subject, htmlBody, attachments = [], inReplyTo, references }) {
  const dest = Array.isArray(to) ? to.join(", ") : to;
  const entetes = [`To: ${dest}`];
  if (cc && (Array.isArray(cc) ? cc.length : cc)) {
    entetes.push(`Cc: ${Array.isArray(cc) ? cc.join(", ") : cc}`);
  }
  entetes.push(`Subject: ${encodeHeader(subject)}`);
  entetes.push("MIME-Version: 1.0");
  if (inReplyTo) entetes.push(`In-Reply-To: ${inReplyTo}`);
  if (references || inReplyTo) entetes.push(`References: ${references || inReplyTo}`);

  const corpsHtml = htmlBody || "";

  if (!attachments.length) {
    entetes.push('Content-Type: text/html; charset="UTF-8"');
    entetes.push("Content-Transfer-Encoding: base64");
    const body = wrap76(Buffer.from(corpsHtml, "utf8").toString("base64"));
    return b64url(`${entetes.join("\r\n")}\r\n\r\n${body}`);
  }

  const boundary = `mia_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  entetes.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parties = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(corpsHtml, "utf8").toString("base64")),
  ];

  for (const pj of attachments) {
    const nom = pj.filename || "piece-jointe";
    const type = pj.mimeType || "application/octet-stream";
    parties.push(
      `--${boundary}`,
      `Content-Type: ${type}; name="${encodeHeader(nom)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(nom)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(String(pj.content_base64 || "").replace(/\s+/g, ""))
    );
  }
  parties.push(`--${boundary}--`, "");

  return b64url(`${entetes.join("\r\n")}\r\n\r\n${parties.join("\r\n")}`);
}

// Crée un brouillon (sans préfixer « Re: », contrairement à createDraft).
export async function createDraftMessage(accessToken, opts) {
  const raw = buildMime(opts);
  const message = { raw };
  if (opts.threadId) message.threadId = opts.threadId;
  return gapi(accessToken, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

// Envoie réellement un message.
export async function sendMessage(accessToken, opts) {
  const raw = buildMime(opts);
  const body = { raw };
  if (opts.threadId) body.threadId = opts.threadId;
  return gapi(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Adresse de la boîte (utile pour vérifier à quel compte appartient un token).
export async function getProfile(accessToken) {
  return gapi(accessToken, "/profile");
}
