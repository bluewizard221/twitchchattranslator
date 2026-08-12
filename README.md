# twitchchattranslator


## 説明
Twitchのチャットに書かれた文章を翻訳します。日本語が否かを判定し、日本語を英語に、非日本語を日本語に翻訳します。
エモートは取り除かれます。


## Usage
```
./twitchchattranslator.js

適宜バックグラウンドプロセスに落とすか、デーモン化を行ってください。

```


## 動作確認済み環境・必要モジュール

* 動作確認済み環境

  FreeBSD 12.2-RELEASE上のnode v16.10.0にて動作を確認出来ています。
  
  また、Dockerの node:20-alpineでも動作を確認できています。

  
* 必要モジュール

  tmi.js, fs, config, log4js, @google-cloud/translate, express, express-session

  Node.js 18 以降が必要です（fetch API を利用しています）。


## 使用手順
1. https://dev.twitch.tv/ から新たにアプリを登録します。

2. 登録したアプリの「アプリケーションの管理」画面内の”クライアントの秘密”からシークレット値を発行します。値はページを遷移すると再度参照できなくなるので注意してください。

3. 登録したアプリ用のOAuthトークンを https://twitchapps.com/tokengen/ から取得します。

4. 翻訳botを利用するユーザーのOAuthトークンを https://twitchapps.com/tmi/ から取得します。

5. https://cloud.google.com/translate/docs/setup?hl=ja を参考にしてサービス・アカウント・キーとなるJSONキーファイルを取得します。

6. 上記必要モジュールをサーバにインストールします。

7. config/default.jsonに適当な値を入力します。（[管理画面](#管理画面web-ui)を使うとブラウザから入力できます）

<dl>
<dt>pidFile</dt>
  <dd>プロセスIDを記入するファイルのファイルパスを設定します。</dd>
<dt>googleProjectId</dt>
  <dd>Google CloudのプロジェクトIDを設定します。</dd>
<dt>googleKeyFile</dt>
  <dd>Google Cloudのサービス・アカウント・キーJSONファイルのファイルパスを設定します。</dd>
<dt>twitchUserName</dt>
  <dd>翻訳botとして利用するユーザーのユーザー名を設定します。</dd>
<dt>twitchOauth</dt>
  <dd>翻訳botとして利用するユーザーのOAuthトークンを設定します。</dd>
<dt>twitchChannel</dt>
  <dd>翻訳botを走らせたいチャンネル名を設定します。（表示名でなくアルファベットの方）</dd>
<dt>twitchClientId</dt>
	<dd>登録したアプリのクライアントIDを設定します。</dd>
<dt>twitchClientSecret</dt>
	<dd>登録したアプリに対応したシークレット値を設定します。</dd>
<dt>coolDownCount</dt>
  <dd>同一ユーザーから1分間の間に受け付ける最大翻訳回数を設定します。ここに設定した数値までを翻訳します。</dd>
</dl>
7. スクリプトを起動します。例ではバックグラウンドに落としていますが、デーモン化したい場合は適宜デーモン化してください。
ex)
```bash
(./twitchchattranslator.js) &
```


## 管理画面（Web UI）
設定ファイルの編集・エモート一覧の更新・Google Cloud のキーのアップロードを、ブラウザから日本語の画面で行えます。
ログインは Twitch の OAuth を利用します。

```bash
npm install
npm run web
```

起動後、ブラウザで http://localhost:3000/ を開いてください。

### できること

<dl>
<dt>基本設定</dt>
  <dd>config/default.json と同じ項目をフォームから編集します。保存先は <code>config/local.json</code> で、
      config/default.json は書き換えません（node-config の優先順位により local.json の値が優先されます）。
      トークンなどの秘密情報は画面に表示されず、「設定済み」かどうかだけが表示されます。</dd>
<dt>翻訳除外リスト</dt>
  <dd>ignoreusers.json と ignoreline.json を編集します。正規表現は保存前に検証されます。</dd>
<dt>エモート</dt>
  <dd>emoticons.json の手動編集と、BetterTTV / FrankerFaceZ からの自動取得を行えます
      （emotelistupdate.js と同じ処理です）。既存の一覧に追加するか、丸ごと置き換えるかを選べます。</dd>
<dt>Google Cloud キー</dt>
  <dd>サービスアカウントキー（JSON）をアップロードします。内容を検証したうえで config/ 配下に
      パーミッション 0600 で保存し、<code>googleKeyFile</code> と <code>googleProjectId</code> を自動的に更新します。</dd>
<dt>bot への反映</dt>
  <dd>ダッシュボードの「bot に反映する」で、稼働中の bot へ SIGHUP を送りリストを再読み込みさせます
      （チャットの !refreshignoreuser などと同じ効果です）。基本設定の変更を反映するには bot の再起動が必要です。</dd>
</dl>

<code>twitchChannel</code> と <code>twitchBroadcasterId</code> は、ログインした Twitch アカウントの情報から
「ログイン情報から」ボタンで自動入力できます。

### 管理画面の設定

`config/webui.example.json` を `config/webui.json` にコピーして編集します。各項目は環境変数でも指定できます。

<dl>
<dt>allowedUsers（WEBUI_ALLOWED_USERS）</dt>
  <dd>ログインを許可する Twitch ユーザー名の一覧。<strong>ここに登録されたアカウントだけがログインできます。</strong>
      1 人も設定していない場合、管理画面は誰もログインできない状態で起動します。</dd>
<dt>twitchClientId / twitchClientSecret（WEBUI_TWITCH_CLIENT_ID / WEBUI_TWITCH_CLIENT_SECRET）</dt>
  <dd>ログインに使う Twitch アプリの認証情報。未設定の場合は bot 設定の値を流用します。</dd>
<dt>redirectUri（WEBUI_REDIRECT_URI）</dt>
  <dd>OAuth のリダイレクト URI。既定値は <code>http://localhost:3000/auth/twitch/callback</code> です。
      <strong>同じ URL を Twitch Developer Console のアプリ設定にも登録してください。</strong></dd>
<dt>sessionSecret（WEBUI_SESSION_SECRET）</dt>
  <dd>セッション Cookie の署名に使うランダムな文字列（例: <code>openssl rand -hex 32</code>）。
      未設定の場合は起動ごとに生成されるため、再起動でログイン状態が失われます。</dd>
<dt>port / host（WEBUI_PORT / WEBUI_HOST）</dt>
  <dd>待ち受けるポートとアドレス。既定は 127.0.0.1:3000（同じマシンからのみアクセス可）です。</dd>
<dt>trustProxy / secureCookie（WEBUI_TRUST_PROXY / WEBUI_SECURE_COOKIE）</dt>
  <dd>リバースプロキシ経由で公開する場合に設定します。HTTPS で公開する場合は secureCookie を true にしてください。</dd>
<dt>（環境変数のみ）BOT_NODE_ENV</dt>
  <dd>bot を <code>NODE_ENV</code> 付きで運用している場合に、同じ値を指定すると設定の重ね合わせが一致します。</dd>
<dt>（環境変数のみ）TCT_ROOT</dt>
  <dd>設定ファイルやリストファイルを読み書きするディレクトリ。既定はリポジトリのルートです。</dd>
</dl>

### 運用上の注意
* 管理画面は設定ファイル（トークンを含む）を編集できるため、**インターネットに直接公開しないでください。**
  公開する場合は HTTPS のリバースプロキシ経由とし、`secureCookie` と `trustProxy` を有効にしてください。
* ログイン状態はメモリ上に保持されるため、管理画面を再起動すると再ログインが必要です。
* ログは `logs/webui.log` に出力されます。
* `config/local.json` `config/webui.json` `config/google-key.json` は .gitignore 済みです。誤ってコミットしないでください。


## エモートについて
* エモートの一覧はルートディレクトリ内の emoticons.json に格納されています。コミットされているファイルには FrankerFaceZ・Better TTV のグローバルエモートが格納されていますが、付属の emotelistupdate.js を利用することで FFZのチャンネルエモートも登録することが可能です。
* emotelistupdate.js は既存の emoticons.json を上書きします。
* emotelistupdate.js は config/jsonupdate.json を設定ファイルとして利用します。

config/jsonupdate.jsonについて：

<dl>
<dt>twitchChannel</dt>
  <dd>翻訳botを走らせたいチャンネル名を設定します。（表示名でなくアルファベットの方）</dd>
<dt>twitchUserId</dt>
  <dd>翻訳botとして利用するユーザーのユーザーIDを設定します。（数値）</dd>
</dl>

設定を書き換えたら、以下のようにスクリプトを実行して emoticons.json を更新します。

```bash
NODE_ENV=jsonupdate ./emotelistupdate.js
```

管理画面の「エモート」タブからも同じ更新が行えます。その場合は「基本設定」の値が使われ、
config/jsonupdate.json も同じ内容に更新されます。


## 特定の文字・ユーザーを翻訳させない
ルートディレクトリ内の ignoreline.json ignoreusers.json にそれぞれ「翻訳をしない単語」「翻訳をしないユーザー」を記入出来ます。
ignoreline.jsonに関しては正規表現を利用できます。

```
ignoreline.json:

{
  "ignorelines": [
	"(ttp|ttps)\\:\/\/[a-zA-Z0-9+\\.\/%\\\\&\\?#\\$\\!'\\(\\)\\-=_\\:;]+"
  ]
}
```

```
ignoreusers.json:

{
  "ignoreusers": [
    "moobot",
    "streamlabs",
    "nightbot",
  ]
}
```


## コマンド
翻訳botをチャットからある程度コントロールすることが出来ます。以下のコマンドに対応しています：
<dl>
<dt>!refreshignoreuser</dt>
  <dd>ignoreusers.json を更新後実行することでbotに変更を反映させます。モデレーターと配信者のみが利用出来ます。</dd>
<dt>!refreshignoreline</dt>
  <dd>ignoreline.json を更新後実行することでbotに変更を反映させます。モデレーターと配信者のみが利用出来ます。</dd>
<dt>!refreshemoticons</dt>
  <dd>emoticons.json を更新後実行することでbotに変更を反映させます。モデレーターと配信者のみが利用出来ます。</dd>
</dl>


## テスト

```bash
npm test
```

管理画面まわりの設定ファイル操作・入力検証・認証フローのテストが実行されます。


## その他諸注意
* ログが logs/twitchchattranslator.log に書き出されます。
  また、ログのローテーションが日付単位で行われます。ログを書き込むイベントが発生した際に日付が変わっていた場合ローテーションが行われます。
