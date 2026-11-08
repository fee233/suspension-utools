const {
    ipcRenderer
} = require('electron')
const fs = require('fs')

const mineMap = {
    "bmp": "image/bmp",
    "gif": "image/gif",
    "heic": "image/heic",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "jpe": "image/jpeg",
    "png": "image/png",
    "svg": "image/svg+xml",
    "webp": "image/webp",
    "ico": "image/x-icon"
}

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0,
            v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// uTools 8.0 兼容：不再通过 localStorage 向自定义窗口传图，
// 改用官方推荐的 webContents.send 直传。
// 多窗口路由：每个悬浮窗口分配唯一 token，子窗口所有消息携带 token，
// 主界面按 token 找到对应窗口操作（sendToParent 的消息会广播给所有已注册监听器）
const imgWins = new Map();      // token -> BrowserWindow
const imgDataMap = new Map();   // token -> { payload, filePath }
const ackedTokens = new Set();  // 子窗口已确认收到图片数据的 token
const pushTimers = new Map();   // token -> 定时重推 interval id

// 主界面侧调试日志（与子窗口共用 /tmp/suspend-debug.log）
function dbg(msg) {
    try {
        fs.appendFileSync('/tmp/suspend-debug.log',
            new Date().toISOString() + ' [main] :: ' + msg + '\n');
    } catch (e) { /* 忽略日志失败 */ }
}

// 挂载窗口生命周期监听（closed 清理 / will-resize 转发），幂等。
// uTools 8.0 的窗口对象是代理，可能缺少 EventEmitter 方法（on 等），
// 缺失时仅跳过监听（损失 closed 清理与 will-resize 转发），不影响窗口注册
function attachWinListeners(token, win) {
    if (imgWins.has(token)) return;
    imgWins.set(token, win);
    if (typeof win.on === 'function') {
        win.on('closed', () => {
            imgWins.delete(token);
            imgDataMap.delete(token);
            ackedTokens.delete(token);
            const timer = pushTimers.get(token);
            if (timer) { clearInterval(timer); pushTimers.delete(token); }
        });
        win.on('will-resize', (event, newBounds) => {
            event.preventDefault();
            win.webContents.send('will-resize', newBounds);
        });
    } else {
        dbg('attachWinListeners: win.on unavailable (uTools proxy), skip listeners, token=' + token);
    }
}

// 发送图片数据到指定 token 的悬浮窗口。
// 优先走 imgWins 里已注册窗口的 webContents.send（实测可送达）；
// event.sender 是 uTools 代理对象（无 id、send 不可达），仅作最后兜底
function sendImgData(token, target) {
    const d = imgDataMap.get(token);
    if (!d) return false;
    const data = Object.assign({ token }, d);
    try {
        const w = imgWins.get(token);
        if (w && w.webContents && typeof w.webContents.send === 'function') {
            w.webContents.send('img-data', data);
            return 'imgWins';
        }
    } catch (e) { dbg('sendImgData via imgWins ERROR: ' + (e && e.message || e)); }
    try {
        if (target && typeof target.send === 'function') {
            target.send('img-data', data);
            return 'sender';
        }
    } catch (e) { dbg('sendImgData via sender ERROR: ' + (e && e.message || e)); }
    return null;
}

// 子窗口确认收到图片数据：标记 token 已交付，停止对应定时重推
ipcRenderer.on('img-ack', (event, token) => {
    dbg('img-ack token=' + token);
    if (token) ackedTokens.add(token);
    const timer = pushTimers.get(token);
    if (timer) { clearInterval(timer); pushTimers.delete(token); }
});

// 悬浮窗口加载后主动请求图片数据（握手）。
// 注意：img-ready 可能在 createBrowserWindow 回调（窗口注册）之前到达，
// 此时 imgWins 还没有该窗口 —— sendImgData 会先走 imgWins、不行再走 sender，
// 之后由 show() 里的定时重推（窗口注册完成后必然走 imgWins 通道）兜底
ipcRenderer.on('img-ready', (event) => {
    dbg('img-ready, pending=' + imgDataMap.size + ', registered=' + imgWins.size);
    for (const [t] of imgDataMap) {
        if (!ackedTokens.has(t)) {
            // 若窗口尚未注册，尝试通过 sender 反查窗口补注册
            // （uTools 沙盒可能不暴露 BrowserWindow，失败则忽略）
            if (!imgWins.has(t)) {
                try {
                    const { BrowserWindow } = require('electron');
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) attachWinListeners(t, win);
                } catch (e) { /* ignore */ }
            }
            const via = sendImgData(t, event.sender);
            dbg('img-ready deliver token=' + t + ', via=' + via);
            break;
        }
    }
});

ipcRenderer.on('resize', (event, token, changed, proportion) => {
    const win = imgWins.get(token);
    if (!win) return;
    const nowBounds = win.getBounds();
    const widthChanged = nowBounds.width + changed;
    win.setSize(Math.ceil(widthChanged), Math.ceil(widthChanged * proportion));
});

ipcRenderer.on('moveBounds', (event, token, x, y, width, height) => {
    const win = imgWins.get(token);
    if (!win) return;
    const bound = win.getBounds();
    win.setBounds({
        x: parseInt(bound.x + x),
        y: parseInt(bound.y + y),
        width: parseInt(width || bound.width),
        height: parseInt(height || bound.height)
    });
});

ipcRenderer.on('toEdit', (event, token) => {
    const win = imgWins.get(token);
    if (!win) return;
    const bound = win.getBounds();
    win.capturePage().then(img => {
        utools.redirect("截图工具", {
            'type': 'img',
            'data': `data:image/png;base64,${_arrayBufferToBase64(img)}#x=${bound.x}&y=${bound.y}`
        })
        win.close();
    })
});

ipcRenderer.on('copyNowImage', (event, token) => {
    const win = imgWins.get(token);
    if (!win) return;
    win.capturePage().then(img => {
        utools.copyImage(`data:image/png;base64,${_arrayBufferToBase64(img)}`)
        utools.showNotification('图片已经拷贝至剪切板')
        win.webContents.send('reduction');
    })
});

ipcRenderer.on('saveNowImage', (event, token) => {
    const win = imgWins.get(token);
    if (!win) return;
    win.capturePage().then(img => {
        const defaultPath = utools.getPath('downloads') + "/suspend_" + new Date().getTime() + ".png"
        const savePath = utools.showSaveDialog({
            title: '保存图片',
            defaultPath: defaultPath,
            buttonLabel: '保存'
        })
        if (savePath) {
            fs.writeFileSync(savePath, img);
            utools.showNotification("保存成功")
        }
        win.webContents.send('reduction');
    })
});

ipcRenderer.on('modifyOpacity', (event, token, op) => {
    const win = imgWins.get(token);
    if (!win) return;
    win.setOpacity(win.getOpacity() + op);
});

function show(payload, filePath) {
    dbg('show() called, payloadLen=' + (payload || '').length);
    let params = {}
    let paramsIndex = payload.lastIndexOf("#");
    if (paramsIndex > 0) {
        payload.substring(paramsIndex + 1).split("&").forEach(item => {
            params[item.split("=")[0]] = item.split("=")[1]
        })
    }
    let img = new Image();
    img.src = payload;
    img.onload = function () {
        let width = img.width / (utools.isMacOs() ? 2 : 1)
        let height = img.height / (utools.isMacOs() ? 2 : 1)
        let scale = width / (height * 1.0)
        //图片大小不能超过当前显示器80%，否则缩放
        let display = utools.getDisplayNearestPoint(utools.getCursorScreenPoint())
        if (display) {
            width = Math.min(width, display.size.width * 0.8);
            height = width / scale;
            height = Math.min(height, display.size.height * 0.8);
            width = height * scale;
        }
        const token = uuidv4();
        imgDataMap.set(token, { payload, filePath });
        const imgWin = utools.createBrowserWindow('suspend.html', {
            title: 'img',
            x: params.x ? parseInt(params.x) : null,
            y: params.y ? parseInt(params.y) : null,
            width: parseInt(width),
            height: parseInt(height),
            useContentSize: true,
            skipTaskbar: true,
            //不能最大最小化
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            //背景透明，防止放大缩小时出现白框
            transparent: true,
            backgroundColor: '#00000000',
            frame: false,
            // uTools 8.0 兼容：直接以置顶参数创建，回调中再用最高级别强制置顶
            alwaysOnTop: true,
            webPreferences: {
                preload: 'suspend.js',
                devTools: true
            }
        }, () => {
            try {
                dbg('createBrowserWindow callback fired, token=' + token);
                // 'screen' 不是 Electron 合法的窗口层级（新内核会静默忽略导致置顶失效），
                // 改用最高的 screen-saver 级别保证悬浮图始终在其他窗口之上
                imgWin.setAlwaysOnTop(true, 'screen-saver');
                attachWinListeners(token, imgWin);
            } catch (e) {
                dbg('createBrowserWindow callback ERROR: ' + (e && e.stack || e));
            }
        });

        // 主推送通道：创建后立即推一次，再定时重推兜底（200ms 名义间隔；
        // 主窗口隐藏后 Chromium 会把定时器节流到 ~1s，故给足 60 次 ≈ 60s 覆盖）。
        // 只有收到子窗口真实 img-ack 才停推，重复接收幂等
        let pushTries = 0;
        const pushOnce = () => {
            pushTries++;
            if (ackedTokens.has(token) || pushTries > 60) {
                clearInterval(pushTimers.get(token));
                pushTimers.delete(token);
                dbg('pusher stopped, token=' + token + ', tries=' + pushTries +
                    ', acked=' + ackedTokens.has(token));
                return;
            }
            const via = sendImgData(token, null);
            dbg('pusher try=' + pushTries + ', token=' + token + ', via=' + via);
        };
        pushTimers.set(token, setInterval(pushOnce, 200));
        pushOnce();
    }
};

function fileUrlData(path) {
    return new Promise((resolve, reject) => {
        let postfix = path.substring(path.lastIndexOf('.') + 1);
        if (mineMap[postfix.toLowerCase()]) {
            fs.readFile(path, function (err, data) {
                if (err) {
                    reject(err);
                } else {
                    resolve(`data:${mineMap[postfix.toLowerCase()]};base64,${data.toString('base64')}`)
                }
            });
        } else {
            reject("不支持的文件格式!");
        }
    })
}

function _arrayBufferToBase64(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

window.exports = {
    "suspend": {
        mode: "none",
        args: {
            enter: (action) => {
                window.utools.hideMainWindow();
                if (action.type === 'files') {
                    for (i in action.payload) {
                        fileUrlData(action.payload[i].path).then(payload => {
                            show(payload, action.payload[i].path);
                        }).catch(err => {
                            utools.showNotification(err);
                        }).finally(() => {
                            window.utools.outPlugin();
                        })
                    }
                } else if (action.type === 'img') {
                    show(action.payload);
                    window.utools.outPlugin();
                }
            }
        }
    },
    "suspend-screenshot": {
        mode: "none",
        args: {
            enter: (action) => {
                //解决用户反馈的截图并识别容易截取到utools黑屏的问题
                utools.hideMainWindow()
                utools.screenCapture(base64Str => {
                    utools.copyImage(base64Str);
                    show(base64Str);
                    utools.outPlugin();
                })
            }
        }
    },
    "suspend-base64": {
        mode: "none",
        args: {
            enter: (action) => {
                show(action.payload);
                window.utools.outPlugin();
            }
        }
    },
    "suspend-svg": {
        mode: "none",
        args: {
            enter: (action) => {
                var base64 = btoa(action.payload);
                show(`data:image/svg+xml;base64,${base64}`);
                window.utools.outPlugin();
            }
        }
    }
}