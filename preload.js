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
// 改用官方推荐的 webContents.send 直传（悬浮窗口加载后主动回执请求，主界面立即应答）
let imgWin = null;
let pendingImgData = null;

ipcRenderer.on('img-ready', () => {
    if (imgWin && pendingImgData) {
        imgWin.webContents.send('img-data', pendingImgData);
    }
});

function show(payload, filePath) {
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
        pendingImgData = { payload, filePath };
        imgWin = utools.createBrowserWindow('suspend.html', {
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
            alwaysOnTop: false,
            webPreferences: {
                preload: 'suspend.js',
                devTools: true
            }
        }, () => {
            imgWin.setAlwaysOnTop(true, 'screen');
            // 窗口就绪后主动推送图片数据，附带重试以防监听器尚未注册
            for (let i = 0; i <= 5; i++) {
                setTimeout(() => {
                    if (imgWin && pendingImgData) {
                        imgWin.webContents.send('img-data', pendingImgData);
                    }
                }, i * 200);
            }
            // uTools 8.0 (Electron 34) 兼容：
            // ipcRenderer.sendTo 已废弃，子窗口 -> 主界面改用 utools.sendToParent，
            // 主界面 -> 子窗口改用 imgWin.webContents.send
            ipcRenderer.on('resize', (event, changed, proportion) => {
                let nowBounds = imgWin.getBounds()
                let widthChanged = nowBounds.width + changed
                imgWin.setSize(Math.ceil(widthChanged), Math.ceil(widthChanged * proportion));
            });
            ipcRenderer.on('moveBounds', (event, x, y, width, height) => {
                let bound = imgWin.getBounds();
                let newBounds = {
                    x: parseInt(bound.x + x),
                    y: parseInt(bound.y + y),
                    width: parseInt(width || bound.width),
                    height: parseInt(height || bound.height)
                }
                imgWin.setBounds(newBounds);
            });
            ipcRenderer.on('toEdit', (event) => {
                let bound = imgWin.getBounds();
                imgWin.capturePage().then(img => {
                    utools.redirect("截图工具", {
                        'type': 'img',
                        'data': `data:image/png;base64,${_arrayBufferToBase64(img)}#x=${bound.x}&y=${bound.y}`
                    })
                    imgWin.close();
                })
            });
            ipcRenderer.on('copyNowImage', (event) => {
                imgWin.capturePage().then(img => {
                    utools.copyImage(`data:image/png;base64,${_arrayBufferToBase64(img)}`)
                    utools.showNotification('图片已经拷贝至剪切板')
                    imgWin.webContents.send('reduction');
                })
            });
            ipcRenderer.on('saveNowImage', (event) => {
                imgWin.capturePage().then(img => {
                    let defaultPath = utools.getPath('downloads') + "/suspend_" + new Date().getTime() + ".png"
                    let savePath = utools.showSaveDialog({
                        title: '保存图片',
                        defaultPath: defaultPath,
                        buttonLabel: '保存'
                    })
                    if (savePath) {
                        fs.writeFileSync(savePath, img);
                        utools.showNotification("保存成功")
                    }
                    imgWin.webContents.send('reduction');
                })
            });
            ipcRenderer.on('modifyOpacity',(event,op) => {
                let opacity = imgWin.getOpacity();
                imgWin.setOpacity(opacity +op);
            })
            imgWin.on('will-resize', (event, newBounds) => {
                event.preventDefault();
                imgWin.webContents.send('will-resize', newBounds);
            });

        });
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