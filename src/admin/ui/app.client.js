// Form Worker admin UI. No framework; every value is inserted with textContent.

const state = { me: null, forms: [], entries: [], hasMore: false, open: new Set(), view: 'inbox', search: '', entriesKey: '' };
const $ = (selector) => document.querySelector(selector);

const SPAM_LEVELS = [
  { value: 0, label: 'Off', hint: 'Keep everything in the inbox.' },
  { value: 70, label: 'Relaxed', hint: 'Only obvious spam is filtered.' },
  { value: 50, label: 'Balanced', hint: 'Recommended for most sites.' },
  { value: 35, label: 'Strict', hint: 'Filters more; check the Spam tab now and then.' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/admin/api${path}`, {
    method,
    headers: { 'X-Form-Worker': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (response.headers.get('Content-Type') || '').includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const box = $('#toast');
  box.replaceChildren(h('div', { class: isError ? 'error' : '', text: message }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.replaceChildren(), isError ? 8000 : 3500);
}

/** Runs an async action with the button disabled; reports errors as a toast. */
async function busy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (error) {
    toast(error.message, true);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

const fullDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function relativeDate(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const enc = encodeURIComponent;

async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Copy failed: select the text and copy it manually', true);
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function openDialog(title, body, actions) {
  const dialog = $('#dialog');
  dialog.replaceChildren(h('h2', { id: 'dialog-title', text: title }), body, h('div', { class: 'actions' }, actions));
  dialog.showModal();
  return dialog;
}

const closeDialog = () => $('#dialog').close();

function confirmDialog(title, message, confirmLabel) {
  return new Promise((resolve) => {
    const dialog = $('#dialog');
    const done = (value) => {
      dialog.close();
      resolve(value);
    };
    openDialog(title, h('p', { text: message }), [
      h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => done(false) }),
      h('button', { type: 'button', class: 'btn danger', text: confirmLabel, onclick: () => done(true) }),
    ]);
    dialog.addEventListener('cancel', () => resolve(false), { once: true });
  });
}

function showApiKey(title, apiKey, endpoint) {
  openDialog(
    title,
    h(
      'div',
      {},
      h('p', {}, 'Copy this API key now. It is ', h('strong', { text: 'shown only once' }), ' and cannot be retrieved later.'),
      h('code', { class: 'secret mono', text: apiKey }),
      h('p', { class: 'muted' }, 'Servers send it as ', h('code', { text: 'Authorization: Bearer <key>' }), ' to:'),
      h('code', { class: 'secret mono', text: endpoint }),
    ),
    [
      h('button', { type: 'button', class: 'btn', text: 'Copy key', onclick: () => copy(apiKey, 'API key copied') }),
      h('button', { type: 'button', class: 'btn primary', text: 'Done', onclick: closeDialog }),
    ],
  );
}

function newFormDialog() {
  const id = h('input', { type: 'text', id: 'nf-id', required: true, pattern: '[a-z0-9][a-z0-9-]{1,62}', autocomplete: 'off' });
  const name = h('input', { type: 'text', id: 'nf-name', required: true, autocomplete: 'off', placeholder: 'Client website' });
  const form = h(
    'form',
    { id: 'nf' },
    h('div', { class: 'field' }, h('label', { for: 'nf-name', text: 'Name' }), name, h('span', { class: 'hint', text: 'Usually the website or client name, e.g. "Acme Bakery contact form".' })),
    h('div', { class: 'field' }, h('label', { for: 'nf-id', text: 'Form ID' }), id, h('span', { class: 'hint', text: 'Appears in the form URL. Lowercase letters, numbers and hyphens.' })),
  );
  const submit = h('button', { type: 'submit', form: 'nf', class: 'btn primary', text: 'Create form' });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(submit, async () => {
      const result = await api('/forms', { method: 'POST', body: { id: id.value.trim().toLowerCase(), name: name.value.trim() } });
      closeDialog();
      await loadForms();
      location.hash = `#/forms/${enc(result.form.id)}/setup`;
      showApiKey('Form created', result.apiKey, result.endpoint);
    });
  });
  name.addEventListener('input', () => {
    if (!id.dataset.touched) id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  });
  id.addEventListener('input', () => (id.dataset.touched = '1'));
  openDialog('New form', form, [h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeDialog }), submit]);
  name.focus();
}

function addEntryDialog(form) {
  const text = h('textarea', { id: 'ae-data', rows: 8, placeholder: 'name: Sam Lee\nemail: sam@example.com\nmessage: Called about a new website' });
  const dialogForm = h(
    'form',
    { id: 'ae' },
    h('div', { class: 'field' }, h('label', { for: 'ae-data', text: 'Fields' }), text, h('span', { class: 'hint', text: 'One "field: value" per line, e.g. an enquiry taken by phone. Manual entries are not emailed.' })),
  );
  const submit = h('button', { type: 'submit', form: 'ae', class: 'btn primary', text: 'Add entry' });
  dialogForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = {};
    for (const line of lines(text.value)) {
      const at = line.indexOf(':');
      if (at > 0) data[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    busy(submit, async () => {
      await api(`/forms/${enc(form.id)}/entries`, { method: 'POST', body: { data } });
      closeDialog();
      toast('Entry added');
      state.view = 'inbox';
      await refresh(form.id);
    });
  });
  openDialog(`Add entry to ${form.name}`, dialogForm, [h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeDialog }), submit]);
  text.focus();
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadForms() {
  state.forms = (await api('/forms')).forms;
}

async function loadEntries(formId, append = false) {
  const params = new URLSearchParams({ view: state.view });
  if (state.search) params.set('q', state.search);
  const last = append ? state.entries[state.entries.length - 1] : null;
  if (last) {
    params.set('before', last.createdAt);
    params.set('beforeId', last.id);
  }
  const result = await api(`/forms/${enc(formId)}/entries?${params}`);
  state.entries = append ? [...state.entries, ...result.entries] : result.entries;
  state.hasMore = result.hasMore;
  state.entriesKey = `${formId}|${state.view}|${state.search}`;
}

async function refresh(formId) {
  await Promise.all([loadForms(), loadEntries(formId)]);
  render();
}

function route() {
  const match = /^#\/forms\/([^/]+)(?:\/(settings|setup))?$/.exec(location.hash);
  return match ? { formId: decodeURIComponent(match[1]), tab: match[2] || 'entries' } : { formId: null, tab: null };
}

// ── Views ────────────────────────────────────────────────────────────────────

function renderSidebar(current) {
  $('#form-list').replaceChildren(
    ...state.forms.map((form) =>
      h(
        'li',
        {},
        h(
          'a',
          { href: `#/forms/${enc(form.id)}`, 'aria-current': form.id === current ? 'page' : null },
          h('span', { class: 'form-name' }, form.enabled ? null : h('span', { class: 'dot off', title: 'Not accepting submissions' }), form.name),
          h('span', { class: 'count', 'aria-label': `${form.entryCount} entries`, text: form.entryCount }),
        ),
      ),
    ),
  );
  if (state.forms.length === 0) $('#form-list').append(h('li', { class: 'muted small pad', text: 'No forms yet.' }));
}

function badge(status) {
  const labels = { sent: 'Emailed', failed: 'Email failed', pending: 'Sending', skipped: 'Not emailed' };
  return h('span', { class: `badge ${status}`, text: labels[status] || status });
}

function summary(entry) {
  return Object.entries(entry.data)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`)
    .join(' · ');
}

function stats(form) {
  const stat = (value, label) => h('div', { class: 'stat' }, h('div', { class: 'stat-value', text: value }), h('div', { class: 'stat-label', text: label }));
  return h(
    'div',
    { class: 'stats' },
    stat(form.entryCount, 'Entries'),
    stat(form.last7Days, 'Last 7 days'),
    stat(form.spamCount, 'Spam caught'),
    stat(form.lastEntryAt ? relativeDate(form.lastEntryAt) : '—', 'Latest entry'),
  );
}

function entryDetails(form, entry) {
  const actions = [];

  if (entry.isSpam) {
    const rescue = h('button', { type: 'button', class: 'btn small primary', text: 'Not spam' });
    rescue.addEventListener('click', () =>
      busy(rescue, async () => {
        const result = await api(`/entries/${enc(entry.id)}/spam`, { method: 'POST', body: { spam: false } });
        toast(result.status === 'sent' ? 'Moved to inbox and emailed' : 'Moved to inbox');
        state.open.delete(entry.id);
        await refresh(form.id);
      }),
    );
    actions.push(rescue);
  } else {
    if (form.notifyEmails.length) {
      const resend = h('button', { type: 'button', class: 'btn small', text: entry.notifyStatus === 'sent' ? 'Email again' : 'Send email' });
      resend.addEventListener('click', () =>
        busy(resend, async () => {
          const result = await api(`/entries/${enc(entry.id)}/notify`, { method: 'POST' });
          Object.assign(entry, result.entry);
          toast(result.status === 'sent' ? 'Email sent' : `Email ${result.status}: ${result.entry.notifyError || ''}`, result.status === 'failed');
          render();
        }),
      );
      actions.push(resend);
    }
    const markSpam = h('button', { type: 'button', class: 'btn small', text: 'Mark as spam' });
    markSpam.addEventListener('click', () =>
      busy(markSpam, async () => {
        await api(`/entries/${enc(entry.id)}/spam`, { method: 'POST', body: { spam: true } });
        toast('Moved to spam');
        state.open.delete(entry.id);
        await refresh(form.id);
      }),
    );
    actions.push(markSpam);
  }

  const remove = h('button', { type: 'button', class: 'btn small danger', text: 'Delete' });
  remove.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete entry?', 'This permanently deletes the entry. It cannot be undone.', 'Delete entry'))) return;
    await busy(remove, async () => {
      await api(`/entries/${enc(entry.id)}`, { method: 'DELETE' });
      toast('Entry deleted');
      await refresh(form.id);
    });
  });
  actions.push(remove);

  const meta = Object.entries(entry.meta).map(([key, value]) => `${key}: ${value}`);
  return h(
    'div',
    {},
    entry.spamReasons.length
      ? h(
          'div',
          { class: `spam-box${entry.isSpam ? ' is-spam' : ''}` },
          h('strong', { text: `Spam score ${entry.spamScore}/100` }),
          h('ul', {}, entry.spamReasons.map((reason) => h('li', { text: reason }))),
        )
      : null,
    h('dl', {}, Object.entries(entry.data).flatMap(([key, value]) => [h('dt', { text: key }), h('dd', { text: value || '—' })])),
    h(
      'p',
      { class: 'meta' },
      `Received ${fullDate(entry.createdAt)}`,
      meta.length ? ` · ${meta.join(' · ')}` : '',
      entry.notifyError && !entry.isSpam ? ` · Email: ${entry.notifyError}` : '',
    ),
    h('div', { class: 'toolbar' }, actions),
  );
}

function entriesView(form) {
  const search = h('input', { type: 'search', id: 'entry-search', value: state.search, placeholder: 'Search entries', 'aria-label': 'Search entries' });
  search.addEventListener(
    'input',
    debounce(() => {
      state.search = search.value.trim();
      busy(null, async () => {
        await loadEntries(form.id);
        render();
        const again = $('#entry-search');
        again?.focus();
        again?.setSelectionRange(again.value.length, again.value.length);
      });
    }, 300),
  );

  const viewButton = (view, label, count) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        'aria-pressed': String(state.view === view),
        onclick: () => {
          if (state.view === view) return;
          state.view = view;
          state.open.clear();
          busy(null, async () => {
            await loadEntries(form.id);
            render();
          });
        },
      },
      label,
      h('span', { class: 'seg-count', text: count }),
    );

  const refreshButton = h('button', { type: 'button', class: 'btn', text: 'Refresh' });
  refreshButton.addEventListener('click', () => busy(refreshButton, () => refresh(form.id)));

  const toolbar = h(
    'div',
    { class: 'toolbar entries-toolbar' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, viewButton('inbox', 'Inbox', form.entryCount), viewButton('spam', 'Spam', form.spamCount)),
    search,
    h('span', { class: 'spacer' }),
    refreshButton,
    h('button', { type: 'button', class: 'btn', text: 'Add entry', onclick: () => addEntryDialog(form) }),
    h('a', { class: 'btn', href: `/admin/api/forms/${enc(form.id)}/entries.csv`, text: 'Export CSV' }),
  );

  if (state.entries.length === 0) {
    const message = state.search
      ? ['No matches', `Nothing in ${state.view === 'spam' ? 'spam' : 'the inbox'} matches “${state.search}”.`]
      : state.view === 'spam'
        ? ['No spam', 'Submissions the spam filter catches will appear here.']
        : ['No entries yet', 'Submissions to this form will appear here. The Setup tab shows how to connect a website.'];
    return h('div', {}, toolbar, h('div', { class: 'panel empty' }, h('h2', { text: message[0] }), h('p', { class: 'muted', text: message[1] })));
  }

  const rows = state.entries.flatMap((entry) => {
    const isOpen = state.open.has(entry.id);
    const toggle = h('button', { type: 'button', class: 'toggle', 'aria-expanded': String(isOpen), text: summary(entry) || '(no fields)' });
    toggle.addEventListener('click', () => {
      if (isOpen) state.open.delete(entry.id);
      else state.open.add(entry.id);
      render();
    });
    const row = h(
      'tr',
      { class: isOpen ? 'open' : '' },
      h('td', { class: 'when' }, h('time', { datetime: entry.createdAt, title: fullDate(entry.createdAt), text: relativeDate(entry.createdAt) })),
      h('td', { class: 'summary' }, toggle),
      h('td', { class: 'status' }, entry.isSpam ? h('span', { class: 'badge spam', text: `Spam ${entry.spamScore}` }) : badge(entry.notifyStatus)),
    );
    return isOpen ? [row, h('tr', { class: 'details' }, h('td', { colspan: 3 }, entryDetails(form, entry)))] : [row];
  });

  const more = state.hasMore ? h('button', { type: 'button', class: 'btn', text: 'Load more' }) : null;
  more?.addEventListener('click', () =>
    busy(more, async () => {
      await loadEntries(form.id, true);
      render();
    }),
  );

  return h(
    'div',
    {},
    toolbar,
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'entries' },
        h('caption', { class: 'visually-hidden', text: `${state.view === 'spam' ? 'Spam' : 'Entries'} for ${form.name}` }),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Received' }), h('th', { scope: 'col', text: 'Entry' }), h('th', { scope: 'col', text: 'Status' }))),
        h('tbody', {}, rows),
      ),
    ),
    more ? h('div', { class: 'toolbar more' }, more) : null,
  );
}

function field(id, label, input, hint) {
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
}

function settingsView(form) {
  const name = h('input', { type: 'text', value: form.name, required: true });
  const origins = h('textarea', { rows: 3, placeholder: 'https://www.client-site.com' });
  origins.value = form.allowedOrigins.join('\n');
  const emails = h('textarea', { rows: 3, placeholder: 'you@example.com' });
  emails.value = form.notifyEmails.join('\n');
  const redirect = h('input', { type: 'url', value: form.redirectUrl || '', placeholder: 'https://www.client-site.com/thank-you' });
  const retention = h('input', { type: 'number', min: 1, max: 3650, value: form.retentionDays });
  const spam = h(
    'select',
    {},
    SPAM_LEVELS.map((level) => h('option', { value: level.value, selected: level.value === form.spamThreshold, text: `${level.label} — ${level.hint}` })),
  );
  if (!SPAM_LEVELS.some((level) => level.value === form.spamThreshold)) {
    spam.append(h('option', { value: form.spamThreshold, selected: true, text: `Custom (score ≥ ${form.spamThreshold})` }));
  }
  const turnstile = h('input', { type: 'checkbox', id: 'st-turnstile', checked: form.requireTurnstile });
  const enabled = h('input', { type: 'checkbox', id: 'st-enabled', checked: form.enabled });
  const save = h('button', { type: 'submit', class: 'btn primary', text: 'Save settings' });

  const settings = h(
    'form',
    { class: 'panel' },
    h('h2', { text: 'Settings' }),
    field('st-name', 'Name', name),
    field('st-emails', 'Notification emails', emails, 'One address per line. Each new entry (except spam) is emailed to all of them.'),
    field('st-origins', 'Allowed websites', origins, 'One origin per line. Needed when a browser posts straight to this form; server-to-server requests use the API key instead.'),
    field('st-spam', 'Spam filter', spam, 'Spam is kept in the Spam tab and never emailed. Senders always see a normal “thank you”.'),
    field('st-redirect', 'Thank-you page (optional)', redirect, 'Where plain HTML forms send visitors after submitting.'),
    field('st-retention', 'Delete entries after (days)', retention, 'Entries older than this are deleted automatically. Match your or your client’s privacy policy.'),
    h('div', { class: 'check' }, turnstile, h('label', { for: 'st-turnstile', text: 'Require a Cloudflare Turnstile check for browser posts' })),
    h('div', { class: 'check' }, enabled, h('label', { for: 'st-enabled', text: 'Accept new submissions' })),
    save,
  );
  settings.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(save, async () => {
      await api(`/forms/${enc(form.id)}`, {
        method: 'PATCH',
        body: {
          name: name.value,
          notifyEmails: lines(emails.value),
          allowedOrigins: lines(origins.value),
          redirectUrl: redirect.value,
          retentionDays: Number(retention.value),
          spamThreshold: Number(spam.value),
          requireTurnstile: turnstile.checked,
          enabled: enabled.checked,
        },
      });
      await loadForms();
      toast('Settings saved');
      render();
    });
  });

  const testTo = h('input', { type: 'email', value: form.notifyEmails[0] || '', placeholder: 'you@example.com' });
  const sendTest = h('button', { type: 'button', class: 'btn', text: 'Send test email' });
  sendTest.addEventListener('click', () =>
    busy(sendTest, async () => {
      await api('/test-email', { method: 'POST', body: { to: testTo.value.trim() } });
      toast(`Test email sent to ${testTo.value.trim()}`);
    }),
  );
  const email = h(
    'div',
    { class: 'panel' },
    h('h2', { text: 'Email notifications' }),
    state.me?.smtpConfigured
      ? h('p', { class: 'muted', text: `Sent through SMTP as ${state.me.smtpUser}.` })
      : h('p', { class: 'notice', text: 'SMTP is not configured yet: set the SMTP_USER and SMTP_PASS secrets on the Worker.' }),
    field('st-test', 'Send a test to', testTo),
    sendTest,
  );

  const rotate = h('button', { type: 'button', class: 'btn', text: 'Create new API key' });
  rotate.addEventListener('click', async () => {
    if (!(await confirmDialog('Replace the API key?', 'The current key stops working immediately. Update every site that uses it.', 'Replace key'))) return;
    await busy(rotate, async () => {
      const result = await api(`/forms/${enc(form.id)}/rotate-key`, { method: 'POST' });
      showApiKey('New API key', result.apiKey, endpointFor(form));
    });
  });
  const key = h(
    'div',
    { class: 'panel' },
    h('h2', { text: 'API key' }),
    h('p', { class: 'muted', text: 'Keys are stored hashed and cannot be shown again. If one is lost or leaked, create a new one.' }),
    rotate,
  );

  const remove = h('button', { type: 'button', class: 'btn danger', text: 'Delete form and all entries' });
  remove.addEventListener('click', async () => {
    const total = form.entryCount + form.spamCount;
    if (!(await confirmDialog(`Delete ${form.name}?`, `This permanently deletes the form and all ${total} entries. It cannot be undone.`, 'Delete form'))) return;
    await busy(remove, async () => {
      await api(`/forms/${enc(form.id)}`, { method: 'DELETE' });
      await loadForms();
      toast('Form deleted');
      location.hash = '#/';
    });
  });

  return h('div', { class: 'settings' }, settings, email, key, h('div', { class: 'panel danger-zone' }, h('h2', { text: 'Danger zone' }), remove));
}

function snippet(title, description, code) {
  return h(
    'div',
    { class: 'panel' },
    h('div', { class: 'snippet-head' }, h('h2', { text: title }), h('button', { type: 'button', class: 'btn small', text: 'Copy', onclick: () => copy(code, `${title} copied`) })),
    h('p', { class: 'muted', text: description }),
    h('pre', { class: 'code' }, h('code', { text: code })),
  );
}

function setupView(form) {
  const endpoint = endpointFor(form);
  const html = `<form action="${endpoint}" method="POST">
  <label>Name <input name="name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Message <textarea name="message" required></textarea></label>
  <!-- Honeypot: hidden from people, bots fill it in -->
  <input name="_gotcha" tabindex="-1" autocomplete="off" style="display:none">
  <button type="submit">Send</button>
</form>`;
  const js = `const response = await fetch("${endpoint}", {
  method: "POST",
  headers: { Accept: "application/json" },
  body: new FormData(document.querySelector("form")),
});
const result = await response.json(); // { ok: true, id: "…" } or { ok: false, error: "…" }`;
  const server = `curl -X POST "${endpoint}" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Sam","email":"sam@example.com","message":"Hello"}'`;

  const needsOrigin = form.allowedOrigins.length === 0;
  return h(
    'div',
    {},
    needsOrigin
      ? h('p', { class: 'notice' }, 'Before a website can post from the browser, add its address under ', h('a', { href: `#/forms/${enc(form.id)}/settings`, text: 'Settings → Allowed websites' }), '.')
      : null,
    snippet('Plain HTML form', 'Works without JavaScript. Set a thank-you page in Settings to send visitors back to the site.', html),
    snippet('JavaScript (fetch)', 'For forms that show their own confirmation message.', js),
    snippet('From a server', 'For server-side code, Pages Functions or other Workers. Uses the form’s API key instead of an allowed website.', server),
  );
}

const endpointFor = (form) => `${location.origin}/api/forms/${enc(form.id)}/submissions`;

function formView(form, tab) {
  const endpoint = endpointFor(form);
  const base = `#/forms/${enc(form.id)}`;
  const tabLink = (href, key, label) => h('a', { href, 'aria-current': tab === key ? 'page' : null, text: label });
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'head' },
      h('div', {}, h('h1', { text: form.name }), h('div', { class: 'endpoint' }, h('code', { class: 'mono', text: endpoint }), h('button', { type: 'button', class: 'btn small ghost', text: 'Copy URL', onclick: () => copy(endpoint, 'URL copied') }))),
      form.enabled ? null : h('span', { class: 'badge failed', text: 'Paused' }),
    ),
    stats(form),
    h(
      'nav',
      { class: 'tabs', 'aria-label': 'Form sections' },
      tabLink(base, 'entries', 'Entries'),
      tabLink(`${base}/setup`, 'setup', 'Setup'),
      tabLink(`${base}/settings`, 'settings', 'Settings'),
    ),
    tab === 'settings' ? settingsView(form) : tab === 'setup' ? setupView(form) : entriesView(form),
  );
}

function homeView() {
  if (state.forms.length === 0) {
    return h(
      'div',
      { class: 'panel empty hero' },
      h('h1', { text: 'Welcome to Form Worker' }),
      h('p', { class: 'muted', text: 'Create a form for each website you look after. Submissions are stored here, filtered for spam and emailed to you.' }),
      h('button', { type: 'button', class: 'btn primary', text: 'Create your first form', onclick: newFormDialog }),
    );
  }
  const total = state.forms.reduce((sum, form) => sum + form.entryCount, 0);
  const week = state.forms.reduce((sum, form) => sum + form.last7Days, 0);
  const spam = state.forms.reduce((sum, form) => sum + form.spamCount, 0);
  return h(
    'div',
    {},
    h('div', { class: 'head' }, h('h1', { text: 'Overview' })),
    h(
      'div',
      { class: 'stats' },
      ...[
        [state.forms.length, 'Forms'],
        [total, 'Entries'],
        [week, 'Last 7 days'],
        [spam, 'Spam caught'],
      ].map(([value, label]) => h('div', { class: 'stat' }, h('div', { class: 'stat-value', text: value }), h('div', { class: 'stat-label', text: label }))),
    ),
    h(
      'div',
      { class: 'cards' },
      state.forms.map((form) =>
        h(
          'a',
          { class: 'card', href: `#/forms/${enc(form.id)}` },
          h('strong', { text: form.name }),
          h('span', { class: 'muted', text: `${form.entryCount} entries · ${form.last7Days} this week` }),
          h('span', { class: 'muted small', text: form.lastEntryAt ? `Latest ${relativeDate(form.lastEntryAt)}` : 'No entries yet' }),
        ),
      ),
    ),
  );
}

function render() {
  const { formId, tab } = route();
  const form = state.forms.find((item) => item.id === formId);
  renderSidebar(form?.id);
  $('#main').replaceChildren(form ? formView(form, tab) : homeView());
}

async function onRoute() {
  const { formId } = route();
  if (formId && state.forms.some((form) => form.id === formId) && !state.entriesKey.startsWith(`${formId}|`)) {
    state.open.clear();
    state.view = 'inbox';
    state.search = '';
    await busy(null, () => loadEntries(formId));
  }
  render();
  $('#main').focus({ preventScroll: true });
}

// ── Start ────────────────────────────────────────────────────────────────────

async function start() {
  $('#new-form').addEventListener('click', newFormDialog);
  window.addEventListener('hashchange', onRoute);
  try {
    [state.me] = await Promise.all([api('/me'), loadForms()]);
    $('#whoami').textContent = state.me.user;
  } catch (error) {
    $('#main').replaceChildren(h('div', { class: 'panel' }, h('h1', { text: 'Could not load' }), h('p', { text: error.message })));
    return;
  }
  await onRoute();
}

start();
