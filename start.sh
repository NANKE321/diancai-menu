#!/bin/bash
cd "$(dirname "$0")"

PORT=3000

# 杀掉旧进程
pkill -f "node server.js" 2>/dev/null
pkill -f "serveo.net" 2>/dev/null
sleep 1

echo "🍽️  启动点菜服务..."
node server.js &
SERVER_PID=$!
sleep 1

echo "🌐 创建外网隧道..."
ssh -o StrictHostKeyChecking=no -R 80:localhost:$PORT serveo.net &
LT_PID=$!
sleep 4

echo ""
echo "========================================="
echo "✅ 服务已启动！"
echo ""
echo "📱 本地访问: http://localhost:$PORT"
echo "🌐 外网访问: 见上方 Forwarding 地址"
echo ""
echo "⚠️  保持此终端运行，Ctrl+C 停止服务"
echo "========================================="

trap "kill $SERVER_PID $LT_PID 2>/dev/null; exit" SIGINT SIGTERM
wait
