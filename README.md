# twitchchattranslator


## 説明
Twitch のチャットに書かれた文章を翻訳します。日本語かどうかを判定し、日本語を英語に、日本語以外を日本語に翻訳します。
エモートは取り除いてから翻訳します。

複数のチャンネルで動かせます。チャンネルごとに bot のプロセスを分け、設定・リスト・bot アカウント・
Google Cloud のキーもチャンネルごとに持ちます。運営者がチャンネルを登録し、配信者は Web の管理画面から
自分のチャンネルの準備と設定を行います。

チャットは Twitch の EventSub（Webhook）で受け取り、翻訳は Twitch Helix API（Send Chat Message）で投稿します。
IRC は使いません。


## 翻訳と投稿のルール
* **チャンネル主の発言**は、配信中かどうかに関係なく常に翻訳します。
* **それ以外のユーザーの発言**は、配信中のみ翻訳します。配信の開始・終了は EventSub の通知（`stream.online` / `stream.offline`）で反映します。
  bot の起動時には一度だけ Helix API（Get Streams）で配信中かどうかを確認します。
* `!refreshignoreuser` などの[コマンド](#コマンド)は、配信中かどうかに関係なく使えます。
* **翻訳の投稿**には、チャンネル主が bot を許可している（`channel:bot`）か、bot アカウントがそのチャンネルのモデレーターであることが必要です。
  管理画面へのログイン時に `channel:bot` の許可を求めます。どちらもないチャンネルには投稿せず、その旨をログに記録します。
* **元の発言が削除・BAN・タイムアウトされたとき**の翻訳の自動削除には、bot アカウントがモデレーターである必要があります。
* **1 日の翻訳文字数の上限**を設定すると、上限に達した日はチャンネル主の発言も含めて翻訳しません。
  文字数は Google に送った文字数で、言語の判定と翻訳の両方を数えます。
* 同じユーザーの発言は、1 分間にクールダウン回数まで翻訳します（モデレーターとチャンネル主は対象外）。
* 共有チャット（Shared Chat）で他のチャンネルから届いた発言は翻訳しません。


## 構成

```
コンテナ（node manager.js が PID 1）
├─ 管理プロセス manager.js
│    ├─ EventSub の受信口      :3200  POST /eventsub/callback（署名を検証し、配信者の ID で bot に振り分け）
│    ├─ 状態の口              :3100  GET /healthz（正常 200 / 異常 503。外へは公開しない）
│    ├─ App Access Token の管理と、EventSub の購読の突き合わせ
│    ├─ エモート一覧の自動更新（チャンネルごとに 6 時間おき）
│    └─ ログの整理（30 日）と操作の記録の整理（1 年）
├─ 管理画面 web/server.js     :3000  （管理プロセスの子プロセス）
└─ bot twitchchattranslator.js × チャンネルの数（管理プロセスの子プロセス。channels/<login>/ で動く）
```

* 管理プロセスは、異常終了した子プロセスを間隔をあけて起動し直します（間隔は少しずつ長くなります）。
* `SIGTERM` を受けると、bot、管理画面の順に止めてから終了します。
* 管理画面からの操作（起動・停止・再起動・リストの読み直しなど）は、プロセス間通信（IPC）で管理プロセスに依頼します。

### データの配置

```
config/default.json         共通の設定（Twitch アプリの Client ID / Secret など）
config/local.json           共通の設定の上書き（管理画面の「共通の設定」の保存先。EventSub の設定もここ）
config/operators.json       運営者の Twitch ログイン名
config/webui.json           管理画面の設定
channels/<login>/
    channel.json            登録情報（登録日時・登録者・起動するかどうか）
    config/local.json       チャンネルの設定（対象チャンネル、配信者の ID、クールダウン、1 日の上限）
    secrets/bot-tokens.json bot アカウントのトークン（0600）
    secrets/google-key.json Google Cloud のサービスアカウントキー（0600）
    ignoreusers.json  ignoreline.json  emoticons.json
    logs/                   このチャンネルの bot のログ
data/audit.log              操作の記録（秘密の値は書きません）
data/usage/<login>.json     翻訳文字数（日・月）
logs/                       管理プロセスと管理画面のログ
```

`config/` の実データ、`channels/`、`data/` は git の対象外で、Docker のイメージにも入れません（`.gitignore`・`.dockerignore`）。
**バックアップを取るときは `channels/*/secrets/` を含めないでください。**


## 必要なもの

* Node.js 20 以降（Docker のイメージは `node:20-alpine`）
* **HTTPS で公開できるドメイン**（443 番）。EventSub の Webhook は 443 番の HTTPS にしか届きません。管理画面のログインにも使います。
* 運営者が用意するもの: Twitch アプリ（[dev.twitch.tv](https://dev.twitch.tv/) で登録。全チャンネルで共通）
* 配信者が用意するもの:
  * 翻訳を投稿する **bot 用の Twitch アカウント**（チャンネル主のアカウントとは別のもの）
  * Cloud Translation API を有効にした **Google Cloud のプロジェクトと、サービスアカウントキー（JSON）**
    （[手順](https://cloud.google.com/translate/docs/setup?hl=ja)）。翻訳の料金は配信者のプロジェクトにかかります。


## 運営者の準備

1. **Twitch アプリを登録します。** OAuth のリダイレクト URL に `https://<ドメイン>/auth/twitch/callback` を登録し、
   「クライアントの秘密」を発行します（ページを移ると再表示できないので控えてください）。

2. **共通の設定を書きます。** `config/local.example.json` を `config/local.json` にコピーして編集します
   （`config/default.json` に書いても構いません。同じ項目は `local.json` が優先されます）。管理画面の「共通の設定」からも変更できます。

   <dl>
   <dt>twitchClientId / twitchClientSecret</dt>
     <dd>手順 1 のアプリの Client ID と Client Secret。管理画面のログイン、bot アカウントの接続、EventSub のすべてに使います。</dd>
   <dt>eventsub.callbackUrl</dt>
     <dd>EventSub の受信口の URL。<code>https://&lt;ドメイン&gt;/eventsub/callback</code> の形です。
         購読のたびに Twitch に伝えるので、Twitch のコンソールに登録する必要はありません。</dd>
   <dt>eventsub.secret</dt>
     <dd>受け取ったイベントの署名の検証に使う、10〜100 文字のランダムな文字列（例: <code>openssl rand -hex 32</code>）。</dd>
   </dl>

   値が説明文のまま（日本語などを含む）の項目は未設定として扱います。

3. **運営者を決めます。** `config/operators.example.json` を `config/operators.json` にコピーし、運営者の Twitch ログイン名を書きます。

4. **管理画面の設定を書きます。** `config/webui.example.json` を `config/webui.json` にコピーして編集します（[管理画面の設定](#管理画面の設定)）。

5. **リバースプロキシを設定します。** HTTPS で受けて、次のように転送します。
   * `/eventsub/` → コンテナの 3200 番（パスはそのまま渡す。受信口は `/eventsub/callback` で待ち受けます）
   * それ以外 → コンテナの 3000 番
   * 3100 番（状態の口）は外へ公開しないでください。

6. **起動します。**
   ```bash
   npm ci --omit=dev
   npm start            # node manager.js
   ```
   Docker の場合はイメージの既定のコマンドが `node manager.js` です。停止の猶予（`stop_grace_period`）は 30 秒程度にしてください。
   イメージには `HEALTHCHECK`（状態の口を確認）が入っています。

7. **チャンネルを登録します。** 運営者として管理画面にログインし、「チャンネル管理」で配信者の Twitch ログイン名を登録します。


## 配信者の準備

運営者にチャンネルを登録してもらったあと、管理画面で次の順に進めます（「マイチャンネル」に進み具合が表示されます）。

1. **ログインします。** 「Twitch でログイン」で、`channel:bot` の許可も求めます。許可すると、bot アカウントがこのチャンネルで受信・投稿できるようになります。
2. **bot アカウントを接続します。** 「bot アカウントを接続」を押し、**bot 用のアカウントで** Twitch にログインし直して許可します
   （必要な許可: `user:read:chat`、`user:bot`、`user:write:chat`、`moderator:manage:chat_messages`）。チャンネル主のアカウントは使えません。
3. **bot アカウントをモデレーターにします**（推奨）。チャットで `/mod <bot のアカウント名>` と入力します。翻訳の自動削除に必要です。
4. **Google Cloud のキーをアップロードします。** 「Google Cloud キー」タブから、サービスアカウントキー（JSON）をアップロードします。
5. 準備がそろうと **bot が自動で起動します。**

許可は Twitch の「設定 → 接続」からいつでも外せます。Twitch アカウントの二段階認証を有効にしておいてください（管理画面の本人確認は Twitch に任せています）。


## 管理画面

ログインには Twitch の OAuth を使います。ログインできるのは運営者と、登録済みのチャンネルの配信者だけです。
権限はリクエストのたびに確かめるので、運営者から外したり、チャンネルを削除したりすると、ログイン中の人もすぐに使えなくなります。

### 配信者ができること（自分のチャンネルだけ）

<dl>
<dt>マイチャンネル</dt>
  <dd>利用開始までの手順と進み具合、bot の稼働状態、翻訳文字数、bot の起動・再起動・停止、bot アカウントの接続と解除。</dd>
<dt>設定</dt>
  <dd>クールダウン回数と、1 日の翻訳文字数の上限。翻訳文字数（今日・今月）の確認。</dd>
<dt>リスト・エモート</dt>
  <dd>翻訳しないユーザー、翻訳しない文字列（正規表現）、エモート一覧の編集と、エモートの今すぐ取得。</dd>
<dt>Google Cloud キー</dt>
  <dd>サービスアカウントキーのアップロード・状態の確認・削除。<strong>ファイルを削除しても Google Cloud 側ではキーは有効なままです。</strong>
      不要になったキーは Google Cloud のコンソールでも削除してください。</dd>
<dt>ログ / 操作の記録</dt>
  <dd>自分のチャンネルの bot のログと、操作の記録。</dd>
</dl>

設定・リスト・キーを変えると、動いている bot に自動で反映します（設定とキーは再起動、リストは読み直し）。

### 運営者ができること

<dl>
<dt>チャンネル管理</dt>
  <dd>全チャンネルの準備状況と bot の状態の確認、起動・停止・再起動、ログの閲覧、チャンネルの登録と削除。EventSub の状態の確認。</dd>
<dt>共通の設定</dt>
  <dd>Twitch アプリと EventSub の設定、運営者の一覧。<strong>共通の設定は起動時に読み込むので、反映にはコンテナ（管理プロセス）の再起動が必要です。</strong></dd>
<dt>ログ / 操作の記録</dt>
  <dd>管理プロセス・管理画面・全チャンネルのログと、全体の操作の記録。</dd>
</dl>

運営者は配信者の代わりに、設定・リスト・bot アカウント・Google Cloud のキーを操作できません（自分のチャンネルを登録している運営者は、そのチャンネルについては配信者として操作できます）。

### チャンネルの削除

運営者が削除すると、次の順に処理します。

1. bot を止める
2. そのチャンネルの EventSub の購読を削除する
3. bot アカウントのトークンを Twitch 側で無効化する
4. Google Cloud のキー、トークン、設定、リスト、ログ、翻訳文字数の記録を削除する
5. その配信者のセッションを無効にする
6. 操作の記録を残す

管理プロセスに接続できなくても、3〜6 は必ず行います。Google Cloud のキーは Google Cloud 側では有効なままなので、配信者にコンソールでの削除を伝えてください。

### 秘密の値の扱い

bot のトークン、Google Cloud のキー、Twitch アプリの Client Secret、EventSub の署名用シークレットは書き込み専用です。
運営者を含めて、画面にも API にも返しません（「設定済み」かどうかだけを表示します）。ログの中のトークンらしき文字列も伏せて表示します。

### 管理画面の設定

`config/webui.json`（各項目は環境変数でも指定できます）。

<dl>
<dt>redirectUri（WEBUI_REDIRECT_URI）</dt>
  <dd>OAuth のリダイレクト URI。<code>https://&lt;ドメイン&gt;/auth/twitch/callback</code>。
      <strong>Twitch アプリに登録した URL と完全に一致させてください。</strong>既定値は <code>http://localhost:3000/auth/twitch/callback</code> です。</dd>
<dt>sessionSecret（WEBUI_SESSION_SECRET）</dt>
  <dd>セッション Cookie の署名に使うランダムな文字列（例: <code>openssl rand -hex 32</code>）。
      未設定の場合は起動ごとに生成されるため、再起動でログイン状態が失われます。</dd>
<dt>port / host（WEBUI_PORT / WEBUI_HOST）</dt>
  <dd>待ち受けるポートとアドレス。既定は 127.0.0.1:3000 です。コンテナで動かす場合は host を <code>0.0.0.0</code> にします。</dd>
<dt>trustProxy / secureCookie（WEBUI_TRUST_PROXY / WEBUI_SECURE_COOKIE）</dt>
  <dd>HTTPS のリバースプロキシの後ろで公開する場合は、どちらも true にします（secureCookie は redirectUri が https なら既定で true）。</dd>
<dt>sessionHours（WEBUI_SESSION_HOURS）</dt>
  <dd>ログインの有効期間（既定 12 時間）。ログイン状態は上限付きのメモリに保存します（既定 1000 件、WEBUI_MAX_SESSIONS）。
      ログインを始めただけのセッションは 10 分で破棄します。管理画面を再起動すると再ログインが必要です。</dd>
<dt>rateLimitAuthPerMinute / rateLimitApiPerMinute（WEBUI_RATE_LIMIT_AUTH / WEBUI_RATE_LIMIT_API）</dt>
  <dd>1 分あたりの回数制限（既定 /auth 30 回、/api 600 回）。</dd>
<dt>allowedUsers（WEBUI_ALLOWED_USERS）</dt>
  <dd>以前の版の設定です。ここに書かれた名前は運営者として扱います。新しく設定する場合は <code>config/operators.json</code> を使ってください。</dd>
</dl>


## 環境変数

<dl>
<dt>TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / EVENTSUB_CALLBACK_URL / EVENTSUB_SECRET</dt>
  <dd>共通の設定を上書きします（設定ファイルより優先）。</dd>
<dt>WEBUI_OPERATORS</dt>
  <dd>運営者の Twitch ログイン名（カンマか空白で区切る）。<code>config/operators.json</code> に加えて運営者として扱います。管理画面からは変更できません。</dd>
<dt>MANAGER_HEALTH_PORT / MANAGER_HEALTH_HOST</dt>
  <dd>状態の口（既定 0.0.0.0:3100）。</dd>
<dt>EVENTSUB_PORT / EVENTSUB_HOST</dt>
  <dd>EventSub の受信口（既定 0.0.0.0:3200）。</dd>
<dt>MANAGER_LOG_LEVEL / WEBUI_LOG_LEVEL</dt>
  <dd>ログの詳しさ（既定 info）。</dd>
<dt>TCT_ROOT</dt>
  <dd>設定・チャンネル・ログを読み書きするディレクトリ。既定はリポジトリのルートです。</dd>
</dl>


## エモートについて
* エモート一覧に登録した文字列は、翻訳の前に取り除きます。
* 管理プロセスが、チャンネルごとに **6 時間おき**に BetterTTV と FrankerFaceZ からチャンネルのエモートを取得し、一覧を作り直します。
  **取得したものだけで作り直すので、手で追加したエモートは次の自動取得で消えます。**
  どの取得元からも取得できなかったときは、一覧を変更しません。
* 管理画面の「今すぐ取得」で、すぐに取得し直せます。


## 特定の文字・ユーザーを翻訳させない
管理画面の「リスト・エモート」で、翻訳しないユーザーと、翻訳しない文字列（正規表現）を設定できます。
正規表現は保存前に検証します。ファイルは `channels/<login>/ignoreusers.json` と `ignoreline.json` です。

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
    "nightbot"
  ]
}
```


## コマンド
チャットから次のコマンドを使えます。モデレーターとチャンネル主だけが使えます。

<dl>
<dt>!refreshignoreuser</dt>
  <dd>ignoreusers.json を読み直します。</dd>
<dt>!refreshignoreline</dt>
  <dd>ignoreline.json を読み直します。</dd>
<dt>!refreshemoticons</dt>
  <dd>emoticons.json を読み直します。</dd>
</dl>

管理画面でリストを保存したときは自動で読み直すので、通常は使う必要はありません。


## ログと記録
* bot のログは `channels/<login>/logs/twitchchattranslator.log`、管理プロセスと管理画面のログは `logs/manager.log`・`logs/webui.log` です。
  日付ごとに切り替え、**30 日**を過ぎたものは削除します。チャットの発言の本文は通常のログに書きません。
* 操作の記録（誰が、いつ、どのチャンネルの、何を変えたか）は `data/audit.log` で、**1 年**保存します。秘密の値は書きません。
* 状態の口 `GET /healthz`（3100 番）は、bot（再起動回数と前回の終了の理由を含む）と管理画面の状態、EventSub の購読の突き合わせの結果と取り消し、
  App Access Token の期限を JSON で返します（トークンそのものは返しません）。
  動かすべき bot や管理画面が止まっていると 503 になります。


## 単一チャンネル版からの移行

以前の版（`config/default.json` に bot アカウントの情報まで入れて 1 チャンネルで動かす形）からは、移行スクリプトで移します。

```bash
node scripts/migrate-single-channel.js <login>                      # 何を移すかを表示するだけ
node scripts/migrate-single-channel.js <login> --apply --operator   # 移して、運営者にもする
```

* 移すもの: 対象チャンネル・配信者の ID・クールダウン回数、ルートの ignoreusers.json / ignoreline.json / emoticons.json、
  `googleKeyFile` のキー（コンテナ内のパス `/app/...` はリポジトリのルートに読み替えます）。
* **移さないもの: bot アカウントのトークン。** EventSub の受信に必要な許可（`user:read:chat`）がないため、移行後に管理画面から接続し直します。
* 元のファイルは消しません。設定の対象チャンネルと違うログイン名や、すでにあるチャンネルへの移行は拒否します。
* コンテナと同じ uid（1000）で実行してください。

移行後、起動コマンドを `node manager.js` に変えます。以前の版のエモート更新（`emotelistupdate.js` と `config/jsonupdate.json`、
ホストの cron など）は不要になります。


## テスト

```bash
npm test
```

権限の分離（配信者が他のチャンネルに触れないこと、運営者が配信者の代わりに操作できないこと）を全 API について確かめるテスト、
EventSub の署名の検証、管理プロセス、bot、削除の手順、移行スクリプトなどのテストが実行されます。


## 動作確認済み環境
* Docker の node:20-alpine（Node.js 20.20.2）と Node.js 24 でテストしています。
