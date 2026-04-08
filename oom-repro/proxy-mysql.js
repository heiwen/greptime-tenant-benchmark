/**
 * TCP proxy for MySQL protocol inspection.
 * Listens on :4003, forwards to localhost:4002.
 * Counts COM_STMT_PREPARE (0x16) and COM_STMT_EXECUTE (0x17) commands.
 *
 * Usage:
 *   node oom-repro/proxy-mysql.js
 */

const net = require('net');

const LISTEN_PORT = 4003;
const TARGET_PORT = 4002;
const TARGET_HOST = 'localhost';

let connId = 0;
let totalPrepare = 0;
let totalExecute = 0;

const server = net.createServer((client) => {
  const id = ++connId;
  const target = net.connect(TARGET_PORT, TARGET_HOST);

  let prepareCount = 0;
  let executeCount = 0;

  // Buffer for incomplete MySQL packets from client
  let clientBuf = Buffer.alloc(0);
  // Track whether we've finished the handshake (first client packet after server greeting is auth)
  let handshakeDone = false;
  let serverGreetingBytes = 0;

  target.on('data', (data) => {
    client.write(data);
    // Count server bytes to detect when greeting is complete (first packet from server)
    if (!handshakeDone) {
      serverGreetingBytes += data.length;
    }
  });

  client.on('data', (data) => {
    target.write(data);

    clientBuf = Buffer.concat([clientBuf, data]);

    while (clientBuf.length >= 4) {
      // MySQL packet: 3-byte length (LE) + 1-byte sequence + payload
      const pktLen = clientBuf.readUIntLE(0, 3);
      const totalLen = 4 + pktLen;
      if (clientBuf.length < totalLen) break;

      const seq = clientBuf[3];
      const payload = clientBuf.slice(4, totalLen);
      clientBuf = clientBuf.slice(totalLen);

      if (!handshakeDone) {
        // seq=1 is the client auth packet (response to server greeting)
        if (seq === 1) {
          handshakeDone = true;
        }
        continue;
      }

      if (payload.length === 0) continue;
      const cmd = payload[0];

      if (cmd === 0x16) { // COM_STMT_PREPARE
        prepareCount++;
        totalPrepare++;
        const sql = payload.slice(1).toString('utf8');
        const preview = sql.slice(0, 80).replace(/\n/g, ' ');
        console.log(`[conn ${id}] COM_STMT_PREPARE #${prepareCount} (total: ${totalPrepare}): ${preview}...`);
      } else if (cmd === 0x17) { // COM_STMT_EXECUTE
        executeCount++;
        totalExecute++;
        console.log(`[conn ${id}] COM_STMT_EXECUTE #${executeCount} (total: ${totalExecute})`);
      } else if (cmd === 0x01) { // COM_QUIT
        console.log(`[conn ${id}] COM_QUIT`);
      }
    }
  });

  client.on('end', () => {
    target.end();
    console.log(`[conn ${id}] closed — PREPARE: ${prepareCount}, EXECUTE: ${executeCount}`);
    console.log(`[total so far] PREPARE: ${totalPrepare}, EXECUTE: ${totalExecute}`);
  });

  target.on('end', () => client.end());
  client.on('error', () => target.destroy());
  target.on('error', () => client.destroy());
});

server.listen(LISTEN_PORT, () => {
  console.log(`MySQL proxy listening on :${LISTEN_PORT} → localhost:${TARGET_PORT}`);
});
