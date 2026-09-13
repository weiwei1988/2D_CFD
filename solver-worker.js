'use strict';

// 計算と履歴の所有者。描画・タブの可視性に依存せず、自分のタイマーで進める。
importScripts('cfd-core.js?v=worker-20260912-1', 'solver.js?v=hotpath-20260914-1');
const initialized = CFDSolver.initialize();
let solver, running = false, speed = 1, timer = null, revision = 0;
const history = [];
const dynamicFields = ['rho', 'mx', 'my', 'E', 'uField', 'vField', 'machField', 'schlieren'];
const gridFields = ['nodeX', 'nodeY', 'cellX', 'cellY', 'surfaceX', 'surfaceTheta'];

function recordHistory() {
  const d = solver.diagnostics, c = solver.coeffs;
  history.push({iteration:solver.iteration, time:solver.time, residual:solver.residual,
    cl:c.cl, cd:c.cd, cm:c.cm, shockX:d.shockDetected ? d.shockX : NaN, maxMach:d.maxSurfaceMach});
  if (history.length > 2400) history.shift();
}

function stop() {
  running = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function tick() {
  timer = null;
  if (!running) return;
  const start = performance.now();
  try {
    solver.step();
    if (solver.iteration % 10 === 0) recordHistory();
    // 遅延分の一括計算は行わず、発熱と停止操作の遅延を抑える。
    timer = setTimeout(tick, Math.max(0, 120 / speed - (performance.now() - start)));
  } catch (error) {
    stop();
    self.postMessage({type:'error', error:String(error.message || error)});
  }
}

function snapshot(includeGrid, afterIteration = -1) {
  solver.updateDerivedFields();
  const state = {iteration:solver.iteration, time:solver.time, residual:solver.residual,
    coeffs:solver.coeffs, diagnostics:solver.diagnostics, cp:solver.cp};
  if (includeGrid) {
    for (const key of ['nx', 'ny', 'n', 'geometry', 'mach', 'aoa', 'reynolds', 'frictionModel',
      'backend', 'cfl', 'xmin', 'xmax', 'ymin', 'ymax', 'gridReady']) state[key] = solver[key];
  }
  const transfers = [];
  for (const key of includeGrid ? [...dynamicFields, ...gridFields] : dynamicFields) {
    // Wasmのヒープそのものは転送しない。描画用のコピーだけを移譲する。
    state[key] = solver[key].slice();
    transfers.push(state[key].buffer);
  }
  return {data:{revision, state, history:history.filter(h => h.iteration > afterIteration)}, transfers};
}

async function handle(message) {
  await initialized;
  const {id, type} = message;
  let result;
  if (type === 'configure') {
    stop();
    const c = message.config;
    // 条件の補完は CFDSolver.applyConfig に一本化し、新規生成と再利用で同じ solver にする。
    // 新規生成はコンストラクタ内の reset で反映されるため、どちらの経路も格子生成は1回。
    if (!solver || solver.nx !== c.nx || solver.ny !== c.ny) {
      solver = new CFDSolver(c.nx, c.ny, c);
    } else {
      solver.applyConfig(c);
      solver.reset(solver.mach, solver.aoa, true);
    }
    revision++;
    history.length = 0;
    recordHistory();
    result = snapshot(true);
  } else {
    if (!solver) throw new Error('Solver has not been configured');
    if (type === 'reset') {
      stop();
      solver.reset(solver.mach, solver.aoa, false);
      revision++;
      history.length = 0;
      recordHistory();
      result = snapshot(false);
    } else if (type === 'run') {
      if (!running) { running = true; timer = setTimeout(tick, 120 / speed); }
    } else if (type === 'pause') {
      stop();
      result = snapshot(false, message.afterIteration);
    } else if (type === 'speed') {
      if (![1, 2, 4].includes(message.speed)) throw new Error('Invalid calculation speed');
      speed = message.speed;
      if (running) { clearTimeout(timer); timer = setTimeout(tick, 120 / speed); }
    } else if (type === 'snapshot') {
      result = snapshot(false, message.afterIteration);
    } else throw new Error('Unknown solver command: ' + type);
  }
  self.postMessage({id, ...result?.data}, result?.transfers || []);
}

// Wasm初期化待ちの間に届いた操作も、受信順序を保持する。
let commands = Promise.resolve();
self.onmessage = ({data}) => {
  commands = commands.then(() => handle(data)).catch(error => {
    stop();
    self.postMessage({id:data.id, error:String(error.message || error)});
  });
};
