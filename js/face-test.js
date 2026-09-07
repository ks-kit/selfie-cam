// Phase 3 の検証。本体(index.html)には手を触れず、ここだけで顔検出を試す。
//
// 知りたいのは3つ。
//   1. MediaPipe Face Landmarker が実機で動くか
//   2. 検出に何ミリ秒かかり、frame rate がどこまで落ちるか
//   3. 顔の輪郭から作ったマスクが、肌マスクの代わりに使える形をしているか

import { FaceLandmarker, FaceDetector, FilesetResolver }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';

const WASM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// 顔の枠と6点（両目・鼻・口・両耳）だけを返す軽量な検出器。230KB ほど。
const MODEL_BOX = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const $ = (id) => document.getElementById(id);
const el = {
  state: $('s-state'), fps: $('s-fps'), det: $('s-det'), pts: $('s-pts'),
  video: $('v'), canvas: $('c'), log: $('log'),
  start: $('start'), skip: $('skip'), drawPts: $('draw-pts'), drawMask: $('draw-mask'),
  detRes: $('det-res'), delegate: $('delegate'), engine: $('engine'),
};
const ctx = el.canvas.getContext('2d');

let landmarker = null;
let detector = null;     // 軽量な「顔の枠だけ」検出器
let fileset = null;      // wasm の読み込みは使い回す
let srcW = 0, srcH = 0;  // 検出に渡した映像の大きさ（枠の座標を正規化するのに要る）
let stream = null;
let running = false;
let frame = 0;
let lastResult = null;      // 検出を間引く間はこれを使い回す
let detMs = 0;              // 直近の検出にかかった時間
let frames = 0, lastFpsAt = 0;

const log = (m) => { el.log.textContent = m; };

// 検出に渡す映像を縮小するための作業用キャンバス。
// 顔の位置を知るのに元の解像度は要らず、処理量は面積に比例するので効きが大きい。
// ランドマークは 0〜1 の正規化座標で返るため、縮小しても座標はそのまま使える。
const small = document.createElement('canvas');
const sctx = small.getContext('2d', { alpha: false });

function detectSource() {
  const target = parseInt(el.detRes.value, 10);
  if (!target) { srcW = el.video.videoWidth; srcH = el.video.videoHeight; return el.video; }
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  const s = Math.min(1, target / Math.max(vw, vh));
  const w = Math.max(2, Math.round(vw * s)), h = Math.max(2, Math.round(vh * s));
  if (small.width !== w || small.height !== h) { small.width = w; small.height = h; }
  sctx.drawImage(el.video, 0, 0, w, h);
  srcW = w; srcH = h;
  return small;
}

/* ---------- 顔の各部位の点の並びを作る ---------- */
// MediaPipe が配るのは {start,end} の集合なので、繋いで閉じた輪郭に直す。
// 決め打ちの番号表を持たずに済むので、バージョンが変わっても壊れにくい。
function loopFromConnections(conns) {
  if (!conns || !conns.length) return [];
  const next = new Map();
  for (const c of conns) next.set(c.start, c.end);
  const first = conns[0].start;
  const out = [first];
  let cur = next.get(first);
  while (cur !== undefined && cur !== first && out.length < 400) {
    out.push(cur);
    cur = next.get(cur);
  }
  return out;
}

let PART = null;
function buildParts() {
  const F = FaceLandmarker;
  PART = {
    oval:   loopFromConnections(F.FACE_LANDMARKS_FACE_OVAL),
    lips:   loopFromConnections(F.FACE_LANDMARKS_LIPS),
    eyeL:   loopFromConnections(F.FACE_LANDMARKS_LEFT_EYE),
    eyeR:   loopFromConnections(F.FACE_LANDMARKS_RIGHT_EYE),
    browL:  loopFromConnections(F.FACE_LANDMARKS_LEFT_EYEBROW),
    browR:  loopFromConnections(F.FACE_LANDMARKS_RIGHT_EYEBROW),
  };
  return Object.entries(PART).map(([k, v]) => `${k}:${v.length}`).join(' ');
}

/* ---------- 初期化 ---------- */
async function initFace() {
  el.state.textContent = '読込中';
  const t0 = performance.now();
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(WASM);

  if (el.engine.value === 'mesh') {
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: el.delegate.value },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    detector = null;
    const ms = Math.round(performance.now() - t0);
    log(`輪郭478点 / 読み込み ${ms}ms (${el.delegate.value}) / ${buildParts()}`);
  } else {
    detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_BOX, delegate: el.delegate.value },
      runningMode: 'VIDEO',
    });
    landmarker = null;
    const ms = Math.round(performance.now() - t0);
    log(`顔の枠だけ / 読み込み ${ms}ms (${el.delegate.value})`);
  }
}

async function start() {
  el.start.disabled = true;
  try {
    if (!landmarker && !detector) await initFace();
  } catch (e) {
    el.state.textContent = '読込失敗';
    log('MediaPipe の読み込みに失敗: ' + e.message);
    el.start.disabled = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    el.state.textContent = 'カメラ失敗';
    log('カメラを開けません: ' + e.name + ' ' + e.message);
    el.start.disabled = false;
    return;
  }
  el.video.srcObject = stream;
  await el.video.play();
  while (el.video.videoWidth === 0) await new Promise(requestAnimationFrame);

  el.canvas.width = el.video.videoWidth;
  el.canvas.height = el.video.videoHeight;
  el.state.textContent = '動作中';
  el.start.textContent = '停止';
  el.start.disabled = false;
  running = true;
  frames = 0; lastFpsAt = performance.now();
  loop();
}

function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  el.video.srcObject = null;
  el.state.textContent = '停止';
  el.start.textContent = 'カメラを起動';
}

/* ---------- 毎フレームの処理 ---------- */
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (el.video.readyState < 2) return;

  const skip = parseInt(el.skip.value, 10);
  frame++;

  // 検出は間引く。顔は急に動かないので、間はひとつ前の結果を使い回せる。
  if (frame % skip === 0) {
    const t0 = performance.now();
    try {
      const src = detectSource();
      lastResult = landmarker
        ? landmarker.detectForVideo(src, t0)
        : detector.detectForVideo(src, t0);
    } catch (e) {
      log('検出に失敗: ' + e.message);
      lastResult = null;
    }
    detMs = detMs * 0.8 + (performance.now() - t0) * 0.2;   // ならして表示
  }

  render();

  frames++;
  const now = performance.now();
  if (now - lastFpsAt >= 500) {
    el.fps.textContent = ((frames * 1000) / (now - lastFpsAt)).toFixed(1);
    el.det.textContent = detMs.toFixed(1) + ' ms';
    frames = 0; lastFpsAt = now;
  }
}

function poly(lm, idx, w, h) {
  ctx.beginPath();
  for (let k = 0; k < idx.length; k++) {
    const p = lm[idx[k]];
    if (!p) continue;
    const x = p.x * w, y = p.y * h;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 「顔の枠だけ」の結果から描く。
// 枠から楕円を作って顔の内側とし、目と口はキーポイントの周りを円で抜く。
// 輪郭478点ほど正確ではないが、背景を除外する目的なら足りるはず、という検証。
function renderBox() {
  const w = el.canvas.width, h = el.canvas.height;
  const d = lastResult?.detections?.[0];
  ctx.clearRect(0, 0, w, h);
  el.pts.textContent = d ? `枠${lastResult.detections.length}` : '検出なし';
  if (!d) return;

  // 枠は検出に渡した映像のピクセル座標なので、正規化してから描画側に合わせる
  const b = d.boundingBox;
  const cx = ((b.originX + b.width  / 2) / srcW) * w;
  const cy = ((b.originY + b.height / 2) / srcH) * h;
  const rx = (b.width  / srcW) * w * 0.58;   // 枠より少し広げて顔全体を覆う
  const ry = (b.height / srcH) * h * 0.62;

  const kp = d.keypoints || [];
  const P = (i) => (kp[i] ? { x: kp[i].x * w, y: kp[i].y * h } : null);
  const eyeR = P(0), eyeL = P(1), mouth = P(3);
  const eyeGap = (eyeR && eyeL) ? Math.hypot(eyeL.x - eyeR.x, eyeL.y - eyeR.y) : rx * 0.6;

  if (el.drawMask.checked) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#000';
    for (const p of [eyeR, eyeL]) {
      if (!p) continue;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, eyeGap * 0.30, eyeGap * 0.20, 0, 0, 6.283); ctx.fill();
    }
    if (mouth) {
      ctx.beginPath(); ctx.ellipse(mouth.x, mouth.y, eyeGap * 0.42, eyeGap * 0.26, 0, 0, 6.283); ctx.fill();
    }
    return;
  }

  ctx.lineWidth = Math.max(1.5, w / 640);
  ctx.strokeStyle = 'rgba(79,209,197,.95)';
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 6.283); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.strokeRect((b.originX / srcW) * w, (b.originY / srcH) * h,
                 (b.width / srcW) * w, (b.height / srcH) * h);
  ctx.fillStyle = 'rgba(255,120,120,.95)';
  for (const p of kp) {
    ctx.beginPath(); ctx.arc(p.x * w, p.y * h, Math.max(3, w / 220), 0, 6.283); ctx.fill();
  }
}

function render() {
  if (detector) { renderBox(); return; }

  const w = el.canvas.width, h = el.canvas.height;
  const lm = lastResult?.faceLandmarks?.[0];

  ctx.clearRect(0, 0, w, h);
  el.pts.textContent = lm ? lm.length : '検出なし';
  if (!lm) return;

  if (el.drawMask.checked) {
    // 本番で肌マスクに掛ける予定の形。顔の内側だけを白にし、
    // 目・眉・唇は補正から守りたいので黒で抜く。
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    poly(lm, PART.oval, w, h); ctx.fill();
    ctx.fillStyle = '#000';
    for (const k of ['lips', 'eyeL', 'eyeR', 'browL', 'browR']) {
      poly(lm, PART[k], w, h); ctx.fill();
    }
  } else {
    ctx.lineWidth = Math.max(1.5, w / 640);
    ctx.strokeStyle = 'rgba(79,209,197,.95)';
    poly(lm, PART.oval, w, h); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,120,120,.95)';
    for (const k of ['lips', 'eyeL', 'eyeR', 'browL', 'browR']) {
      poly(lm, PART[k], w, h); ctx.stroke();
    }
    if (el.drawPts.checked) {
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      const r = Math.max(1, w / 900);
      for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, r, 0, 6.283); ctx.fill(); }
    }
  }
}

el.start.addEventListener('click', () => (running ? stop() : start()));

// 処理系を切り替えたら作り直す。動作中でもその場で入れ替わる。
el.engine.addEventListener('change', () => el.delegate.dispatchEvent(new Event('change')));
el.delegate.addEventListener('change', async () => {
  el.state.textContent = '切替中';
  try {
    landmarker?.close?.();
    detector?.close?.();
  } catch (_) {}
  landmarker = null;
  detector = null;
  lastResult = null;
  detMs = 0;
  try {
    await initFace();
    el.state.textContent = running ? '動作中' : '待機';
  } catch (e) {
    el.state.textContent = '切替失敗';
    log(el.delegate.value + ' での初期化に失敗: ' + e.message);
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop(); });

if (!window.isSecureContext) {
  el.state.textContent = 'https 必要';
  log('カメラは https か localhost でしか使えません');
}
