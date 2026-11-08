const fs = require('fs');
const { ipcRenderer } = require('electron')

// uTools 8.0 (Electron 34) 兼容：
// ipcRenderer.sendTo 已废弃移除。
// 子窗口 -> 插件主界面：utools.sendToParent(channel, ...args)
// 插件主界面 -> 子窗口：webContents.send()，本文件中用 ipcRenderer.on 接收

window.isMac = utools.isMacOs();

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
