'use strict';
// A minimal stand-in for the `ws` package, built on node's own WebSocket
// (available since node 22). The suites only need `on`, `once` and `send`, so
// this keeps the whole project free of dependencies.

const Native = globalThis.WebSocket;

if (!Native) {
  throw new Error('This node build has no global WebSocket; node 22 or newer is needed.');
}

function toText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

class WebSocketLite extends Native {
  constructor(url, opts) {
    super(url, opts && opts.protocols);
    this._listeners = { open: [], close: [], error: [], message: [] };
    super.addEventListener('open', () => this._emit('open'));
    super.addEventListener('close', (e) => this._emit('close', e));
    super.addEventListener('error', () => this._emit('error', new Error('socket error')));
    super.addEventListener('message', (e) => this._emit('message', toText(e.data)));
  }

  _emit(kind, arg) {
    for (const fn of this._listeners[kind].slice()) {
      try { fn(arg); } catch (err) { /* a listener throwing must not kill the socket */ }
    }
  }

  on(kind, fn) {
    if (this._listeners[kind]) this._listeners[kind].push(fn);
    return this;
  }

  once(kind, fn) {
    const wrapped = (arg) => {
      this.off(kind, wrapped);
      fn(arg);
    };
    return this.on(kind, wrapped);
  }

  off(kind, fn) {
    const list = this._listeners[kind];
    if (!list) return this;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
    return this;
  }

  send(data, cb) {
    try {
      super.send(data);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err); else throw err;
    }
  }
}

module.exports = WebSocketLite;
module.exports.WebSocket = WebSocketLite;
