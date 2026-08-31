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
      config: { name: 'yeyu' },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux', 'darwin'],
    },
  ],
};
