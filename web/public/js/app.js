'use strict';

(function () {

    var state = {
        csrfToken: null,
        user: null,
        config: null,
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

    function el(tag, className, text) {
        var node = document.createElement(tag);

        if (className) { node.className = className; }
        if (text !== undefined && text !== null) { node.textContent = text; }

        return node;
    }

    function clear(node) {
        while (node.firstChild) { node.removeChild(node.firstChild); }
    }

    function toast(type, text) {
        var area = document.getElementById('toasts');
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

    // ------------------------------------------------------------------
    // タブ切り替え
    // ------------------------------------------------------------------

    var LOADERS = {
        dashboard: loadOverview,
        config: loadConfig,
        lists: function () { return loadLists(['ignoreusers', 'ignoreline']); },
        emotes: function () { return loadLists(['emoticons']).then(updateEmoteTarget); },
        google: loadGoogleKey,
        logs: loadLogs
    };

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
            LOADERS[name]().catch(function (err) { toast('error', err.message); });
        }

        if (window.location.hash !== '#' + name) {
            window.history.replaceState(null, '', '#' + name);
        }
    }

    // ------------------------------------------------------------------
    // ダッシュボード
    // ------------------------------------------------------------------

    function loadOverview() {
        return api('GET', '/api/overview').then(function (data) {
            var stats = document.getElementById('overviewStats');
            var notices = document.getElementById('overviewNotices');

            clear(stats);

            stats.appendChild(stat('bot プロセス',
                data.bot.running ? '稼働中' : '停止中',
                data.bot.pid ? 'PID ' + data.bot.pid : (data.bot.message || '')));

            stats.appendChild(stat('対象チャンネル',
                data.channel || '未設定',
                data.broadcasterId ? 'ID ' + data.broadcasterId : '配信者 ID が未設定です'));

            stats.appendChild(stat('bot アカウント', data.botUserName || '未設定', ''));

            stats.appendChild(stat('Google Cloud キー',
                data.googleKey.valid ? '設定済み' : '未設定',
                data.googleKey.valid ? (data.googleKey.projectId || '') : (data.googleKey.message || '')));

            data.lists.forEach(function (list) {
                stats.appendChild(stat(list.label, list.count + ' 件',
                    list.error ? list.error : '最終更新 ' + formatDateTime(list.updatedAt)));
            });

            if (data.channelMatchesLogin === false) {
                setNotice(notices, 'error', '対象チャンネル（' + (data.channel || '—') + '）がログイン中のアカウント（' +
                    data.loginChannel + '）と異なります。bot は設定ファイルのチャンネルで動作します。' +
                    '「基本設定」で「ログイン情報から」を使って保存し、bot を再起動してください。');
            } else if (data.missingRequired.length > 0) {
                setNotice(notices, 'warn', '未設定の必須項目があります。「基本設定」タブで入力してください。',
                    data.missingRequired.map(function (item) { return item.label + '（' + item.reason + '）'; }));
            } else {
                setNotice(notices, 'ok', '必須項目はすべて設定されています。');
            }

            document.getElementById('botStatusText').textContent = data.bot.running
                ? 'bot は稼働中です（PID ' + data.bot.pid + '）。'
                : (data.bot.message || 'bot の状態を確認できませんでした。');

            document.getElementById('pollIntervalText').textContent = data.streamStatusPollSeconds + ' 秒';

            var brand = document.getElementById('brandChannel');

            brand.textContent = data.channel ? '#' + data.channel : '管理画面';
        });
    }

    function stat(label, value, sub) {
        var node = el('div', 'stat');

        node.appendChild(el('div', 'stat-label', label));
        node.appendChild(el('div', 'stat-value', value));

        if (sub) { node.appendChild(el('div', 'stat-sub', sub)); }

        return node;
    }

    // ------------------------------------------------------------------
    // 基本設定
    // ------------------------------------------------------------------

    function loadConfig() {
        return api('GET', '/api/config').then(function (data) {
            state.config = data;
            renderConfig(data);
        });
    }

    function renderConfig(data) {
        var container = document.getElementById('configGroups');
        var notices = document.getElementById('configNotices');

        clear(container);

        var brokenLayers = data.layers.filter(function (layer) { return layer.error; });

        if (brokenLayers.length > 0) {
            setNotice(notices, 'error', '設定ファイルの読み込みに失敗しました。',
                brokenLayers.map(function (layer) { return layer.path + ': ' + layer.error; }));
        } else {
            clear(notices);
        }

        data.groups.forEach(function (group) {
            var fields = data.fields.filter(function (field) { return field.group === group.key; });

            if (fields.length === 0) { return; }

            var panel = el('div', 'panel');

            panel.appendChild(el('h2', null, group.label));
            panel.appendChild(el('p', 'panel-help', group.help));

            fields.forEach(function (field) {
                panel.appendChild(renderField(field, data.values[field.key], data.oauth));
            });

            container.appendChild(panel);
        });

        document.getElementById('configMeta').textContent =
            '保存先: ' + data.meta.path + (data.meta.exists ? '（最終更新 ' + formatDateTime(data.meta.updatedAt) + '）' : '（未作成）');
    }

    function renderField(field, value, oauth) {
        var wrapper = el('div', 'field');
        var label = el('label', null, field.label);

        label.htmlFor = 'field-' + field.key;

        if (field.required) { label.appendChild(el('span', 'req', '必須')); }

        if (value && value.isPlaceholder) {
            label.appendChild(el('span', 'source-tag warn-tag', '（config/default.json の説明文のまま・未設定）'));
        } else if (value && value.source) {
            label.appendChild(el('span', 'source-tag', '（' + value.source + ' 由来）'));
        }

        wrapper.appendChild(label);

        var row = el('div', 'input-row');
        var input = document.createElement('input');

        input.id = 'field-' + field.key;
        input.name = field.key;
        input.dataset.key = field.key;
        input.dataset.secret = field.secret ? '1' : '';
        input.className = 'config-input';
        input.type = field.type === 'number' ? 'number' : (field.secret ? 'password' : 'text');
        input.autocomplete = field.secret ? 'new-password' : 'off';
        input.spellcheck = false;

        // ログイン中のアカウントに固定する項目は手入力させない（「ログイン情報から」でのみ入力）
        if (field.locked) {
            input.readOnly = true;
            input.classList.add('locked-input');
        }

        if (field.secret) {
            input.placeholder = value && value.hasValue
                ? '設定済み（変更する場合のみ入力）'
                : (field.placeholder || '未設定');
        } else {
            input.placeholder = field.placeholder || '';

            // テンプレートの説明文はそのまま保存させたくないので入力欄には入れない
            input.value = value && value.hasValue && value.value !== null && value.value !== undefined
                ? String(value.value)
                : '';
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

        if (field.oauth && oauth) {
            var fill = el('button', 'btn btn-small', 'ログイン情報から');

            fill.type = 'button';
            fill.addEventListener('click', function () {
                input.value = field.oauth === 'login' ? oauth.twitchChannel : oauth.twitchBroadcasterId;
                input.classList.remove('invalid');
                toast('info', field.label + 'に「' + input.value + '」を入力しました。保存を忘れずに。');
            });
            row.appendChild(fill);
        }

        wrapper.appendChild(row);

        if (field.help) { wrapper.appendChild(el('p', 'help', field.help)); }

        wrapper.appendChild(el('p', 'field-error hidden'));

        return wrapper;
    }

    function collectConfigValues() {
        var inputs = document.querySelectorAll('.config-input');
        var values = {};

        for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            var isSecret = input.dataset.secret === '1';

            // secret 項目は空欄なら「変更しない」の意味なので送らない
            if (isSecret && input.value.trim() === '') { continue; }

            values[input.dataset.key] = input.value;
        }

        return values;
    }

    function showFieldErrors(fieldErrors) {
        var inputs = document.querySelectorAll('.config-input');

        for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            var message = fieldErrors ? fieldErrors[input.dataset.key] : null;
            var errorNode = input.closest('.field').querySelector('.field-error');

            input.classList.toggle('invalid', !!message);
            errorNode.textContent = message || '';
            errorNode.classList.toggle('hidden', !message);
        }
    }

    function saveConfig(event) {
        event.preventDefault();

        var button = document.getElementById('saveConfig');
        var notices = document.getElementById('configNotices');

        busy(button, true, '保存中…');

        api('PUT', '/api/config', { values: collectConfigValues() }).then(function (result) {
            showFieldErrors(null);
            toast('ok', '設定を保存しました。');

            if (result.missingRequired.length > 0) {
                setNotice(notices, 'warn', 'まだ未設定の必須項目があります。', result.missingRequired);
            } else {
                setNotice(notices, 'ok', '設定を保存しました。bot に反映するには bot の再起動が必要です。');
            }

            state.loaded.dashboard = false;

            return loadConfig();
        }).catch(function (err) {
            if (err.data && err.data.fieldErrors) {
                showFieldErrors(err.data.fieldErrors);
                setNotice(notices, 'error', '入力内容にエラーがあります。各項目のメッセージを確認してください。');
            } else {
                setNotice(notices, 'error', err.message);
            }

            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    // ------------------------------------------------------------------
    // 各種リスト
    // ------------------------------------------------------------------

    function loadLists(ids) {
        return api('GET', '/api/lists').then(function (data) {
            ids.forEach(function (id) {
                var panel = document.querySelector('[data-list="' + id + '"]');

                if (!panel || !data[id]) { return; }

                renderList(panel, id, data[id]);
            });
        });
    }

    function renderList(panel, id, data) {
        panel.querySelector('.list-help').textContent = data.help;
        panel.querySelector('.list-input').value = data.items.join('\n');
        panel.querySelector('.list-input').placeholder = data.placeholder;
        panel.querySelector('.list-count').textContent = data.items.length + ' 件';
        panel.querySelector('.list-path').textContent = 'ファイル: ' + data.path;
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

        return api('PUT', '/api/lists/' + id, { items: items }).then(function (result) {
            textarea.value = result.items.join('\n');
            panel.querySelector('.list-count').textContent = result.items.length + ' 件';
            panel.querySelector('.list-updated').textContent = '最終更新: ' + formatDateTime(result.updatedAt);

            var message = result.items.length + ' 件を保存しました。';

            if (result.removedDuplicates > 0) {
                message += '（重複 ' + result.removedDuplicates + ' 件を除きました）';
            }

            setNotice(notices, 'ok', message + ' 稼働中の bot に反映するには、ダッシュボードの「bot に反映する」を実行してください。');
            toast('ok', message);
            state.loaded.dashboard = false;
        }).catch(function (err) {
            setNotice(notices, 'error', err.message, err.data ? err.data.errors : null);
            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    // ------------------------------------------------------------------
    // エモート更新
    // ------------------------------------------------------------------

    function updateEmoteTarget() {
        return api('GET', '/api/overview').then(function (data) {
            var target = document.getElementById('emoteTarget');

            if (!data.channel) {
                target.textContent = '対象チャンネルが未設定です。';
                return;
            }

            target.textContent = '対象: #' + data.channel +
                (data.broadcasterId ? '（配信者 ID ' + data.broadcasterId + '）' : '（配信者 ID 未設定のため BTTV チャンネルエモートは取得されません）');
        });
    }

    function refreshEmotes(save) {
        var button = document.getElementById(save ? 'updateEmotes' : 'previewEmotes');
        var notices = document.getElementById('emoteNotices');
        var mode = document.querySelector('input[name="emoteMode"]:checked').value;

        busy(button, true, '取得中…');
        setNotice(notices, 'info', 'BTTV / FFZ からエモート一覧を取得しています…');

        return api('POST', '/api/emotes/refresh', { mode: mode, save: save }).then(function (result) {
            renderEmoteSources(result.sources);

            var summary = result.saved
                ? 'emoticons.json を更新しました（' + result.before + ' 件 → ' + result.after + ' 件、追加 ' + result.added + ' 件' +
                  (result.removed > 0 ? '、削除 ' + result.removed + ' 件' : '') + '）。'
                : '取得結果: ' + result.after + ' 件（現在 ' + result.before + ' 件、追加候補 ' + result.added + ' 件' +
                  (result.removed > 0 ? '、削除候補 ' + result.removed + ' 件' : '') + '）。まだ保存していません。';

            setNotice(notices, result.warnings.length > 0 ? 'warn' : 'ok', summary, result.warnings);
            toast(result.warnings.length > 0 ? 'warn' : 'ok', summary);

            if (result.saved) {
                state.loaded.dashboard = false;
                return loadLists(['emoticons']);
            }

            return null;
        }).catch(function (err) {
            setNotice(notices, 'error', err.message, err.data ? err.data.errors : null);
            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    function renderEmoteSources(sources) {
        var list = document.getElementById('emoteSources');

        clear(list);
        list.classList.remove('hidden');

        sources.forEach(function (source) {
            var item = el('li');

            item.appendChild(el('span', 'badge ' + (source.ok ? 'badge-ok' : 'badge-error'), source.ok ? 'OK' : '失敗'));
            item.appendChild(el('span', null, source.label));
            item.appendChild(el('span', 'count', source.ok
                ? source.count + ' 件取得 / ' + source.added + ' 件追加'
                : (source.error || '取得できませんでした')));

            list.appendChild(item);
        });
    }

    // ------------------------------------------------------------------
    // Google Cloud キー
    // ------------------------------------------------------------------

    function loadGoogleKey() {
        return api('GET', '/api/google-key').then(function (data) {
            var table = document.getElementById('googleStatus');
            var status = data.status;

            clear(table);

            var body = el('tbody');

            function row(label, value) {
                var tr = el('tr');

                tr.appendChild(el('th', null, label));
                tr.appendChild(el('td', null, value === null || value === undefined || value === '' ? '—' : String(value)));
                body.appendChild(tr);
            }

            row('設定されているパス', status.configured);
            row('ファイルの状態', status.exists ? (status.valid ? '正常なサービスアカウントキー' : (status.message || '形式が不正です')) : (status.message || '見つかりません'));
            row('プロジェクト ID', status.projectId);
            row('サービスアカウント', status.clientEmail);
            row('パーミッション', status.mode);
            row('最終更新', status.updatedAt ? formatDateTime(status.updatedAt) : null);

            table.appendChild(body);

            var notices = document.getElementById('googleNotices');

            if (!status.exists || !status.valid) {
                setNotice(notices, 'warn', 'まだ有効なサービスアカウントキーが設定されていません。下のフォームからアップロードしてください。' +
                    '（既定の保存先: ' + data.defaultPath + '）');
            } else {
                setNotice(notices, 'ok', 'サービスアカウントキーは設定済みです。');
            }
        });
    }

    function handleKeyFile(file) {
        var preview = document.getElementById('keyPreviewText');
        var uploadButton = document.getElementById('uploadKey');

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

            state.pendingKey = { fileName: file.name, content: text };
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

        var button = document.getElementById('uploadKey');
        var notices = document.getElementById('googleNotices');

        busy(button, true, 'アップロード中…');

        api('POST', '/api/google-key', {
            fileName: state.pendingKey.fileName,
            content: state.pendingKey.content
        }).then(function (result) {
            setNotice(notices, 'ok', 'キーを ' + result.path + ' に保存し、設定（' + result.applied.join(', ') + '）に反映しました。' +
                ' bot に反映するには bot の再起動が必要です。', result.warnings);
            toast('ok', 'サービスアカウントキーを保存しました。');

            state.pendingKey = null;
            button.disabled = true;
            document.getElementById('keyPreviewText').textContent = '';
            document.getElementById('keyFile').value = '';
            state.loaded.config = false;
            state.loaded.dashboard = false;

            return loadGoogleKey();
        }).catch(function (err) {
            setNotice(notices, 'error', err.message, err.data ? err.data.warnings : null);
            toast('error', err.message);
        }).then(function () {
            busy(button, false);
        });
    }

    // ------------------------------------------------------------------
    // ログ
    // ------------------------------------------------------------------

    function loadLogs() {
        return api('GET', '/api/logs').then(function (data) {
            var select = document.getElementById('logSelect');
            var current = select.value;

            clear(select);

            data.logs.forEach(function (log) {
                var option = el('option', null, log.label + '（' + log.path + (log.exists ? '' : '・未作成') + '）');

                option.value = log.id;
                select.appendChild(option);
            });

            if (current) { select.value = current; }

            return loadLog();
        });
    }

    function loadLog() {
        var id = document.getElementById('logSelect').value || 'bot';
        var lines = document.getElementById('logLines').value;
        var problemsOnly = document.getElementById('logProblemsOnly').checked;
        var url = '/api/logs/' + encodeURIComponent(id) + '?lines=' + encodeURIComponent(lines) +
            (problemsOnly ? '&level=warn' : '');

        return api('GET', url).then(function (data) {
            var output = document.getElementById('logOutput');
            var notices = document.getElementById('logNotices');
            var meta = document.getElementById('logMeta');

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
    // 初期化
    // ------------------------------------------------------------------

    function wire() {
        document.getElementById('tabs').addEventListener('click', function (event) {
            var tab = event.target.closest('.tab');

            if (tab) { showView(tab.dataset.view); }
        });

        document.getElementById('logoutButton').addEventListener('click', function () {
            api('POST', '/auth/logout', {}).then(function () {
                window.location.href = '/login';
            }).catch(function (err) {
                toast('error', err.message);
            });
        });

        document.getElementById('refreshOverview').addEventListener('click', function (event) {
            busy(event.target, true, '読み込み中…');
            loadOverview().catch(function (err) { toast('error', err.message); })
                .then(function () { busy(event.target, false); });
        });

        document.getElementById('reloadBot').addEventListener('click', function (event) {
            busy(event.target, true, '送信中…');
            api('POST', '/api/bot/reload', {}).then(function (result) {
                toast('ok', result.message + ' リストを再読み込みしました。');
            }).catch(function (err) {
                toast('error', err.message);
            }).then(function () {
                busy(event.target, false);
                return loadOverview();
            });
        });

        document.getElementById('configForm').addEventListener('submit', saveConfig);

        document.getElementById('reloadConfig').addEventListener('click', function () {
            loadConfig().then(function () { toast('info', '設定を再読み込みしました。'); })
                .catch(function (err) { toast('error', err.message); });
        });

        document.getElementById('fillFromOauth').addEventListener('click', function () {
            if (!state.config || !state.config.oauth) { return; }

            var filled = [];

            state.config.fields.filter(function (field) { return field.oauth; }).forEach(function (field) {
                var input = document.getElementById('field-' + field.key);

                if (!input) { return; }

                input.value = field.oauth === 'login'
                    ? state.config.oauth.twitchChannel
                    : state.config.oauth.twitchBroadcasterId;
                input.classList.remove('invalid');
                filled.push(field.label);
            });

            if (filled.length > 0) {
                setNotice(document.getElementById('configNotices'), 'info',
                    'ログイン中のアカウント（' + state.config.oauth.twitchChannel + '）の情報を ' +
                    filled.join(' / ') + ' に入力しました。内容を確認して保存してください。');
            }
        });

        document.querySelectorAll('[data-list]').forEach(function (panel) {
            panel.querySelector('.list-save').addEventListener('click', function () { saveList(panel); });
            panel.querySelector('.list-reload').addEventListener('click', function () {
                loadLists([panel.dataset.list]).then(function () { toast('info', '再読み込みしました。'); })
                    .catch(function (err) { toast('error', err.message); });
            });
        });

        document.getElementById('previewEmotes').addEventListener('click', function () { refreshEmotes(false); });
        document.getElementById('updateEmotes').addEventListener('click', function () { refreshEmotes(true); });

        var drop = document.getElementById('keyDrop');
        var fileInput = document.getElementById('keyFile');

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

        var reloadLog = function () {
            loadLog().catch(function (err) { toast('error', err.message); });
        };

        document.getElementById('logSelect').addEventListener('change', reloadLog);
        document.getElementById('logLines').addEventListener('change', reloadLog);
        document.getElementById('logProblemsOnly').addEventListener('change', reloadLog);
        document.getElementById('refreshLogs').addEventListener('click', function (event) {
            busy(event.target, true, '読み込み中…');
            loadLogs().catch(function (err) { toast('error', err.message); })
                .then(function () { busy(event.target, false); });
        });

        document.getElementById('uploadKey').addEventListener('click', uploadKey);
        document.getElementById('refreshGoogle').addEventListener('click', function (event) {
            busy(event.target, true, '読み込み中…');
            loadGoogleKey().catch(function (err) { toast('error', err.message); })
                .then(function () { busy(event.target, false); });
        });
    }

    api('GET', '/api/session').then(function (data) {
        state.csrfToken = data.csrfToken;
        state.user = data.user;

        document.getElementById('userName').textContent = data.user.displayName || data.user.login;

        if (data.user.profileImageUrl) {
            var avatar = document.getElementById('userAvatar');

            avatar.src = data.user.profileImageUrl;
            avatar.alt = data.user.displayName || data.user.login;
            avatar.classList.remove('hidden');
        }

        wire();

        var initial = (window.location.hash || '#dashboard').slice(1);

        showView(LOADERS[initial] ? initial : 'dashboard');
    }).catch(function (err) {
        toast('error', err.message);
    });

}());
