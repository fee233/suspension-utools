const fs = require('fs');
const { ipcRenderer } = require('electron')

// uTools 8.0 (Electron 34) 兼容：
// ipcRenderer.sendTo 已废弃移除。
// 子窗口 -> 插件主界面：utools.sendToParent(channel, ...args)
// 插件主界面 -> 子窗口：webContents.send()，本文件中用 ipcRenderer.on 接收

window.isMac = utools.isMacOs();

// 调试日志：便于排查显示问题，可随时删除
function debugLog(msg) {
    try {
        let img = window.document.querySelector("img");
        fs.appendFileSync('/tmp/suspend-debug.log',
            `${new Date().toISOString()} href=${window.location.href} ` +
            `payloadLen=${(window._payload || '').length} naturalWidth=${img ? img.naturalWidth : 'N/A'} :: ${msg}\n`);
    } catch (e) { /* 忽略日志失败 */ }
}
window.debugLog = debugLog;
debugLog('suspend.js preload loaded, ready to request img');

// 主动向主界面请求图片数据（主界面 webContents.send 应答）
utools.sendToParent('img-ready');

ipcRenderer.on('img-data', (event, data) => {
    let img = window.document.querySelector("img");
    window._payload = data.payload || '';
    img.onload = () => debugLog('img onload, naturalWidth=' + img.naturalWidth);
    img.onerror = (e) => debugLog('img onerror');
    img.src = data.payload;
    window._filePath = data.filePath;
    debugLog('img-data received, payloadLen=' + (data.payload || '').length);
})

window.toEdit = () => {
    utools.sendToParent('toEdit');
}
window.resize = (changed, proportion) => {
    utools.sendToParent('resize', changed, proportion);
}
window.moveBounds = (x, y, width, height) => {
    utools.sendToParent('moveBounds', x, y, width, height);
}

/**
 * 拷贝当前图片，借助窗口截图实现
 */
window.copyNowImage = () => {
    utools.sendToParent('copyNowImage');
}

/*
 * 保存当前图片，借助窗口截图实现
 */
window.saveNowImage = () => {
    utools.sendToParent('saveNowImage');
}

ipcRenderer.on('reduction', (event) => {
    document.body.className = "body-hover"
})

window.modifyOpacity = (op) => {
    utools.sendToParent('modifyOpacity', op);
}


ipcRenderer.on('will-resize', (event, newBounds) => {
    //只能按比例缩放图片
    let img = window.document.querySelector("img");
    img.style.width = '100%';
    img.style.height = '100%';
    let scale = img.width / (img.height * 1.0)
    let height = newBounds.width / scale;
    window.setSize(newBounds.width, Math.min(newBounds.height, height));
})
