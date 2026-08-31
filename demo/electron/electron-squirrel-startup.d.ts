declare module 'electron-squirrel-startup' {
  /**
   * 包导入时立即检查 Squirrel.Windows 命令行事件；
   * 处理到 --squirrel-install/--squirrel-updated/--squirrel-uninstall/
   * --squirrel-obsolete 时为 true，主进程应当立即退出。
   */
  const squirrelStartupHandled: boolean;
  export default squirrelStartupHandled;
}
