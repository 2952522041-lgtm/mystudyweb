// 用 Electron（Chromium）把 demo/public/favicon.svg 栅格化成各尺寸 PNG 应用图标。
// 图标源是仓库自有视觉资产，避免引入来源不明的图片或系统工具依赖。
//
//   ./node_modules/.bin/electron scripts/render-app-icons.cjs
//
// 产出 demo/assets/icons/png/yeyu-<size>.png，提交进仓库供 maker-deb 使用。
// 全程只做一次导航：渲染器里用 canvas 按 vector 重绘每个尺寸并导出 PNG，
// 主进程不使用 capturePage（隐藏窗口上会抛 UnknownVizError）。
const { BrowserWindow, app } = require('electron');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ROOT = path.resolve(__dirname, '..');
const SOURCE_SVG = path.join(ROOT, 'public', 'favicon.svg');
const OUTPUT_DIR = path.join(ROOT, 'assets', 'icons', 'png');

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    width: 512,
    height: 512,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  try {
    const source = await readFile(SOURCE_SVG, 'utf8');
    const inner = source
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>[\s\S]*$/, '');
    if (!inner.includes('<path')) {
      throw new Error('favicon.svg 中没有找到可渲染的 path 元素');
    }
    // viewBox 24x24，矢量重绘到任意尺寸都清晰；canvas 默认透明底。
    const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`,
    ).toString('base64')}`;
    await window.loadURL('about:blank');
    const rendered = await window.webContents.executeJavaScript(
      `(async (svgUrl, sizes) => {
        const out = {};
        for (const size of sizes) {
          const image = new Image();
          image.width = size;
          image.height = size;
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('SVG 加载失败：' + size));
            image.src = svgUrl;
          });
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d');
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, size, size);
          out[size] = canvas.toDataURL('image/png');
        }
        return out;
      })(${JSON.stringify(svgDataUrl)}, ${JSON.stringify(SIZES)})`,
    );
    await mkdir(OUTPUT_DIR, { recursive: true });
    for (const size of SIZES) {
      const png = Buffer.from(
        rendered[size].replace(/^data:image\/png;base64,/, ''),
        'base64',
      );
      if (png.length < 100) {
        throw new Error(`yeyu-${size}.png 异常地小（${png.length} 字节）`);
      }
      await writeFile(path.join(OUTPUT_DIR, `yeyu-${size}.png`), png);
      console.log(`rendered yeyu-${size}.png (${png.length} bytes)`);
    }
    console.log('done');
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
