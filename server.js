const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// 读取或初始化数据
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { orders: [], version: 0 };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let appData = loadData();

// HTTP 服务器
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(appData));
    return;
  }

  if (req.url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        if (update.orders !== undefined) appData.orders = update.orders;
        if (update.version !== undefined) appData.version = update.version;
        else appData.version++;
        saveData(appData);
        // 广播给所有 WebSocket 客户端
        broadcast(JSON.stringify({ type: 'update', data: appData }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: appData.version }));
      } catch (e) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // 静态文件服务
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket 实现（手动升级，不依赖 ws 库）
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB90DC65B88')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  clients.add(socket);
  // 发送当前数据
  sendFrame(socket, JSON.stringify({ type: 'init', data: appData }));

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      let payload = buffer.slice(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const mask = buffer.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }

      buffer = buffer.slice(offset + maskLen + payloadLen);

      // 处理客户端消息
      const opcode = firstByte & 0x0F;
      if (opcode === 0x08) { socket.end(); return; } // close
      if (opcode === 0x09) { sendFrame(socket, Buffer.from([0x8A, 0x00])); continue; } // ping -> pong

      try {
        const msg = JSON.parse(payload.toString());
        if (msg.type === 'sync' && msg.orders !== undefined) {
          appData.orders = msg.orders;
          appData.version++;
          saveData(appData);
          // 广播给其他人
          for (const c of clients) {
            if (c !== socket && !c.destroyed) {
              sendFrame(c, JSON.stringify({ type: 'update', data: appData }));
            }
          }
        }
      } catch (e) {}
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

function sendFrame(socket, data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(data) {
  for (const c of clients) {
    if (!c.destroyed) sendFrame(c, data);
  }
}

server.listen(PORT, () => {
  console.log(`🍽️  点菜服务已启动: http://localhost:${PORT}`);
});
