/**
 * Windows Squirrel 安装生命周期（HANDOFF 13.2）。
 * electron-squirrel-startup 会在 --squirrel-install/--squirrel-updated 时
 * 创建快捷方式、--squirrel-uninstall 时移除快捷方式、--squirrel-obsolete
 * 时直接退出，全部通过 Update.exe 完成；这些事件必须在应用生命周期的
 * 最早期处理。该包在加载时就执行检查并 require('electron')，因此只在
 * win32 上延迟加载，其他平台和单元测试都不会触碰它。
 */

export function handleSquirrelStartup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS 包，且只在 win32 上加载
  const squirrelStartup = require('electron-squirrel-startup') as unknown;
  return squirrelStartup === true;
}
