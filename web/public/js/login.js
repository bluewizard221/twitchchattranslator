'use strict';

(function () {
    var MESSAGES = {
        denied: {
            type: 'error',
            text: 'このアカウントには管理画面へのアクセスが許可されていません。配信者の方は、運営者にチャンネルの登録を依頼してください。'
        },
        state: {
            type: 'error',
            text: 'ログイン要求を検証できませんでした（state 不一致）。お手数ですがもう一度お試しください。'
        },
        oauth: {
            type: 'error',
            text: 'Twitch との認証に失敗しました。時間をおいてもう一度お試しください。続く場合は運営者に連絡してください。'
        },
        cancelled: {
            type: 'warn',
            text: 'Twitch の認可がキャンセルされました。'
        },
        session: {
            type: 'error',
            text: 'セッションの作成に失敗しました。サーバーのログを確認してください。'
        },
        setup: {
            type: 'error',
            text: '管理画面の設定が完了していません。下記の内容を確認してから、サーバーを再起動してください。'
        }
    };

    var params = new URLSearchParams(window.location.search);
    var container = document.getElementById('message');

    function render(type, text, items) {
        var box = document.createElement('div');

        box.className = 'notice notice-' + (type === 'warn' ? 'warn' : (type === 'error' ? 'error' : 'info'));
        box.textContent = text;

        if (items && items.length) {
            var list = document.createElement('ul');

            items.forEach(function (item) {
                var li = document.createElement('li');

                li.textContent = item;
                list.appendChild(li);
            });

            box.appendChild(list);
        }

        container.appendChild(box);
    }

    var errorKey = params.get('error');

    if (errorKey && MESSAGES[errorKey]) {
        var message = MESSAGES[errorKey];
        var login = params.get('login');

        render(message.type, errorKey === 'denied' && login
            ? 'ログインしたアカウント「' + login + '」には管理画面へのアクセスが許可されていません。配信者の方は、運営者にチャンネルの登録を依頼してください。'
            : message.text);
    }

    // サーバー側の設定不足を確認して、ログインできない理由を先に知らせる
    fetch('/auth/status', { credentials: 'same-origin' })
        .then(function (res) { return res.json(); })
        .then(function (status) {
            if (status.loggedIn) {
                window.location.replace('/');
                return;
            }

            if (!status.ready) {
                document.getElementById('loginButton').classList.add('hidden');
                render('error', '管理画面の設定が完了していないためログインできません。', status.errors);
            }
        })
        .catch(function () {
            render('error', 'サーバーに接続できませんでした。');
        });
}());
