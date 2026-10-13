#!/usr/bin/env node
'use strict';

const { createServer } = require('../src/http');

// 发送授权服务。默认只绑 127.0.0.1：暴露到公网是部署决定，不该是默认值。

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const stateDir = arg('--state-dir', null);
const port = Number(arg('--port', '8790'));
const host = arg('--host', '127.0.0.1');

if (!stateDir) {
  process.stderr.write('缺少 --state-dir（授权服务的库与 tokens.json 都在这里）\n');
  process.exit(2);
}

const created = createServer({ stateDir });
created.server.listen(port, host, function () {
  process.stdout.write('send-authority listening on http://' + host + ':' + port + '\n');
  process.stdout.write('state-dir: ' + created.stateDir + '\n');
  process.stdout.write('tokens:    ' + created.stateDir + '\\tokens.json（{\"<tenant>\": \"<token>\"}）\n');
});
