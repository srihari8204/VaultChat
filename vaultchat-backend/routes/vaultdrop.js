const express    = require('express');
const router     = express.Router();
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');

const vaultDropStore = new Map();

const upload = multer({
  dest: path.join(__dirname, '../temp_uploads/'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function gen8Code() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// POST /api/vaultdrop/create-link
router.post('/create-link', upload.single('file'), async (req, res) => {
  try {
    const { senderName, recipientEmail, fileName } = req.body;
    if (!recipientEmail || !fileName) {
      return res.status(400).json({ error: 'recipientEmail and fileName are required' });
    }

    const id    = uuidv4();
    const code8 = gen8Code();
    const link  = `${process.env.APP_URL || 'https://vaultchat.app'}/drop/${id}`;

    vaultDropStore.set(id, {
      id, code8, fileName,
      filePath:       req.file ? req.file.path : null,
      recipientEmail,
      senderName:     senderName || 'Someone',
      createdAt:      Date.now(),
      downloaded:     false
    });

    // Auto-delete after 24 hours
    setTimeout(() => {
      const r = vaultDropStore.get(id);
      if (r && r.filePath) { try { fs.unlinkSync(r.filePath); } catch (e) {} }
      vaultDropStore.delete(id);
    }, 24 * 60 * 60 * 1000);

    await transporter.sendMail({
      from:    `"VaultChat" <${process.env.EMAIL_USER}>`,
      to:      recipientEmail,
      subject: `${senderName || 'Someone'} sent you a secure file via VaultChat`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:auto;background:#0D1B2E;padding:32px;border-radius:16px;color:#fff;">
          <h2 style="color:#4A9FFF;">VaultDrop - Secure File</h2>
          <p style="color:rgba(255,255,255,0.7);">
            <strong>${senderName || 'Someone'}</strong> sent you: <strong style="color:#fff;">${fileName}</strong>
          </p>
          <p style="color:rgba(255,255,255,0.5);font-size:13px;">One-time download · Requires 8-digit code · Auto-deletes after download</p>
          <a href="${link}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#1D4ED8;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">
            Open Secure Link
          </a>
          <p style="color:rgba(255,255,255,0.4);font-size:12px;">You will need the 8-digit code from the sender to unlock this file.</p>
        </div>`
    });

    res.json({ success: true, id, link, code8 });
  } catch (err) {
    console.error('VaultDrop create-link error:', err);
    res.status(500).json({ error: 'Failed to create VaultDrop link' });
  }
});

// POST /api/vaultdrop/send-direct
router.post('/send-direct', upload.single('file'), async (req, res) => {
  try {
    const { senderName, recipientEmail, fileName } = req.body;
    if (!recipientEmail || !req.file) {
      return res.status(400).json({ error: 'recipientEmail and file are required' });
    }

    await transporter.sendMail({
      from:    `"VaultChat" <${process.env.EMAIL_USER}>`,
      to:      recipientEmail,
      subject: `${senderName || 'Someone'} sent you a file via VaultChat`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:auto;background:#0D1B2E;padding:32px;border-radius:16px;color:#fff;">
          <h2 style="color:#10B981;">Direct File Transfer</h2>
          <p style="color:rgba(255,255,255,0.7);">
            <strong>${senderName || 'Someone'}</strong> sent you <strong style="color:#fff;">${fileName || req.file.originalname}</strong>
          </p>
          <p style="color:rgba(255,255,255,0.5);font-size:13px;">The file is attached below. No code needed.</p>
        </div>`,
      attachments: [{ filename: fileName || req.file.originalname, path: req.file.path }]
    });

    setTimeout(() => { try { fs.unlinkSync(req.file.path); } catch (e) {} }, 5000);
    res.json({ success: true });
  } catch (err) {
    console.error('VaultDrop send-direct error:', err);
    res.status(500).json({ error: 'Failed to send file' });
  }
});

// POST /api/vaultdrop/verify
router.post('/verify', (req, res) => {
  const { id, code8 } = req.body;
  const record = vaultDropStore.get(id);
  if (!record)           return res.status(404).json({ error: 'Link expired or not found' });
  if (record.downloaded) return res.status(410).json({ error: 'File already downloaded' });
  if (record.code8 !== code8) return res.status(401).json({ error: 'Invalid code' });
  res.json({ success: true, fileName: record.fileName });
});

// GET /api/vaultdrop/download/:id
router.get('/download/:id', (req, res) => {
  const record = vaultDropStore.get(req.params.id);
  if (!record)            return res.status(404).json({ error: 'Not found' });
  if (record.downloaded)  return res.status(410).json({ error: 'Already downloaded' });
  record.downloaded = true;
  if (record.filePath && fs.existsSync(record.filePath)) {
    res.download(record.filePath, record.fileName, () => {
      try { fs.unlinkSync(record.filePath); } catch (e) {}
      vaultDropStore.delete(record.id);
    });
  } else {
    res.status(404).json({ error: 'File not found on server' });
  }
});

module.exports = router;
