// 美顔補正のシェーダ群。
//
// 処理は3パスに分かれる:
//   1. blurH  : バイラテラルフィルタ（横方向）
//   2. blurV  : バイラテラルフィルタ（縦方向）
//   3. composite : 元画像とぼかしを合成し、質感を戻してトーンを整える
//
// バイラテラルフィルタは「輪郭を残したままぼかす」フィルタ。
// 単純なぼかしと違い、色が大きく違う画素（目・眉・唇の境界）を平均に含めないので、
// 肌だけがなめらかになり、目鼻立ちは残る。

// 頂点シェーダは2種類。
//
// 映像テクスチャは「上が原点」、オフスクリーン描画先のテクスチャは「下が原点」と
// 座標系が上下逆。混ぜると途中のパスで画が反転するので、
//   ・映像を最初に読み込むパスだけ VERT_SOURCE（上下を合わせ、鏡像もここで適用）
//   ・以降のパス間は VERT_QUAD（そのまま）
// と役割を分けて、座標系を一度で確定させている。

export const VERT_SOURCE = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
uniform float u_flipX;
void main() {
  vec2 uv = a_pos * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  if (u_flipX > 0.5) uv.x = 1.0 - uv.x;
  v_uv = uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const VERT_QUAD = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// パス1・2で共用。u_dir で横/縦を切り替える。
export const FRAG_BILATERAL = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_texel;       // 1画素あたりのUV量
uniform vec2  u_dir;         // (1,0)=横 / (0,1)=縦
uniform float u_radius;      // ぼかし半径（画素）
uniform float u_sigmaColor;  // 色の差をどこまで同じ肌とみなすか
out vec4 fragColor;

const int TAPS = 8;

void main() {
  vec3 center = texture(u_tex, v_uv).rgb;
  vec3 sum = center;
  float wsum = 1.0;

  float sigmaSpace = max(u_radius * 0.5, 0.001);
  float c2 = 2.0 * u_sigmaColor * u_sigmaColor;

  for (int i = 1; i <= TAPS; i++) {
    float off = float(i) * u_radius / float(TAPS);
    vec2 d = u_dir * u_texel * off;

    vec3 a = texture(u_tex, v_uv + d).rgb;
    vec3 b = texture(u_tex, v_uv - d).rgb;

    // 空間の重み：離れた画素ほど弱く
    float ws = exp(-0.5 * (off * off) / (sigmaSpace * sigmaSpace));

    // 色の重み：色が違う画素ほど弱く（＝輪郭を越えて混ぜない）
    vec3 da = a - center;
    vec3 db = b - center;
    float wa = ws * exp(-dot(da, da) / c2);
    float wb = ws * exp(-dot(db, db) / c2);

    sum  += a * wa + b * wb;
    wsum += wa + wb;
  }
  fragColor = vec4(sum / wsum, 1.0);
}`;

export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_orig;    // 元映像
uniform sampler2D u_blur;    // ぼかし済み
uniform float u_smooth;      // 肌なめらか      0..1
uniform float u_detail;      // 質感の戻し量    0..1
uniform float u_brightness;  // 明るさ         -1..1
uniform float u_contrast;    // コントラスト    -1..1
uniform float u_saturation;  // 彩度           -1..1
uniform float u_warmth;      // 色温度(暖⇔寒)  -1..1
uniform float u_skinTone;    // 肌の明るさ      -1..1
uniform float u_maskOnly;    // 1.0 で肌マスクを可視化（調整用）
out vec4 fragColor;

// 肌色の判定。YCbCr に変換すると、肌の色は明るさに関係なく
// 狭い範囲に集まるという性質を使う。
float skinMask(vec3 c) {
  float y  = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;

  // 肌色の中心からの距離
  float d = distance(vec2(cb, cr), vec2(0.42, 0.60));
  float m = smoothstep(0.155, 0.045, d);

  // 極端に暗い/明るい画素は肌とみなさない（髪・白飛び対策）
  m *= smoothstep(0.06, 0.20, y);
  m *= smoothstep(1.02, 0.86, y);
  return m;
}

void main() {
  vec3 orig = texture(u_orig, v_uv).rgb;
  vec3 blur = texture(u_blur, v_uv).rgb;

  float mask = skinMask(orig);

  if (u_maskOnly > 0.5) {
    fragColor = vec4(vec3(mask), 1.0);
    return;
  }

  // 周波数分離：高周波＝肌の細かい質感。
  // 全部消すとのっぺりするので、一部を戻して自然さを保つ。
  vec3 detail = orig - blur;
  vec3 smoothed = blur + detail * u_detail;

  vec3 col = mix(orig, smoothed, clamp(u_smooth, 0.0, 1.0) * mask);

  // 肌だけを明るく（くすみ抜き）
  col += vec3(u_skinTone * 0.14) * mask;

  // トーン
  col = (col - 0.5) * (1.0 + u_contrast) + 0.5;
  col += u_brightness * 0.25;

  // 彩度
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(g), col, 1.0 + u_saturation);

  // 色温度：暖かく＝赤を上げ青を下げる
  col.r += u_warmth * 0.05;
  col.b -= u_warmth * 0.05;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// 無加工（補正オフ時、および比較表示用）
export const FRAG_PASSTHROUGH = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() { fragColor = texture(u_tex, v_uv); }`;
