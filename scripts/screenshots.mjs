// Regenerates the README screenshots (docs/screenshots) with headless Chrome:
//   npm run dev            (in another terminal)
//   npm run screenshots
// Uses a fresh browser profile (your takes and songs are untouched) and drives the app through the
// dev-only window.recorder hook, with the demo voice and a generated beat. The animated GIF needs
// ffmpeg on the PATH (skipped otherwise). Chrome/Edge is found automatically or via CHROME_PATH.
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'docs/screenshots';
const TMP = mkdtempSync(join(tmpdir(), 'recorder-shots-'));
const FRAMES = join(TMP, 'frames');
const URL = process.env.APP_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });
mkdirSync(FRAMES, { recursive: true });

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('No Chrome/Edge found: set CHROME_PATH.');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: join(TMP, 'profile'),
  args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-color-profile=srgb'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Screenshot of an element with some breathing room around it. */
async function shoot(pg, selector, path, pad = 14) {
  const box = await (await pg.$(selector)).boundingBox();
  await pg.screenshot({ path, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
}
const log = (...a) => console.log('[shots]', ...a);

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
page.on('console', (m) => m.type() === 'error' && log('console error:', m.text()));
page.on('pageerror', (e) => log('page error:', e.message));
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.recorder && window.recorder.store.get().recordings !== undefined);
await sleep(800);

// --- 1. Hero: live pitch line on auto-tune (C major, 0 ms), with the intro captions -------------
await page.evaluate(() => {
  const { store } = window.recorder;
  store.set((s) => ({ source: 'demo', tuning: { ...s.tuning, enabled: true, root: 0, type: 'major', retuneMs: 0, harmony: [] } }));
});
await page.click('#listen');
await sleep(5600);
await page.screenshot({ path: `${OUT}/hero-live-autotune.png` });
log('hero');

// Animated GIF frames of the stage (roll) while singing.
const stage = await page.$('.stage');
for (let i = 0; i < 60; i++) {
  await stage.screenshot({ path: `${FRAMES}/f${String(i).padStart(3, '0')}.png` });
  await sleep(40);
}
log('gif frames');

// --- 2. Harmonizer ----------------------------------------------------------------------------
await page.evaluate(() => {
  window.recorder.store.set((s) => ({ tuning: { ...s.tuning, retuneMs: 30, harmony: ['thirdUp', 'fifthUp'], harmonyMix: 0.6 } }));
});
await sleep(5000);
await page.screenshot({ path: `${OUT}/harmonizer.png` });
log('harmonizer');

// --- 3. Hear myself (monitoring) readout in the Input section ----------------------------------
await page.evaluate(() => {
  window.recorder.store.set((s) => ({ input: { ...s.input, monitor: true }, tuning: { ...s.tuning, harmony: [] } }));
});
await sleep(2500);
await shoot(page, '#controls-col details.section:not([hidden])', `${OUT}/hear-myself.png`);
log('hear myself');
await page.evaluate(async () => {
  const { store, session } = window.recorder;
  store.set((s) => ({ input: { ...s.input, monitor: false } }));
  await session.stopLive();
});

// --- 4. Studio: a song with a generated beat and two vocal takes --------------------------------
await page.evaluate(async () => {
  const { store, session } = window.recorder;
  // A 16 s beat at 96 BPM: Am - F - C - G pads, bass and a four-on-the-floor kick.
  const sr = 48000, bpm = 96, beat = 60 / bpm, len = Math.round(sr * 16);
  const L = new Float32Array(len), R = new Float32Array(len);
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const bar = Math.floor(t / (beat * 4)) % 4;
    const ch = chords[bar];
    let pad = 0;
    for (const m of ch) for (let h = 1; h <= 4; h++) pad += Math.sin(2 * Math.PI * hz(m) * h * t) / (h * h);
    const bass = Math.sin(2 * Math.PI * hz(ch[0] - 12) * t);
    const tb = t % beat;
    const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-tb * 30)) * tb) * Math.exp(-tb * 9);
    const hat = ((Math.random() * 2 - 1) * Math.exp(-((t + beat / 2) % beat) * 60)) * 0.15;
    L[i] = 0.05 * pad + 0.18 * bass + 0.5 * kick + hat;
    R[i] = 0.05 * pad + 0.18 * bass + 0.5 * kick - hat;
  }
  const { encodeWavChannels } = await import('/src/audio/wav.ts');
  const file = new File([encodeWavChannels([L, R], sr)], 'Night Drive (beat).wav', { type: 'audio/wav' });
  session.importInstrumental(file, true);
  for (let i = 0; i < 100 && !store.get().detection; i++) await new Promise((r) => setTimeout(r, 100));
  session.applyDetectedKey();
  store.set((s) => ({ input: { ...s.input, countIn: false } }));
  // Two takes, recorded over the beat with the demo voice.
  for (const seconds of [9, 7]) {
    session.player.seek(seconds === 9 ? 0.5 : 2);
    await session.startLive(true);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await session.stopLive();
    await new Promise((r) => setTimeout(r, 1200));
  }
  const song = store.get().projects.find((p) => p.id === store.get().projectId);
  const vocals = song.tracks.filter((t) => t.kind === 'vocal');
  session.updateTrackMix(vocals[0].id, { name: 'Lead' });
  session.updateTrackMix(vocals[1].id, { name: 'Double', pan: -0.4, gainDb: -4 });
  session.applyFxPreset(vocals[0].id, 'dreamy');
  session.updateSongFx({ reverb: { preset: 'hall' } });
  session.setLoopRegion(2.5, 7.5);
  session.selectTrack(vocals[0].id);
  await new Promise((r) => setTimeout(r, 1500));
  session.player.seek(6.2);
  await session.player.play();
  await new Promise((r) => setTimeout(r, 900));
  session.player.pause();
});
await sleep(1500);
await page.evaluate(() => localStorage.setItem('recorder.tipsSeen', JSON.stringify(['song', 'beat', 'mixer', 'loop', 'keyShift'])));
await page.setViewport({ width: 1440, height: 1080, deviceScaleFactor: 2 });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.recorder && window.recorder.store.get().projects.length > 0);
await page.evaluate(async () => {
  const { store, session } = window.recorder;
  session.openProject(store.get().projects[0].id);
  for (let i = 0; i < 50 && !store.get().projectId; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 2000));
  session.player.seek(6.2);
  await session.player.play();
  await new Promise((r) => setTimeout(r, 900));
  session.player.pause();
});
await sleep(1500);
await page.screenshot({ path: `${OUT}/studio.png` });
log('studio');

// Inspector sections.
await page.evaluate(() => {
  document.getElementById('fx-panel').scrollIntoView();
  // Show one slider's value bubble, as while dragging.
  const ns = document.getElementById('fx-eqHigh').closest('.ns');
  ns.classList.add('show-bubble', 'is-dragging');
  ns.querySelector('.ns-bubble').textContent = ns.nextElementSibling.textContent;
});
await sleep(300);
await shoot(page, '#fx-panel', `${OUT}/effects.png`, 26);
await page.evaluate(() => document.getElementById('fx-eqHigh').closest('.ns').classList.remove('show-bubble', 'is-dragging'));
// Tablet: centre + inspector, takes in a drawer.
await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 2 });
await sleep(600);
await page.screenshot({ path: `${OUT}/tablet.png` });
await page.setViewport({ width: 1440, height: 1080, deviceScaleFactor: 2 });
await sleep(400);
await page.evaluate(() => document.getElementById('tuning-panel').scrollIntoView());
await sleep(300);
await shoot(page, '#tuning-panel', `${OUT}/autotune-panel.png`);
await shoot(page, '#tracks', `${OUT}/mixer.png`, 10);
log('panels');

// Note editing: the lead's notes as blobs, one moved up a semitone and selected.
const noteEdit = await page.evaluate(async () => {
  const { store, session } = window.recorder;
  const song = store.get().projects.find((p) => p.id === store.get().projectId);
  const lead = song.tracks.find((t) => t.name === 'Lead');
  session.selectTrack(lead.id);
  const notes = session.notesOf(session.takes.get(lead.takeId));
  const t = 5.4 - lead.offset;
  const index = Math.max(0, notes.findIndex((n) => n.end > t));
  session.seek(lead.offset + notes[Math.min(notes.length - 1, index + 1)].end);
  session.toggleNoteMode(true);
  session.selectNote(index);
  session.editNote(index, { shift: 1 });
  await new Promise((r) => setTimeout(r, 1200));
  return index;
});
await shoot(page, '.stage', `${OUT}/note-editing.png`, 0);
await page.evaluate(() => {
  const { session } = window.recorder;
  session.undo();
  session.toggleNoteMode(false);
});
log('note editing', noteEdit);

// --- 5. Phone --------------------------------------------------------------------------------
const phone = await browser.newPage();
await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await phone.goto(URL, { waitUntil: 'networkidle0' });
await phone.waitForFunction(() => window.recorder && window.recorder.store.get().projects.length > 0);
await phone.evaluate(async () => {
  const { store, session } = window.recorder;
  session.openProject(store.get().projects[0].id);
  for (let i = 0; i < 50 && !store.get().projectId; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500));
  session.player.seek(6.2);
  await session.player.play();
  await new Promise((r) => setTimeout(r, 900));
  session.player.pause();
});
await sleep(1200);
await phone.screenshot({ path: `${OUT}/phone-roll.png` });
await phone.evaluate(() => window.recorder.store.set({ mobileTab: 'controls' }));
await sleep(800);
await phone.screenshot({ path: `${OUT}/phone-controls.png` });
log('phone');

await browser.close();

try {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '8', '-i', join(FRAMES, 'f%03d.png'), '-vf',
    'scale=780:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', join(OUT, 'live-pitch-line.gif')]);
  log('gif');
} catch {
  log('ffmpeg not found: skipped the GIF');
}
rmSync(TMP, { recursive: true, force: true });
log('done');
