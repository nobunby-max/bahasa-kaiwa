'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const exifr = require('exifr');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Directories ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials', 'service-account.json');

[UPLOADS_DIR, THUMBNAILS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/thumbnails', express.static(THUMBNAILS_DIR));

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ── Google Sheets ─────────────────────────────────────────────────────────────
const SHEET_NAME = 'Photos';
const SHEET_HEADERS = ['id', 'filename', 'thumbnail', 'date', 'address', 'category', 'comment', 'lat', 'lng'];
// Columns: A=id, B=filename, C=thumbnail, D=date, E=address, F=category, G=comment, H=lat, I=lng

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Service account credentials not found at ${CREDENTIALS_PATH}. ` +
        'Please follow SETUP.md to configure Google Sheets API.'
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function ensureHeaderRow() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn('GOOGLE_SHEET_ID not set – skipping header check.');
    return;
  }

  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A1:I1`,
    });

    const rows = res.data.values || [];
    if (rows.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [SHEET_HEADERS] },
      });
      console.log('Header row written to Google Sheet.');
    }
  } catch (err) {
    console.error('Failed to ensure header row:', err.message);
  }
}

// ── Helper: extract date from EXIF or file mtime ──────────────────────────────
async function extractDate(filePath) {
  try {
    const exif = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate'] });
    if (exif && (exif.DateTimeOriginal || exif.CreateDate)) {
      const raw = exif.DateTimeOriginal || exif.CreateDate;
      return raw instanceof Date ? raw.toISOString() : new Date(raw).toISOString();
    }
  } catch (_) {
    // fall through
  }

  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
}

// ── Helper: generate thumbnail ────────────────────────────────────────────────
async function generateThumbnail(sourcePath, thumbnailFilename) {
  const destPath = path.join(THUMBNAILS_DIR, thumbnailFilename);
  await sharp(sourcePath)
    .rotate() // auto-orient based on EXIF
    .resize({ width: 300 })
    .jpeg({ quality: 80 })
    .toFile(destPath);
  return destPath;
}

// ── API: GET /api/photos ──────────────────────────────────────────────────────
app.get('/api/photos', async (_req, res) => {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    return res.json({ type: 'FeatureCollection', features: [] });
  }

  try {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A2:I`,
    });

    const rows = response.data.values || [];
    const features = rows
      .filter((row) => row[7] && row[8]) // must have lat (H) and lng (I)
      .map((row) => {
        const [id, filename, thumbnail, date, address, category, comment, lat, lng] = row;
        return {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          properties: {
            id: id || '',
            filename: filename || '',
            thumbnail: thumbnail || '',
            date: date || '',
            address: address || '',
            category: category || '',
            comment: comment || '',
          },
        };
      });

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('GET /api/photos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: POST /api/upload ─────────────────────────────────────────────────────
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "photo".' });
  }

  const uploadedPath = req.file.path;
  const filename = req.file.filename;
  const thumbFilename = `thumb_${filename.replace(/\.[^.]+$/, '.jpg')}`;

  try {
    // Generate thumbnail
    await generateThumbnail(uploadedPath, thumbFilename);

    // Extract date
    const date = await extractDate(uploadedPath);

    res.json({
      filename,
      thumbnail: thumbFilename,
      date,
    });
  } catch (err) {
    console.error('POST /api/upload error:', err.message);
    // Clean up uploaded file on error
    fs.unlink(uploadedPath, () => {});
    res.status(500).json({ error: `Failed to process image: ${err.message}` });
  }
});

// ── API: POST /api/photos ─────────────────────────────────────────────────────
app.post('/api/photos', async (req, res) => {
  const { filename, thumbnail, date, address, category, comment, lat, lng } = req.body;

  if (!filename || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'filename, lat, and lng are required.' });
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    return res.status(500).json({ error: 'GOOGLE_SHEET_ID environment variable is not set.' });
  }

  const id = uuidv4();
  const row = [
    id,
    filename,
    thumbnail || '',
    date || new Date().toISOString(),
    address || '',
    category || '',
    comment || '',
    String(lat),
    String(lng),
  ];

  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    res.json({ success: true, id });
  } catch (err) {
    console.error('POST /api/photos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Photo Map server running at http://localhost:${PORT}`);
  await ensureHeaderRow();
});
