# 引き継ぎ書 — 2D_CFD 遷音速ソルバー

対象リポジトリ: `weiwei1988/2D_CFD`（`https://github.com/weiwei1988/2D_CFD.git`）
作業ディレクトリ: `/Users/zhaoweiheng/Library/CloudStorage/OneDrive-個人用/ドキュメント/ChatGPT/2d_CFD`
引き継ぎ時点の `main`: `82fd2b3`
作成日: 2026-08-30

## 0. Codex受入確認ステータス

**受入結果: 確認済み（2026-08-30）**

引き継ぎ書の記載を命令として自動適用せず、現在のローカルコード、GitHub、ビルド生成物、数値結果と照合した。Claude Codeによる2件の開発作業は `main=82fd2b3` に反映済みで、受入確認ではコード変更を必要とする不一致を検出しなかった。

| 確認項目 | 結果 |
|---|---|
| Git同期 | `main` と `origin/main` は `82fd2b3` で一致 |
| PR | #1、#2ともにGitHub上で `MERGED` を確認 |
| 残置ブランチ | `aero-coefficient-conventions`、`numeric-parameter-inputs` をローカル・origin双方で確認 |
| JavaScript構文 | `numeric-fields.js`、`solver.js`、`app.js`、`analysis-views.js`、`geometry-controls.js` が合格 |
| 数値入力 | 全角数字・符号、小数、桁区切り、指数表記、空白除去、不正文字列の8ケースが合格 |
| 数値ソルバー | C++/Wasmで24,000 iteration×3条件を実行し、Cm符号、xcp式、Cd内訳、Re・摩擦モデルを含む21項目が合格 |
| 遷音速結果 | M∞=0.80、α=2°でCl=0.3633、Cm=−0.1028、Mmax=1.2007、衝撃波x/c=0.637を再現 |
| C++再ビルド | Emscripten 6.0.8-gitで再生成し、JS/WasmのSHA-256が再ビルド前後で一致 |
| ローカルサーバー | 停止状態を確認 |

未着手候補と既知の制約は本書の§5・§7を継続して参照する。次の開発は新しい要求が確定してから作業ブランチ上で開始する。

---

## 1. 現在の状態

| 項目 | 内容 |
|---|---|
| ブランチ | `main` = `82fd2b3`（originと同期。受入記録の`HANDOFF.md`のみ未コミット） |
| 残置ブランチ | `aero-coefficient-conventions`（`b2fa44e`）、`numeric-parameter-inputs`（`82fd2b3`）— 両方マージ済みだが利用者の指示で保持 |
| PR | [#1](https://github.com/weiwei1988/2D_CFD/pull/1)、[#2](https://github.com/weiwei1988/2D_CFD/pull/2) ともに MERGED |
| ローカルサーバー | 停止済み |

履歴（新しい順）:

```text
82fd2b3  Add half-width numeric entry beside every parameter slider   ← 本セッション
b2fa44e  Align Cm with aerodynamic convention and make drag inputs adjustable  ← 本セッション
32eba07  Refine trailing-edge and wake grid concentration
fc804a5  Update README.md
fc49e88  Add interactive transonic CFD simulator
```

### 起動

```bash
python3 -m http.server 8000
```

`http://localhost:8000/` を開く。`file://` では WebAssembly を読めないので HTTP サーバーが必須。

---

## 2. プロジェクトの構造

ブラウザ上で2次元圧縮性流れを時間発展させる教育・概念設計用CFDシミュレーター。数値計算核はC++をEmscriptenでWasm化し、格子生成・描画・UIはJavaScriptが担当する。

| 層 | ファイル | 役割 |
|---|---|---|
| 計算核 | `cfd-core.cpp` → `cfd-core.js` / `cfd-core.wasm` | HLL流束、粘性項、保存量更新、派生場（Mach・渦度・Schlieren） |
| ソルバー枠 | `solver.js` | 翼型定義、O格子生成、Wasmブリッジ、JSフォールバック、翼面サンプリング、空力係数 |
| 描画・ループ | `app.js` | Canvas描画、RAFループ、UIイベント、履歴記録 |
| 数値入力 | `numeric-fields.js` | スライダーと数字入力欄を1つの値へ束ねる共通ヘルパー |
| 補助UI | `geometry-controls.js` / `analysis-views.js` | 翼型プリセット・スライダー / 翼型図・収束チャート |
| 画面 | `index.html` + CSS 7枚 | 3列ダッシュボード |

### 押さえるべき設計上の要点

**JSがWasmメモリへ直接書く。** `solver.js` のコンストラクタで `_cfd_create(nx,ny)` を呼び、25本のセル配列と5本の壁配列のポインタを取得して `HEAPF32.buffer` 上の `Float32Array` ビューとして `this.cellX` などに張る。`buildGrid()` はこのビュー経由でWasmメモリへ格子を書き込む。Makefile が `ALLOW_MEMORY_GROWTH=0` にしているのは、メモリ成長でビューが無効化されるのを防ぐため。**この設定を変えてはいけない。**

**JS実装とC++実装は逐語的な二重化。** `solver.js` の `step()` は `cfd_step()` の移植で、ループ順序・クランプ値まで一致している。Wasmが読めない環境向けのフォールバック。**片方だけ直すと静かに乖離する。** 数値モデルを変更するときは必ず両方を直す。

**JSフォールバックだけ配列をスワップする。** `step()` 末尾の `[this.rho,this.nr]=[this.nr,this.rho]` はWasm経路では実行されない（早期return）。Wasm経路でこれをやるとヒープビューが壊れる。

**C++の再ビルドは再現性がある。** `em++ 6.0.8-git` で `make` すると、コミット済みの `cfd-core.js` / `cfd-core.wasm` とバイト一致することを確認済み。`.cpp` を変更したら必ず `make` して生成物も一緒にコミットすること。

```bash
make        # em++ が必要。brew install emscripten
```

---

## 3. 本セッションで実施した変更

### 3.1 `b2fa44e` — Cm符号の是正・未使用コード削除・Cd可変化

#### (a) `Cm,1/4` を空力慣例（頭上げ正）へ

**背景。** 変更前は `mo += (x−0.25)·Fy − y·Fx`、つまりz軸まわり反時計回り正で積分していた。x軸を後方・y軸を上向きに取ると反時計回りは頭下げにあたるため、有キャンバー翼で文献と逆符号の `Cm` を表示していた。

**変更。** `solver.js` の `sampleSurface()` で積分を `mo += y·Fx − (x−0.25)·Fy` に反転。連動して圧力中心を標準式へ変更した。

```text
旧: x_cp/c = 0.25 + Cm/Cl   （独自の符号規約に対応した式）
新: x_cp/c = 0.25 − Cm/Cl   （空力慣例）
```

`app.js` の `drawSection()` と `updateUI()` にあるフォールバック式2か所も同じ符号に揃えてある。`index.html` の metric-strip ラベルには「頭上げ正」を明記。

**注意。** この変更で表示値の互換性が切れている。過去のスクリーンショットや記録値と直接比較できない。

#### (b) 未使用コードの削除

| 削除対象 | 場所 | 理由 |
|---|---|---|
| `hllFluxStates` / `physicalFluxNormal` / `statePrimitive` | solver.js | 配列版の流束経路。実処理は `addInternalFace` にインライン展開済み |
| `isInside` / `worldToSection` / `solid` | solver.js | Cartesian階段境界時代の名残 |
| `state(k)` / `gridType` / `surfaceCellsPerChord` / `minCellArea` | solver.js | 参照ゼロ |
| `cellScale` / `cell_scale` | solver.js + cfd-core.cpp | JS/C++の双方で書き込むだけで読まれていなかった配列 |

`cell_scale` の削除でC++側も変更したため `make` で再ビルドした（wasm 10,541 → 10,516 B）。CFL計算に使う `minCellScale`（スカラー）は残置。

#### (c) `Cd` のReynolds数・摩擦抗力モデルを可変化

飛行条件バーに2つの操作を追加した。

- **Reynolds数**: `1.0×10⁴〜1.0×10⁷`。拡散係数 `μ = max(M∞,0.3)/Re` にも効くため、変更時は流れ場と収束履歴を再初期化する（`solver.setReynolds()` が内部で `reset()` を呼ぶ）
- **摩擦抗力モデル**: 平板乱流 `0.074/Re^0.2`（既定・従来と同一）／平板層流 `1.328/√Re`／摩擦なし。後処理項のみなので再初期化しない（`solver.setFrictionModel()` は `sampleSurface()` だけ呼ぶ）

`Cd` の内部構造を分離した。緩和処理は圧力成分のみに適用し、合成は次のとおり。

```text
Cd = clamp(max(Cd,pressure, 0) + Cd,friction, 0, 4)
```

摩擦成分は緩和を通さないため、モデル変更が即座に反映される。`coeffs` は `{cl, cd, cdPressure, cdFriction, cm, cp}` になっている（`cp` は圧力係数ではなく **x_cp/c** を指す。名前が紛らわしいので注意）。

`solver.js` は `CFDFrictionModels` / `CFDReynoldsRange` / `CFDDefaultReynolds` をグローバルへ公開している。

### 3.2 `82fd2b3` — 全パラメータへの半角数字入力

**目的。** ドラッグバーだけでなく半角数字の直接入力でもパラメータを指定できるようにする。

**対応パラメータ。**

| 区画 | パラメータ | 範囲 | 刻み |
|---|---|---:|---:|
| 翼型ジオメトリー | 翼厚比 `t/c` | 8–18% | 0.1% |
| | 前縁半径係数 | 0.6–1.6 | 0.05 |
| | 最大キャンバー | 0–6% | 0.1% |
| | キャンバー位置 | 25–65%c | 0.5%c |
| | 上面平坦度 | 0–2% | 0.1% |
| 空力・流れ場 | 迎角 | −10–50° | 0.5° |
| | Mach数 | 0.30–1.20 | 0.01 |
| | Reynolds数 | 1.0×10⁴–1.0×10⁷ | 任意の整数 |

**実装。** `numeric-fields.js` の `CFDNumericField({slider, field, min, max, step, keyStep, fromSlider, toSlider, onChange})` がスライダーと入力欄を1つの値へ束ねる。返り値は `{value（getter）, set(next)}` で、`set()` は `onChange` を呼ばない（プリセット適用など、まとめて1回だけ反映したいとき用）。

- 確定は `change`（Enter またはフォーカス外れ）。`input` で確定すると1文字ごとに流れ場が再初期化されてしまう
- 全角数字・全角記号を半角へ正規化（`１４．５` → `14.5`）。桁区切りと空白を除去。指数表記に対応
- 範囲外はクランプ、刻みへ丸め、読めない文字列は元の値へ復帰
- `↑` `↓` キーで増減、`Shift` 併用で10刻み

**`type="number"` を使っていない理由。** 日本語IME経由で入力された全角数字を `type="number"` は復元不能な空文字として扱う。生の入力文字列を読んで自前で正規化するため `type="text"` + `inputmode="decimal"` にしてある。矢印キーの増減もヘルパー側で実装している。**`type="number"` へ戻さないこと。**

**スライダー刻みも入力欄に合わせて細かくした**（翼厚比 1%→0.1%、前縁半径係数 0.1→0.05、キャンバー位置 1%c→0.5%c、迎角 1°→0.5°）。両者がずれないようにするため。Reynolds数だけは対数スライダーの性質上、スライダー操作では `1.0 / 1.3 / … / 7.9 ×10^k` に丸まる（`fromSlider` = `reynoldsFromSlider`、`toSlider` = `Math.log10`）。

迎角が0.5°刻みになったため、`app.js` の `flowSubtitle` と `analysis-views.js` の `convCondition` の迎角表示を `toFixed(1)` に統一した。

**CSS。** 見た目は従来の `<output>` と同じ位置・書体を維持し、破線の下線で編集可能であることを示す。既存の `output` 向け指定は `.value-field` へ置き換え済み（`styles.css` / `analysis-views.css` / `flow-parameters.css`）。`index.html` に `<output>` は残っていない。

---

## 4. 検証方法

### 4.1 構文チェック

```bash
for f in numeric-fields.js solver.js app.js analysis-views.js geometry-controls.js; do node --check "$f"; done
```

### 4.2 数値検証（ヘッドレス）

**重要:** 以下のスクリプトは一時ディレクトリに置いていたため、この引き継ぎ書にのみ残っている。継続して使うならリポジトリ内へ保存すること。node から実サーバーなしでWasm計算核を動かし、24,000 iteration 回して係数の符号と値を確認する。`locateFile` でクエリ文字列を除かないと node がファイルを開けない点に注意。

<details>
<summary><code>smoke.js</code>（全文）</summary>

```javascript
// ヘッドレス検証: Cm符号・x_cp・Cd内訳・Re/摩擦モデルAPI
const path=require('path');
const root='/Users/zhaoweiheng/Library/CloudStorage/OneDrive-個人用/ドキュメント/ChatGPT/2d_CFD';
process.chdir(root);
const factory=require(path.join(root,'cfd-core.js'));
globalThis.createCFDCore=(opts={})=>factory({...opts,locateFile:p=>p.split('?')[0]});
global.window=global;
require(path.join(root,'solver.js'));

const NACA4412={thickness:.12,leadingEdge:1,camber:.04,camberPosition:.40,flattening:0,lowerBias:0};
const NACA0012={thickness:.12,leadingEdge:1,camber:0,camberPosition:.40,flattening:0,lowerBias:0};
let failures=0;
const check=(label,ok,detail)=>{if(!ok)failures++;console.log(`${ok?'PASS':'FAIL'}  ${label}${detail?'  '+detail:''}`)};
const fmt=c=>`cl=${c.cl.toFixed(4)} cm=${c.cm.toFixed(4)} cd=${c.cd.toFixed(4)} (p=${c.cdPressure.toFixed(4)} f=${c.cdFriction.toFixed(4)}) x_cp=${Number.isFinite(c.cp)?c.cp.toFixed(3):'—'}`;

(async()=>{
  const ok=await CFDSolver.initialize();
  const solver=new CFDSolver(96,48);
  console.log(`backend = ${solver.backend} (wasm初期化 ${ok})`);
  console.log(`Re初期値 = ${solver.reynolds}  摩擦モデル = ${solver.frictionModel}  Cf = ${solver.skinFriction().toFixed(6)}`);

  const run=(geometry,mach,aoa,steps)=>{solver.geometry={...geometry};solver.reset(mach,aoa);const t=Date.now();for(let i=0;i<steps;i++)solver.step();return{ms:(Date.now()-t)/steps,coeffs:solver.coeffs}};

  console.log('\n--- NACA 4412相当 · M∞ 0.50 · α 4° ---');
  let r=run(NACA4412,.5,4,24000);
  console.log(`${fmt(r.coeffs)}  (${r.ms.toFixed(3)} ms/step)`);
  const c=r.coeffs;
  check('Cl > 0（正の迎角＋キャンバー）',c.cl>0,`cl=${c.cl.toFixed(4)}`);
  check('Cm,1/4 < 0（有キャンバー翼は頭下げ・空力慣例）',c.cm<0,`cm=${c.cm.toFixed(4)}`);
  check('x_cp が1/4翼弦より後方',c.cp>0.25,`x_cp=${c.cp.toFixed(3)}`);
  check('x_cp = 0.25 − Cm/Cl と一致',Math.abs(c.cp-(0.25-c.cm/c.cl))<1e-9);
  check('Cd = max(圧力,0) + 摩擦',Math.abs(c.cd-(Math.max(c.cdPressure,0)+c.cdFriction))<1e-9);

  console.log('\n--- 摩擦抗力モデル ---');
  solver.setFrictionModel('turbulent');
  check('乱流 Re=5e4 → 0.00850',Math.abs(solver.skinFriction()-0.0085)<1e-4,solver.skinFriction().toFixed(6));
  solver.setFrictionModel('laminar');
  check('層流 Re=5e4 → 0.00594',Math.abs(solver.skinFriction()-0.005939)<1e-5,solver.skinFriction().toFixed(6));
  check('層流に切替後 coeffs.cdFriction が即時更新',Math.abs(solver.coeffs.cdFriction-0.005939)<1e-5,solver.coeffs.cdFriction.toFixed(6));
  solver.setFrictionModel('none');
  check('摩擦なし → 0',solver.skinFriction()===0);
  check('摩擦なしでも Cd ≥ 0',solver.coeffs.cd>=0,solver.coeffs.cd.toFixed(6));
  solver.setFrictionModel('bogus');
  check('不正キーは無視',solver.frictionModel==='none');
  solver.setFrictionModel('turbulent');

  console.log('\n--- Reynolds数 ---');
  solver.setReynolds(1e6);
  check('Re=1e6 で反映',solver.reynolds===1e6);
  check('Re=1e6 乱流 Cf → 0.004669',Math.abs(solver.skinFriction()-0.004669)<1e-5,solver.skinFriction().toFixed(6));
  check('Re変更で流れ場を再初期化',solver.iteration===0);
  solver.setReynolds(1e9); check('上限 1e7 でクランプ',solver.reynolds===1e7,String(solver.reynolds));
  solver.setReynolds(1); check('下限 1e4 でクランプ',solver.reynolds===1e4,String(solver.reynolds));
  solver.setReynolds(NaN); check('NaNは無視',solver.reynolds===1e4);
  solver.setReynolds(5e4);

  console.log('\n--- NACA 0012相当 · M∞ 0.50 · α 0°（対称・無揚力）---');
  r=run(NACA0012,.5,0,24000);
  console.log(`${fmt(r.coeffs)}`);
  check('対称翼 α=0 で Cl ≈ 0',Math.abs(r.coeffs.cl)<.05,`cl=${r.coeffs.cl.toFixed(4)}`);
  check('対称翼 α=0 で Cm ≈ 0',Math.abs(r.coeffs.cm)<.02,`cm=${r.coeffs.cm.toFixed(4)}`);

  console.log('\n--- 遷音速 · スーパクリティカル基準形状 · M∞ 0.80 · α 2° ---');
  r=run(CFDDefaultGeometry,.8,2,24000);
  console.log(`${fmt(r.coeffs)}  Mmax=${solver.diagnostics.maxSurfaceMach.toFixed(3)} shock=${solver.diagnostics.shockDetected?solver.diagnostics.shockX.toFixed(3):'なし'}`);
  check('遷音速で Cl > 0',r.coeffs.cl>0);
  check('係数がすべて有限',[r.coeffs.cl,r.coeffs.cd,r.coeffs.cm].every(Number.isFinite));

  console.log(`\n${failures===0?'すべて成功':failures+' 件失敗'}`);
  process.exit(failures?1:0);
})();
```

</details>

**引き継ぎ時点の期待値**（全19項目パス、`0.114 ms/step` @ 96×48）:

| ケース | Cl | Cm | Cd（圧力 + 摩擦） | x_cp/c |
|---|---:|---:|---|---:|
| NACA 4412相当 · M0.50 · α4° | 0.7578 | −0.1594 | 0.1164（0.1079 + 0.0085） | 0.460 |
| NACA 0012相当 · M0.50 · α0° | −0.0219 | 0.0084 | 0.0678（0.0593 + 0.0085） | — |
| 基準形状 · M0.80 · α2° | 0.3633 | −0.1028 | 0.0954（0.0869 + 0.0085） | 0.533 |

M0.80のケースは `Mmax = 1.201`、上面衝撃波 `x/c = 0.637`。

### 4.3 全角正規化の単体確認

```bash
node -e "
global.window=global; require('./numeric-fields.js');
for (const [i,e] of [['１４．５','14.5'],['０.６５','0.65'],['－４','-4'],['250,000','250000'],['2e5','2e5'],[' 12 . 5 ','12.5'],['ー３．２','-3.2'],['abc','abc']])
  console.log((CFDNormaliseNumber(i)===e?'PASS':'FAIL')+'  '+JSON.stringify(i)+' → '+JSON.stringify(CFDNormaliseNumber(i)));
"
```

### 4.4 C++再ビルドの整合確認

```bash
make && git diff --stat cfd-core.js cfd-core.wasm   # .cpp未変更なら差分ゼロになるはず
```

---

## 5. 落とし穴・既知の制約

### 5.1 ヘッドレスブラウザでは時間発展を確認できない

Claude Code のブラウザペインは `document.hidden === true` になるため、`requestAnimationFrame` が完全停止し `setTimeout` も1秒程度に絞られる。結果として次が確認できない。

- メインループ（`app.js` の `loop()`）による時間発展
- ジオメトリ適用（`geometry-controls.js` の `schedule()` がrAFスロットリング）
- 収束ログ描画（`analysis-views.js` の `queueDraw()` がrAF）

**回避策。** 検証時は `window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0)` を差し込み、各操作の後に約1.6秒待つ。時間発展を伴う数値の確認は §4.2 のヘッドレス検証で行うこと。**アプリ側の不具合ではないので「RAFが動かない」を理由にコードを変更しないこと。**

また、このペインではキーイベント（`computer key`）が要素へ届かない。Enter・矢印キーの確認は `new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})` の合成ディスパッチで行った。

### 5.2 キャッシュバスター

`index.html` のスクリプト・スタイル参照と `solver.js` の `locateFile`（wasm）にクエリ文字列でバージョンを付けている。現在はすべて `?v=numeric-20260830-3`（wasmのみ `?v=aero-20260830-2`）。**JSやwasmを更新したら必ずこの文字列も更新すること。** 更新漏れがあると利用者のブラウザに古いファイルが残る。

### 5.3 未着手の技術的負債

- **旧レイアウト由来の未使用CSS。** `geometry.css` 全体（`.control-panel` / `.geometry-controls`）と `styles.css` の一部（`.workspace` / `.main-stage` / `.simulation-actions` / `.model-note` / `.section-label` / `.divider`）は現在の `index.html` から参照されていない。今回のセッションでは範囲外として残した
- **浮動小数の桁落ち。** `camber: 2.2 * 0.01 = 0.022000000000000002` のような値が `getGeometry()` に現れる。無害だが気になるなら丸めを入れる余地がある
- **`coeffs.cp` の命名。** 圧力係数ではなく圧力中心 `x_cp/c` を指す。将来のリファクタで `xcp` などへ改名する価値がある

### 5.4 数値モデルの制約（変更前から）

- HLL一次精度で数値粘性が大きく、亜音速の `Cd,pressure` は物理的な抗力ではなく数値散逸の大きさを表す
- 滑り壁近似のため境界層・剥離・失速を定量的に再現できない
- 外部境界は一様流固定（非反射境界ではない）
- 詳細は `README.md` の「適用範囲と制約」を参照

---

## 6. 作業上の約束事

- **言語。** UI文字列・コメント・`README.md` は日本語、識別子は英語。**コミットメッセージとPR本文はこのリポジトリの慣例に従い、コミット件名は英語、PR本文は日本語**（既存の履歴とPR #1・#2に合わせる）
- **コードスタイル。** 既存コードは非常に密（1行に複数文、短い変数名、minifyに近い書き方）。新規コードも周囲に合わせること。ただしコメントは要点に絞って日本語で書く
- **ブランチ運用。** `main` へ直接コミットせず、作業ブランチを切ってからコミットする。本セッションではPR作成後、利用者の指示で `git push origin HEAD:main` による fast-forward で main へ反映した（PRはGitHub側で自動的にMERGED扱いになる）
- **ファイル追加の慣例。** CSSは機能単位で1ファイル追加していく方式（`geometry.css` / `analysis-views.css` / `equal-columns.css` / `airfoil-presets.css` / `flow-parameters.css` / `numeric-fields.css`）。追加したら `index.html` の `<link>` も忘れずに

---

## 7. 次に手を付けるとよい候補

利用者から明示的な依頼は出ていない。以下は本セッション中に把握した改善余地。

1. **未使用CSSの整理**（§5.3）— 影響範囲が狭く安全
2. **`smoke.js` のリポジトリ格納** — 現状この引き継ぎ書にしか存在しない。`tools/` などへ置いて `README.md` に実行方法を書くと再現性が上がる
3. **`coeffs.cp` の改名** — `x_cp` を指す紛らわしい名前
4. **数値精度の向上** — MUSCL/TVD再構成やHLLCへの置き換え。ただし `solver.js` と `cfd-core.cpp` の両方を同期して直す必要がある（§2）
