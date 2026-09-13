'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {Worker} = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bootstrap = `
const {parentPort, workerData} = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
globalThis.self = globalThis;
globalThis.postMessage = (data, transfers) => parentPort.postMessage(data, transfers);
globalThis.importScripts = (...names) => {
  for (const name of names) {
    const file = path.join(workerData.root, name.split('?')[0]);
    if (name.startsWith('cfd-core')) {
      if (workerData.fallback) continue;
      const factory = require(file);
      globalThis.createCFDCore = options => factory({...options,
        locateFile:name => path.join(workerData.root, name.split('?')[0])});
    } else vm.runInThisContext(fs.readFileSync(file, 'utf8'), {filename:file});
  }
};
vm.runInThisContext(fs.readFileSync(path.join(workerData.root, 'solver-worker.js'), 'utf8'));
parentPort.on('message', data => self.onmessage({data}));
`;
async function check(fallback) {
  const worker = new Worker(bootstrap, {eval:true, workerData:{root,fallback}});
  const pending = new Map();
  let nextId = 0;
  worker.on('message', data => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data);
  });
  worker.on('error', error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
  const request = (type, payload={}) => new Promise((resolve, reject) => {
    const id=++nextId; pending.set(id,{resolve,reject});worker.postMessage({id,type,...payload});
  });
  try {
    const config={nx:96,ny:48,geometry:{...CFDDefaultGeometry,lowerBias:.005},
      mach:.8,aoa:2,reynolds:50000,frictionModel:'turbulent'};
    const initial=await request('configure',{config});
    assert.equal(initial.state.backend, fallback ? 'javascript' : 'cpp-wasm');
    await request('speed',{speed:4});
    await request('run');
    // 画面側に相当するスレッドを停止しても計算スレッドが進む。
    const until=performance.now()+600;
    while(performance.now()<until) {}
    const result=await request('pause');
    assert.ok(result.state.iteration>=5, 'Computation depends on the caller thread');
    const frozen=await request('snapshot');
    await delay(120);
    assert.equal((await request('snapshot')).state.iteration, frozen.state.iteration);
    assert.equal(result.state.rho.length,96*48,'Wasm memory must not be detached by snapshot transfer');
    const reference=new CFDSolver(96,48);
    reference.geometry={...config.geometry}; reference.reset(config.mach,config.aoa);
    for(let i=0;i<result.state.iteration;i++)reference.step();
    if (!fallback) {
      assert.deepEqual(result.state.rho,reference.rho,'Worker numerical result changed');
      assert.deepEqual(result.state.E,reference.E);
      assert.deepEqual(result.state.coeffs,reference.coeffs);
    }
    assert.deepEqual(result.history.map(h=>h.iteration),
      Array.from({length:Math.floor(result.state.iteration/10)+1},(_,i)=>i*10));
    const reset=await request('reset');
    assert.equal(reset.state.iteration,0);
    assert.ok(reset.revision>result.revision);
    assert.deepEqual(reset.history.map(h=>h.iteration),[0]);
    assert.deepEqual(reset.state.rho,initial.state.rho);
    // 操作を連続送信しても順序が保たれ、古い格子・履歴が混ざらない。
    const changed={...config,nx:128,ny:64,mach:.7};
    const requests=[request('run'),request('configure',{config:changed}),request('pause')];
    const [,grid,stopped]=await Promise.all(requests);
    assert.equal(grid.state.rho.length,128*64);
    assert.equal(grid.state.mach,.7);
    assert.equal(stopped.state.iteration,0);
    // 格子寸法を据え置いた configure は再利用ブランチを通る。新規生成した solver と一致すること。
    const sameGrid={...changed,mach:.72,aoa:3,geometry:{...changed.geometry,camber:.03}};
    const reused=await request('configure',{config:sameGrid});
    const fresh=new CFDSolver(128,64,sameGrid);
    assert.deepEqual(reused.state.nodeX,fresh.nodeX,'Reuse branch grid differs from a freshly constructed solver');
    assert.deepEqual(reused.state.geometry,fresh.geometry);
    for(const key of ['mach','aoa','reynolds','frictionModel'])assert.equal(reused.state[key],fresh[key],key);
    if (!fallback) {
      assert.deepEqual(reused.state.rho,fresh.rho,'Reuse branch flow field differs from a fresh solver');
      assert.deepEqual(reused.state.coeffs,fresh.coeffs);
    }
    // 欠けた項目は両ブランチとも同じ既定値で補われ、Workerを停止させない。
    const partial={nx:128,ny:64,geometry:{thickness:.14}};
    const viaReuse=await request('configure',{config:partial});
    const viaFresh=await request('configure',{config:{...partial,nx:96,ny:48}});
    const expectedGeometry={...CFDDefaultGeometry,thickness:.14};
    assert.deepEqual(viaReuse.state.geometry,expectedGeometry,'Reuse branch must fill missing geometry');
    assert.deepEqual(viaFresh.state.geometry,expectedGeometry,'Fresh branch must fill missing geometry');
    for(const snap of [viaReuse,viaFresh]){
      assert.equal(snap.state.frictionModel,'turbulent');
      assert.equal(snap.state.reynolds,50000);
      assert.equal(snap.state.gridReady,true);
      assert.ok(Number.isFinite(snap.state.coeffs.cl),'Partial configure produced a non-finite lift coefficient');
    }
    console.log((fallback?'JS':'Wasm')+': independent stepping, pause, reset, history, ordered reconfiguration and configure branches PASS ('+result.state.iteration+' iterations)');
  } finally { await worker.terminate(); }
}
(async()=>{
  const factory=require(path.join(root,'cfd-core.js'));
  globalThis.createCFDCore=options=>factory({...options,locateFile:file=>path.join(root,file.split('?')[0])});
  require(path.join(root,'solver.js'));
  await CFDSolver.initialize();
  await check(false);
  await check(true);
})().catch(error=>{console.error(error);process.exitCode=1});
