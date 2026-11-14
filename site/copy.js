// Adds a "Copy" button to every command block. Classic script (not a module) so it also works from file://.
(function () {
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  document.querySelectorAll('pre.cmd').forEach(function (pre) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy command');
    button.addEventListener('click', function () {
      copy(pre.querySelector('code').textContent).then(function (ok) {
        button.textContent = ok ? 'Copied' : 'Select & copy';
        setTimeout(function () { button.textContent = 'Copy'; }, 1500);
      });
    });
    pre.appendChild(button);
  });
})();
