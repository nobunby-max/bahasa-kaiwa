require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const exifr = require('exifr');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/thumbnails', express.static(path.join(__dirname, 'thumbnails')));

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const thumbnailsDir = path.join(__dirname, 'thumbnails');
[uploadsDir, thumbnailsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer configuration
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('画像ファイルのみアップロード可能です'));
  }
});

// Google Sheets setup
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const credPath = path.join(__dirname, 'credentials', 'service-account.json');
  if (!fs.existsSync(credPath)) {
    throw new Error('credentials/service-account.json が見つかりません。SETUP.md を参照してください。');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Photos';
const HEADERS = ['id', 'filename', 'thumbnail', 'date', 'address', 'category', 'comment', 'lat', 'lng'];

async function ensureHeaderRow() {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:I1`
    });
    const rows = res.data.values;
    if (!rows || rows.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] }
      });
      console.log('ヘッダー行を書き込みました');
    }
  } catch (err) {
    console.error('ヘッダー行の確認エラー:', err.message);
  }
}

// GET /api/photos - returns GeoJSON FeatureCollection
app.get('/api/photos', async (req, res) => {
  try {
    if (!SHEET_ID) {
      return res.json({ type: 'FeatureCollection', features: [] });
    }

    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:I`
    });

    const rows = result.data.values || [];
    const features = rows
      .filter(row => row[7] && row[8]) // must have lat and lng
      .map(row => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [parseFloat(row[8]), parseFloat(row[7])] // [lng, lat]
        },
        properties: {
          id: row[0] || '',
          filename: row[1] || '',
          thumbnail: row[2] || '',
          date: row[3] || '',
          address: row[4] || '',
          category: row[5] || '',
          comment: row[6] || '',
          lat: parseFloat(row[7]),
          lng: parseFloat(row[8])
        }
      }));

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('GET /api/photos エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload - upload photo, generate thumbnail, extract EXIF date
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルがありません' });
    }

    const filename = req.file.filename;
    const filePath = path.join(uploadsDir, filename);
    const ext = path.extname(filename);
    const thumbnailFilename = `thumb_${filename.replace(ext, '')}.jpg`;
    const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);

    // Generate 300px wide thumbnail
    await sharp(filePath)
      .resize(300, null, { withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(thumbnailPath);

    // Extract EXIF date or use file mtime
    let date;
    try {
      const exif = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate'] });
      if (exif && (exif.DateTimeOriginal || exif.CreateDate)) {
        const d = exif.DateTimeOriginal || exif.CreateDate;
        date = d instanceof Date ? d.toISOString().split('T')[0] : String(d).split(' ')[0];
      }
    } catch (exifErr) {
      console.warn('EXIF読み取りエラー:', exifErr.message);
    }

    if (!date) {
      const stat = fs.statSync(filePath);
      date = stat.mtime.toISOString().split('T')[0];
    }

    res.json({ filename, thumbnail: thumbnailFilename, date });
  } catch (err) {
    console.error('POST /api/upload エラー:', err);
    // Clean up on error
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photos - save photo metadata to Google Sheets
app.post('/api/photos', async (req, res) => {
  try {
    const { filename, thumbnail, date, address, category, comment, lat, lng } = req.body;

    if (!filename || !lat || !lng) {
      return res.status(400).json({ error: '必須フィールドが不足しています (filename, lat, lng)' });
    }

    const id = uuidv4();
    const row = [id, filename, thumbnail || '', date || '', address || '', category || '', comment || '', String(lat), String(lng)];

    if (!SHEET_ID) {
      console.warn('GOOGLE_SHEET_ID が設定されていません。データは保存されません。');
      return res.json({ id, message: 'GOOGLE_SHEET_ID未設定のため保存スキップ' });
    }

    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:I`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    res.json({ id });
  } catch (err) {
    console.error('POST /api/photos エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

// Error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `アップロードエラー: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// Start server
app.listen(PORT, async () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
  await ensureHeaderRow();
});
