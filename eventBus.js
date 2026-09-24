const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(100);

function emit(type, payload = {}) {
  bus.emit("event", {
    type,
    at: new Date().toISOString(),
    payload
  });
}

function subscribe(listener) {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

module.exports = { emit, subscribe };
