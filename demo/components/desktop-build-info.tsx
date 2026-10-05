'use client';

import { useEffect, useState } from 'react';
import type { DesktopBuildInfo as BuildInfo } from '@/electron/build-info';

export function DesktopBuildInfo() {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  useEffect(() => {
    let live = true;
    void window.yeyuDesktop
      ?.getBuildInfo?.()
      .then((value) => {
        if (live) setInfo(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!info) return null;
  return (
    <details className="mb-3 text-xs text-slate-500">
      <summary className="cursor-pointer">
        页语 {info.version} · {info.commit?.slice(0, 8) ?? '版本信息未记录'}
        {info.dirty ? ' · 含未提交改动' : ''}
      </summary>
      <p className="mt-1">
        {info.packaged ? '桌面安装版' : '开发构建'} · 构建时间：
        {info.builtAt ? new Date(info.builtAt).toLocaleString() : '未知'}
      </p>
      <p className="mt-1">
        从源码更新（Linux x64）：退出页语，在项目 demo 目录运行{' '}
        <code>pnpm desktop:update</code>。安装后重新打开并核对这里的版本。
      </p>
    </details>
  );
}
