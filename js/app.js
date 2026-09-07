// 美顔カメラ本体。カメラ制御・補正パラメータ・撮影・保存を受け持つ。
// 補正処理そのものは renderer.js と shaders.js 側にある。

import { Renderer, DEFAULT_PARAMS } from './renderer.js';

const $ = (id) => document.getElementById(id);

const el = {
  state: $('d-state'), res: $('d-res'), fps: $('d-fps'), cam: $('d-cam'),
  canvas: $('view'), video: $('src'),
  startOverlay: $('start-overlay'), btnStart: $('btn-start'),
  err: $('err'), errTitle: $('err-title'), errMsg: $('err-msg'), btnRetry: $('btn-retry'),
  selRes: $('sel-res'),
  chkMirrorPreview: $('chk-mirror-preview'),
  btnFlip: $('btn-flip'), btnShutter: $('btn-shutter'), btnStop: $('btn-stop'),
  preview: $('preview'), pvImg: $('pv-img'), pvScroll: $('pv-scroll'),
  pvInfo: $('pv-info'), btnBack: $('btn-back'), btnZoom: $('btn-zoom'),
  btnSave: $('btn-save'), btnShare: $('btn-share'), toast: $('toast'),
  presets: $('presets'), btnPresetMy: $('btn-preset-my'), hint: $('hint'),
  tune: $('tune'), btnTuneOpen: $('btn-tune-open'), btnTuneClose: $('btn-tune-close'),
  btnTuneReset: $('btn-tune-reset'), btnTuneSave: $('btn-tune-save'), chkMask: $('chk-mask'),
};

// 要求する解像度。実際に返る値は端末とブラウザ次第なので必ず表示して確認する。
const RES = {
  max: { w: 3840, h: 2160 },
  fhd: { w: 1920, h: 1080 },
  hd:  { w: 1280, h: 720  },
};

// プリセット。実機で見ながら調整した値（2026-09-07）。
// 当初の設定は全体に効きが弱かったため一段強くし、
// 元の「ナチュラル」相当は「ひかえめ」として残してある。
const PRESETS = {
  off:     { smooth: 0.00, detail: 0.45, brightness: 0.00, contrast: 0.00, saturation:  0.00, warmth:  0.00, skinTone: 0.00, radius:  6 },
  light:   { smooth: 0.55, detail: 0.55, brightness: 0.06, contrast: 0.02, saturation:  0.02, warmth:  0.02, skinTone: 0.10, radius:  6 },
  natural: { smooth: 0.85, detail: 0.38, brightness: 0.11, contrast: 0.03, saturation:  0.03, warmth:  0.03, skinTone: 0.18, radius:  8 },
  strong:  { smooth: 1.00, detail: 0.22, brightness: 0.15, contrast: 0.04, saturation:  0.05, warmth:  0.04, skinTone: 0.28, radius: 11 },
  fair:    { smooth: 0.88, detail: 0.38, brightness: 0.20, contrast: 0.02, saturation: -0.04, warmth: -0.08, skinTone: 0.38, radius:  8 },
  warm:    { smooth: 0.88, detail: 0.38, brightness: 0.12, contrast: 0.03, saturation:  0.14, warmth:  0.20, skinTone: 0.22, radius:  8 },
};

// プリセットの数値を変えたので、保存済みの旧設定は読み込まないようキーを上げる
const STORE_KEY = 'beautycam.v2';

const state = {
  stream: null,
  track: null,
  facing: 'user',      // 'user' = インカメラ / 'environment' = アウトカメラ
  running: false,
  rafId: null,
  frames: 0,
  lastFpsAt: 0,
  shot: null,          // { blob, url, w, h }
  params: { ...DEFAULT_PARAMS, ...PRESETS.natural },
  preset: 'natural',
  my: null,            // ユーザーが保存した設定
  comparing: false,    // 長押し中は補正前を表示
};

// 処理解像度の目安（長辺の画素数）。
//
// プレビューは画面に映る以上の細かさで計算しても見えないので、ここまで落とす。
// 4K を選んでも画面は 1080×2340 しかなく、そのまま処理すると 4 倍の画素を
// 無駄に計算して frame rate だけが落ちる。
// 撮影の瞬間だけカメラのフル解像度に切り替えるので、保存される写真は 4K のまま。
const PREVIEW_MAX_LONG    = 1920;   // プレビューの出力解像度
const PREVIEW_BLUR_TARGET = 720;    // プレビューのぼかし解像度
const CAPTURE_BLUR_TARGET = 1440;   // 撮影時のぼかし解像度
const blurScaleFor = (w, h, target) => Math.min(1, target / Math.max(w, h));

function applyPreviewSize(vw, vh) {
  const s = Math.min(1, PREVIEW_MAX_LONG / Math.max(vw, vh));
  const w = Math.round(vw * s), h = Math.round(vh * s);
  renderer.resize(w, h, blurScaleFor(w, h, PREVIEW_BLUR_TARGET));
}

const renderer = new Renderer(el.canvas);

/* ---------------- カメラ ---------------- */

async function startCamera() {
  stopCamera();
  setState('起動中…');

  const want = RES[el.selRes.value];

  // facingMode は exact で狙い、通らない端末では ideal に落とす
  const attempts = [
    { video: { facingMode: { exact: state.facing }, width: { ideal: want.w }, height: { ideal: want.h } }, audio: false },
    { video: { facingMode: state.facing,            width: { ideal: want.w }, height: { ideal: want.h } }, audio: false },
    { video: { facingMode: state.facing }, audio: false },
    { video: true, audio: false },
  ];

  let stream = null, lastErr = null;
  for (const c of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch (e) {
      lastErr = e;
      // 権限そのものを断られた場合は解像度を落としても無駄なので即中断
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
    }
  }
  if (!stream) { showError(lastErr); return; }

  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  el.video.srcObject = stream;

  try { await el.video.play(); }
  catch (e) { showError(e); return; }

  await waitForVideoSize();

  const s = state.track.getSettings();
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  applyPreviewSize(vw, vh);

  el.res.textContent = `${vw}×${vh}`;
  el.cam.textContent = state.facing === 'user' ? '前面' : '背面';
  hideOverlays();
  setState('動作中');
  showHint();

  state.running = true;
  state.frames = 0;
  state.lastFpsAt = performance.now();
  loop();
}

// videoWidth が 0 のまま描画すると真っ黒になるので、確定するまで待つ
function waitForVideoSize(timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if (el.video.videoWidth > 0 || performance.now() - t0 > timeout) return resolve();
      requestAnimationFrame(check);
    };
    check();
  });
}

function stopCamera() {
  state.running = false;
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  state.track = null;
  el.video.srcObject = null;
}

function loop() {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(loop);

  if (el.video.readyState >= 2) {
    renderer.draw(el.video, {
      ...state.params,
      flipX: el.chkMirrorPreview.checked,
      maskOnly: el.chkMask.checked,
      bypass: state.comparing || state.preset === 'off',
    });
    state.frames++;
  }

  const now = performance.now();
  if (now - state.lastFpsAt >= 500) {
    const fps = (state.frames * 1000) / (now - state.lastFpsAt);
    el.fps.textContent = fps.toFixed(1);
    state.frames = 0;
    state.lastFpsAt = now;
  }
}

/* ---------------- 撮影 ---------------- */

async function capture() {
  if (!state.running) return;

  // 撮影はカメラのフル解像度で行う。プレビューは軽さのために縮小してあるので、
  // ここで一度だけ本来の解像度に切り替え、ぼかしも高い解像度でかけ直す。
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  const pw = renderer.width, ph = renderer.height, ps = renderer.blurScale;

  renderer.resize(vw, vh, blurScaleFor(vw, vh, CAPTURE_BLUR_TARGET));
  // 保存は常に実際の向き（鏡像にしない）。純正カメラと同じ挙動で、
  // 写り込んだ文字も鏡文字にならない。プレビューだけを鏡像で見せている。
  renderer.draw(el.video, {
    ...state.params,
    flipX: false,
    bypass: state.preset === 'off',
  });

  let blob;
  try { blob = await renderer.toBlob('image/jpeg', 0.95); }
  catch (e) { toast(e.message); return; }
  finally { renderer.resize(pw, ph, ps); }   // プレビュー用の解像度に戻す

  if (state.shot?.url) URL.revokeObjectURL(state.shot.url);
  state.shot = { blob, url: URL.createObjectURL(blob), w: vw, h: vh };

  el.pvImg.src = state.shot.url;
  el.pvInfo.textContent =
    `${state.shot.w}×${state.shot.h} / ${(blob.size / 1024 / 1024).toFixed(2)} MB / JPEG 95%`;
  el.pvScroll.classList.remove('actual');
  el.btnZoom.textContent = '等倍で見る';
  el.preview.classList.remove('hidden');
}

// 保存方法は OS で分ける。
//   iOS     : 共有シートの「画像を保存」だけがカメラロールに入れる唯一の手段。
//   Android : 共有シートに「画像を保存」が無い。ダウンロードが正解で、
//             保存先の Download フォルダはギャラリーからも見える。
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 保存も共有も、必ずボタンのタップから直接呼ぶ。
// iOS は共有シートをタップ直後にしか開けず、撮影処理を挟むと弾かれるため。
async function save() {
  if (!state.shot) return;
  const name = `selfie_${timestamp()}.jpg`;

  if (IS_IOS) {
    const file = new File([state.shot.blob], name, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
  }

  // ダウンロード（Android の本命。iOS でも共有が使えなければここに落ちる）
  try {
    const a = document.createElement('a');
    a.href = state.shot.url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(IS_IOS ? 'ファイルに保存しました' : 'Download フォルダに保存しました');
    return;
  } catch (_) { /* 最後の手段へ */ }

  // 最後の手段：新しいタブで開いて長押し保存
  window.open(state.shot.url, '_blank');
  toast('画像を長押しして「画像を保存」を選んでください');
}

// 共有シートを開く（他アプリへ送りたいとき用。保存とは別物）
async function share() {
  if (!state.shot) return;
  const name = `selfie_${timestamp()}.jpg`;
  const file = new File([state.shot.blob], name, { type: 'image/jpeg' });
  if (!navigator.canShare?.({ files: [file] })) {
    toast('この環境では共有できません');
    return;
  }
  try { await navigator.share({ files: [file] }); }
  catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした'); }
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
}

function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------------- 表示まわり ---------------- */

function setState(s) { el.state.textContent = s; }

function hideOverlays() {
  el.startOverlay.classList.add('hidden');
  el.err.classList.add('hidden');
}

function showError(e) {
  stopCamera();
  setState('エラー');
  const map = {
    NotAllowedError: ['カメラの使用が許可されませんでした',
      'ブラウザの設定でこのサイトのカメラを「許可」にしてから再試行してください。\n' +
      'iPhone: 設定 → Safari → カメラ\nAndroid: アドレスバーの鍵アイコン → 権限'],
    NotFoundError: ['カメラが見つかりません', 'この端末で使えるカメラが検出できませんでした。'],
    NotReadableError: ['カメラを開けません', '他のアプリがカメラを使用中の可能性があります。閉じてから再試行してください。'],
    OverconstrainedError: ['この解像度に対応していません', '解像度を下げて再試行してください。'],
    SecurityError: ['安全な接続ではありません', 'カメラは https:// または localhost でのみ使用できます。'],
  };
  const [title, msg] = map[e?.name] || ['カメラを起動できませんでした', String(e?.message || e)];
  el.errTitle.textContent = title;
  el.errMsg.textContent = msg;
  el.startOverlay.classList.add('hidden');
  el.err.classList.remove('hidden');
}

/* ---------------- イベント ---------------- */

el.btnStart.addEventListener('click', startCamera);
el.btnRetry.addEventListener('click', startCamera);
el.btnShutter.addEventListener('click', capture);
el.btnStop.addEventListener('click', () => {
  stopCamera();
  setState('停止');
  el.fps.textContent = '—';
  el.startOverlay.classList.remove('hidden');
});
el.btnFlip.addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  // アウトカメラは鏡像にしないのが自然
  el.chkMirrorPreview.checked = state.facing === 'user';
  startCamera();
});
el.selRes.addEventListener('change', () => { if (state.running) startCamera(); });

el.btnBack.addEventListener('click', () => el.preview.classList.add('hidden'));
el.btnZoom.addEventListener('click', () => {
  const actual = el.pvScroll.classList.toggle('actual');
  el.btnZoom.textContent = actual ? '画面に合わせる' : '等倍で見る';
});
el.btnSave.addEventListener('click', save);
el.btnShare.addEventListener('click', share);

// タブが隠れている間はカメラを止めて発熱と電池を抑える
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.running) {
    stopCamera();
    setState('中断（バックグラウンド）');
    el.startOverlay.classList.remove('hidden');
  }
});

/* ---------------- 補正パラメータ ---------------- */

const fmtVal = (v) => {
  const n = parseFloat(v);
  return Math.abs(n) >= 2 ? n.toFixed(1) : n.toFixed(2);
};

function applyPreset(name) {
  const src = name === 'my' ? state.my : PRESETS[name];
  if (!src) return;
  state.preset = name;
  state.params = { ...DEFAULT_PARAMS, ...src };
  syncPresetButtons();
  syncSliders();
  persist();
}

function syncPresetButtons() {
  el.presets.querySelectorAll('button[data-preset]').forEach((b) => {
    b.classList.toggle('on', b.dataset.preset === state.preset);
  });
  el.btnPresetMy.hidden = !state.my;
}

function syncSliders() {
  el.tune.querySelectorAll('input[data-p]').forEach((inp) => {
    const v = state.params[inp.dataset.p];
    if (v === undefined) return;
    inp.value = v;
    inp.nextElementSibling.value = fmtVal(v);
  });
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      preset: state.preset, params: state.params, my: state.my,
      mirrorPreview: el.chkMirrorPreview.checked,
      res: el.selRes.value,
    }));
  } catch (_) { /* 保存できない環境でも動作には支障がないので無視する */ }
}

function restore() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) {}
  if (d) {
    state.my = d.my || null;
    if (d.params) state.params = { ...DEFAULT_PARAMS, ...d.params };
    if (d.preset) state.preset = d.preset;
    if (typeof d.mirrorPreview === 'boolean') el.chkMirrorPreview.checked = d.mirrorPreview;
    if (d.res && RES[d.res]) el.selRes.value = d.res;
  }
  syncPresetButtons();
  syncSliders();
}

function showHint() {
  el.hint.classList.add('show');
  setTimeout(() => el.hint.classList.remove('show'), 3000);
}

/* ---------------- 補正まわりのイベント ---------------- */

el.presets.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-preset]');
  if (b) applyPreset(b.dataset.preset);
});

el.tune.querySelectorAll('input[data-p]').forEach((inp) => {
  inp.addEventListener('input', () => {
    state.params[inp.dataset.p] = parseFloat(inp.value);
    inp.nextElementSibling.value = fmtVal(inp.value);
    persist();
  });
});

el.btnTuneOpen.addEventListener('click', () => el.tune.classList.remove('hidden'));
el.btnTuneClose.addEventListener('click', () => el.tune.classList.add('hidden'));
el.btnTuneReset.addEventListener('click', () => applyPreset(state.preset));
el.btnTuneSave.addEventListener('click', () => {
  state.my = { ...state.params };
  state.preset = 'my';
  syncPresetButtons();
  persist();
  toast('マイ設定として保存しました');
});

el.chkMirrorPreview.addEventListener('change', persist);

// 画面を長押ししている間だけ補正前を表示して見比べられるようにする
let pressTimer = null;
el.canvas.addEventListener('pointerdown', () => {
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { state.comparing = true; }, 220);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  el.canvas.addEventListener(ev, () => {
    clearTimeout(pressTimer);
    state.comparing = false;
  }));
el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- 起動時チェック ---------------- */

(function boot() {
  if (!window.isSecureContext) {
    showError({ name: 'SecurityError' });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showError({ message: 'このブラウザはカメラに対応していません。' });
    return;
  }
  try {
    renderer.init();
  } catch (e) {
    showError(e.message === 'WEBGL2_UNSUPPORTED'
      ? { message: 'この端末は WebGL2 に対応していないため、リアルタイム補正は動作しません。' }
      : e);
    return;
  }
  restore();
  setState('待機中');
})();
