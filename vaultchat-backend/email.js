// Email sender — Nodemailer with Gmail SMTP by default.
// Env: EMAIL_USER, EMAIL_PASS (Gmail App Password), EMAIL_FROM (optional display)
// For production volume switch to Resend / Postmark / SES — same interface.

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  return transporter;
}

async function sendOTP(toEmail, code) {
  const from = process.env.EMAIL_FROM || `"VaultChat" <${process.env.EMAIL_USER}>`;
  const t = getTransporter();
  return t.sendMail({
    from,
    to: toEmail,
    subject: 'Your VaultChat sign-in code',
    text:
      `Your VaultChat sign-in code is: ${code}\n\n` +
      `This code expires in 10 minutes.\n\n` +
      `If you didn't request this, you can safely ignore the email.`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;">Your VaultChat sign-in code</h2>
        <p style="font-size:14px;color:#555;margin:0 0 24px;">Enter this code in the app to continue.</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f4f4;padding:16px 24px;border-radius:8px;text-align:center;">${code}</div>
        <p style="font-size:13px;color:#888;margin:24px 0 0;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

async function verifyConfig() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return { ok: false, error: 'EMAIL_USER or EMAIL_PASS not set' };
  }
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendOTP, verifyConfig };
