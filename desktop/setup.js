// The setup page: ticks off each step as it's done, and keeps checking while Claude Code's sign-in window is open.
const api = window.forgeDesktop;
const $ = (id) => document.getElementById(id);
let folder = '';
let polling = null;

function mark(id, done, current) {
  const li = $(id);
  li.classList.toggle('done', done);
  li.classList.toggle('current', !done && current);
  const button = li.querySelector('button:not(.secondary)');
  if (button) {
    button.hidden = done;
    button.disabled = !current;
  }
}

function say(id, text) {
  const msg = $(id).querySelector('.msg');
  msg.textContent = text || '';
  msg.hidden = !text;
}

async function refresh() {
  const s = await api.status();
  if (!folder) folder = s.folder;
  $('folder').textContent = folder;
  mark('step-git', s.git, true);
  mark('step-claude', s.claude, s.git);
  mark('step-signin', s.signedIn, s.git && s.claude);
  mark('step-folder', s.signedIn && !!folder, s.signedIn);
  $('finish').disabled = !(s.git && s.claude && s.signedIn && folder);
  if (s.signedIn && polling) {
    clearInterval(polling);
    polling = null;
  }
  return s;
}

for (const button of document.querySelectorAll('[data-install]')) {
  button.addEventListener('click', async () => {
    const what = button.dataset.install;
    const step = what === 'git' ? 'step-git' : 'step-claude';
    say(step, '');
    button.disabled = true;
    button.textContent = 'Installing…';
    const r = await api.install(what);
    button.textContent = r.ok ? 'Install' : 'Check again';
    if (!r.ok) say(step, r.message);
    await refresh();
  });
}

$('signin').addEventListener('click', async () => {
  say('step-signin', '');
  const r = await api.signIn();
  if (!r.ok) return say('step-signin', r.message);
  $('signin').textContent = 'Waiting for sign-in…';
  if (!polling) polling = setInterval(refresh, 3000);
});

$('browse').addEventListener('click', async () => {
  const picked = await api.pickFolder();
  if (picked) {
    folder = picked;
    await refresh();
  }
});

$('finish').addEventListener('click', async () => {
  $('finish').disabled = true;
  $('finish').textContent = 'Starting…';
  const r = await api.finish(folder);
  if (!r.ok) {
    $('finish-msg').textContent = r.message;
    $('finish-msg').hidden = false;
    $('finish').textContent = 'Open Forge AIOS';
    await refresh();
  }
});

refresh();
