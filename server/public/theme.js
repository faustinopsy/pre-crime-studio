// Tema: ?theme=dark|light (usado pelo app desktop); sem parâmetro segue o sistema.
(function () {
  var t = new URLSearchParams(location.search).get('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
})();
