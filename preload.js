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

// 挂载窗口生命周期监听（closed 清理 / will-resize 转发），幂等
function attachWinListeners(token, win) {
    if (imgWins.has(token)) return;
    imgWins.set(token, win);
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
}

// 子窗口确认收到图片数据：停止对应 token 的定时重推
ipcRenderer.on('img-ack', (event, token) => {
    dbg('img-ack token=' + token);
    if (token) ackedTokens.add(token);
    const timer = pushTimers.get(token);
    if (timer) { clearInterval(timer); pushTimers.delete(token); }
});

// 悬浮窗口加载后主动请求图片数据（握手）：
// 直接用 event.sender 应答，按创建顺序取第一个未确认的 token（多窗口 FIFO 对齐），
// 不依赖 createBrowserWindow 回调是否触发，也不要求子窗口预先上报 token
ipcRenderer.on('img-ready', (event) => {
    dbg('img-ready from senderId=' + (event.sender ? event.sender.id : '?') +
        ', pending=' + imgDataMap.size);
    for (const [t, d] of imgDataMap) {
        if (!ackedTokens.has(t)) {
            ackedTokens.add(t);
            event.sender.send('img-data', Object.assign({ token: t }, d));
            dbg('img-data delivered via img-ready, token=' + t);
            // 若创建回调未触发，尝试通过 sender 反查窗口完成注册
            // （uTools 沙盒可能不暴露 BrowserWindow，失败则忽略）
            try {
                const { BrowserWindow } = require('electron');
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win) attachWinListeners(t, win);
            } catch (e) { /* ignore */ }
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

        // 主推送通道：show() 内直接定时重推图片数据（200ms × 最多 30 次），
        // 子窗口收到后回 img-ack 停推；不依赖创建回调与握手时序。
        // 重复接收幂等（子窗口重新设置同一 src 无副作用）
        let pushTries = 0;
        pushTimers.set(token, setInterval(() => {
            pushTries++;
            if (ackedTokens.has(token) || pushTries > 30) {
                clearInterval(pushTimers.get(token));
                pushTimers.delete(token);
                dbg('pusher stopped, token=' + token + ', tries=' + pushTries +
                    ', acked=' + ackedTokens.has(token));
                return;
            }
            try {
                const d = imgDataMap.get(token);
                if (d) {
                    imgWin.webContents.send('img-data', Object.assign({ token }, d));
                }
            } catch (e) {
                dbg('push ERROR: ' + (e && e.message || e));
            }
        }, 200));
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