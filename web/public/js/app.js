'use strict';

(function () {

    var state = {
        csrfToken: null,
        user: null,
        role: null,          // { login, isOperator, channel }
        loaded: {},
        pendingKey: null
    };

    // ------------------------------------------------------------------
    // 共通ユーティリティ
    // ------------------------------------------------------------------

    function api(method, url, body) {
        var options = {
            method: method,
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        };

        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.headers['X-CSRF-Token'] = state.csrfToken || '';
            options.body = JSON.stringify(body);
        }

        return fetch(url, options).then(function (res) {
            if (res.status === 401) {
                window.location.href = '/login';
                throw new Error('ログインが必要です。');
            }

            return res.text().then(function (text) {
                var data = null;

                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (err) {
                        throw new Error('サーバーの応答を解釈できませんでした。');
                    }
                }

                if (!res.ok) {
                    var error = new Error((data && data.error) || ('エラーが発生しました（HTTP ' + res.status + '）'));

                    error.data = data;
                    throw error;
                }

                return data;
            });
        });
    }

    /** 自分のチャンネルの API の URL */
    function own(path) {
        return '/api/channels/' + encodeURIComponent(state.role.channel) + (path || '');
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);

        if (className) { node.className = className; }
        if (text !== undefined && text !== null) { node.textContent = text; }

        return node;
    }

    function clear(node) {
        while (node.firstChild) { node.removeChild(node.firstChild); }
    }

    function $(id) {
        return document.getElementById(id);
    }

    function toast(type, text) {
        var area = $('toasts');
        var node = el('div', 'toast toast-' + type, text);

        area.appendChild(node);

        // 画面を埋め尽くさないよう、古いものから消す
        while (area.children.length > 4) {
            area.removeChild(area.firstChild);
        }

        window.setTimeout(function () {
            if (node.parentNode) { node.parentNode.removeChild(node); }
        }, type === 'error' ? 9000 : 5000);
    }

    /** 通知欄を差し替える。items を渡すと箇条書きを追加する */
    function setNotice(container, type, text, items) {
        clear(container);

        if (!text && (!items || !items.length)) { return; }

        var box = el('div', 'notice notice-' + type);

        if (text) { box.appendChild(document.createTextNode(text)); }

        if (items && items.length) {
            var list = el('ul');

            items.forEach(function (item) { list.appendChild(el('li', null, item)); });
            box.appendChild(list);
        }

        container.appendChild(box);
    }

    function formatDateTime(iso) {
        if (!iso) { return '—'; }

        var date = new Date(iso);

        if (isNaN(date.getTime())) { return '—'; }

        var pad = function (num) { return String(num).padStart(2, '0'); };

        return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) +
            ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function formatNumber(num) {
        return Number(num || 0).toLocaleString('ja-JP');
    }

    function busy(button, isBusy, busyLabel) {
        if (!button) { return; }

        if (isBusy) {
            button.dataset.label = button.textContent;
            button.textContent = busyLabel || '処理中…';
            button.disabled = true;
        } else {
            if (button.dataset.label) { button.textContent = button.dataset.label; }
            button.disabled = false;
        }
    }

    /** ボタンを処理中にして promise を待ち、エラーはトーストに出す */
    function withBusy(button, label, promise) {
        busy(button, true, label);

        return promise.catch(function (err) {
            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    function stat(label, value, sub, tone) {
        var node = el('div', 'stat' + (tone ? ' stat-' + tone : ''));

        node.appendChild(el('div', 'stat-label', label));
        node.appendChild(el('div', 'stat-value', value));

        if (sub) { node.appendChild(el('div', 'stat-sub', sub)); }

        return node;
    }

    function badge(type, text) {
        return el('span', 'badge badge-' + type, text);
    }

    // bot プロセスの状態（lib/supervisor.js）の表示
    var PROCESS_LABELS = {
        running: ['ok', '稼働中'],
        backoff: ['error', '異常終了・再起動待ち'],
        stopping: ['warn', '停止中…'],
        stopped: ['muted', '停止']
    };

    function processBadge(info) {
        if (!info) { return badge('muted', '停止'); }

        var entry = PROCESS_LABELS[info.state] || ['muted', info.state];

        return badge(entry[0], entry[1]);
    }

    function processNote(info) {
        if (!info) { return ''; }

        var parts = [];

        if (info.state === 'running' && info.startedAt) { parts.push('起動 ' + formatDateTime(info.startedAt)); }
        if (info.restarts) { parts.push('再起動 ' + info.restarts + ' 回'); }
        if (info.state === 'backoff' && info.nextStartAt) { parts.push('次の起動 ' + formatDateTime(info.nextStartAt)); }
        if (info.lastExit && info.state !== 'running') {
            parts.push('前回の終了: ' + (info.lastExit.error || ('code ' + info.lastExit.code + (info.lastExit.signal ? ' / ' + info.lastExit.signal : ''))));
        }

        return parts.join('・');
    }

    // ------------------------------------------------------------------
    // タブ切り替え
    // ------------------------------------------------------------------

    var LOADERS = {
        channel: loadChannel,
        config: function () { return Promise.all([loadConfig(), loadUsage()]); },
        lists: function () { return loadLists(['ignoreusers', 'ignoreline', 'emoticons']); },
        google: loadGoogleKey,
        channels: loadChannels,
        shared: function () { return Promise.all([loadShared(), loadOperators()]); },
        logs: loadLogs,
        audit: loadAudit
    };

    function allowedTab(tab) {
        var role = tab.dataset.role;

        if (role === 'owner') { return !!state.role.channel; }
        if (role === 'operator') { return state.role.isOperator; }

        return true;
    }

    function availableViews() {
        var tabs = document.querySelectorAll('.tab');
        var names = [];

        for (var i = 0; i < tabs.length; i++) {
            if (allowedTab(tabs[i])) { names.push(tabs[i].dataset.view); }
        }

        return names;
    }

    function showView(name) {
        var tabs = document.querySelectorAll('.tab');

        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('active', tabs[i].dataset.view === name);
        }

        var views = document.querySelectorAll('.view');

        for (var j = 0; j < views.length; j++) {
            views[j].classList.toggle('hidden', views[j].id !== 'view-' + name);
        }

        if (!state.loaded[name] && LOADERS[name]) {
            state.loaded[name] = true;
            LOADERS[name]().catch(function (err) {
                state.loaded[name] = false;
                toast('error', err.message);
            });
        }

        if (window.location.hash !== '#' + name) {
            window.history.replaceState(null, '', '#' + name);
        }
    }

    /** 別のタブの内容が古くなったときに呼ぶ（次に開いたときに読み直す） */
    function invalidate() {
        for (var i = 0; i < arguments.length; i++) {
            state.loaded[arguments[i]] = false;
        }
    }

    // ------------------------------------------------------------------
    // マイチャンネル（配信者）
    // ------------------------------------------------------------------

    function loadChannel() {
        return api('GET', own()).then(function (data) {
            renderSteps(data);
            renderChannelStats(data);

            var notices = $('channelNotices');

            if (!data.managerAvailable) {
                setNotice(notices, 'error', '管理プロセスに接続できないため、bot の状態を確認できません。運営者に連絡してください。');
            } else if (data.owner && data.owner.usage.exceeded) {
                setNotice(notices, 'warn', '今日の翻訳文字数が上限（' + formatNumber(data.owner.usage.dailyLimit) +
                    ' 文字）に達したため、今日は翻訳していません。上限は「設定」タブで変えられます。');
            } else if (data.ready && data.enabled && data.process && data.process.state === 'running') {
                setNotice(notices, 'ok', '準備はすべてそろっていて、bot は稼働中です。');
            } else {
                clear(notices);
            }
        });
    }

    function renderSteps(data) {
        var list = $('channelSteps');
        var owner = data.owner;
        var bot = owner.bot;
        var key = owner.googleKey;

        clear(list);

        function step(done, title, body, actions) {
            var item = el('li', 'step ' + (done ? 'step-done' : 'step-todo'));
            var head = el('div', 'step-head');

            head.appendChild(badge(done ? 'ok' : 'warn', done ? '完了' : '未完了'));
            head.appendChild(el('strong', null, title));
            item.appendChild(head);

            if (body) { item.appendChild(el('p', 'step-body', body)); }

            if (actions && actions.length) {
                var row = el('div', 'step-actions');

                actions.forEach(function (node) { row.appendChild(node); });
                item.appendChild(row);
            }

            list.appendChild(item);
        }

        function link(label, href, primary) {
            var node = el('a', 'btn btn-small' + (primary ? ' btn-primary' : ''), label);

            node.href = href;
            return node;
        }

        function button(label, onClick, extra) {
            var node = el('button', 'btn btn-small' + (extra ? ' ' + extra : ''), label);

            node.type = 'button';
            node.addEventListener('click', onClick);
            return node;
        }

        step(true, 'チャンネルの登録', '運営者が #' + data.login + ' を登録しました（' + formatDateTime(data.createdAt) + '）。');

        step(!!owner.channelBotGrantedAt, 'bot の利用の許可（channel:bot）',
            owner.channelBotGrantedAt
                ? formatDateTime(owner.channelBotGrantedAt) + ' のログインで許可しました。bot アカウントがこのチャンネルで受信・投稿できます。'
                : 'ログイン時に「channel:bot」の許可が得られていません。一度ログアウトし、ログインし直して許可してください。');

        var botBody;
        var botActions = [];

        if (bot.connected) {
            botBody = 'bot アカウント「' + bot.botLogin + '」を接続しています（' + formatDateTime(bot.connectedAt) + '）。';

            if (bot.missingScopes.length > 0) {
                botBody += ' 必要な許可が足りません: ' + bot.missingScopes.join(', ') + '。接続し直してください。';
            }

            botActions.push(link('接続し直す', '/auth/bot/' + encodeURIComponent(data.login)));
            botActions.push(button('接続を解除', disconnectBot, 'btn-danger'));
        } else {
            botBody = '翻訳を投稿する bot 用の Twitch アカウントを接続します。ボタンを押すと Twitch のログイン画面になるので、' +
                'チャンネル主ではなく bot 用のアカウントでログインして許可してください（チャンネル主のアカウントは使えません）。';
            botActions.push(link('bot アカウントを接続', '/auth/bot/' + encodeURIComponent(data.login), true));
        }

        step(bot.connected && bot.missingScopes.length === 0, 'bot アカウントの接続', botBody, botActions);

        // モデレーターかどうかはこの画面からは確認できないので、完了の印は付けずに案内だけする
        var modItem = el('li', 'step step-info');
        var modHead = el('div', 'step-head');

        modHead.appendChild(badge('muted', '推奨'));
        modHead.appendChild(el('strong', null, 'bot アカウントをモデレーターにする'));
        modItem.appendChild(modHead);
        modItem.appendChild(el('p', 'step-body', bot.connected
            ? 'チャットで「/mod ' + bot.botLogin + '」と入力してください。元の発言が削除されたときに翻訳も削除するために必要です。'
            : 'bot アカウントを接続したあと、チャットで「/mod <bot のアカウント名>」と入力してください。元の発言が削除されたときに翻訳も削除するために必要です。'));
        list.appendChild(modItem);

        step(key.exists && key.valid, 'Google Cloud のキーのアップロード',
            key.exists && key.valid
                ? 'プロジェクト「' + key.projectId + '」のキーをアップロード済みです。'
                : (key.message || 'キーがまだアップロードされていません。') + ' 「Google Cloud キー」タブからアップロードしてください。',
            key.exists && key.valid ? [] : [link('Google Cloud キーへ', '#google')]);

        var running = data.process && data.process.state === 'running';
        var startBody;

        if (!data.ready) {
            startBody = 'まだそろっていないもの: ' + data.missing.map(function (m) { return m.label; }).join('、') + '。そろうと自動で起動します。';
        } else if (!data.enabled) {
            startBody = '停止しています。下の「起動」で動かせます。';
        } else {
            startBody = running ? 'bot は稼働中です。' : 'bot が起動していません。下の状態を確認してください。';
        }

        step(running, 'bot の起動', startBody);
    }

    function renderChannelStats(data) {
        var stats = $('channelStats');
        var usage = data.owner.usage;

        clear(stats);

        var proc = el('div', 'stat');

        proc.appendChild(el('div', 'stat-label', 'bot プロセス'));
        proc.appendChild(el('div', 'stat-value')).appendChild(processBadge(data.process));
        stats.appendChild(proc);

        stats.appendChild(stat('起動の設定', data.enabled ? '有効' : '停止中', data.enabled ? '準備がそろえば自動で起動します' : '「起動」を押すまで動きません'));
        stats.appendChild(stat('今日の翻訳文字数', formatNumber(usage.today),
            usage.dailyLimit > 0 ? '上限 ' + formatNumber(usage.dailyLimit) + ' 文字' : '上限なし', usage.exceeded ? 'warn' : null));
        stats.appendChild(stat('今月の翻訳文字数', formatNumber(usage.month), ''));

        $('channelProcessNote').textContent = processNote(data.process);
    }

    function controlOwnChannel(button) {
        var op = button.dataset.control;

        if (op === 'stop' && !window.confirm('bot を停止します。「起動」を押すまで翻訳しません。よろしいですか？')) { return; }

        withBusy(button, '処理中…', api('POST', own('/' + op), {}).then(function () {
            toast('ok', { start: '起動しました。', stop: '停止しました。', restart: '再起動しました。' }[op]);
            invalidate('channels', 'audit');
            return loadChannel();
        }));
    }

    function disconnectBot(event) {
        if (!window.confirm('bot アカウントの接続を解除します。トークンを無効化し、bot は止まります。よろしいですか？')) { return; }

        withBusy(event.target, '解除中…', api('DELETE', own('/bot'), {}).then(function (result) {
            toast(result.revoked === false ? 'warn' : 'ok', result.revoked === false
                ? '接続を解除しました（一部のトークンは無効化できませんでした。すでに無効だった可能性があります）。'
                : '接続を解除しました。');
            invalidate('audit');
            return loadChannel();
        }));
    }

    // ------------------------------------------------------------------
    // 設定・使用量（配信者）
    // ------------------------------------------------------------------

    function loadConfig() {
        return api('GET', own('/config')).then(function (data) {
            var container = $('configFields');

            clear(container);

            var fixed = el('div', 'field');

            fixed.appendChild(el('label', null, '対象チャンネル / 配信者の ID'));
            fixed.appendChild(el('p', 'mono', '#' + data.twitchChannel + ' / ' + (data.twitchBroadcasterId || '（次のログインで記録されます）')));
            container.appendChild(fixed);

            data.fields.forEach(function (field) {
                container.appendChild(renderField('config', field, data.values[field.key]));
            });

            $('configMeta').textContent = '保存先: ' + data.meta.path +
                (data.meta.exists ? '（最終更新 ' + formatDateTime(data.meta.updatedAt) + '）' : '');
        });
    }

    function loadUsage() {
        return api('GET', own('/usage')).then(function (usage) {
            var stats = $('usageStats');

            clear(stats);
            stats.appendChild(stat('今日', formatNumber(usage.today) + ' 文字',
                usage.dailyLimit > 0 ? '上限 ' + formatNumber(usage.dailyLimit) + ' 文字' + (usage.exceeded ? '（上限に達しました）' : '') : '上限なし',
                usage.exceeded ? 'warn' : null));
            stats.appendChild(stat('今月', formatNumber(usage.month) + ' 文字', ''));
        });
    }

    /**
     * 設定項目の入力欄。prefix ごとに .<prefix>-input を付け、保存時にまとめて集める。
     * value: チャンネル設定は { value, isDefault }、共通の設定は { value, hasValue, source }
     */
    function renderField(prefix, field, value) {
        var wrapper = el('div', 'field');
        var label = el('label', null, field.label);
        var id = prefix + '-field-' + field.key;

        label.htmlFor = id;

        if (field.required) { label.appendChild(el('span', 'req', '必須')); }

        if (value && value.isDefault) {
            label.appendChild(el('span', 'source-tag', '（既定値）'));
        } else if (value && value.source) {
            label.appendChild(el('span', 'source-tag', '（' + value.source + '）'));
        }

        wrapper.appendChild(label);

        var row = el('div', 'input-row');
        var input = document.createElement('input');

        input.id = id;
        input.dataset.key = field.key;
        input.dataset.secret = field.secret ? '1' : '';
        input.className = prefix + '-input';
        input.type = field.type === 'number' ? 'number' : (field.secret ? 'password' : 'text');
        input.autocomplete = field.secret ? 'new-password' : 'off';
        input.spellcheck = false;

        if (field.min !== undefined && field.min !== null) { input.min = field.min; }
        if (field.max !== undefined && field.max !== null) { input.max = field.max; }

        if (field.secret) {
            input.placeholder = value && value.hasValue ? '設定済み（変更する場合のみ入力）' : '未設定';
        } else {
            input.placeholder = field.placeholder || '';
            input.value = value && value.value !== null && value.value !== undefined ? String(value.value) : '';
        }

        row.appendChild(input);

        if (field.secret) {
            var toggle = el('button', 'btn btn-small', '表示');

            toggle.type = 'button';
            toggle.addEventListener('click', function () {
                var showing = input.type === 'text';

                input.type = showing ? 'password' : 'text';
                toggle.textContent = showing ? '表示' : '隠す';
            });
            row.appendChild(toggle);
        }

        wrapper.appendChild(row);

        if (field.help) { wrapper.appendChild(el('p', 'help', field.help)); }

        wrapper.appendChild(el('p', 'field-error hidden'));

        return wrapper;
    }

    function collectValues(prefix) {
        var inputs = document.querySelectorAll('.' + prefix + '-input');
        var values = {};

        for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];

            // 秘密の値は空欄なら「変更しない」の意味なので送らない
            if (input.dataset.secret === '1' && input.value.trim() === '') { continue; }

            values[input.dataset.key] = input.value;
        }

        return values;
    }

    function showFieldErrors(prefix, fieldErrors) {
        var inputs = document.querySelectorAll('.' + prefix + '-input');

        for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            var message = fieldErrors ? fieldErrors[input.dataset.key] : null;
            var errorNode = input.closest('.field').querySelector('.field-error');

            input.classList.toggle('invalid', !!message);
            errorNode.textContent = message || '';
            errorNode.classList.toggle('hidden', !message);
        }
    }

    function submitForm(prefix, method, url, button, notices, onSaved) {
        busy(button, true, '保存中…');

        return api(method, url, { values: collectValues(prefix) }).then(function (result) {
            showFieldErrors(prefix, null);
            onSaved(result);
        }).catch(function (err) {
            if (err.data && err.data.fieldErrors) {
                showFieldErrors(prefix, err.data.fieldErrors);
                setNotice(notices, 'error', '入力内容にエラーがあります。各項目のメッセージを確認してください。');
            } else {
                setNotice(notices, 'error', err.message);
            }

            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    function saveConfig(event) {
        event.preventDefault();

        var notices = $('configNotices');

        submitForm('config', 'PUT', own('/config'), $('saveConfig'), notices, function (result) {
            var text = result.saved.length === 0
                ? '変更はありませんでした。'
                : '設定を保存しました。' + (result.restarted ? '動いていた bot を再起動して反映しました。' : 'bot の次の起動から反映されます。');

            setNotice(notices, 'ok', text);
            toast('ok', text);
            invalidate('channel', 'audit');

            return Promise.all([loadConfig(), loadUsage()]);
        });
    }

    // ------------------------------------------------------------------
    // リスト・エモート（配信者）
    // ------------------------------------------------------------------

    function loadLists(ids) {
        return api('GET', own('/lists')).then(function (data) {
            ids.forEach(function (id) {
                var panel = document.querySelector('[data-list="' + id + '"]');

                if (!panel || !data[id]) { return; }

                renderList(panel, data[id]);
            });
        });
    }

    function renderList(panel, data) {
        panel.querySelector('.list-help').textContent = data.help;
        panel.querySelector('.list-input').value = data.items.join('\n');
        panel.querySelector('.list-input').placeholder = data.placeholder;
        panel.querySelector('.list-count').textContent = data.items.length + ' 件';
        panel.querySelector('.list-updated').textContent = '最終更新: ' + formatDateTime(data.updatedAt);

        var notices = panel.querySelector('.list-notices');

        if (data.error) {
            setNotice(notices, 'error', data.error);
        } else {
            clear(notices);
        }
    }

    function saveList(panel) {
        var id = panel.dataset.list;
        var textarea = panel.querySelector('.list-input');
        var button = panel.querySelector('.list-save');
        var notices = panel.querySelector('.list-notices');

        var items = textarea.value.split('\n').map(function (line) { return line.trim(); })
            .filter(function (line) { return line !== ''; });

        busy(button, true, '保存中…');

        return api('PUT', own('/lists/' + encodeURIComponent(id)), { items: items }).then(function (result) {
            textarea.value = result.items.join('\n');
            panel.querySelector('.list-count').textContent = result.items.length + ' 件';
            panel.querySelector('.list-updated').textContent = '最終更新: ' + formatDateTime(result.updatedAt);

            var message = result.items.length + ' 件を保存しました。';

            if (result.removedDuplicates > 0) {
                message += '（重複 ' + result.removedDuplicates + ' 件を除きました）';
            }

            message += result.reloaded ? ' 動いている bot に反映しました。' : ' bot の次の起動から反映されます。';

            setNotice(notices, 'ok', message);
            toast('ok', message);
            invalidate('audit');
        }).catch(function (err) {
            setNotice(notices, 'error', err.message, err.data ? err.data.errors : null);
            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    function refreshEmotes(event) {
        var panel = document.querySelector('[data-list="emoticons"]');
        var notices = panel.querySelector('.list-notices');

        setNotice(notices, 'info', 'BetterTTV / FrankerFaceZ からエモート一覧を取得しています…');

        withBusy(event.target, '取得中…', api('POST', own('/emotes/refresh'), {}).then(function (result) {
            var text = 'エモート一覧を ' + result.count + ' 件で更新しました。';

            toast('ok', text);
            invalidate('audit');

            // 読み直すと通知欄が消えるので、結果は読み直したあとに出す
            return loadLists(['emoticons']).then(function () {
                setNotice(notices, result.warnings.length > 0 ? 'warn' : 'ok', text, result.warnings);
            });
        }).catch(function (err) {
            setNotice(notices, 'error', err.message, err.data ? err.data.errors : null);
            throw err;
        }));
    }

    // ------------------------------------------------------------------
    // Google Cloud キー（配信者）
    // ------------------------------------------------------------------

    function loadGoogleKey() {
        return api('GET', own('/google-key')).then(function (data) {
            var table = $('googleStatus');
            var status = data.status;

            clear(table);

            var body = el('tbody');

            function row(label, value) {
                var tr = el('tr');

                tr.appendChild(el('th', null, label));
                tr.appendChild(el('td', null, value === null || value === undefined || value === '' ? '—' : String(value)));
                body.appendChild(tr);
            }

            row('状態', status.exists ? (status.valid ? '正常なサービスアカウントキー' : (status.message || '形式が不正です')) : '未アップロード');
            row('プロジェクト ID', status.projectId);
            row('サービスアカウント', status.clientEmail);
            row('パーミッション', status.mode);
            row('最終更新', status.updatedAt ? formatDateTime(status.updatedAt) : null);

            table.appendChild(body);

            $('deleteKey').disabled = !status.exists;

            var notices = $('googleNotices');

            if (!status.exists || !status.valid) {
                setNotice(notices, 'warn', 'まだ有効なサービスアカウントキーがありません。下からアップロードしてください。');
            } else {
                setNotice(notices, 'ok', 'サービスアカウントキーはアップロード済みです。差し替える場合は、新しいキーをアップロードしてください。');
            }
        });
    }

    function handleKeyFile(file) {
        var preview = $('keyPreviewText');
        var uploadButton = $('uploadKey');

        state.pendingKey = null;
        uploadButton.disabled = true;

        if (!file) { return; }

        if (!/\.json$/i.test(file.name)) {
            preview.textContent = 'JSON ファイル（.json）を選択してください。';
            return;
        }

        if (file.size > 64 * 1024) {
            preview.textContent = 'ファイルサイズが大きすぎます（64KB 以内）。サービスアカウントキーではない可能性があります。';
            return;
        }

        var reader = new FileReader();

        reader.onload = function () {
            var text = String(reader.result);
            var parsed;

            try {
                parsed = JSON.parse(text);
            } catch (err) {
                preview.textContent = 'JSON として読み込めませんでした: ' + file.name;
                return;
            }

            if (!parsed || parsed.type !== 'service_account') {
                preview.textContent = 'サービスアカウントキー（"type": "service_account"）ではないようです: ' + file.name;
                return;
            }

            state.pendingKey = { content: text };
            uploadButton.disabled = false;

            preview.textContent = '選択中: ' + file.name +
                '（プロジェクト: ' + (parsed.project_id || '不明') +
                ' / サービスアカウント: ' + (parsed.client_email || '不明') + '）';
        };

        reader.onerror = function () {
            preview.textContent = 'ファイルを読み込めませんでした。';
        };

        reader.readAsText(file);
    }

    function uploadKey() {
        if (!state.pendingKey) { return; }

        var button = $('uploadKey');
        var notices = $('googleNotices');

        busy(button, true, 'アップロード中…');

        api('POST', own('/google-key'), { content: state.pendingKey.content }).then(function (result) {
            setNotice(notices, 'ok', 'キー（プロジェクト「' + result.projectId + '」）を保存しました。' +
                (result.restarted ? '動いていた bot を再起動して反映しました。' : ''), result.warnings);
            toast('ok', 'サービスアカウントキーを保存しました。');

            state.pendingKey = null;
            $('keyPreviewText').textContent = '';
            $('keyFile').value = '';
            invalidate('channel', 'audit');

            return loadGoogleKey();
        }).catch(function (err) {
            setNotice(notices, 'error', err.message, err.data ? err.data.warnings : null);
            toast('error', err.message);
        }).then(function () {
            busy(button, false);
            button.disabled = !state.pendingKey;
        });
    }

    function deleteKey(event) {
        if (!window.confirm('Google Cloud のキーを削除します。bot は翻訳できなくなり停止します。よろしいですか？')) { return; }

        withBusy(event.target, '削除中…', api('DELETE', own('/google-key'), {}).then(function (result) {
            toast('ok', 'キーを削除しました。');
            invalidate('channel', 'audit');

            return loadGoogleKey().then(function () {
                setNotice($('googleNotices'), 'warn', result.notice);
            });
        }));
    }

    // ------------------------------------------------------------------
    // チャンネル管理（運営者）
    // ------------------------------------------------------------------

    function loadChannels() {
        return api('GET', '/api/channels').then(function (data) {
            var tbody = $('channelsTable').querySelector('tbody');

            clear(tbody);

            if (!data.managerAvailable) {
                setNotice($('channelsNotices'), 'error', '管理プロセスに接続できないため、bot の状態を取得できません。');
            } else {
                clear($('channelsNotices'));
            }

            if (data.channels.length === 0) {
                var empty = el('tr');
                var cell = el('td', 'loading', 'まだチャンネルが登録されていません。');

                cell.colSpan = 5;
                empty.appendChild(cell);
                tbody.appendChild(empty);
            }

            data.channels.forEach(function (channel) {
                tbody.appendChild(channelRow(channel));
            });

            var eventsub = data.eventsub;

            $('eventsubNote').textContent = !eventsub ? '' : (eventsub.configured
                ? 'EventSub: 受信口 ' + (eventsub.callbackUrl || '—') +
                    (eventsub.lastSync ? '・最終同期 ' + formatDateTime(eventsub.lastSync.at) + (eventsub.lastSync.error ? '（失敗: ' + eventsub.lastSync.error + '）' : '') : '') +
                    (eventsub.revocations && eventsub.revocations.length ? '・取り消し ' + eventsub.revocations.length + ' 件' : '')
                : 'EventSub は無効です（「共通の設定」の Twitch アプリ・受信口の URL・署名用シークレットを確認してください）。チャットのイベントは届きません。');
        });
    }

    function channelRow(channel) {
        var tr = el('tr');
        var name = el('td');

        name.appendChild(el('strong', null, '#' + channel.login));

        if (state.role.channel === channel.login) { name.appendChild(el('span', 'source-tag', '（自分）')); }

        tr.appendChild(name);

        var ready = el('td');

        ready.appendChild(channel.ready ? badge('ok', 'そろっている') : badge('warn', '未完了'));

        if (!channel.ready) {
            ready.appendChild(el('div', 'cell-note', channel.missing.map(function (m) { return m.label; }).join('、')));
        }

        tr.appendChild(ready);

        var proc = el('td');

        proc.appendChild(processBadge(channel.process));

        if (!channel.enabled) { proc.appendChild(el('div', 'cell-note', '停止に設定')); }

        var note = processNote(channel.process);

        if (note) { proc.appendChild(el('div', 'cell-note', note)); }

        tr.appendChild(proc);

        tr.appendChild(el('td', 'cell-note', formatDateTime(channel.createdAt) + (channel.createdBy ? '・' + channel.createdBy : '')));

        // td 自体を flex にすると表の罫線が崩れるので、中に箱を作って並べる
        var actionCell = el('td');
        var actions = el('div', 'cell-actions');

        [['start', '起動'], ['restart', '再起動'], ['stop', '停止']].forEach(function (pair) {
            var button = el('button', 'btn btn-small', pair[1]);

            button.type = 'button';
            button.addEventListener('click', function () { controlChannel(channel.login, pair[0], button); });
            actions.appendChild(button);
        });

        var logs = el('button', 'btn btn-small', 'ログ');

        logs.type = 'button';
        logs.addEventListener('click', function () {
            state.logTarget = 'channel:' + channel.login;
            invalidate('logs');
            showView('logs');
        });
        actions.appendChild(logs);

        var remove = el('button', 'btn btn-small btn-danger', '削除');

        remove.type = 'button';
        remove.addEventListener('click', function () { deleteChannel(channel.login, remove); });
        actions.appendChild(remove);
        actionCell.appendChild(actions);

        tr.appendChild(actionCell);

        return tr;
    }

    function controlChannel(login, op, button) {
        if (op === 'stop' && !window.confirm('#' + login + ' の bot を停止します。よろしいですか？')) { return; }

        withBusy(button, '…', api('POST', '/api/channels/' + encodeURIComponent(login) + '/' + op, {}).then(function () {
            toast('ok', '#' + login + ': ' + { start: '起動しました。', stop: '停止しました。', restart: '再起動しました。' }[op]);
            invalidate('channel', 'audit');
            return loadChannels();
        }));
    }

    function registerChannel(event) {
        event.preventDefault();

        var input = $('registerLogin');
        var notices = $('registerNotices');
        var login = input.value.trim();

        if (!login) { return; }

        withBusy($('registerButton'), '登録中…', api('POST', '/api/channels', { login: login }).then(function (result) {
            input.value = '';
            setNotice(notices, 'ok', '#' + result.channel.login + ' を登録しました。配信者本人にこの管理画面へのログインを案内してください。', result.warnings);
            invalidate('audit');

            return loadChannels();
        }).catch(function (err) {
            setNotice(notices, 'error', err.message);
            throw err;
        }));
    }

    var STEP_LABELS = {
        stop: 'bot の停止',
        subscriptions: 'EventSub の購読の削除',
        revoke: 'bot のトークンの無効化',
        files: 'キー・トークン・設定・リスト・ログ・使用量の削除',
        sessions: '配信者のセッションの無効化',
        audit: '操作の記録'
    };

    function deleteChannel(login, button) {
        var typed = window.prompt('#' + login + ' を削除します。bot のトークンと Google Cloud のキーを含め、このチャンネルのデータはすべて削除され、元に戻せません。\n' +
            '確認のため、ログイン名（' + login + '）を入力してください。');

        if (typed === null) { return; }

        if (typed.trim().toLowerCase() !== login) {
            toast('error', 'ログイン名が一致しないため、削除しませんでした。');
            return;
        }

        withBusy(button, '削除中…', api('DELETE', '/api/channels/' + encodeURIComponent(login), { confirm: typed.trim() }).then(function (result) {
            renderDeleteResult(login, result);
            toast(result.steps.every(function (s) { return s.ok; }) ? 'ok' : 'warn', '#' + login + ' を削除しました。');
            invalidate('channel', 'audit', 'logs');

            return loadChannels();
        }));
    }

    function renderDeleteResult(login, result) {
        var container = $('deleteResult');

        clear(container);
        $('deleteResultPanel').classList.remove('hidden');

        container.appendChild(el('p', null, '#' + login + ' の削除の手順と結果:'));

        var list = el('ul', 'result-list');

        result.steps.forEach(function (step) {
            var item = el('li');

            item.appendChild(badge(step.ok ? 'ok' : 'error', step.ok ? '完了' : '失敗'));
            item.appendChild(el('span', null, ' ' + (STEP_LABELS[step.step] || step.step) + (step.detail ? '（' + step.detail + '）' : '')));
            list.appendChild(item);
        });

        container.appendChild(list);

        var notices = el('div');

        setNotice(notices, 'warn', '配信者に次のことを伝えてください。', result.notices);
        container.appendChild(notices);
    }

    // ------------------------------------------------------------------
    // 共通の設定・運営者（運営者）
    // ------------------------------------------------------------------

    function loadShared() {
        return api('GET', '/api/shared/config').then(function (data) {
            var container = $('sharedFields');

            clear(container);

            data.fields.forEach(function (field) {
                container.appendChild(renderField('shared', field, data.values[field.key]));
            });

            $('sharedMeta').textContent = data.notice;
        });
    }

    function saveShared(event) {
        event.preventDefault();

        var notices = $('sharedNotices');

        submitForm('shared', 'PUT', '/api/shared/config', $('saveShared'), notices, function (result) {
            setNotice(notices, 'ok', result.saved.length === 0 ? '変更はありませんでした。' : '保存しました。' + result.notice);
            toast('ok', '共通の設定を保存しました。');
            invalidate('audit');

            return loadShared();
        });
    }

    function loadOperators() {
        return api('GET', '/api/shared/operators').then(renderOperators);
    }

    function renderOperators(data) {
        $('operatorsInput').value = data.fromFile.join('\n');
        $('operatorsPath').textContent = '保存先: ' + data.path;

        var fixed = data.fromEnv.concat(data.fromLegacy);

        $('operatorsFixed').textContent = fixed.length > 0
            ? 'このほかに、環境変数・旧形式の設定で運営者になっている人（画面からは変更できません）: ' + fixed.join(', ')
            : '';
    }

    function saveOperators(event) {
        var notices = $('operatorsNotices');
        var names = $('operatorsInput').value.split(/[\s,]+/).map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });

        withBusy(event.target, '保存中…', api('PUT', '/api/shared/operators', { operators: names }).then(function (result) {
            renderOperators(result);
            setNotice(notices, 'ok', '運営者の一覧を保存しました（' + result.operators.join(', ') + '）。');
            invalidate('audit');
        }).catch(function (err) {
            setNotice(notices, 'error', err.message);
            throw err;
        }));
    }

    // ------------------------------------------------------------------
    // ログ
    // ------------------------------------------------------------------

    /** 選べるログの範囲: 自分のチャンネル、（運営者は）各チャンネルとシステム */
    function logScopes() {
        var scopes = [];

        if (state.role.channel) { scopes.push({ key: 'channel:' + state.role.channel, label: '#' + state.role.channel, base: own('/logs') }); }

        if (!state.role.isOperator) { return Promise.resolve(scopes); }

        scopes.push({ key: 'system', label: 'システム', base: '/api/system/logs' });

        return api('GET', '/api/channels').then(function (data) {
            data.channels.forEach(function (channel) {
                if (channel.login === state.role.channel) { return; }

                scopes.push({ key: 'channel:' + channel.login, label: '#' + channel.login, base: '/api/channels/' + encodeURIComponent(channel.login) + '/logs' });
            });

            return scopes;
        });
    }

    function loadLogs() {
        return logScopes().then(function (scopes) {
            var lists = scopes.map(function (scope) {
                return api('GET', scope.base).then(function (data) {
                    return data.logs.map(function (log) {
                        return { value: scope.base + '/' + encodeURIComponent(log.id), scope: scope.key, label: scope.label + ' — ' + log.label + (log.exists ? '' : '（未作成）') };
                    });
                });
            });

            return Promise.all(lists);
        }).then(function (groups) {
            var select = $('logSelect');
            var current = select.value;

            clear(select);

            groups.forEach(function (options) {
                options.forEach(function (item) {
                    var option = el('option', null, item.label);

                    option.value = item.value;
                    option.dataset.scope = item.scope;
                    select.appendChild(option);
                });
            });

            // チャンネル管理の「ログ」から来たときは、そのチャンネルを選ぶ
            if (state.logTarget) {
                var target = select.querySelector('option[data-scope="' + state.logTarget + '"]');

                if (target) { select.value = target.value; }
                state.logTarget = null;
            } else if (current && select.querySelector('option[value="' + current + '"]')) {
                select.value = current;
            }

            return loadLog();
        });
    }

    function loadLog() {
        var url = $('logSelect').value;

        if (!url) { return Promise.resolve(); }

        var lines = $('logLines').value;
        var problemsOnly = $('logProblemsOnly').checked;

        return api('GET', url + '?lines=' + encodeURIComponent(lines) + (problemsOnly ? '&level=warn' : '')).then(function (data) {
            var output = $('logOutput');
            var notices = $('logNotices');
            var meta = $('logMeta');

            if (!data.exists) {
                setNotice(notices, 'info', data.error || 'ログファイルはまだありません。');
                output.textContent = '';
                meta.textContent = data.path;
                return;
            }

            if (data.lines.length === 0) {
                setNotice(notices, 'info', problemsOnly ? '警告・エラーはありません。' : 'ログは空です。');
            } else if (data.truncated) {
                setNotice(notices, 'info', 'ファイルが大きいため、末尾の一部だけを読み込んでいます。');
            } else {
                clear(notices);
            }

            output.textContent = data.lines.join('\n');
            output.scrollTop = output.scrollHeight;

            meta.textContent = data.path + '・' + data.lines.length + ' 行を表示' +
                (problemsOnly ? '（警告・エラーのみ ' + data.matched + ' 件中）' : '') +
                '・最終更新 ' + formatDateTime(data.updatedAt);
        });
    }

    // ------------------------------------------------------------------
    // 操作の記録
    // ------------------------------------------------------------------

    var ACTION_LABELS = {
        'login': 'ログイン',
        'channel.register': 'チャンネルの登録',
        'channel.delete': 'チャンネルの削除',
        'channel.start': 'bot の起動',
        'channel.stop': 'bot の停止',
        'channel.restart': 'bot の再起動',
        'config.update': '設定の変更',
        'lists.update': 'リストの変更',
        'emotes.refresh': 'エモートの取得',
        'googleKey.upload': 'Google Cloud キーのアップロード',
        'googleKey.delete': 'Google Cloud キーの削除',
        'bot.connect': 'bot アカウントの接続',
        'bot.disconnect': 'bot アカウントの接続解除',
        'shared.config': '共通の設定の変更',
        'operators.update': '運営者の一覧の変更'
    };

    function auditScopes() {
        var select = $('auditScope');

        if (select.options.length > 0) { return; }

        if (state.role.isOperator) {
            var all = el('option', null, 'すべて');

            all.value = '/api/audit';
            select.appendChild(all);
        }

        if (state.role.channel) {
            var mine = el('option', null, '#' + state.role.channel);

            mine.value = own('/audit');
            select.appendChild(mine);
        }

        select.classList.toggle('hidden', select.options.length < 2);
    }

    function describeDetail(detail) {
        if (!detail) { return ''; }

        return Object.keys(detail).map(function (key) {
            var value = detail[key];

            return key + ': ' + (Array.isArray(value) ? value.join(', ') : (value === null ? '—' : String(value)));
        }).join(' / ');
    }

    function loadAudit() {
        auditScopes();

        return api('GET', $('auditScope').value + '?limit=500').then(function (data) {
            var tbody = $('auditTable').querySelector('tbody');

            clear(tbody);

            if (data.entries.length === 0) {
                setNotice($('auditNotices'), 'info', 'まだ記録はありません。');
                return;
            }

            clear($('auditNotices'));

            data.entries.forEach(function (entry) {
                var tr = el('tr');

                tr.appendChild(el('td', 'cell-note', formatDateTime(entry.at)));
                tr.appendChild(el('td', null, entry.actor || '—'));
                tr.appendChild(el('td', null, entry.channel ? '#' + entry.channel : '—'));
                tr.appendChild(el('td', null, ACTION_LABELS[entry.action] || entry.action));
                tr.appendChild(el('td', 'cell-note', describeDetail(entry.detail)));
                tbody.appendChild(tr);
            });
        });
    }

    // ------------------------------------------------------------------
    // 初期化
    // ------------------------------------------------------------------

    function wire() {
        $('tabs').addEventListener('click', function (event) {
            var tab = event.target.closest('.tab');

            if (tab) { showView(tab.dataset.view); }
        });

        // 手順の「Google Cloud キーへ」などのページ内リンク
        window.addEventListener('hashchange', function () {
            var name = window.location.hash.slice(1);

            if (availableViews().indexOf(name) !== -1) { showView(name); }
        });

        $('logoutButton').addEventListener('click', function () {
            api('POST', '/auth/logout', {}).then(function () {
                window.location.href = '/login';
            }).catch(function (err) {
                toast('error', err.message);
            });
        });

        $('refreshChannel').addEventListener('click', function (event) {
            withBusy(event.target, '読み込み中…', loadChannel());
        });

        document.querySelectorAll('[data-control]').forEach(function (button) {
            button.addEventListener('click', function () { controlOwnChannel(button); });
        });

        $('configForm').addEventListener('submit', saveConfig);
        $('reloadConfig').addEventListener('click', function () {
            showFieldErrors('config', null);
            clear($('configNotices'));
            loadConfig().then(function () { toast('info', '設定を再読み込みしました。'); })
                .catch(function (err) { toast('error', err.message); });
        });

        document.querySelectorAll('[data-list]').forEach(function (panel) {
            panel.querySelector('.list-save').addEventListener('click', function () { saveList(panel); });
            panel.querySelector('.list-reload').addEventListener('click', function () {
                loadLists([panel.dataset.list]).then(function () { toast('info', '再読み込みしました。'); })
                    .catch(function (err) { toast('error', err.message); });
            });
        });

        $('refreshEmotes').addEventListener('click', refreshEmotes);

        var drop = $('keyDrop');
        var fileInput = $('keyFile');

        drop.addEventListener('click', function () { fileInput.click(); });
        drop.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInput.click();
            }
        });
        drop.addEventListener('dragover', function (event) {
            event.preventDefault();
            drop.classList.add('dragover');
        });
        drop.addEventListener('dragleave', function () { drop.classList.remove('dragover'); });
        drop.addEventListener('drop', function (event) {
            event.preventDefault();
            drop.classList.remove('dragover');
            handleKeyFile(event.dataTransfer.files[0]);
        });

        fileInput.addEventListener('change', function () { handleKeyFile(fileInput.files[0]); });

        $('uploadKey').addEventListener('click', uploadKey);
        $('deleteKey').addEventListener('click', deleteKey);
        $('refreshGoogle').addEventListener('click', function (event) {
            withBusy(event.target, '読み込み中…', loadGoogleKey());
        });

        $('refreshChannels').addEventListener('click', function (event) {
            withBusy(event.target, '読み込み中…', loadChannels());
        });
        $('registerForm').addEventListener('submit', registerChannel);

        $('sharedForm').addEventListener('submit', saveShared);
        $('saveOperators').addEventListener('click', saveOperators);

        var reloadLog = function () {
            loadLog().catch(function (err) { toast('error', err.message); });
        };

        $('logSelect').addEventListener('change', reloadLog);
        $('logLines').addEventListener('change', reloadLog);
        $('logProblemsOnly').addEventListener('change', reloadLog);
        $('refreshLogs').addEventListener('click', function (event) {
            withBusy(event.target, '読み込み中…', loadLogs());
        });

        $('auditScope').addEventListener('change', function () {
            loadAudit().catch(function (err) { toast('error', err.message); });
        });
        $('refreshAudit').addEventListener('click', function (event) {
            withBusy(event.target, '読み込み中…', loadAudit());
        });
    }

    function applyRole() {
        var tabs = document.querySelectorAll('.tab');

        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('hidden', !allowedTab(tabs[i]));
        }

        var labels = [];

        if (state.role.channel) { labels.push('#' + state.role.channel); }
        if (state.role.isOperator) { labels.push('運営者'); }

        $('brandRole').textContent = labels.join('・') || '管理画面';
    }

    api('GET', '/api/session').then(function (data) {
        state.csrfToken = data.csrfToken;
        state.user = data.user;
        state.role = data.role;

        $('userName').textContent = data.user.displayName || data.user.login;

        if (data.user.profileImageUrl) {
            var avatar = $('userAvatar');

            avatar.src = data.user.profileImageUrl;
            avatar.alt = data.user.displayName || data.user.login;
            avatar.classList.remove('hidden');
        }

        applyRole();
        wire();

        if (!data.managerAvailable) {
            setNotice($('globalNotices'), 'error', '管理プロセスに接続されていません。bot の起動・停止や状態の確認はできません。');
        }

        // bot アカウントの接続（OAuth）から戻ったときの結果
        if (data.flash) {
            toast(data.flash.type === 'ok' ? 'ok' : 'error', data.flash.text);
        }

        var views = availableViews();
        var initial = (window.location.hash || '').slice(1);

        showView(views.indexOf(initial) !== -1 ? initial : views[0]);
    }).catch(function (err) {
        toast('error', err.message);
    });

}());
