#!/usr/bin/env bash
# 一键启动「页语」PDF 随页翻译阅读器（本地运行）
#
# 用法：在终端执行  ./start.sh
# 首次运行会自动安装依赖并构建，之后启动约需十几秒。
# 端口被占用时会自动换一个，启动后以终端里打印的地址为准。
set -e
cd "$(dirname "$0")/demo"

if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖…"
  pnpm install
fi

echo "构建生产版本…"
pnpm build

# 从 8787 开始找一个空闲端口
PORT=8787
while ss -tln 2>/dev/null | grep -q ":$PORT "; do
  PORT=$((PORT + 1))
done

echo
echo "✅ 启动完成：请在浏览器打开 http://localhost:$PORT"
echo "   按 Ctrl+C 停止。PDF、译文缓存和翻译设置都保存在本机浏览器中。"
echo
npx wrangler dev --config dist/server/wrangler.json --port "$PORT"
