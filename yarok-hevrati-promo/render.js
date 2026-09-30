// Renders promo.html frame-by-frame with headless Chromium and encodes MP4 with ffmpeg.
// Usage: node render.js [square|story|all]
//   square -> 1080x1080 (Facebook + Instagram feed)
//   story  -> 1080x1920 (Instagram Reels/Stories, Facebook Stories)
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const FPS = 30;
const OUT_DIR = __dirname;
const FRAMES_DIR = process.env.FRAMES_DIR || path.join(OUT_DIR, '.frames');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const FORMATS = {
  square: { w: 1080, h: 1080, file: 'yarok-hevrati-promo-1080x1080.mp4' },
  story:  { w: 1080, h: 1920, file: 'yarok-hevrati-promo-1080x1920.mp4' },
};

async function render(name) {
  const fmt = FORMATS[name];
  const frames = path.join(FRAMES_DIR, name);
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: fmt.w, height: fmt.h }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(OUT_DIR, 'promo.html') + '?render=1');
  await page.evaluate(() => document.fonts.ready);
  const total = await page.evaluate(() => window.TOTAL);
  const n = Math.round(total * FPS);

  for (let i = 0; i < n; i++) {
    await page.evaluate(t => window.seek(t), i / FPS);
    await page.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`), type: 'png' });
    if (i % 60 === 0) console.log(`${name}: frame ${i}/${n}`);
  }
  await browser.close();

  const out = path.join(OUT_DIR, fmt.file);
  execFileSync(FFMPEG, [
    '-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest',
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'slow', '-r', String(FPS), '-g', '60',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', out,
  ], { stdio: 'inherit' });
  fs.rmSync(frames, { recursive: true, force: true });
  console.log('wrote', out);
}

(async () => {
  const which = process.argv[2] || 'all';
  const list = which === 'all' ? Object.keys(FORMATS) : [which];
  for (const f of list) await render(f);
})().catch(e => { console.error(e); process.exit(1); });
