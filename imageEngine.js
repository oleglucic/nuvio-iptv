const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

async function getPremiumPoster(cId, logoUrl, fallbackName) {
    const cachePath = path.join(cacheDir, `${cId}.png`);
    
    // Serve instantly if already compiled on disk
    if (fs.existsSync(cachePath)) return cachePath;

    try {
        if (!logoUrl || !logoUrl.startsWith('http')) throw new Error("Invalid URL");

        // Download source artwork into memory buffer
        const response = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 7000 });
        const logoBuffer = Buffer.from(response.data);

        // Layer 1: Ambient Blurred Backdrop (600x900 Stremio spec)
        const background = await sharp(logoBuffer)
            .resize(600, 900, { fit: 'cover' })
            .blur(35)
            .linear(0.55, 0) // Subtle dark exposure overlay
            .toBuffer();

        // Layer 2: Clean, proportion-locked crisp foreground logo
        const foreground = await sharp(logoBuffer)
            .resize(440, 440, { fit: 'inside' })
            .toBuffer();

        // Flatten layers into a high-performance production PNG asset
        await sharp(background)
            .composite([{ input: foreground, gravity: 'center' }])
            .toFile(cachePath);

        return cachePath;
    } catch (err) {
        // High-Contrast SVG Fallback Vector Graphic generation for dead/missing links
        const cleanName = fallbackName ? fallbackName.toUpperCase() : "LIVE TV";
        const fallbackSvg = `
            <svg width="600" height="900" xmlns="http://www.w3.org/2000/svg">
                <rect width="100%" height="100%" fill="#0f172a"/>
                <rect x="20" y="20" width="560" height="860" rx="15" fill="none" stroke="#1e293b" stroke-width="4"/>
                <circle cx="300" cy="400" r="80" fill="#1e293b"/>
                <text x="300" y="415" font-family="sans-serif" font-size="50" font-weight="bold" fill="#6366f1" text-anchor="middle">📺</text>
                <text x="300" y="580" font-family="sans-serif" font-size="36" font-weight="bold" fill="#94a3b8" text-anchor="middle">${cleanName}</text>
            </svg>
        `;
        await sharp(Buffer.from(fallbackSvg)).toFile(cachePath);
        return cachePath;
    }
}

module.exports = { getPremiumPoster };
