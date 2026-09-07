# 美顔カメラアプリ — 作業の引き継ぎ

最終更新: 2026-09-07（医院PC ROOM2F で作成 / 同日 家KS で環境セットアップを追記）

## これは何か

iPhone / Android の両方で使える、自撮り用の美顔補正カメラ。ブラウザで動く **PWA**。
既存アプリの課金要素が強くて満足に使えない、という不満から自作を始めたもの。

- **公開URL: https://ks-kit.github.io/selfie-cam/**
- リポジトリ: https://github.com/ks-kit/selfie-cam （public）
- GitHubアカウント: `ks-kit`（2026-09-07 作成）

**撮った写真は端末外に一切出ない。** 撮影も補正も保存もすべて端末内で完結し、
GitHub Pages は静的ファイルの置き場でしかない。

## なぜネイティブアプリではなく PWA なのか

「家族・友人にも配りたい」という条件があったため。
iOS ネイティブの無料枠は自分の端末専用の仕組みで、他人に配れない。
配るには Apple Developer（$99/年）が必要になり、「課金したくない」という当初の動機と矛盾する。

PWA なら課金ゼロ・Mac 不要・審査なしで、iPhone と Android が 1 つのコードで動く。
懸念だった画質と frame rate は、実測の結果いずれも問題なかった（下表）。

## 今どこまでできているか

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | カメラ表示・撮影・保存 | **完了** |
| 2 | 美顔補正（肌なめらか・トーン調整・プリセット・スライダー） | **完了** |
| 5 | GitHub Pages 公開 | **完了** |
| 3 | 顔検出（くま消し、目や唇の保護） | 未着手。肌色判定で代用できているため優先度は低い |
| 4 | 色味フィルター（LUT 方式） | 未着手 ← **次にやるならここ**。当初の要望に含まれており、実装が軽く効果が大きい |
| 6 | 動画撮影 | 未着手。「たまに撮る」程度の要望 |

### 実測値

| 端末 | フルHD | 4K |
|---|---|---|
| iPhone 15 Pro（A17 Pro） | 60fps | 60fps |
| SH-M29（Snapdragon 7s Gen 2 系） | 60fps | 57fps |

**設計の経緯・ハマった点・数値の根拠はすべて `仕様書.md` にある。作業前にそれを読むこと。**

---

## 家のPCで作業を始めるときの手順

### 1. GitHub CLI の認証（そのPCで初回のみ）

認証情報は PC ごとに保存されるため、PC ごとに一度ずつ必要。

**家KS（`DESKTOP-C8E115C`）は 2026-09-07 に設定済み**（gh 2.100.0）。
`git:https://github.com` が Windows 資格情報に保存され、push が通ることを確認済み。
**家KSでこの手順を繰り返す必要はない。** 以下はまだ認証していないPCで行う。

```
winget install --id GitHub.cli --accept-source-agreements --accept-package-agreements
```

インストール後、**新しいターミナルを開いてから**:

```
gh auth login --hostname github.com --git-protocol https --web
```

- `Authenticate Git with your GitHub credentials?` → **Y**
- 表示されたワンタイムコードをメモして Enter → ブラウザでコードを入力 → Authorize
- `✓ Logged in as ks-kit` と出れば完了

認証できたかは `gh auth status` と `git push --dry-run origin main` で確認できる。
認証を担うのは gh 自身ではなく Git Credential Manager（`C:\Program Files\Git\etc\gitconfig` の `credential.helper = manager`）で、
`gh auth login` の途中の `Authenticate Git with your GitHub credentials?` に **Y** と答えるとそこへ認証情報が渡る。ここを N にすると push だけ通らない。

### 2. ローカルサーバーを立てる

カメラ API は **https か localhost でしか動かない**。`file://` で開いても真っ黒になるだけ。

```
python -m http.server 8000
```

→ ブラウザで `http://localhost:8000/`

### 3. 実機で試す

- **iPhone など** → 公開URLを開く。push すれば約 1 分で反映される
- **Android を USB 接続している場合** → `adb reverse tcp:8000 tcp:8000` を実行すると、
  実機の `http://127.0.0.1:8000/` からローカル版に繋がる。
  localhost 扱いになるので HTTPS の用意が要らない

### 4. 更新を公開に反映する

```
git add -A
git commit -m "変更内容"
git push
```

約 1 分で `https://ks-kit.github.io/selfie-cam/` に反映される。

---

## 注意

- **このフォルダは Dropbox 同期下にあり、`.git` も同期される。**
  医院PC と家KS で**同時に git 操作をしないこと**。作業前に Dropbox の同期完了を確認する。
- コミットには GitHub の匿名アドレス（`<id>+ks-kit@users.noreply.github.com`）を使う設定が
  リポジトリローカルに入れてある。公開リポジトリの履歴にメールアドレスを残さないため。**変更しない。**
- リポジトリは **public**。無料プランの GitHub Pages は公開リポジトリからしか配信できないため。
  写真が端末外に出ない構造なので、個人情報のリスクはない。
- `*.bak` は `.gitignore` で除外済み。

## ファイル構成

```
index.html          画面
css/style.css       スタイル
js/app.js           カメラ制御・補正パラメータ・撮影・保存
js/renderer.js      WebGL2 の描画パイプライン（4パス構成）
js/shaders.js       補正シェーダ本体（GLSL）
test-shader.html    シェーダ検証ページ
仕様書.md            設計の経緯・実測値・ハマった点の記録
README.md           公開用の説明
```

### 補正の仕組み（要点）

描画は 4 パス。

1. 映像 → origFBO（鏡像と上下の向きをここで確定）
2. バイラテラルフィルタ・横
3. バイラテラルフィルタ・縦
4. 合成（元画像とぼかしを混ぜ、トーンを整える）

**ぼかしだけを低い解像度で計算している**のが要点。ぼかしは低い周波数の成分しか持たないので
縮小しても見た目が変わらない一方、計算量は面積に比例するため、ここを半分にすると負荷が 1/4 になる。
合成は出力解像度のまま行うので、目や髪のディテールは落ちない。

さらに**プレビューと撮影で解像度を分けている**。プレビューは長辺 1920 まで落とし、
シャッターを切った瞬間だけカメラのフル解像度（4K）に切り替えて処理し直す。
これをやる前は 4K で 30fps しか出なかった。

### 実機なしでシェーダを検証する

`test-shader.html` をブラウザで開くだけでよい。合成したテスト画像に補正をかけた結果が並ぶ。

- 左上の赤・右下の青の位置が変わっていなければ、**座標系の反転は起きていない**
- 中央の暗い横線がぼけずに残っていれば、**輪郭を保つ処理が効いている**
- 「肌の判定」で肌色の面だけが白ければ、**マスクが正しい**

座標系の反転はこの構成で最もバグりやすい箇所なので、シェーダを触ったら必ずここで確認する。
