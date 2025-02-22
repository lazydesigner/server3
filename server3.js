const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { exec } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Use memory storage to avoid initial disk write
const storage = multer.memoryStorage();
const upload = multer({ storage });

const EXIFTOOL_PATH = 'F:\\firsthaulers\\exiftool-13.21_64\\exiftool.exe';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const unlinkWithRetry = async (filePath, retries = 5, delayMs = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.access(filePath);
      await fs.unlink(filePath);
    //   console.log(`Deleted: ${filePath}`);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // console.log(`File already deleted: ${filePath}`);
        return true;
      }
      if (error.code === 'EPERM' && i < retries - 1) {
        // console.log(`EPERM on ${filePath}, retrying (${i + 1}/${retries}) after ${delayMs}ms...`);
        await delay(delayMs);
      } else {
        console.warn(`Failed to delete ${filePath} after ${retries} attempts:`, error);
        return false;
      }
    }
  }
};

const ensureDirectories = async () => {
  const dirs = ['temp', 'downloads']; // No 'uploads' needed with memory storage
  for (const dir of dirs) {
    const dirPath = path.resolve(dir);
    try {
      await fs.mkdir(dirPath, { recursive: true });
    //   console.log(`Directory ${dirPath} ensured`);
    } catch (error) {
      console.error(`Failed to create directory ${dirPath}:`, error);
    }
  }
};

const runExifTool = (command) => {
  return new Promise((resolve, reject) => {
    const fullCommand = `"${EXIFTOOL_PATH}" ${command}`;
    // console.log('Executing exiftool:', fullCommand);
    exec(fullCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('exiftool stderr:', stderr);
        return reject(new Error(`exiftool error: ${stderr || error.message}`));
      }
    //   console.log('exiftool stdout:', stdout);
      resolve(stdout);
    });
  });
};

app.post('/api/process-image', upload.single('image'), async (req, res) => {
//   console.log('Received request at /api/process-image');
  let tempPath, outputPath;
  try {
    // console.log('Request body:', req.body);
    // console.log('Uploaded file:', req.file);

    const { title, description, latitude, longitude, tags, comments, format } = req.body;
    const timestamp = Date.now();
    tempPath = path.resolve(`temp/temp-${timestamp}.${format}`);
    outputPath = path.resolve(`downloads/output-${timestamp}.${format}`);

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // console.log('Processing image with sharp to:', tempPath);
    let image = sharp(req.file.buffer); // Use buffer directly from memory
    if (format === 'webp') {
      await image.webp().toFile(tempPath);
    } else if (format === 'png') {
      await image.png().toFile(tempPath);
    } else {
      await image.jpeg().toFile(tempPath);
    }
    // console.log('Sharp processing complete');

    try {
      await fs.access(tempPath);
    //   console.log(`File exists after sharp: ${tempPath}`);
    } catch (error) {
      console.error(`File not found after sharp: ${tempPath}`, error);
      throw new Error(`Failed to create temp file: ${tempPath}`);
    }

    const tagList = tags ? tags.split(',').map((tag) => `-Keywords=${tag.trim()}`).join(' ') : '';
    const exifCommand = `-overwrite_original \
      -Title="${title || 'Untitled'}" \
      -Description="${description || ''}" \
      ${tagList} \
      -Comment="${comments || ''}" \
      -GPSLatitude="${Math.abs(lat)}" \
      -GPSLatitudeRef="${lat >= 0 ? 'N' : 'S'}" \
      -GPSLongitude="${Math.abs(lon)}" \
      -GPSLongitudeRef="${lon >= 0 ? 'E' : 'W'}" \
      "${tempPath}" -o "${outputPath}"`;
    await runExifTool(exifCommand);
    // console.log('Metadata embedded with exiftool');

    const metadataCommand = `-j "${outputPath}"`;
    const metadataOutput = await runExifTool(metadataCommand);
    const metadata = JSON.parse(metadataOutput)[0];
    // console.log('Extracted metadata:', metadata);

    const fileBuffer = await fs.readFile(outputPath);
    const base64File = fileBuffer.toString('base64');
    // console.log('File converted to base64, length:', base64File.length);

    const response = {
      file: {
        data: base64File,
        filename: `processed-image-${Date.now()}.${format}`,
        mimetype: `image/${format === 'jpg' ? 'jpeg' : format}`,
      },
      metadata,
      cleanupFailed: false, // Will be updated in finally block if needed
    };
    // console.log('Sending response:', { file: { filename: response.file.filename, mimetype: response.file.mimetype, dataLength: response.file.data.length }, metadata });
    res.json(response);
  } catch (error) {
    console.error('Backend error:', error);
    res.status(500).json({ error: error.message || 'Processing failed', cleanupFailed: false });
  } finally {
    const paths = [tempPath, outputPath].filter(Boolean); // No inputPath with memory storage
    // console.log('Cleaning up files:', paths);
    await delay(1000);
    let cleanupFailed = false;
    await Promise.all(
      paths.map(async (p) => {
        const deleted = await unlinkWithRetry(p, 5, 1000);
        if (!deleted) cleanupFailed = true;
      })
    );
    // console.log('Files cleaned up');
    if (cleanupFailed) {
      console.warn('Cleanup failed for some files; they will remain in temp or downloads directories.');
      res.status(200).json(Object.assign(res.body || {}, { cleanupFailed: true }));
    }
  }
});

ensureDirectories().then(() => {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});