import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");

const introPage = path.join(publicDir, "assets", "intro", "page-01.png");
const cardFiles = [
  path.join(publicDir, "assets", "cards", "emberroot_bastion.png"),
  path.join(publicDir, "assets", "cards", "aionroot_observatory.png"),
  path.join(publicDir, "assets", "cards", "verdant_citadel.png"),
];

const faviconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Doctrine">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="64%">
      <stop offset="0" stop-color="#17335d"/>
      <stop offset="0.58" stop-color="#0b1628"/>
      <stop offset="1" stop-color="#060913"/>
    </radialGradient>
    <linearGradient id="sigil" x1="16" y1="11" x2="49" y2="54" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f4d48a"/>
      <stop offset="0.45" stop-color="#57d8ff"/>
      <stop offset="1" stop-color="#b58b4f"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <circle cx="32" cy="32" r="24" fill="none" stroke="#c6a35a" stroke-width="2.4"/>
  <circle cx="32" cy="32" r="17" fill="none" stroke="#57d8ff" stroke-width="1.4" opacity="0.75"/>
  <path d="M32 8v12M32 44v12M8 32h12M44 32h12" stroke="#c6a35a" stroke-width="2" stroke-linecap="round"/>
  <path d="M21 16h11.5c8.8 0 15.5 6.4 15.5 16s-6.7 16-15.5 16H21V16Zm8 7.4v17.2h3.3c4.6 0 7.6-3.4 7.6-8.6s-3-8.6-7.6-8.6H29Z" fill="url(#sigil)"/>
  <path d="M18 48 46 16" stroke="#eef9ff" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
</svg>
`;

const maskIconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path fill="#000" d="M32 4a28 28 0 1 0 0 56 28 28 0 0 0 0-56Zm0 7a21 21 0 1 1 0 42 21 21 0 0 1 0-42Zm-11 5v32h11.5C41.3 48 48 41.6 48 32S41.3 16 32.5 16H21Zm8 7.4h3.3c4.6 0 7.6 3.4 7.6 8.6s-3 8.6-7.6 8.6H29V23.4Z"/>
</svg>
`;

function svgBuffer(svg) {
  return Buffer.from(svg.trim());
}

async function makeCard(input, width, rotateDegrees) {
  const resized = await sharp(input)
    .resize({ width, height: Math.round(width * 1.4), fit: "cover", position: "top" })
    .png()
    .toBuffer();

  const border = svgBuffer(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(width * 1.4)}" viewBox="0 0 ${width} ${Math.round(width * 1.4)}">
      <rect x="4" y="4" width="${width - 8}" height="${Math.round(width * 1.4) - 8}" rx="18" fill="none" stroke="#f2d28a" stroke-width="8" opacity="0.9"/>
      <rect x="12" y="12" width="${width - 24}" height="${Math.round(width * 1.4) - 24}" rx="12" fill="none" stroke="#07101d" stroke-width="4" opacity="0.55"/>
    </svg>
  `);

  return sharp(resized)
    .composite([{ input: border, left: 0, top: 0 }])
    .rotate(rotateDegrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function generateSocialCard() {
  const background = await sharp(introPage)
    .resize(1200, 630, { fit: "cover", position: "top" })
    .modulate({ brightness: 0.74, saturation: 1.12 })
    .png()
    .toBuffer();

  const cards = await Promise.all([
    makeCard(cardFiles[0], 176, -5),
    makeCard(cardFiles[1], 188, 0),
    makeCard(cardFiles[2], 176, 5),
  ]);

  const overlay = svgBuffer(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="shade" x1="0" x2="1">
          <stop offset="0" stop-color="#04070e" stop-opacity="0.97"/>
          <stop offset="0.56" stop-color="#061020" stop-opacity="0.82"/>
          <stop offset="1" stop-color="#061020" stop-opacity="0.42"/>
        </linearGradient>
        <linearGradient id="line" x1="72" y1="448" x2="544" y2="448" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#56d8ff"/>
          <stop offset="1" stop-color="#f1c978"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.45"/>
        </filter>
      </defs>
      <rect width="1200" height="630" fill="url(#shade)"/>
      <rect x="72" y="68" width="604" height="478" rx="24" fill="#061020" opacity="0.4" filter="url(#shadow)"/>
      <rect x="96" y="100" width="212" height="34" rx="17" fill="#102d46" stroke="#56d8ff" stroke-opacity="0.65"/>
      <text x="202" y="123" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="16" font-weight="800" fill="#dff8ff">ACTION RTS AUTOBATTLER</text>
      <text x="94" y="222" font-family="Georgia, 'Times New Roman', serif" font-size="84" font-weight="800" fill="#f8efe0">Doctrine</text>
      <text x="98" y="278" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="31" font-weight="800" fill="#a9eaff">Draft armies from broken worlds.</text>
      <text x="98" y="318" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="31" font-weight="800" fill="#fff4db">Break the next one.</text>
      <rect x="98" y="358" width="470" height="3" fill="url(#line)"/>
      <text x="98" y="407" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="24" fill="#e8edf7">Build a doctrine of structures, spells, and commands.</text>
      <text x="98" y="442" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="24" fill="#e8edf7">Drag cards into battle. Command the Wizard.</text>
      <text x="98" y="506" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="20" font-weight="800" fill="#f2d28a">PLAY FREE IN BROWSER</text>
      <circle cx="760" cy="104" r="70" fill="none" stroke="#56d8ff" stroke-width="3" opacity="0.34"/>
      <circle cx="1012" cy="506" r="88" fill="none" stroke="#f2d28a" stroke-width="3" opacity="0.24"/>
    </svg>
  `);

  const sparkles = svgBuffer(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <g fill="#dff8ff" opacity="0.88">
        <path d="M709 96 716 115 735 122 716 129 709 148 702 129 683 122 702 115Z"/>
        <path d="M1082 174 1087 188 1101 193 1087 198 1082 212 1077 198 1063 193 1077 188Z"/>
        <path d="M965 503 970 517 984 522 970 527 965 541 960 527 946 522 960 517Z"/>
      </g>
    </svg>
  `);

  await sharp({
    create: {
      width: 1200,
      height: 630,
      channels: 4,
      background: "#050913",
    },
  })
    .composite([
      { input: background, left: 0, top: 0 },
      { input: overlay, left: 0, top: 0 },
      { input: cards[0], left: 724, top: 204 },
      { input: cards[1], left: 838, top: 104 },
      { input: cards[2], left: 974, top: 192 },
      { input: sparkles, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(path.join(publicDir, "social-card.png"));
}

async function generateIcons() {
  const source = svgBuffer(faviconSvg);
  await writeFile(path.join(publicDir, "favicon.svg"), faviconSvg);
  await writeFile(path.join(publicDir, "mask-icon.svg"), maskIconSvg);
  await sharp(source).resize(32, 32).png().toFile(path.join(publicDir, "favicon-32.png"));
  await sharp(source).resize(192, 192).png().toFile(path.join(publicDir, "icon-192.png"));
  await sharp(source).resize(512, 512).png().toFile(path.join(publicDir, "icon-512.png"));
  await sharp(source).resize(180, 180).png().toFile(path.join(publicDir, "apple-touch-icon.png"));
}

await generateIcons();
await generateSocialCard();

console.log("Generated public favicon/app icons and social-card.png");
