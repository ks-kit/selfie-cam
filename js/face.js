// 顔検出と「顔マスク」の生成。
//
// 肌の判定は色だけで行ってきたので、唇と暖色の背景が肌と区別できなかった。
// 顔の輪郭の内側だけを対象にすれば、その2つをまとめて外せる。
//
// 検出は1回 48ms 前後かかり、毎フレームは間に合わない（実測・SH-M29）。
// そこで数フレームに1回だけ検出し、間はひとつ前のマスクを使い回す。
// 顔は急に動かないうえ、マスクの縁はぼかしてあるので、多少の遅れは目に見えない。

import { FaceLandmarker, FilesetResolver }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';

const WASM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const MASK_LONG = 256;   // マスクの長辺。輪郭は緩い形なのでこれで足りる

// MediaPipe が配るのは {start,end} の集合なので、繋いで閉じた輪郭に直す
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

export class FaceMask {
  constructor() {
    this.landmarker = null;
    this.parts = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.canvas.width = 2; this.canvas.height = 2;
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, 2, 2);      // 初期状態は全面白＝補正を制限しない

    this.ready = false;
    this.loading = false;
    this.hasFace = false;
    this.frame = 0;
    this.skip = 4;          // 何フレームに1回検出するか
    this.detMs = 0;
    this.error = null;
  }

  async init(delegate = 'GPU') {
    if (this.ready || this.loading) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
      const F = FaceLandmarker;
      this.parts = {
        oval:  loopFromConnections(F.FACE_LANDMARKS_FACE_OVAL),
        lips:  loopFromConnections(F.FACE_LANDMARKS_LIPS),
        eyeL:  loopFromConnections(F.FACE_LANDMARKS_LEFT_EYE),
        eyeR:  loopFromConnections(F.FACE_LANDMARKS_RIGHT_EYE),
        browL: loopFromConnections(F.FACE_LANDMARKS_LEFT_EYEBROW),
        browR: loopFromConnections(F.FACE_LANDMARKS_RIGHT_EYEBROW),
      };
      this.ready = true;
      this.error = null;
    } catch (e) {
      this.error = e.message || String(e);
      throw e;
    } finally {
      this.loading = false;
    }
  }

  dispose() {
    try { this.landmarker?.close?.(); } catch (_) {}
    this.landmarker = null;
    this.ready = false;
    this.hasFace = false;
    this._blank();
  }

  _blank() {
    if (this.canvas.width !== 2) { this.canvas.width = 2; this.canvas.height = 2; }
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, 2, 2);
  }

  _poly(lm, idx, w, h) {
    const c = this.ctx;
    c.beginPath();
    for (let k = 0; k < idx.length; k++) {
      const p = lm[idx[k]];
      if (!p) continue;
      const x = p.x * w, y = p.y * h;
      if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }

  // 数フレームに1回だけ検出し、マスクを描き直す。
  // 検出しなかったフレームでは何もしないので、前回のマスクがそのまま使われる。
  update(video, now) {
    if (!this.ready || !video || video.readyState < 2) return;
    this.frame++;
    if (this.frame % this.skip !== 0) return;

    const t0 = performance.now();
    let res = null;
    try {
      res = this.landmarker.detectForVideo(video, t0);
    } catch (_) {
      return;
    }
    this.detMs = this.detMs * 0.8 + (performance.now() - t0) * 0.2;

    const lm = res?.faceLandmarks?.[0];
    if (!lm) {
      // 顔が見つからないときは全面白に戻す。
      // 補正が急に消えるより、顔検出が無かった頃と同じ挙動になるほうが自然。
      if (this.hasFace) { this.hasFace = false; this._blank(); }
      return;
    }
    this.hasFace = true;

    const vw = video.videoWidth, vh = video.videoHeight;
    const s = MASK_LONG / Math.max(vw, vh);
    const w = Math.max(2, Math.round(vw * s)), h = Math.max(2, Math.round(vh * s));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }

    const c = this.ctx;
    c.filter = 'none';
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);

    // 縁をぼかして、検出の遅れやわずかなズレが縁に出ないようにする
    c.filter = `blur(${Math.max(2, Math.round(w * 0.02))}px)`;
    c.fillStyle = '#fff';
    this._poly(lm, this.parts.oval, w, h); c.fill();

    // 目・眉・唇は補正から守る。ここも縁をぼかす
    c.fillStyle = '#000';
    for (const k of ['lips', 'eyeL', 'eyeR', 'browL', 'browR']) {
      this._poly(lm, this.parts[k], w, h); c.fill();
    }
    c.filter = 'none';
  }
}
