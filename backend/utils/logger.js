function createLogger(module) {
  function log(level, msg, meta = {}) {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      module,
      msg,
      ...meta
    });
    if (level === 'error') console.error(entry);
    else if (level === 'warn') console.warn(entry);
    else console.log(entry);
  }

  return {
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    debug: (msg, meta) => log('debug', msg, meta)
  };
}

function traceId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = { createLogger, traceId };
