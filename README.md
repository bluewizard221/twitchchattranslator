# twitchchattranslator


## 説明
Twitchのチャットに書かれた文章を翻訳します。日本語が否かを判定し、日本語を英語に、非日本語を日本語に翻訳します。
エモートは取り除かれます。

チャンネル主の発言は常に翻訳し、それ以外のユーザーの発言は配信中のみ翻訳します。
配信中かどうかは Twitch Helix API（Get Streams）を定期的に問い合わせて判定します（既定 60 秒間隔。配信開始・終了の反映には最大でこの間隔ぶんの遅れがあります）。
起動直後などで配信状態をまだ一度も取得できていない間は、従来どおり全員の発言を翻訳します。
`!refreshignoreuser` などのコマンドは、配信中かどうかに関係なく使えます。

翻訳の投稿には Twitch Helix API（Send Chat Message）を使うため、**投稿先のチャンネル主が bot を許可している
（`channel:bot`）か、bot がそのチャンネルのモデレーターである必要があります**（[使用手順](#使用手順)の 5・6）。
許可のないチャンネルには投稿しません（IRC での代替投稿は行いません）。


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

  tmi.js, fs, config, log4js, @google-cloud/translate, got


## 使用手順
1. https://dev.twitch.tv/ から新たにアプリを登録します。OAuth Redirect URLには `http://localhost` を設定します。

2. 登録したアプリの「アプリケーションの管理」画面内の”クライアントの秘密”からシークレット値を発行します。値はページを遷移すると再度参照できなくなるので注意してください。

3. 翻訳botを利用するユーザーのOAuthトークンを https://twitchapps.com/tmi/ から取得します。（チャットの読み取り用の IRC 接続に使います）

4. botユーザーでログインした状態で以下のURLにアクセスし、アプリを認可します（翻訳の投稿・チャットボットバッジの表示・翻訳の自動削除に必要です）。
   ```
   https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&scope=user:bot+user:write:chat+moderator:manage:chat_messages
   ```
   リダイレクト先URL（`http://localhost/?code=...`、ページは表示されなくて構いません）の `code=` の値を使い、アクセストークンとリフレッシュトークンを取得します。
   ```bash
   curl -X POST 'https://id.twitch.tv/oauth2/token' \
     -d 'client_id=YOUR_CLIENT_ID' \
     -d 'client_secret=YOUR_CLIENT_SECRET' \
     -d 'code=CODE_FROM_URL' \
     -d 'grant_type=authorization_code' \
     -d 'redirect_uri=http://localhost'
   ```

5. **配信者ユーザー**でログインした状態で以下のURLにアクセスし、botがチャンネルに投稿することを許可します（`channel:bot`）。
   ```
   https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&scope=channel:bot
   ```
   許可した事実が Twitch 側に記録されれば十分なので、こちらはトークンを取得・保管する必要はありません。

6. 配信チャンネルで botユーザーにモデレーター権限を付与します（チャットで `/mod botのユーザー名`）。

   **翻訳を投稿するには、5（`channel:bot` の許可）と 6（モデレーター権限）のどちらか一方が必要です。** どちらもないチャンネルでは投稿が拒否され、
   ログに `Helix refused to post` と `Translation was not posted` が記録されます（IRC での代替投稿は行いません）。
   また、元の発言が削除・BAN・タイムアウトされたときに翻訳を自動で削除する機能には、6 のモデレーター権限が必要です。

7. https://cloud.google.com/translate/docs/setup?hl=ja を参考にしてサービス・アカウント・キーとなるJSONキーファイルを取得します。

8. 上記必要モジュールをサーバにインストールします。

9. config/default.jsonに適当な値を入力します。

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
  <dd>翻訳botとして利用するユーザーのOAuthトークンを設定します。（手順3で取得）</dd>
<dt>twitchChannel</dt>
  <dd>翻訳botを走らせたいチャンネル名を設定します。（表示名でなくアルファベットの方）</dd>
<dt>twitchClientId</dt>
	<dd>登録したアプリのクライアントIDを設定します。</dd>
<dt>twitchClientSecret</dt>
	<dd>登録したアプリに対応したシークレット値を設定します。</dd>
<dt>twitchBotUserId</dt>
  <dd>翻訳botとして利用するユーザーの数値IDを設定します。（下の取得例を参照）</dd>
<dt>twitchBroadcasterId</dt>
  <dd>配信者の数値IDを設定します。（下の取得例を参照）配信中かどうかの判定と、チャンネル主の発言の判定にも使います。</dd>
<dt>twitchBotUserAccessToken</dt>
  <dd>手順4で取得したbotユーザーのアクセストークンを設定します。</dd>
<dt>twitchBotRefreshToken</dt>
  <dd>手順4で取得したリフレッシュトークンを設定します。アクセストークンの自動更新に使います（更新後の値は config/tokens.json に保存されます）。</dd>
<dt>coolDownCount</dt>
  <dd>同一ユーザーから1分間の間に受け付ける最大翻訳回数を設定します。ここに設定した数値までを翻訳します。</dd>
<dt>streamStatusPollSeconds（省略可）</dt>
  <dd>配信中かどうかを確認する間隔（秒）を設定します。省略時は 60 秒です。</dd>
</dl>

   ユーザーIDの取得例（ACCESS_TOKEN は手順4のアクセストークン）：
   ```bash
   curl -s -H "Authorization: Bearer ACCESS_TOKEN" \
        -H "Client-Id: YOUR_CLIENT_ID" \
        "https://api.twitch.tv/helix/users?login=BOT_USERNAME&login=BROADCASTER_USERNAME"
   ```

10. スクリプトを起動します。例ではバックグラウンドに落としていますが、デーモン化したい場合は適宜デーモン化してください。
ex)
```bash
(./twitchchattranslator.js) &
```


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


## その他諸注意
* ログが logs/twitchchattranslator.log に書き出されます。
  また、ログのローテーションが日付単位で行われます。ログを書き込むイベントが発生した際に日付が変わっていた場合ローテーションが行われます。
* 翻訳の投稿には Twitch Helix API（Send Chat Message）を使います。投稿先のチャンネル主が bot に `channel:bot` を許可しているか、bot がそのチャンネルのモデレーターである必要があります。
  許可のないチャンネルでは投稿が拒否され、その旨がログに記録されます。チャンネル主の同意なしに投稿しないよう、IRC での代替投稿は行いません。
