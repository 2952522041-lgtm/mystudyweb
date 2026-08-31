// Electron Forge 配置。用 .cjs 是因为 demo/package.json 声明了 "type": "module"。
// dist/client 通过 extraResource 打进 resources，运行时由主进程的本地静态服务器提供。
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
      config: {
        // NuGet 包 ID（不允许连字符）；快捷方式与卸载条目都以它为主键。
        name: 'yeyu',
        // Squirrel.Windows 的 NuGet manifest 需要作者与描述，缺省会直接 make 失败。
        authors: 'Yeyu Team',
        description: '页语——本地课程知识库、PDF 随页翻译与 AI 答疑阅读器',
        exe: 'yeyu.exe',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux', 'darwin'],
    },
  ],
};
