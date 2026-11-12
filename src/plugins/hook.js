'use strict';

// Roda DENTRO da página do jogo (serializada via toString). Observa as
// mensagens recebidas pelos WebSockets da página, sem enviar nada nem alterar
// o que o jogo recebe, e repassa os eventos detectados para o preload por
// window.postMessage.
function installHook(detect, special, pluginId) {
  if (window.__idleHubHook) return;
  Object.defineProperty(window, '__idleHubHook', { value: true });

  const Native = window.WebSocket;
  const decoder = new TextDecoder();
  const ALIVE_MS = 30000;
  let lastAlive = 0;

  const post = (events) => {
    window.postMessage({ __idleHub: true, pluginId, events }, window.location.origin);
  };

  const handle = (data) => {
    const now = Date.now();
    const events = [];
    if (now - lastAlive > ALIVE_MS) {
      lastAlive = now;
      events.push({ type: 'alive' });
    }
    let text = null;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = decoder.decode(data);
    if (text) {
      try {
        const found = detect(JSON.parse(text), special);
        if (found && found.length) events.push(...found);
      } catch (_) {
        /* mensagem que não é JSON ou formato inesperado: ignora */
      }
    }
    if (events.length) post(events);
  };

  function ObservedWebSocket(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    ws.addEventListener('message', (ev) => handle(ev.data));
    return ws;
  }
  Object.setPrototypeOf(ObservedWebSocket, Native);
  ObservedWebSocket.prototype = Native.prototype;
  window.WebSocket = ObservedWebSocket;
}

module.exports = { installHook };
