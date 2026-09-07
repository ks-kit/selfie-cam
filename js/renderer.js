// WebGL2 による美顔補正パイプライン。
//
// 描画は4パス構成:
//   Pass 0  映像 → origFBO             （出力解像度。鏡像と上下の向きをここで確定）
//   Pass 1  origFBO → blurA            （バイラテラル・横。ここから下は低解像度）
//   Pass 2  blurA   → blurB            （バイラテラル・縦）
//   Pass 3  origFBO → baseA            （肌だけ取り出してごく低解像度へ）
//   Pass 4  baseA   → baseB            （ガウス・横）
//   Pass 5  baseB   → baseA            （ガウス・縦。これで「周囲の肌の平均色」ができる）
//   Pass 6  origFBO + blurB + baseA → 画面（合成・トーン調整）
//
// ぼかしだけを低解像度で行うのが要点。
// ぼかしは低い周波数の成分しか持たないため縮小しても見た目が変わらない一方、
// 計算量は面積に比例するので、ここを半分にすると負荷が 1/4 になる。
// 合成は出力解像度のまま行うので、目や髪のディテールは失われない。

import { VERT_SOURCE, VERT_QUAD, FRAG_BILATERAL, FRAG_GAUSS, FRAG_SKINPACK,
         FRAG_COMPOSITE, FRAG_PASSTHROUGH } from './shaders.js';

export const DEFAULT_PARAMS = {
  smooth: 0.0,      // 肌なめらか
  detail: 0.45,     // 質感の戻し量
  brightness: 0.0,
  contrast: 0.0,
  saturation: 0.0,
  warmth: 0.0,
  skinTone: 0.0,
  shadow: 0.0,      // 髭・くま・くすみの持ち上げ
  even: 0.0,        // 色ムラの平均化
  look: 0,          // 色味フィルターの種類（0 = なし）
  lookAmount: 1.0,  // その強さ
  radius: 6.0,      // ぼかし半径（低解像度側の画素数）
  // 同じ肌とみなす色の差。0.16 では色差 0.16 の画素にもまだ 0.61 の重みが残り、
  // 眉毛と肌の境目のような中くらいの輪郭を越えて混ざっていた。
  sigmaColor: 0.11,
};

// 肌の平均色を作るバッファの大きさと、そこでのぼかし半径。
// 出力解像度に依存しない固定値にしてあるので、プレビューでも撮影でも同じ効き方になる。
const BASE_LONG   = 128;
const BASE_RADIUS = 24;

// バイラテラルの半径を解釈する基準になる、ぼかしバッファの長辺。
// u_radius は「ぼかしバッファ上の画素数」なので、バッファの大きさが変わると
// 画に対する効き幅も変わってしまう。ここを基準に正規化して揃える。
const RADIUS_REF = 720;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.width = 0;
    this.height = 0;
    this.blurScale = 0.5;   // ぼかしを行う解像度の倍率
    this.prog = {};
    this.fbo = {};
    this.videoTex = null;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false,
      preserveDrawingBuffer: true,   // toBlob で中身を読むために必要
      desynchronized: true,
    });
    if (!gl) throw new Error('WEBGL2_UNSUPPORTED');
    this.gl = gl;

    this.prog.copy      = this._program(VERT_SOURCE, FRAG_PASSTHROUGH, ['u_tex', 'u_flipX']);
    this.prog.blit      = this._program(VERT_QUAD,   FRAG_PASSTHROUGH, ['u_tex']);
    this.prog.bilateral = this._program(VERT_QUAD,   FRAG_BILATERAL,
      ['u_tex', 'u_texel', 'u_dir', 'u_radius', 'u_sigmaColor']);
    this.prog.skinpack  = this._program(VERT_QUAD,   FRAG_SKINPACK, ['u_tex']);
    this.prog.gauss     = this._program(VERT_QUAD,   FRAG_GAUSS,
      ['u_tex', 'u_texel', 'u_dir', 'u_radius']);
    this.prog.composite = this._program(VERT_QUAD,   FRAG_COMPOSITE,
      ['u_orig', 'u_blur', 'u_base', 'u_smooth', 'u_detail', 'u_brightness', 'u_contrast',
       'u_saturation', 'u_warmth', 'u_skinTone', 'u_shadow', 'u_even',
       'u_look', 'u_lookAmount', 'u_maskOnly',
       'u_faceMask', 'u_faceOn', 'u_faceFlip']);

    // 画面全体を覆う三角形2枚。全パスで使い回す。
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    for (const key of Object.keys(this.prog)) {
      const loc = gl.getAttribLocation(this.prog[key].id, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    this.videoTex = this._texture();
    this.faceTex  = this._texture();   // 顔マスク（2D キャンバスから毎回上げ直す）
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _program(vsSrc, fsSrc, uniformNames) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('シェーダのコンパイルに失敗:\n' + log);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const id = gl.createProgram();
    gl.attachShader(id, vs);
    gl.attachShader(id, fs);
    gl.linkProgram(id);
    if (!gl.getProgramParameter(id, gl.LINK_STATUS)) {
      throw new Error('シェーダのリンクに失敗:\n' + gl.getProgramInfoLog(id));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const u = {};
    for (const n of uniformNames) u[n] = gl.getUniformLocation(id, n);
    return { id, u };
  }

  _texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _makeFBO(w, h) {
    const gl = this.gl;
    const tex = this._texture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  _disposeFBO(f) {
    if (!f) return;
    this.gl.deleteTexture(f.tex);
    this.gl.deleteFramebuffer(f.fb);
  }

  // 出力解像度を設定する。ぼかし用のバッファもここで作り直す。
  resize(w, h, blurScale = this.blurScale) {
    if (this.width === w && this.height === h && this.blurScale === blurScale) return;
    this.width = w;
    this.height = h;
    this.blurScale = blurScale;
    this.canvas.width = w;
    this.canvas.height = h;

    this._disposeFBO(this.fbo.orig);
    this._disposeFBO(this.fbo.a);
    this._disposeFBO(this.fbo.b);
    this._disposeFBO(this.fbo.baseA);
    this._disposeFBO(this.fbo.baseB);

    const bw = Math.max(2, Math.round(w * blurScale));
    const bh = Math.max(2, Math.round(h * blurScale));
    this.fbo.orig = this._makeFBO(w, h);
    this.fbo.a    = this._makeFBO(bw, bh);
    this.fbo.b    = this._makeFBO(bw, bh);

    // 肌の平均色用。出力解像度によらず固定の大きさにする
    const bs = BASE_LONG / Math.max(w, h);
    const sw = Math.max(2, Math.round(w * bs));
    const sh = Math.max(2, Math.round(h * bs));
    this.fbo.baseA = this._makeFBO(sw, sh);
    this.fbo.baseB = this._makeFBO(sw, sh);
  }

  _bindTarget(target) {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
    }
  }

  _useTexture(tex, unit, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  // 1フレーム描画する。
  // params は DEFAULT_PARAMS と同じ形。flipX / maskOnly / bypass は個別に受ける。
  draw(video, params = {}) {
    const gl = this.gl;
    const p = { ...DEFAULT_PARAMS, ...params };
    gl.bindVertexArray(this.vao);

    // --- Pass 0: 映像を origFBO へ。ここで鏡像と上下の向きを確定させる ---
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.useProgram(this.prog.copy.id);
    this._bindTarget(this.fbo.orig);
    this._useTexture(this.videoTex, 0, this.prog.copy.u.u_tex);
    gl.uniform1f(this.prog.copy.u.u_flipX, params.flipX ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 補正なしならそのまま画面へ出して終わり（比較表示・オフ時）
    if (params.bypass) {
      gl.useProgram(this.prog.blit.id);
      this._bindTarget(null);
      this._useTexture(this.fbo.orig.tex, 0, this.prog.blit.u.u_tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }

    // --- Pass 1,2: バイラテラルを横→縦の2回に分ける ---
    // 本来は縦横まとめて1回で行うフィルタだが、それだと画素数の2乗に比例して重くなる。
    // 横と縦に分けると和で済み、見た目はほとんど変わらない。
    const bp = this.prog.bilateral;
    gl.useProgram(bp.id);
    // 半径はぼかしバッファ上の画素数なので、バッファの大きさで正規化して
    // プレビュー（長辺720）と撮影（長辺1440）で効き幅が揃うようにする。
    // これをしないと、保存される写真だけ補正の効き幅が半分になる。
    const rScale = Math.max(this.fbo.a.w, this.fbo.a.h) / RADIUS_REF;
    gl.uniform1f(bp.u.u_radius, p.radius * rScale);
    gl.uniform1f(bp.u.u_sigmaColor, p.sigmaColor);

    this._bindTarget(this.fbo.a);
    gl.uniform2f(bp.u.u_texel, 1 / this.fbo.a.w, 1 / this.fbo.a.h);
    gl.uniform2f(bp.u.u_dir, 1, 0);
    this._useTexture(this.fbo.orig.tex, 0, bp.u.u_tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this._bindTarget(this.fbo.b);
    gl.uniform2f(bp.u.u_texel, 1 / this.fbo.b.w, 1 / this.fbo.b.h);
    gl.uniform2f(bp.u.u_dir, 0, 1);
    this._useTexture(this.fbo.a.tex, 0, bp.u.u_tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 3,4,5: 周囲の肌の平均色を作る ---
    // 肌だけを取り出して（色にマスクを掛け、マスクを alpha に入れて）ごく低い解像度へ落とし、
    // 広めのガウスでぼかす。合成側で rgb を alpha で割ると肌だけの平均色になる。
    // 髪や背景は alpha が小さいので平均に混ざらない。
    const sp = this.prog.skinpack;
    gl.useProgram(sp.id);
    this._bindTarget(this.fbo.baseA);
    this._useTexture(this.fbo.orig.tex, 0, sp.u.u_tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const gp = this.prog.gauss;
    gl.useProgram(gp.id);
    gl.uniform1f(gp.u.u_radius, BASE_RADIUS);
    gl.uniform2f(gp.u.u_texel, 1 / this.fbo.baseA.w, 1 / this.fbo.baseA.h);

    this._bindTarget(this.fbo.baseB);
    gl.uniform2f(gp.u.u_dir, 1, 0);
    this._useTexture(this.fbo.baseA.tex, 0, gp.u.u_tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this._bindTarget(this.fbo.baseA);
    gl.uniform2f(gp.u.u_dir, 0, 1);
    this._useTexture(this.fbo.baseB.tex, 0, gp.u.u_tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 6: 合成して画面へ ---
    const cp = this.prog.composite;
    gl.useProgram(cp.id);
    this._bindTarget(null);
    this._useTexture(this.fbo.orig.tex,  0, cp.u.u_orig);
    this._useTexture(this.fbo.b.tex,     1, cp.u.u_blur);
    this._useTexture(this.fbo.baseA.tex, 2, cp.u.u_base);

    // 顔マスク。渡されたときだけ有効にし、無ければ従来どおり色だけの判定で動く。
    const faceOn = !!(params.faceSource && params.faceOn);
    if (faceOn) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.faceTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, params.faceSource);
      gl.uniform1i(cp.u.u_faceMask, 3);
    } else {
      this._useTexture(this.faceTex, 3, cp.u.u_faceMask);
    }
    gl.uniform1f(cp.u.u_faceOn,   faceOn ? 1.0 : 0.0);
    gl.uniform1f(cp.u.u_faceFlip, params.flipX ? 1.0 : 0.0);

    gl.uniform1f(cp.u.u_smooth,     p.smooth);
    gl.uniform1f(cp.u.u_detail,     p.detail);
    gl.uniform1f(cp.u.u_brightness, p.brightness);
    gl.uniform1f(cp.u.u_contrast,   p.contrast);
    gl.uniform1f(cp.u.u_saturation, p.saturation);
    gl.uniform1f(cp.u.u_warmth,     p.warmth);
    gl.uniform1f(cp.u.u_skinTone,   p.skinTone);
    gl.uniform1f(cp.u.u_shadow,     p.shadow);
    gl.uniform1f(cp.u.u_even,       p.even);
    gl.uniform1f(cp.u.u_look,       p.look);
    gl.uniform1f(cp.u.u_lookAmount, p.lookAmount);
    gl.uniform1f(cp.u.u_maskOnly,   params.maskOnly ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  toBlob(type = 'image/jpeg', quality = 0.95) {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('画像の書き出しに失敗しました'))),
        type, quality
      );
    });
  }
}
