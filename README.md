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

  FreeBSD 11.2-RELEASE上のnode v15.3.0にて動作を確認出来ています。
* 必要モジュール

  tmi.js, request, fs, config, log4js, request-promise-native, google-translate


## 使用手順
1. https://dev.twitch.tv/ から新たにアプリを登録します。

2. 登録したアプリ用のOAuthトークンを https://twitchapps.com/tokengen/ から取得します。

3. 翻訳botを利用するユーザーのOAuthトークンを https://twitchapps.com/tmi/ から取得します。

4. Google Cloud Translate APIキーを Google Cloud Platform 経由で取得します。

5. 上記必要モジュールをサーバにインストールします。

6. config/default.jsonに適当な値を入力します。

<dl>
<dt>pidFile</dt>
  <dd>プロセスIDを記入するファイルのファイルパスを設定します。</dd>
<dt>twitchUserName</dt>
  <dd>翻訳botとして利用するユーザーのユーザー名を設定します。</dd>
<dt>twitchOauth</dt>
  <dd>翻訳botとして利用するユーザーのOAuthトークンを設定します。</dd>
<dt>twitchChannel</dt>
  <dd>翻訳botを走らせたいチャンネル名を設定します。（表示名でなくアルファベットの方）</dd>
<dt>twitchUserId</dt>
  <dd>翻訳botを走らせたいチャンネルのID（数値）を設定します。</dd>
<dt>googleApiKey</dt>
  <dd>Google Cloud Translation APIのキーを設定します。</dd>
<dt>coolDownCount</dt>
  <dd>同一ユーザーから1分間の間に受け付ける最大翻訳回数を設定します。ここに設定した数値までを翻訳します。</dd>
</dl>

7. スクリプトを起動します。例ではバックグラウンドに落としていますが、デーモン化したい場合は適宜デーモン化してください。
ex)
```bash
(./twitchchattranslator.js) &
```


## エモートについて
* エモートの一覧はルートディレクトリ内の emoticons.json に格納されています。コミットされているファイルには twitch の全エモート, FrankerFaceZ・Better TTV のグローバルエモートが格納されていますが、付属の emotelistupdate.js を利用することで FFZのチャンネルエモートも登録することが可能です。
* emotelistupdate.js は既存の emoticons.json を上書きします。
* emotelistupdate.js は config/jsonupdate.json を設定ファイルとして利用します。

config/jsonupdate.jsonについて：

<dl>
<dt>twitchClientId</dt>
  <dd>翻訳botのアプリ用のクライアントIDを設定します。dev.twitch.tv で取得したものです。</dd>
<dt>twitchChannel</dt>
  <dd>翻訳botを走らせたいチャンネル名を設定します。（表示名でなくアルファベットの方）</dd>
<dt>oauthToken</dt>
  <dd>翻訳botのアプリ用OAuthトークンを設定します。twitchapps.com/tokengen/ で取得したものです。</dd>
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
<dt>!switchtarget (main|room)</dt>
  <dd>翻訳bot が翻訳文を書く部屋を指定出来ます。mainはデフォルトの部屋、roomは設定で指定した部屋に書かれます。 targetisOtherRoom を1として設定している時のみ動作します。</dd>
</dl>


## その他諸注意
* ログが logs/twitchchattranslator.log に書き出されます。
  また、ログのローテーションが日付単位で行われます。ログを書き込むイベントが発生した際に日付が変わっていた場合ローテーションが行われます。
