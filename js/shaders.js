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

// 肌色の判定。合成パスと肌抽出パスの両方で使うので、断片として切り出してある。
//
// YCbCr に変換すると、肌の色は明るさに関係なく狭い範囲に集まる。その性質を使う。
const SKIN_GLSL = `
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float skinMask(vec3 c) {
  float y  = luma(c);
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;

  // 肌色の中心からの距離
  //
  // しきい値は 2026-09-07 に締め直した。以前は 0.155/0.045・暗部 0.06/0.20 で、
  // 眉と髪が 0.61、鼻の穴が 0.30、暖色の壁が 0.21 と、肌以外まで拾っていた。
  // その結果「肌だけ」のはずのぼかしが画面全体に掛かり、全体がぼやけて見えていた。
  float d = distance(vec2(cb, cr), vec2(0.42, 0.60));
  float m = smoothstep(0.115, 0.040, d);

  // 暗い画素を肌から外す（髪・眉・鼻の穴・口の線）。
  // 下限を上げすぎると暗い室内で肌まで外れるので、
  // 眉髪 0.04 / 暗い室内の肌 0.82 になる値を選んである。
  m *= smoothstep(0.15, 0.30, y);

  // 白飛びも肌とみなさない
  m *= smoothstep(1.02, 0.86, y);
  return m;
}
`;

// 肌だけを取り出して低解像度へ落とすパス。
// 色に肌マスクを掛けて書き、マスクそのものを alpha に入れる。
// このあとガウスでぼかしてから rgb を alpha で割ると、
// 「その辺りにある肌だけの平均色」が得られる。髪や背景は alpha が小さいので混ざらない。
export const FRAG_SKINPACK = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
${SKIN_GLSL}
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  float m = skinMask(c);
  fragColor = vec4(c * m, m);
}`;

// 素直なガウスぼかし。肌の平均色を作るのに使う（横→縦の2回）。
// alpha も一緒にぼかす必要があるので RGBA のまま扱う。
export const FRAG_GAUSS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_texel;
uniform vec2  u_dir;
uniform float u_radius;
out vec4 fragColor;

const int TAPS = 8;

void main() {
  vec4 sum = texture(u_tex, v_uv);
  float wsum = 1.0;
  float sigma = max(u_radius * 0.5, 0.001);
  for (int i = 1; i <= TAPS; i++) {
    float off = float(i) * u_radius / float(TAPS);
    vec2 d = u_dir * u_texel * off;
    float w = exp(-0.5 * (off * off) / (sigma * sigma));
    sum += (texture(u_tex, v_uv + d) + texture(u_tex, v_uv - d)) * w;
    wsum += 2.0 * w;
  }
  fragColor = sum / wsum;
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
uniform sampler2D u_base;    // 周囲の肌の平均色（rgb は肌マスクで重み付け済み、a が重み）
uniform float u_shadow;      // 髭・くまの持ち上げ 0..1
uniform float u_even;        // 色ムラの平均化     0..1
uniform float u_look;        // 色味フィルターの種類（0 = なし）
uniform float u_lookAmount;  // その強さ 0..1
uniform float u_maskOnly;    // 1.0 で肌マスクを可視化（調整用）
out vec4 fragColor;
${SKIN_GLSL}
// 持ち上げの上限（明るさ）。これが無いと鼻の穴や口の線まで浮く。
const float LIFT_MAX = 0.20;

// 常に残す陰影の量。
//
// 鼻の脇・あごの下・頬の丸みといった自然な陰影も「周囲の肌より暗い」ので、
// 素直に持ち上げると顔から立体感が消えて平べったくなる。
// この量までの暗さは陰影とみなして手を付けず、それを超えた分だけを戻す。
const float SHADE_KEEP = 0.05;

// 色味フィルター。
//
// LUT 画像ではなく式で書いてある。作るのが手作りの数本なら、
// 式の方が軽く（画像の追加取得が無い）、値を直して push すればすぐ確かめられる。
// 外部の .cube LUT を読み込みたくなったら、そのときサンプラーを足せばよい。
//
// 中身はどれも同じ4つの操作の組み合わせ:
//   fade  黒を持ち上げる（フィルムの褪せた感じ）
//   tint  暗部と明部に別々の色を乗せる（スプリットトーン）
//   con   コントラスト
//   sat   彩度
vec3 applyLook(vec3 c, float id, float amt) {
  if (id < 0.5 || amt <= 0.001) return c;

  vec3 sTint, hTint;
  float sat, con, fade;

  if (id < 1.5) {        // フィルム: 褪せた黒、暖かいハイライト、冷たいシャドウ
    sTint = vec3(-0.020, -0.005,  0.045); hTint = vec3( 0.045,  0.020, -0.030);
    sat = -0.10; con =  0.06; fade = 0.030;
  } else if (id < 2.5) { // クリア: 締まった、わずかに寒色
    sTint = vec3(-0.010,  0.000,  0.020); hTint = vec3( 0.010,  0.015,  0.020);
    sat =  0.10; con =  0.14; fade = 0.000;
  } else if (id < 3.5) { // やわらか: 低コントラストで暖かい
    sTint = vec3( 0.020,  0.010,  0.000); hTint = vec3( 0.035,  0.020,  0.000);
    sat = -0.06; con = -0.10; fade = 0.050;
  } else if (id < 4.5) { // ノスタルジー: セピア寄り
    sTint = vec3( 0.030,  0.005, -0.010); hTint = vec3( 0.060,  0.035, -0.020);
    sat = -0.30; con =  0.02; fade = 0.045;
  } else if (id < 5.5) { // クール: 青寄りで締まった
    sTint = vec3(-0.020, -0.005,  0.050); hTint = vec3(-0.010,  0.005,  0.035);
    sat =  0.06; con =  0.10; fade = 0.000;
  } else {               // モノクロ: わずかに暖かい黒白
    sTint = vec3( 0.000,  0.000,  0.000); hTint = vec3( 0.020,  0.012,  0.000);
    sat = -1.00; con =  0.12; fade = 0.020;
  }

  vec3 o = vec3(fade) + c * (1.0 - fade);
  o += mix(sTint, hTint, smoothstep(0.0, 1.0, luma(o)));
  o = (o - 0.5) * (1.0 + con) + 0.5;
  o = mix(vec3(luma(o)), o, 1.0 + sat);

  return mix(c, clamp(o, 0.0, 1.0), clamp(amt, 0.0, 1.0));
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

  // ---- 髭・くま・くすみ ----
  //
  // これらは「周りの肌より、その場所だけ暗い」という共通の性質を持つ。
  // バイラテラルは細かい凹凸しか触れないので、この低い周波数の暗さは消せない。
  // そこで「その辺りの肌の平均色」を別に作り、平均より暗い分を戻す。
  vec4  packed = texture(u_base, v_uv);
  float area   = packed.a;                          // その辺りが肌である度合い
  vec3  base   = packed.rgb / max(area, 0.001);     // 肌だけの平均色
  float yBase  = luma(base);
  float yCol   = luma(col);

  // area をそのまま重みに使うと、髭自身のマスクが低いせいで
  // 髭の中心ほど平均の重みが下がり、一番効かせたい場所で効かなくなる。
  // 「顔の領域か」を判定したいだけなので、しきい値を通して 0/1 に寄せる。
  float areaW = smoothstep(0.12, 0.45, area);

  // 暗すぎる／明るすぎる画素は触らない（鼻の穴・口の線・眉・白飛び）。
  // 髭は y=0.53 前後なので残り、眉は 0.19 前後なので落ちる。
  float guard = areaW * smoothstep(0.16, 0.34, yCol) * smoothstep(1.00, 0.88, yCol);

  // 唇を守る。唇は周囲の肌より赤（cr）が明確に高い。
  // これが無いと、唇は「周囲より暗い」だけの理由で大きく持ち上がって色が飛ぶ。
  float crCol  = (col.r  - yCol)  * 0.713 + 0.5;
  float crBase = (base.r - yBase) * 0.713 + 0.5;
  float redGuard = 1.0 - smoothstep(0.010, 0.045, crCol - crBase);

  // 平均より暗い分のうち、自然な陰影ぶんを差し引いた残りだけを持ち上げる。
  // 差し引きにしてあるので、強い影ほど多く戻りつつ、陰影の順序は保たれる。
  float excess = max(yBase - yCol - SHADE_KEEP, 0.0);
  col += min(excess, LIFT_MAX) * u_shadow * guard * redGuard;

  // 色みだけを周囲の肌へ寄せる（明るさは変えない）。
  // 周囲より彩度が低い画素だけを対象にするのが要点。
  // 髭は彩度が落ちて青寄りなので寄せたいが、唇は周囲より彩度が高いので触れずに済む。
  float yc = luma(col);
  vec3 chroma  = col  - vec3(yc);
  vec3 bChroma = base - vec3(yBase);
  float bLen = length(bChroma);
  float lack = clamp((bLen - length(chroma)) / max(bLen, 0.05), 0.0, 1.0);
  col = vec3(yc) + mix(chroma, bChroma, clamp(u_even, 0.0, 1.0) * guard * lack);

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

  // 色味フィルターは最後。肌の補正が終わった画に対して全体の色を決める。
  col = applyLook(clamp(col, 0.0, 1.0), u_look, u_lookAmount);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// 無加工（補正オフ時、および比較表示用）
export const FRAG_PASSTHROUGH = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() { fragColor = texture(u_tex, v_uv); }`;
