// Cuts the film together from the recorded take and the spoken lines.
// Adapted from the author's own earlier tooling. Shots are named by the marks in the take.
//
//   node compose.mjs plan                 works out the timeline from the voices, writes timeline.json
//   node compose.mjs stills 3,20,55       renders single frames at those seconds, to check the look
//   node compose.mjs render <out.mp4>     renders the whole film (needs mix.wav from mix.py)

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = join(homedir(), '.baton', 'video');
const TAKE = process.env.FILM_TAKE ?? 'take1';
const FPS = 30;
const SCALE = 1.5; // recorded layout is 1280 wide, the film is 1920 wide
const SCRIPT = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'));
const LINES = Object.fromEntries(SCRIPT.lines.map((line) => [line.id, line]));
const WHO = { maya: 'Maya', sam: 'Sam', narrator: '' };

const log = JSON.parse(readFileSync(join(HOME, 'takes', TAKE, 'take.json'), 'utf8'));
const FRAMES = log.frames;
const MARKS = Object.fromEntries(log.marks.map((m) => [m.name, m]));

/** The last frame shown at or before this moment. The screencast only sends frames when the page changes. */
function frameAt(t) {
  let low = 0;
  let high = FRAMES.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (FRAMES[mid][1] <= t) low = mid;
    else high = mid - 1;
  }
  return FRAMES[low][0];
}

const WIDE = [640, 360, 1];

/** A camera position that frames one named element of a mark, clear of the caption. */
function on(markName, rect, { zoom, dy = 26, padding = 1.12 } = {}) {
  const r = MARKS[markName].rects[rect];
  if (!r) throw new Error(`mark ${markName} has no rect ${rect}`);
  const fit = Math.min(1280 / (r.w * padding), 540 / (r.h * padding));
  return [r.x + r.w / 2, r.y + r.h / 2 + dy, zoom ?? Math.max(1, Math.min(2.1, fit))];
}

// ---- the film: what is on screen, and who speaks over it ----
// hold: a mark. holds: [[from, mark], ...]. clip: [first mark, last mark], played across the shot.
// camera: [seconds from shot start (negative counts from its end, "50%" is part way), x, y, zoom].

const SHOTS = [
  { id: 'open', chapter: 'The problem', hold: 'baton', say: ['m1'], lead: 0.45, tail: 0.3, fadeIn: 0.5,
    camera: [[0, ...WIDE], [-0.01, ...on('baton', 'art', { zoom: 1.32, dy: 40 })]] },
  { id: 'rent', chapter: 'The problem', hold: 'baton', say: ['m2'], lead: 0.1, tail: 0.3, note: 'Your rent is going up',
    camera: [[0, ...on('baton', 'art', { zoom: 1.32, dy: 40 })], [-0.01, ...on('baton', 'art', { zoom: 1.42, dy: 40 })]] },
  { id: 'wait', chapter: 'The problem', hold: 'compare', say: ['m3'], lead: 0.2, tail: 0.35,
    camera: [[0, ...on('compare', 'table', { zoom: 1.0, dy: 30 })], [-0.01, ...on('compare', 'table', { zoom: 1.08, dy: 30 })]] },

  { id: 'idea', chapter: 'The idea', clip: ['home', 'home-end'], say: ['n1'], lead: 0.2, tail: 0.3,
    camera: [[0, ...WIDE], [-0.01, 470, 330, 1.14]] },
  { id: 'nft', chapter: 'The idea', hold: 'baton', say: ['n2'], lead: 0.2, tail: 0.3,
    camera: [[0, ...on('baton', 'art', { zoom: 1.3, dy: 40 })], [-0.01, ...on('baton', 'info', { zoom: 1.28, dy: -30 })]] },
  { id: 'runs', chapter: 'The idea', clip: ['home', 'home-end'], say: ['n3'], lead: 0.15, tail: 0.3,
    camera: [[0, ...on('home', 'track', { zoom: 2.02, dy: 16 })], [-0.01, ...on('home', 'track', { zoom: 2.1, dy: 16 })]] },

  // The form above the list has nothing to do with this line, so it is covered.
  { id: 'offer', chapter: 'See it work', hold: 'offers', say: ['s1'], lead: 0.2, tail: 0.3, maskTop: MARKS.offers.rects.offers.y - 66,
    camera: [[0, ...on('offers', 'offers', { zoom: 1.74, dy: -24 })], [-0.01, ...on('offers', 'offers', { zoom: 1.86, dy: -24 })]] },
  { id: 'press', chapter: 'See it work', clip: ['exit-ready', 'exit-click'], say: ['m4'], lead: 0.2, tail: 0.15, min: 2.1,
    camera: [[0, ...on('exit-ready', 'exit', { zoom: 1.35, dy: 10 })], [-0.01, ...on('exit-ready', 'button', { zoom: 1.75, dy: 30 })]] },
  { id: 'click', chapter: 'See it work', clip: ['exit-click', 'sold-arrived'], dur: 2.1,
    camera: [[0, ...on('exit-ready', 'button', { zoom: 1.75, dy: 30 })], [-0.01, ...on('exit-ready', 'exit', { zoom: 1.2, dy: 10 })]] },
  { id: 'sold', chapter: 'See it work', hold: 'sold-top', say: ['n4'], lead: 0.45, tail: 0.3,
    camera: [[0, ...WIDE], ['28%', 640, 360, 1.04], ['62%', ...on('sold-top', 'balance', { zoom: 1.9, dy: 60 })], [-0.01, ...on('sold-top', 'art', { zoom: 1.18, dy: 40 })]] },
  { id: 'validator', chapter: 'See it work', hold: 'sold', say: ['n5'], lead: 0.2, tail: 0.5,
    camera: [[0, ...on('sold', 'result', { zoom: 1.4, dy: 0 })], [-0.01, ...on('sold', 'validator', { zoom: 2, dy: 12 })]] },
  { id: 'title', chapter: 'See it work', hold: 'title', dur: 2.4,
    camera: [[0, ...on('title', 'legs', { zoom: 1.12, dy: 30 })], [-0.01, ...on('title', 'legs', { zoom: 1.2, dy: 30 })]] },

  { id: 'question', chapter: 'Can the seller get back in?', hold: 'closed', say: ['n6'], lead: 0.25, tail: 0.25,
    camera: [[0, ...on('closed', 'door', { zoom: 1.32, dy: 0 })], [-0.01, ...on('closed', 'door', { zoom: 1.42, dy: 0 })]] },
  { id: 'tried', chapter: 'Can the seller get back in?', clip: ['closed', 'dead-key'], say: ['m5'], lead: 0.15, tail: 0.5,
    camera: [[0, ...on('closed', 'door', { zoom: 1.42, dy: 0 })], ['50%', ...on('closed', 'reason', { zoom: 1.7, dy: 20 })], [-0.01, ...on('dead-key', 'dead', { zoom: 1.75, dy: 0 })]] },
  { id: 'verify', chapter: 'Can the seller get back in?', holds: [[0, 'verify'], [0.68, 'verify-all']], say: ['n7'], lead: 0.2, tail: 0.5,
    camera: [[0, ...on('verify', 'first', { zoom: 1.5, dy: 0 })], ['67.9%', ...on('verify', 'first', { zoom: 1.66, dy: 0 })], ['68%', ...on('verify-all', 'checks', { zoom: 1, dy: 20 })], [-0.01, ...on('verify-all', 'last', { zoom: 1.4, dy: 0 })]] },

  { id: 'every', chapter: 'Why it matters', hold: 'home', say: ['n8'], lead: 0.25, tail: 0.35,
    camera: [[0, 600, 340, 1.2], [-0.01, ...WIDE]] },
  { id: 'sam', chapter: 'Why it matters', hold: 'board', say: ['s2'], lead: 0.15, tail: 0.3,
    camera: [[0, ...on('board', 'board', { zoom: 1.03, dy: -60 })], [-0.01, ...on('board', 'board', { zoom: 1.09, dy: -60 })]] },
  { id: 'maya', chapter: 'Why it matters', hold: 'sold', say: ['m6'], lead: 0.15, tail: 0.85, fadeOut: 0.7,
    camera: [[0, ...on('sold', 'validator', { zoom: 1.6, dy: 12 })], [-0.01, ...on('sold', 'result', { zoom: 1.36, dy: 0 })]] },
  { id: 'end', card: true, dur: 4.6, badge: 0 },
];

// ---- timeline ----

function report() {
  const path = join(HOME, 'voices.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/** The take with the fewest wrong words. Among equals, the one with the most life in its pitch. */
function chooseTake(id, voices) {
  const overrides = existsSync(join(HERE, 'choice.json')) ? JSON.parse(readFileSync(join(HERE, 'choice.json'), 'utf8')) : {};
  if (overrides[id] !== undefined) return overrides[id];
  const options = Object.entries(voices)
    .filter(([key]) => key.startsWith(`${id}.`))
    .map(([key, value]) => ({ take: Number(key.split('.')[1]), ...value }));
  if (!options.length) return null;
  options.sort((a, b) => a.wer - b.wer || b.pitch_spread_semitones - a.pitch_spread_semitones);
  return options[0].take;
}

function plan() {
  const voices = report();
  let clock = 0;
  const lines = [];
  const missing = [];
  const shots = SHOTS.map((shot) => {
    const start = clock;
    let at = start + (shot.lead ?? 0);
    for (const [i, id] of (shot.say ?? []).entries()) {
      const chosen = chooseTake(id, voices);
      let seconds = LINES[id].text.length / 14; // an estimate until the line has been spoken
      if (chosen === null) missing.push(id);
      else seconds = voices[`${id}.${chosen}`].seconds;
      lines.push({ id, take: chosen, at: Number(at.toFixed(3)), seconds, shot: shot.id, voice: LINES[id].voice, text: LINES[id].text });
      at += seconds + (i < shot.say.length - 1 ? shot.gap ?? 0.4 : 0);
    }
    const end = shot.say ? Math.max(at + (shot.tail ?? 0.3), start + (shot.min ?? 0)) : start + shot.dur;
    clock = end;
    return { ...shot, start, end };
  });
  const startOf = (id) => shots.find((s) => s.id === id).start;
  const cues = { idea: startOf('idea'), work: startOf('offer'), sold: startOf('sold'), safe: startOf('question'), matters: startOf('every'), end: startOf('end') };
  const timeline = { duration: clock, lines, cues, missing };
  writeFileSync(join(HERE, 'timeline.json'), JSON.stringify(timeline, null, 1));
  console.log(`duration ${clock.toFixed(1)}s, ${lines.length} lines, missing voices: ${missing.join(' ') || 'none'}`);
  console.log(shots.map((s) => `${s.id}@${s.start.toFixed(1)}`).join(' '));
  return { shots, timeline };
}

// ---- what the screen shows at a moment ----

const smooth = (p) => p * p * (3 - 2 * p);

function cameraAt(shot, t) {
  const length = shot.end - shot.start;
  const when = (at) => (typeof at === 'string' ? (parseFloat(at) / 100) * length : at < 0 ? length + at : at);
  const keys = shot.camera.map(([at, x, y, zoom]) => [when(at), x, y, zoom]);
  const local = t - shot.start;
  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (local >= keys[i][0] && local <= keys[i + 1][0]) {
      a = keys[i];
      b = keys[i + 1];
      break;
    }
  }
  if (local <= keys[0][0]) b = a;
  if (local >= keys[keys.length - 1][0]) a = b;
  const span = b[0] - a[0];
  const p = span > 0 ? smooth(Math.min(1, Math.max(0, (local - a[0]) / span))) : 0;
  const zoom = Math.exp(Math.log(a[3]) + (Math.log(b[3]) - Math.log(a[3])) * p);
  const cx = (a[1] + (b[1] - a[1]) * p) * SCALE;
  const cy = (a[2] + (b[2] - a[2]) * p) * SCALE;
  const tx = Math.min(0, Math.max(1920 - 1920 * zoom, 960 - zoom * cx));
  const ty = Math.min(0, Math.max(1080 - 1080 * zoom, 540 - zoom * cy));
  return { tx: Number(tx.toFixed(2)), ty: Number(ty.toFixed(2)), zoom: Number(zoom.toFixed(4)) };
}

const frameFile = (n) => pathToFileURL(join(HOME, 'takes', TAKE, 'frames', `${String(n).padStart(6, '0')}.jpg`)).href;

function sourceAt(shot, t) {
  if (shot.hold) return frameFile(frameAt(MARKS[shot.hold].t));
  const p = (t - shot.start) / (shot.end - shot.start);
  if (shot.holds) {
    const [, name] = shot.holds.findLast(([from]) => p >= from) ?? shot.holds[0];
    return frameFile(frameAt(MARKS[name].t));
  }
  const [first, last] = shot.clip;
  const from = MARKS[first].t;
  const to = MARKS[last].t;
  return frameFile(frameAt(from + (to - from) * p));
}

/** Splits a line into pieces short enough to read at a glance, timed by their length. */
function chunks(line) {
  const sentences = line.text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [line.text];
  const merged = [];
  for (const piece of sentences) {
    const last = merged[merged.length - 1];
    if (last && (last + ' ' + piece).length <= 58) merged[merged.length - 1] = `${last} ${piece}`;
    else merged.push(piece);
  }
  const total = merged.reduce((sum, piece) => sum + piece.length, 0);
  let at = line.at;
  return merged.map((text) => {
    const seconds = (line.seconds * text.length) / total;
    const chunk = { text: text.replaceAll("'", '’'), from: at, to: at + seconds };
    at += seconds;
    return chunk;
  });
}

function stateAt(shots, captions, t) {
  const shot = shots.find((s) => t >= s.start && t < s.end) ?? shots[shots.length - 1];
  const state = { tx: 0, ty: 0, zoom: 1, badge: shot.badge ?? 1, fade: 0, card: 0, captionOpacity: 0, chapter: shot.chapter ?? '', note: '', noteShown: 0 };
  if (shot.card) {
    state.card = Math.min(1, (t - shot.start) / 0.7);
    state.fade = Number(Math.max(0, (t - (shot.end - 0.9)) / 0.9).toFixed(3));
    state.badge = 0;
    state.chapter = '';
    const last = shots.findLast((s) => !s.card);
    state.src = sourceAt(last, last.end - 0.01);
    Object.assign(state, cameraAt(last, last.end - 0.01));
    return state;
  }
  state.src = sourceAt(shot, t);
  Object.assign(state, cameraAt(shot, t));
  if (shot.fadeIn) state.fade = Math.max(state.fade, 1 - (t - shot.start) / shot.fadeIn);
  if (shot.fadeOut) state.fade = Math.max(state.fade, 1 - (shot.end - t) / shot.fadeOut);
  state.fade = Number(Math.max(0, Math.min(1, state.fade)).toFixed(3));
  if (shot.maskTop) state.maskTop = shot.maskTop * SCALE;
  if (shot.note) {
    state.note = shot.note;
    state.noteShown = Number(smooth(Math.min(1, Math.max(0, (t - shot.start - 0.15) / 0.45))).toFixed(3));
  }
  const caption = captions.find((c) => t >= c.from - 0.06 && t < c.to + 0.16);
  if (caption) {
    state.text = caption.text;
    state.who = caption.who;
    const rise = Math.min(1, (t - (caption.from - 0.06)) / 0.14);
    const fall = Math.min(1, (caption.to + 0.16 - t) / 0.16);
    state.captionOpacity = Number(Math.min(rise, fall).toFixed(3));
  }
  return state;
}

// ---- render ----

async function openStage() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--force-color-profile=srgb', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(HERE, 'stage.html')).href);
  await page.evaluate(() => window.ready());
  return { browser, page };
}

const command = process.argv[2] ?? 'plan';
const { shots, timeline } = plan();
const captions = timeline.lines.flatMap((line) => chunks(line).map((chunk) => ({ ...chunk, who: WHO[line.voice] })));

if (command === 'stills') {
  const out = join(HOME, 'stills');
  mkdirSync(out, { recursive: true });
  const { browser, page } = await openStage();
  for (const second of process.argv[3].split(',').map(Number)) {
    await page.evaluate((s) => window.draw(s), stateAt(shots, captions, second));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `t${String(second).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 });
    console.log(second);
  }
  await browser.close();
}

if (command === 'render') {
  const output = process.argv[3];
  const from = Number(process.env.RENDER_FROM ?? 0);
  const to = Number(process.env.RENDER_TO ?? timeline.duration);
  const first = Math.floor(from * FPS);
  const total = Math.ceil(to * FPS);
  const ff = spawn(process.env.FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', 'pipe:0',
    '-ss', String(from), '-t', String(to - from), '-i', join(HOME, 'mix.wav'),
    '-map', '0:v', '-map', '1:a',
    '-vf', 'unsharp=5:5:0.45:5:5:0,scale=out_range=tv:out_color_matrix=bt709:flags=lanczos,format=yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high', '-x264-params', 'deblock=-1,-1:aq-mode=3',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', output,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const { browser, page } = await openStage();
  let lastKey = '';
  let buffer = null;
  const started = Date.now();
  for (let f = first; f < total; f += 1) {
    const state = stateAt(shots, captions, f / FPS);
    const key = JSON.stringify(state);
    if (key !== lastKey) {
      await page.evaluate((s) => window.draw(s), state);
      buffer = await page.screenshot({ type: 'png' });
      lastKey = key;
    }
    if (!ff.stdin.write(buffer)) await once(ff.stdin, 'drain');
    if (f % 150 === 0) console.log(`${f}/${total} frames, ${Math.round((Date.now() - started) / 1000)}s`);
  }
  ff.stdin.end();
  await once(ff, 'close');
  await browser.close();
  console.log(`done: ${output}`);
}
