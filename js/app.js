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
  diag: $('diag'), chkDiag: $('chk-diag'), chkQuick: $('chk-quick'),
  btnTimer: $('btn-timer'), countdown: $('countdown'), cdNum: $('cd-num'),
  thumb: $('thumb'), thumbImg: $('thumb-img'),
  btnLook: $('btn-look'), looks: $('looks'), lookList: $('look-list'), lookAmount: $('look-amount'),
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
//
// detail（質感の戻し量）は 2026-09-07 に引き上げた。肌マスクを締めた分、
// ぼかしが肌に集中するようになったため、以前の低い値では肌がのっぺりしすぎる。
//
// shadow（髭・くま）は実機で詰めて 0.10 に落ち着いた。当初 0.40 では顔が平坦になり、
// 自然な陰影を守る仕組みを入れたあとでも 0.30 はまだ強かった。効かせすぎない方が良い。
const PRESETS = {
  off:     { smooth: 0.00, detail: 0.45, brightness: 0.00, contrast: 0.00, saturation:  0.00, warmth:  0.00, skinTone: 0.00, shadow: 0.00, even: 0.00, radius:  6 },
  light:   { smooth: 0.55, detail: 0.60, brightness: 0.06, contrast: 0.02, saturation:  0.02, warmth:  0.02, skinTone: 0.10, shadow: 0.06, even: 0.10, radius:  6 },
  natural: { smooth: 0.85, detail: 0.48, brightness: 0.11, contrast: 0.03, saturation:  0.03, warmth:  0.03, skinTone: 0.18, shadow: 0.10, even: 0.18, radius:  8 },
  strong:  { smooth: 1.00, detail: 0.34, brightness: 0.15, contrast: 0.04, saturation:  0.05, warmth:  0.04, skinTone: 0.28, shadow: 0.18, even: 0.32, radius: 11 },
  fair:    { smooth: 0.88, detail: 0.48, brightness: 0.20, contrast: 0.02, saturation: -0.04, warmth: -0.08, skinTone: 0.38, shadow: 0.12, even: 0.20, radius:  8 },
  warm:    { smooth: 0.88, detail: 0.48, brightness: 0.12, contrast: 0.03, saturation:  0.14, warmth:  0.20, skinTone: 0.22, shadow: 0.10, even: 0.20, radius:  8 },
};

// プリセットの数値を変えたので、保存済みの旧設定は読み込まないようキーを上げる
const STORE_KEY = 'beautycam.v9';

const state = {
  stream: null,
  track: null,
  facing: 'user',      // 'user' = インカメラ / 'environment' = アウトカメラ
  running: false,
  camOk: false,       // 一度でもカメラを開けたか。次回の自動起動の判断に使う
  timer: 0,           // セルフタイマーの秒数。0 はオフ
  look: 0,            // 色味フィルター。0 はなし
  lookAmount: 1.0,    // 色味の強さ
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

// auto = true は「ボタンを押さずに試している」状態。
// 断られてもエラー画面は出さず、起動ボタンに戻すだけにする。
async function startCamera({ auto = false } = {}) {
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
  if (!stream) { auto ? showStart() : showError(lastErr); return; }

  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  el.video.srcObject = stream;

  try { await el.video.play(); }
  catch (e) { auto ? showStart() : showError(e); return; }

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

  // 一度開けたので、次回からはボタンを挟まずに試してよい
  if (!state.camOk) { state.camOk = true; persist(); }
}

function showStart() {
  stopCamera();
  setState('待機中');
  el.err.classList.add('hidden');
  el.startOverlay.classList.remove('hidden');
}

// 2回目以降はボタンを押さずにカメラを開く。
//
// getUserMedia はユーザー操作を要求されることがあり、その場合は失敗する。
// 失敗したら起動ボタンに戻すだけなので、試すこと自体に副作用はない。
async function tryAutoStart() {
  let perm = null;
  try {
    const st = await navigator.permissions?.query({ name: 'camera' });
    if (st) perm = st.state;
  } catch (_) {
    // Safari は camera を照会できない。過去に開けた記録の方で判断する。
  }
  if (perm === 'denied') return;                       // 明示的に拒否されている
  if (perm !== 'granted' && !state.camOk) return;      // 初回は必ずボタンから
  await startCamera({ auto: true });
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
  cancelCountdown();          // 停止・カメラ切替・解像度変更のいずれでも秒読みは無効にする
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
      look: state.look, lookAmount: state.lookAmount,
      flipX: el.chkMirrorPreview.checked,
      maskOnly: el.chkMask.checked,
      // 美顔がオフでも色味だけは効かせたいので、両方オフのときだけ素通しにする
      bypass: state.comparing || (state.preset === 'off' && state.look === 0),
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
    look: state.look, lookAmount: state.lookAmount,
    flipX: false,
    bypass: state.preset === 'off' && state.look === 0,
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

  // 直前の一枚を隅に残す。
  // 「撮ったらすぐ保存」でプレビューを飛ばしたときの、写真への戻り道にもなる。
  showThumb(state.shot.url);

  // 「撮ったらすぐ保存」がオンなら、プレビューを挟まずに保存へ進む。
  // 保存しきれなかった場合（iOS で共有シートが弾かれた、ユーザーがやめた）は
  // 今までどおりプレビューを見せるので、撮った写真を取りこぼすことはない。
  if (el.chkQuick.checked && (await storeShot()) === 'ok') {
    toast(IS_IOS ? '保存しました' : 'Download フォルダに保存しました');
    return;
  }

  el.preview.classList.remove('hidden');
}

// 保存方法は OS で分ける。
//   iOS     : 共有シートの「画像を保存」だけがカメラロールに入れる唯一の手段。
//   Android : 共有シートに「画像を保存」が無い。ダウンロードが正解で、
//             保存先の Download フォルダはギャラリーからも見える。
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 写真を端末に残す。戻り値は 'ok' | 'cancel' | 'blocked'。
//
// iOS の共有シートはタップ直後にしか開けない、という制約がある。
// ただし 2026-09-07 に iPhone 15 Pro で試したところ、撮影処理を挟んでも開けた。
// 撮影が長引く（4K など）と間に合わない可能性は残るので、
// 弾かれた場合は 'blocked' を返して呼び出し側にプレビューを出させる。
async function storeShot() {
  const name = `selfie_${timestamp()}.jpg`;

  if (IS_IOS) {
    const file = new File([state.shot.blob], name, { type: 'image/jpeg' });
    if (!navigator.canShare?.({ files: [file] })) return 'blocked';
    try { await navigator.share({ files: [file] }); return 'ok'; }
    catch (e) { return e.name === 'AbortError' ? 'cancel' : 'blocked'; }
  }

  // ダウンロード（Android の本命）
  try {
    const a = document.createElement('a');
    a.href = state.shot.url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return 'ok';
  } catch (_) { return 'blocked'; }
}

async function save() {
  if (!state.shot) return;
  const r = await storeShot();
  if (r === 'ok' && !IS_IOS) toast('Download フォルダに保存しました');
  if (r === 'blocked') {
    // 最後の手段：新しいタブで開いて長押し保存
    window.open(state.shot.url, '_blank');
    toast('画像を長押しして「画像を保存」を選んでください');
  }
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

/* ---------------- 色味フィルター ---------------- */

const LOOK_NAMES = ['色味', 'フィルム', 'クリア', 'やわらか', 'ノスタルジー', 'クール', 'モノクロ'];

function syncLook() {
  el.btnLook.textContent = LOOK_NAMES[state.look] || '色味';
  el.btnLook.classList.toggle('on', state.look > 0);
  el.lookList.querySelectorAll('button[data-look]').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.look) === state.look);
  });
  el.lookAmount.value = state.lookAmount;
  el.lookAmount.nextElementSibling.value = fmtVal(state.lookAmount);
  // 「なし」のときは強さをいじっても意味がないので触れなくする
  el.lookAmount.disabled = state.look === 0;
}

el.btnLook.addEventListener('click', () => {
  el.looks.classList.toggle('hidden');
  el.thumb.classList.add('hidden');   // 一覧と重なるので引っ込める
});

el.lookList.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-look]');
  if (!b) return;
  state.look = Number(b.dataset.look);
  syncLook();
  persist();
});

el.lookAmount.addEventListener('input', () => {
  state.lookAmount = parseFloat(el.lookAmount.value);
  el.lookAmount.nextElementSibling.value = fmtVal(state.lookAmount);
});
el.lookAmount.addEventListener('change', persist);

/* ---------------- 直前の一枚 ---------------- */

// 出しっぱなしにせず、しばらくしたら消す。
// 純正の「カメラ」アプリのサムネイルは消えないが（ギャラリーへの入口を兼ねるため）、
// このアプリでは画面を広く使いたいので、スクリーンショットのサムネイルに近い挙動にした。
const THUMB_MS = 5000;
const THUMB_FADE_MS = 600;

let thumbShow = null, thumbHide = null;

function showThumb(url) {
  clearTimeout(thumbShow); clearTimeout(thumbHide);
  el.thumbImg.src = url;
  el.thumb.classList.remove('hidden', 'fade');
  thumbShow = setTimeout(() => {
    el.thumb.classList.add('fade');
    thumbHide = setTimeout(() => el.thumb.classList.add('hidden'), THUMB_FADE_MS);
  }, THUMB_MS);
}

// 消えかけを掴まれたときは、いったん止めて出したままにする
function holdThumb() {
  clearTimeout(thumbShow); clearTimeout(thumbHide);
  el.thumb.classList.remove('fade');
}

/* ---------------- セルフタイマー ---------------- */

const TIMERS = [0, 3, 5, 10];   // オフ → 3秒 → 5秒 → 10秒 の順に巡回する

let cdId = null;

function syncTimerButton() {
  el.btnTimer.textContent = state.timer ? `${state.timer}秒` : 'タイマー';
  el.btnTimer.classList.toggle('on', state.timer > 0);
}

function cancelCountdown() {
  if (cdId) { clearInterval(cdId); cdId = null; }
  el.countdown.classList.add('hidden');
  el.btnShutter.classList.remove('counting');
}

function startCountdown() {
  let left = state.timer;
  el.cdNum.textContent = left;
  el.countdown.classList.remove('hidden');
  el.btnShutter.classList.add('counting');
  cdId = setInterval(() => {
    left -= 1;
    if (left > 0) { el.cdNum.textContent = left; return; }
    cancelCountdown();
    capture();
  }, 1000);
}

el.btnTimer.addEventListener('click', () => {
  cancelCountdown();
  state.timer = TIMERS[(TIMERS.indexOf(state.timer) + 1) % TIMERS.length];
  syncTimerButton();
  persist();
});

/* ---------------- イベント ---------------- */

// ボタンだけでなくオーバーレイ全体で受ける。
// ボタンへのタップもここへ上がってくるので、待ち受けはこれ一つでよい。
el.startOverlay.addEventListener('click', () => startCamera());
el.btnRetry.addEventListener('click', () => startCamera());
el.btnShutter.addEventListener('click', () => {
  el.looks.classList.add('hidden');                    // 一覧が出たままだと画が隠れる
  if (cdId) { cancelCountdown(); return; }              // 秒読み中なら中止
  if (state.timer > 0 && state.running) { startCountdown(); return; }
  capture();
});

el.thumb.addEventListener('click', () => {
  if (!state.shot) return;
  holdThumb();                       // 見ている間は消さない
  el.preview.classList.remove('hidden');
});
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

el.btnBack.addEventListener('click', () => {
  el.preview.classList.add('hidden');
  if (state.shot) showThumb(state.shot.url);   // 戻ったら数え直す
});
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
      diag: el.chkDiag.checked,
      quick: el.chkQuick.checked,
      camOk: state.camOk,
      timer: state.timer,
      look: state.look,
      lookAmount: state.lookAmount,
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
    if (typeof d.diag === 'boolean') el.chkDiag.checked = d.diag;
    if (typeof d.quick === 'boolean') el.chkQuick.checked = d.quick;
    if (typeof d.camOk === 'boolean') state.camOk = d.camOk;
    if (TIMERS.includes(d.timer)) state.timer = d.timer;
    if (Number.isInteger(d.look) && d.look >= 0 && d.look < LOOK_NAMES.length) state.look = d.look;
    if (typeof d.lookAmount === 'number') state.lookAmount = d.lookAmount;
  }
  syncDiag();
  syncPresetButtons();
  syncSliders();
  syncTimerButton();
  syncLook();
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

// 診断バーは開発用の情報なので既定では出さない。画面を広く使うため。
function syncDiag() {
  el.diag.classList.toggle('hidden', !el.chkDiag.checked);
}
el.chkDiag.addEventListener('change', () => { syncDiag(); persist(); });
el.chkQuick.addEventListener('change', persist);

// iOS では「保存」も共有シートを開くので「共有」と実質同じ動作になる。
// 同じものが2つ並ぶと分かりにくいので、1つにまとめる。
if (IS_IOS) {
  el.btnShare.hidden = true;
  el.btnSave.textContent = '保存・共有';
}

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
  tryAutoStart();
})();
