const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { exec } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
app.use(cors({ origin: 'http://localhost:3000', methods: ['POST'] }));
app.use(express.json());

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Path to exiftool
const EXIFTOOL_PATH = 'F:\\firsthaulers\\exiftool-13.21_64\\exiftool(-k).exe';

// Ensure directories exist
const ensureDirectories = async () => {
  const dirs = ['uploads', 'temp', 'downloads'];
  for (const dir of dirs) {
    const dirPath = path.resolve(dir);
    try {
      await fs.mkdir(dirPath, { recursive: true });
      console.log(`Directory ${dirPath} ensured`);
    } catch (error) {
      console.error(`Failed to create directory ${dirPath}:`, error);
    }
  }
};

// Run exiftool commands
const runExifTool = (command) => {
  return new Promise((resolve, reject) => {
    const fullCommand = `"${EXIFTOOL_PATH}" ${command}`;
    console.log('Executing exiftool:', fullCommand);
    exec(fullCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('exiftool stderr:', stderr);
        return reject(new Error(`exiftool error: ${stderr || error.message}`));
      }
      resolve(stdout);
    });
  });
};

// API to process image and add metadata
app.post('/api/process-image', upload.single('image'), async (req, res) => {
  try {
    console.log('Request body:', req.body);
    console.log('Uploaded file:', req.file);

    const { title, description, latitude, longitude, tags, comments, format } = req.body;
    const inputPath = req.file.path;
    const tempPath = path.resolve(`temp/temp-${Date.now()}.${format}`);
    const outputPath = path.resolve(`downloads/output-${Date.now()}.${format}`);

    // Validate latitude and longitude
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // Convert image to desired format using sharp
    let image = sharp(inputPath);
    if (format === 'webp') {
      await image.webp().toFile(tempPath);
    } else if (format === 'png') {
      await image.png().toFile(tempPath);
    } else {
      await image.jpeg().toFile(tempPath); // Default to JPG
    }

    // Prepare exiftool command with metadata
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

    // Execute exiftool to embed metadata
    await runExifTool(exifCommand);

    // Send file back to client
    res.download(outputPath, async () => {
      // Clean up files
      await Promise.all([
        fs.unlink(inputPath),
        fs.unlink(tempPath),
        fs.unlink(outputPath),
      ]).catch((err) => console.error('Cleanup error:', err));
    });
  } catch (error) {
    console.error('Backend error:', error);
    res.status(500).json({ error: error.message || 'Processing failed' });
  }
});

// Ensure directories are created before starting the server
ensureDirectories().then(() => {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});