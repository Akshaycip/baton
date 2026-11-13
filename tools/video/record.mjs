// Films the real app against NEAR testnet. Demo accounts sign without a wallet popup, and every
// transaction on screen is real. Adapted from the author's own earlier tooling.
//
//   node record.mjs            the full film
//   DRY=1 node record.mjs      stops before anything is signed, to check the camera
//
// Frames, timestamps and named marks go to ~/.baton/video/takes. compose.mjs cuts them together.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DRY = !!process.env.DRY;
const TAKE = process.env.FILM_TAKE ?? (DRY ? 'dry' : 'take1');
const OUT = join(homedir(), '.baton', 'video', 'takes', TAKE);
const FRAMES = join(OUT, 'frames');
const SHARP = Number(process.env.FILM_DSF ?? 3);
const PORT = Number(process.env.FILM_PORT ?? 28791);
const BASE = `http://127.0.0.1:${PORT}/`;

const MAYA = 'baton-maya.testnet';
const SAM = 'baton-sam.testnet';
const FILM = JSON.parse(readFileSync(join(ROOT, 'deployments', 'film.json'), 'utf8'));
const TOKEN = FILM.token;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- the app, on testnet, with demo accounts ----

const server = spawn(process.execPath, ['server/index.mjs', '--testnet'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), BATON_DEV_SIGNERS: `${MAYA},${SAM}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ready, fail) => {
  server.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
    if (String(chunk).includes('running')) ready();
  });
  server.on('exit', () => fail(new Error('server stopped')));
});

// ---- the camera ----

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const log = { frames: [], marks: [], errors: [], facts: {}, sharp: SHARP };
const saveLog = () => writeFileSync(join(OUT, 'take.json'), JSON.stringify(log));
let frameNo = 0;

function mark(name, rects = {}) {
  log.marks.push({ name, t: Date.now() / 1000, rects });
  console.log(`[mark] ${name}`);
  saveLog();
}

async function rectOf(locator) {
  const box = await locator.boundingBox();
  return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none'] });

function cursorScript() {
  const install = () => {
    if (document.getElementById('__cursor')) return;
    const style = document.createElement('style');
    style.textContent =
      '@keyframes __ring{from{transform:translate(-50%,-50%) scale(.35);opacity:.75}to{transform:translate(-50%,-50%) scale(1.5);opacity:0}}' +
      '#__cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}' +
      '.__ring{position:fixed;width:34px;height:34px;border-radius:50%;border:2px solid #ef5a41;z-index:2147483646;pointer-events:none;animation:__ring .45s ease-out forwards}';
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5l13.5 10-6.3 1 -3.5 6.2z" fill="#fff" stroke="#15181c" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    c.style.transform = 'translate(640px,380px)';
    document.documentElement.appendChild(c);
    window.addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__ring';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.documentElement && document.body) install();
  else document.addEventListener('DOMContentLoaded', install);
}

async function startCamera() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: SHARP, colorScheme: 'dark' });
  await context.addInitScript(cursorScript);
  const page = await context.newPage();
  page.on('pageerror', (e) => { log.errors.push(e.message); console.log(`[pageerror] ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !/403|401|Failed to load resource/.test(m.text())) log.errors.push(m.text().slice(0, 300)); });
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frameNo += 1;
    writeFileSync(join(FRAMES, `${String(frameNo).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'));
    log.frames.push([frameNo, metadata.timestamp]);
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1280 * SHARP, maxHeight: 720 * SHARP, everyNthFrame: 1 });
  const hand = { page, cdp, context, x: 640, y: 380 };
  await page.mouse.move(hand.x, hand.y);
  return hand;
}

const pointer = (hand, show) => hand.page.evaluate((visible) => { document.getElementById('__cursor').style.display = visible ? '' : 'none'; }, show);

async function pointAt(hand, locator, { dwell = 120 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await sleep(120);
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to point at');
  const tx = box.x + Math.min(box.width / 2, 120);
  const ty = box.y + box.height / 2;
  const steps = 26;
  for (let i = 1; i <= steps; i += 1) {
    const p = i / steps;
    const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    await hand.page.mouse.move(hand.x + (tx - hand.x) * eased, hand.y + (ty - hand.y) * eased);
    await sleep(15);
  }
  hand.x = tx;
  hand.y = ty;
  await sleep(dwell);
}

async function click(hand, locator) {
  await pointAt(hand, locator);
  await hand.page.mouse.down();
  await sleep(70);
  await hand.page.mouse.up();
  await sleep(220);
}

/** Scrolls smoothly so the element's top sits `offset` pixels below the top of the window. */
async function glideTo(hand, selector, offset = 90, ms = 1100) {
  await hand.page.evaluate(async ({ selector: s, offset: o, ms: duration }) => {
    const element = document.querySelector(s);
    const from = window.scrollY;
    const to = Math.max(0, from + element.getBoundingClientRect().top - o);
    const started = performance.now();
    await new Promise((done) => {
      const tick = (now) => {
        const p = Math.min(1, (now - started) / duration);
        window.scrollTo(0, from + (to - from) * (p * p * (3 - 2 * p)));
        if (p < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
  }, { selector, offset, ms });
  await sleep(350);
}

const go = async (hand, path, ready) => {
  await hand.page.goto(`${BASE}#${path}`);
  await hand.page.locator(ready).first().waitFor({ timeout: 90_000 });
};

async function film() {
  const hand = await startCamera();
  const { page } = hand;
  await page.goto(BASE);
  await page.evaluate((persona) => localStorage.setItem('baton.persona', persona), MAYA);

  // The market.
  await page.goto(BASE);
  await page.locator('.board-row').first().waitFor({ timeout: 90_000 });
  await sleep(1500);
  await pointer(hand, false);
  mark('home', { hero: await rectOf(page.locator('.hero')), track: await rectOf(page.locator('.track')), h1: await rectOf(page.locator('.hero h1')) });
  await sleep(3200);
  mark('home-end');
  await glideTo(hand, '.board', 100);
  await sleep(1200);
  mark('board', { board: await rectOf(page.locator('.board')) });
  await sleep(1500);
  await glideTo(hand, '.compare', 110);
  await sleep(900);
  mark('compare', { table: await rectOf(page.locator('.compare table')) });
  await sleep(1500);
  await pointer(hand, true);

  // Maya's stake, before anything happens.
  await go(hand, `/b/${TOKEN}`, '.exit button');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1800);
  await pointer(hand, false);
  mark('baton', {
    art: await rectOf(page.locator('.art')),
    figures: await rectOf(page.locator('.figures')),
    info: await rectOf(page.locator('.info')),
    exit: await rectOf(page.locator('.exit')),
    balance: await rectOf(page.locator('.persona')),
  });
  await sleep(1500);
  await pointer(hand, true);

  // The holder room, while Maya still holds it.
  await go(hand, `/room/${TOKEN}`, '.door');
  await sleep(1000);
  mark('door', { door: await rectOf(page.locator('.door')) });
  await click(hand, page.getByRole('button', { name: 'Sign to enter' }));
  await page.locator('.room').waitFor({ timeout: 60_000 });
  await sleep(1200);
  mark('room-open', { room: await rectOf(page.locator('.room')) });
  await click(hand, page.getByRole('button', { name: 'Create my key' }));
  await page.getByRole('button', { name: 'Test the key' }).waitFor({ timeout: 30_000 });
  await click(hand, page.getByRole('button', { name: 'Test the key' }));
  await page.locator('.key-box pre').waitFor({ timeout: 30_000 });
  await sleep(1000);
  mark('key-works', { key: await rectOf(page.locator('.key-box')) });
  await sleep(1200);

  // Sam's offer.
  await go(hand, '/offers', '.offers li');
  await glideTo(hand, '.offers', 180, 700);
  await sleep(900);
  await pointer(hand, false);
  mark('offers', { offers: await rectOf(page.locator('.offers')) });
  await sleep(1800);
  await pointer(hand, true);

  // The sale.
  await go(hand, `/b/${TOKEN}`, '.exit button');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1300);
  log.facts.before = await page.locator('.persona b').innerText();
  const exit = page.getByRole('button', { name: /^Exit now for/ });
  log.facts.exit = await exit.innerText();
  await pointAt(hand, exit, { dwell: 400 });
  await sleep(600);
  mark('exit-ready', { exit: await rectOf(page.locator('.exit')), button: await rectOf(exit) });
  await sleep(1200);
  if (DRY) {
    mark('dry-end');
    return;
  }
  mark('exit-click');
  await click(hand, exit);
  await page.locator('.result .ok').waitFor({ timeout: 180_000 });
  mark('sold-arrived');
  await sleep(4500);
  await pointer(hand, false);
  await page.locator('.result').scrollIntoViewIfNeeded();
  await sleep(700);
  log.facts.after = await page.locator('.persona b').innerText();
  log.facts.notice = await page.locator('.result .ok').innerText();
  log.facts.validator = await page.locator('.validator-proof').innerText();
  log.facts.tx = await page.locator('.tx-link').getAttribute('href');
  console.log(log.facts);
  mark('sold', {
    result: await rectOf(page.locator('.result')),
    message: await rectOf(page.locator('.result .ok')),
    validator: await rectOf(page.locator('.validator-proof')),
    balance: await rectOf(page.locator('.persona')),
    art: await rectOf(page.locator('.art')),
  });
  await sleep(2500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1200);
  mark('sold-top', { art: await rectOf(page.locator('.art')), balance: await rectOf(page.locator('.persona')), info: await rectOf(page.locator('.info')) });
  await sleep(2000);
  await glideTo(hand, '.legs', 200);
  await sleep(900);
  mark('title', { legs: await rectOf(page.locator('.legs')) });
  await sleep(2500);
  await pointer(hand, true);

  // The seller tries to get back in.
  await go(hand, `/room/${TOKEN}`, '.door .error');
  await sleep(1400);
  await pointer(hand, false);
  mark('closed', { door: await rectOf(page.locator('.door')), reason: await rectOf(page.locator('.door .error')) });
  await sleep(1500);
  await pointer(hand, true);
  await click(hand, page.getByRole('button', { name: 'Try my old key' }));
  await page.locator('pre.pre-bad').waitFor({ timeout: 30_000 });
  await sleep(1000);
  await pointer(hand, false);
  log.facts.deadKey = await page.locator('pre.pre-bad').innerText();
  mark('dead-key', { door: await rectOf(page.locator('.door')), dead: await rectOf(page.locator('pre.pre-bad')) });
  await sleep(2200);
  await pointer(hand, true);

  // The new holder walks in.
  await page.locator('.persona select').selectOption(SAM);
  await sleep(600);
  await click(hand, page.getByRole('button', { name: 'Sign to enter' }));
  await page.locator('.room').waitFor({ timeout: 60_000 });
  await sleep(1400);
  await pointer(hand, false);
  mark('sam-in', { room: await rectOf(page.locator('.room')), welcome: await rectOf(page.locator('.room .ok')) });
  await sleep(1800);

  // Anyone can check.
  await go(hand, `/verify/${TOKEN}`, '.check');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(2600);
  const passed = await page.locator('.check.pass').count();
  const total = await page.locator('.check').count();
  log.facts.checks = `${passed}/${total}`;
  console.log('checks', log.facts.checks);
  mark('verify', { first: await rectOf(page.locator('.check').first()), checks: await rectOf(page.locator('.checks')) });
  await sleep(1800);
  await glideTo(hand, '.check:last-child', 330);
  await sleep(900);
  mark('verify-all', { checks: await rectOf(page.locator('.checks')), last: await rectOf(page.locator('.check').last()) });
  await sleep(1500);

  // The market again.
  await page.goto(BASE);
  await page.locator('.board-row').first().waitFor({ timeout: 90_000 });
  await sleep(1800);
  mark('home-2', { hero: await rectOf(page.locator('.hero')) });
  await sleep(2500);
  mark('done');
}

try {
  await film();
} catch (error) {
  log.errors.push(String(error.stack ?? error));
  console.log(`[failed] ${error.message}`);
  process.exitCode = 1;
} finally {
  saveLog();
  await browser.close();
  server.kill();
  console.log(`frames ${frameNo}, errors ${log.errors.length}`);
  for (const e of log.errors.slice(0, 10)) console.log(`  ${e.slice(0, 300)}`);
  process.exit();
}
