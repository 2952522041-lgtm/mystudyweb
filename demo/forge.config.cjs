// Electron Forge 配置。用 .cjs 是因为 demo/package.json 声明了 "type": "module"。
// dist/client 通过 extraResource 打进 resources，运行时由主进程的本地静态服务器提供。
const path = require('node:path');

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const hicolorIcons = Object.fromEntries(
  ICON_SIZES.map((size) => [
    `${size}x${size}`,
    path.resolve(__dirname, 'assets/icons/png', `yeyu-${size}.png`),
  ]),
);

module.exports = {
  packagerConfig: {
    name: 'Yeyu',
    executableName: 'yeyu',
    asar: true,
    extraResource: ['dist/client'],
    ignore: [
      /^\/app($|\/)/,
      /^\/lib($|\/)/,
      /^\/components($|\/)/,
      /^\/tests($|\/)/,
      /^\/scripts($|\/)/,
      /^\/public($|\/)/,
      /^\/dist($|\/)/,
      /^\/out($|\/)/,
      /^\/\.next($|\/)/,
      /^\/\.vinext($|\/)/,
      /^\/\.wrangler($|\/)/,
      /^\/\.openai($|\/)/,
      /^\/assets($|\/)/,
      /^\/vite\.config\.ts$/,
      /^\/tsconfig\.json$/,
      /^\/next-env\.d\.ts$/,
      /^\/pnpm-lock\.yaml$/,
      /^\/pnpm-workspace\.yaml$/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      // electron-winstaller（Squirrel.Windows）的 NuGet manifest 必须有
      // authors 与 description；name 是 nupkg 包 ID（ASCII），title 是
      // 面向用户的显示名。
      config: {
        name: 'yeyu',
        title: '页语',
        authors: '余思诚',
        description: '本地课程知识库、PDF 随页翻译与 AI 答疑阅读器',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      // Ubuntu/Debian 安装包：包名、可执行名与图标名都是 yeyu，
      // GNOME 菜单里显示为「页语」（.desktop 的 Name 字段）。
      // bin 必须是打包产物里的可执行名 yeyu，否则符号链接创建失败。
      config: {
        options: {
          name: 'yeyu',
          bin: 'yeyu',
          productName: '页语',
          genericName: '课程知识库阅读器',
          description: '本地课程知识库、PDF 随页翻译与 AI 答疑阅读器',
          productDescription:
            '页语把多份 PDF 组织为本地课程知识库，生成带页码来源的总结与脑图；' +
            '阅读时左侧显示原文，右侧可在随页翻译、AI 视觉答疑、PDF 总结和 PDF 脑图之间切换。',
          maintainer: '余思诚 <2952522041@qq.com>',
          homepage: 'https://github.com/2952522041-lgtm/mystudyweb',
          categories: ['Education'],
          section: 'education',
          icon: hicolorIcons,
          desktopTemplate: path.resolve(__dirname, 'assets/deb/desktop.ejs'),
        },
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux', 'darwin'],
    },
  ],
};
