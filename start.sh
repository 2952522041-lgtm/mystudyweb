#!/usr/bin/env bash
# 一键启动「页语」PDF 随页翻译阅读器（本地运行）
#
# 用法：在终端执行  ./start.sh   然后打开 http://localhost:8787
# 首次运行会自动安装依赖并构建，之后启动约需十几秒。
set -e
cd "$(dirname "$0")/demo"

if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖…"
  pnpm install
fi

echo "构建生产版本…"
pnpm build

echo
echo "✅ 启动完成：请在浏览器打开 http://localhost:8787"
echo "   按 Ctrl+C 停止。PDF、译文缓存和翻译设置都保存在本机浏览器中。"
echo
npx wrangler dev --config dist/server/wrangler.json --port 8787
