/* The backend check page (check.html): keys reaching the page, and the socket's hello. */
(function () {
  var keys = document.getElementById('keys'), seen = [];
  document.addEventListener('keydown', function (e) {
    var mods = (e.metaKey ? '⌘' : '') + (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '');
    seen.unshift(mods + ' ' + e.code + ' (key ' + JSON.stringify(e.key) + ')');
    keys.textContent = seen.slice(0, 8).join('\n');
  }, true);
})();
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var state = document.getElementById('state');
  var ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = function () { ws.send(JSON.stringify({ t: 'auth', token: token })); };
  ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.t === 'hello') {
      state.textContent = 'Connected';
      state.className = 'ok';
      document.getElementById('hello').textContent = JSON.stringify(msg, null, 2);
    }
  };
  ws.onclose = function (e) {
    state.textContent = 'Disconnected (' + e.code + ')';
    state.className = 'bad';
  };
})();
