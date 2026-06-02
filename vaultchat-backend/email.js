// Transactional email sender — Resend (HTTPS API).
//
// Why Resend over Nodemailer/Gmail SMTP for production:
//   - HTTPS API, no SMTP port-blocking issues with Hetzner / cloud hosts
//   - Free tier covers 3K emails/month, no card required
//   - Domain DKIM/SPF managed in their UI, better inbox placement than
//     personal Gmail SMTP
//   - Bounce + complaint webhooks (wired in a later phase)
//
// Env:
//   RESEND_API_KEY  — from https://resend.com/api-keys (re_...)
//   EMAIL_FROM      — "VaultChat <noreply@corefinite.com>" (or any verified sender)

const { Resend } = require('resend');

let resend = null;

function getResend() {
  if (resend) return resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  resend = new Resend(key);
  return resend;
}

function fromAddress() {
  return process.env.EMAIL_FROM || 'VaultChat <noreply@corefinite.com>';
}

async function sendOTP(toEmail, code) {
  const r = await getResend().emails.send({
    from: fromAddress(),
    to: toEmail,
    subject: 'Your VaultChat sign-in code',
    text:
      `Your VaultChat sign-in code is: ${code}\n\n` +
      `This code expires in 10 minutes.\n\n` +
      `If you didn't request this, you can safely ignore this email.`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;">Your VaultChat sign-in code</h2>
        <p style="font-size:14px;color:#555;margin:0 0 24px;">Enter this code in the app to continue.</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f4f4;padding:16px 24px;border-radius:8px;text-align:center;">${code}</div>
        <p style="font-size:13px;color:#888;margin:24px 0 0;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });

  // Resend v4 returns { data, error } shape — surface errors clearly
  if (r?.error) {
    const err = new Error(r.error.message || 'Resend send failed');
    err.code = r.error.name || 'resend_error';
    throw err;
  }
  return r?.data;
}

async function verifyConfig() {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }
  try {
    // Cheapest valid API call to confirm the key is accepted
    await getResend().domains.list();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendOTP, verifyConfig };
