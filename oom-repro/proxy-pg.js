/**
 * TCP proxy for PostgreSQL protocol inspection.
 * Listens on :5435, forwards to localhost:5433.
 * Counts Parse (P), Bind (B), Execute (E), and Describe (D) frontend messages.
 *
 * Usage:
 *   node oom-repro/proxy-pg.js
 */

const net = require('net');

const LISTEN_PORT = 5435;
const TARGET_PORT = 5433;
const TARGET_HOST = 'localhost';

let connId = 0;
let totalParse = 0;
let totalBind = 0;
let totalExecute = 0;

const server = net.createServer((client) => {
  const id = ++connId;
  const target = net.connect(TARGET_PORT, TARGET_HOST);

  let parseCount = 0;
  let bindCount = 0;
  let executeCount = 0;

  // Buffer for incomplete packets from the client
  let clientBuf = Buffer.alloc(0);

  // The very first client message is the StartupMessage (no type byte, 4-byte length).
  // After the server sends ReadyForQuery ('Z'), subsequent messages follow the standard format.
  let handshakeDone = false;

  // Track server data to detect ReadyForQuery
  let serverBuf = Buffer.alloc(0);

  target.on('data', (data) => {
    client.write(data);

    if (!handshakeDone) {
      serverBuf = Buffer.concat([serverBuf, data]);
      // Look for 'Z' (0x5A) ReadyForQuery in server stream
      for (let i = 0; i < serverBuf.length; i++) {
        if (serverBuf[i] === 0x5A) { // 'Z'
          handshakeDone = true;
          // Drain any client bytes buffered before handshake completed
          parseClientMessages();
          break;
        }
      }
      if (handshakeDone) serverBuf = Buffer.alloc(0);
    }
  });

  function parseClientMessages() {
    while (clientBuf.length >= 5) {
      const type = String.fromCharCode(clientBuf[0]);
      const len = clientBuf.readUInt32BE(1); // includes the 4-byte length field itself
      const totalLen = 1 + len;
      if (clientBuf.length < totalLen) break;

      const payload = clientBuf.slice(5, totalLen);
      clientBuf = clientBuf.slice(totalLen);

      if (type === 'P') { // Parse
        parseCount++;
        totalParse++;
        // Payload: prepared-statement name (cstring) + query (cstring) + param type count (int16) + types
        const nullIdx = payload.indexOf(0);
        const stmtName = payload.slice(0, nullIdx).toString('utf8');
        const rest = payload.slice(nullIdx + 1);
        const nullIdx2 = rest.indexOf(0);
        const query = rest.slice(0, nullIdx2).toString('utf8');
        const preview = query.slice(0, 80).replace(/\n/g, ' ');
        console.log(`[conn ${id}] Parse #${parseCount} (total: ${totalParse}) name="${stmtName}": ${preview}...`);
      } else if (type === 'B') { // Bind
        bindCount++;
        totalBind++;
        console.log(`[conn ${id}] Bind #${bindCount} (total: ${totalBind})`);
      } else if (type === 'E') { // Execute
        executeCount++;
        totalExecute++;
        console.log(`[conn ${id}] Execute #${executeCount} (total: ${totalExecute})`);
      } else if (type === 'X') { // Terminate
        console.log(`[conn ${id}] Terminate`);
      }
    }
  }

  client.on('data', (data) => {
    target.write(data);

    clientBuf = Buffer.concat([clientBuf, data]);

    if (!handshakeDone) {
      // Skip the startup message (first 4 bytes = total length including itself, no type byte)
      if (clientBuf.length >= 4) {
        const startupLen = clientBuf.readUInt32BE(0);
        if (clientBuf.length >= startupLen) {
          clientBuf = clientBuf.slice(startupLen);
        }
      }
      return; // wait for ReadyForQuery before parsing further
    }

    parseClientMessages();
  });

  client.on('end', () => {
    target.end();
    console.log(`[conn ${id}] closed — Parse: ${parseCount}, Bind: ${bindCount}, Execute: ${executeCount}`);
    console.log(`[total so far] Parse: ${totalParse}, Bind: ${totalBind}, Execute: ${totalExecute}`);
  });

  target.on('end', () => client.end());
  client.on('error', () => target.destroy());
  target.on('error', () => client.destroy());
});

server.listen(LISTEN_PORT, () => {
  console.log(`PostgreSQL proxy listening on :${LISTEN_PORT} → localhost:${TARGET_PORT}`);
});
