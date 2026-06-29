// Envoi d'email via SMTP (nodemailer).
//
// Variables d'environnement attendues :
//   SMTP_HOST        ex: smtp.gmail.com
//   SMTP_PORT        ex: 465 (SSL) ou 587 (STARTTLS)
//   SMTP_USER        adresse / identifiant SMTP
//   SMTP_PASS        mot de passe (pour Gmail : "mot de passe d'application")
//   MAIL_FROM        expéditeur affiché (def: SMTP_USER)
//   MAIL_TO          destinataire fixe du brief
import nodemailer from "nodemailer";

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "Configuration SMTP manquante (SMTP_HOST / SMTP_USER / SMTP_PASS)."
    );
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true pour 465, false pour 587/STARTTLS
    auth: { user, pass },
  });

  return cachedTransporter;
}

// Envoie le brief en pièce jointe à l'adresse fixe MAIL_TO.
export async function sendBriefEmail({ subject, text, filename, buffer }) {
  const to = process.env.MAIL_TO;
  if (!to) throw new Error("MAIL_TO non défini (destinataire du brief).");

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const transporter = getTransporter();

  return transporter.sendMail({
    from,
    to,
    subject,
    text,
    attachments: [
      {
        filename,
        content: buffer,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ],
  });
}
