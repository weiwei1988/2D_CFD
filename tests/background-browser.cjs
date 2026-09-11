'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.CFD_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' :
      file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cfd-browser-test-'));
  const chrome = spawn(process.env.CFD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
      '--no-default-browser-check', 'about:blank'], {stdio:'ignore'});
  let browser;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let n=0; !fs.existsSync(portFile); n++) {
      if (n >= 100 || chrome.exitCode !== null) throw new Error('Chrome did not start');
      await delay(100);
    }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    // 通常のChromeへ接続し、Playwrightの常時フォーカス模擬を適用しない。
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {noDefaults:true});
    const context = browser.contexts()[0];
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.testRafCount = 0;
      const nativeRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => nativeRaf(t => { window.testRafCount++; cb(t); });
    });
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url);
    await page.evaluate(() => window.cfdReady);
    let state = await page.evaluate(() => cfdApp.getState());
    assert.equal(state.backend, 'cpp-wasm');
    assert.equal(state.workerBusy, false);
    assert.equal(state.running, false);
    assert.equal(state.iteration, 0);
    const worker = page.workers()[0];
    assert.ok(worker);
    await page.locator('#playButton').click();
    await page.waitForFunction(() => cfdApp.getState().iteration >= 5);
    const popup = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank', '_blank'));
    const cover = await popup;
    await cover.bringToFront();
    await delay(250);
    assert.equal(await page.evaluate(() => document.hidden), true);
    const before = await worker.evaluate(() => solver.iteration);
    const rafBefore = await page.evaluate(() => testRafCount);
    await delay(3200);
    const during = await worker.evaluate(() => solver.iteration);
    const rafAfter = await page.evaluate(() => testRafCount);
    assert.equal(rafAfter, rafBefore, 'RAF must actually stop for this regression test');
    assert.ok(during >= before + 15, 'Worker must continue while RAF is stopped');
    console.log('Hidden tab: iterations ' + before + ' -> ' + during + ', RAF unchanged at ' + rafBefore);
    await page.bringToFront();
    await page.waitForFunction(n => cfdApp.getState().iteration >= n, during);
    const logged = await page.evaluate(() => cfdApp.getHistory().map(h => h.iteration));
    for (let n = 0; n <= Math.floor(during / 10) * 10; n += 10)
      assert.ok(logged.includes(n), 'Missing hidden-tab history iteration ' + n);

    await page.locator('#playButton').click();
    await delay(200);
    const paused = await worker.evaluate(() => solver.iteration);
    await delay(400);
    assert.equal(await worker.evaluate(() => solver.iteration), paused);
    assert.equal(await page.locator('#playLabel').textContent(), '再開');
    await page.locator('#playButton').click();
    await page.waitForFunction(n => cfdApp.getState().iteration > n, paused);

    // 値を元へ戻せば未更新表示が解除され、停止位置から再開できる。
    await page.locator('#machInput').fill('0.85');
    await page.locator('#machInput').press('Tab');
    assert.equal(await page.locator('#playButton').isDisabled(), true);
    assert.equal(await page.locator('#resetButton').isDisabled(), true);
    await delay(200);
    const dirtyStop = await worker.evaluate(() => solver.iteration);
    await delay(350);
    assert.equal(await worker.evaluate(() => solver.iteration), dirtyStop);
    await page.locator('#machInput').fill('0.90');
    await page.locator('#machInput').press('Tab');
    assert.equal(await page.locator('#playButton').isDisabled(), false);
    assert.equal(await page.locator('#playLabel').textContent(), '再開');

    // 格子・形状・条件を再設定し、旧snapshotが混ざらずiteration=0に戻る。
    await page.locator('#machInput').fill('0.8');
    await page.locator('#machInput').press('Tab');
    await page.locator('#lowerBiasInput').fill('0.50');
    await page.locator('#lowerBiasInput').press('Tab');
    await page.locator('#gridSelect').selectOption('96x48');
    await page.locator('#regenerateButton').click();
    await page.waitForFunction(() => !cfdApp.getState().workerBusy);
    state = await page.evaluate(() => cfdApp.getState());
    assert.equal(state.mach, 0.8);
    assert.equal(state.iteration, 0);
    assert.equal(state.running, false);
    assert.equal(state.configurationDirty, false);
    assert.equal(await worker.evaluate(() => solver.nx), 96);
    assert.equal(await page.evaluate(() => cfdApp.getGeometry().lowerBias), 0.005);
    await page.locator('#speedSelect').selectOption('4');
    await page.locator('#playButton').click();
    await page.waitForFunction(() => cfdApp.getState().iteration >= 12);
    await page.locator('[data-field="streamlines"]').click();
    await page.locator('#resetButton').click();
    await page.waitForFunction(() => !cfdApp.getState().workerBusy);
    await delay(200);
    state = await page.evaluate(() => cfdApp.getState());
    assert.equal(state.iteration, 0);
    assert.equal(state.mach, 0.8);
    assert.equal(state.hasStarted, false);
    assert.deepEqual(await page.evaluate(() => cfdApp.getHistory().map(h => h.iteration)), [0]);
    assert.deepEqual(errors, []);
    console.log('Pause/resume, dirty/revert, grid regeneration, speed, reset, streamlines: PASS');

    // Wasm取得失敗でもJavaScript計算を同じWorkerで動かせる。
    const fallback = await context.newPage();
    await fallback.route('**/cfd-core.wasm*', route => route.abort());
    await fallback.goto(url);
    await fallback.evaluate(() => cfdReady);
    assert.equal(await fallback.evaluate(() => cfdApp.getState().backend), 'javascript');
    await fallback.locator('#playButton').click();
    await fallback.waitForFunction(() => cfdApp.getState().iteration >= 3);
    await fallback.locator('#playButton').click();
    console.log('JavaScript fallback inside Worker: PASS');

    const broken = await context.newPage();
    await broken.route('**/solver-worker.js*', route => route.abort());
    await broken.goto(url);
    await broken.waitForFunction(() => window.cfdApp?.getState().workerError);
    assert.equal(await broken.locator('#playButton').isDisabled(), true);
    assert.equal(await broken.locator('#solverError').isVisible(), true);
    console.log('Worker loading error is visible and disables calculation: PASS');

  } finally {
    if (browser) {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => {});
      await browser.close();
    }
    if (chrome.exitCode === null) chrome.kill('SIGTERM');
    await delay(300);
    fs.rmSync(profile, {recursive:true, force:true});
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
