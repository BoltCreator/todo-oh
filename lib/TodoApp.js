'use strict';

const { BackendApp } = require('../framework');

/**
 * TodoApp — a second example to show how trivially you switch backend classes,
 * and to demonstrate that methods are individually optional: this app has NO
 * run() loop (it's purely request-driven), yet persists fine via getJson/read.
 */
class TodoApp extends BackendApp {
  constructor(options) {
    super(options);
    this.todos = []; // { id, text, done }
    this.nextId = 1;
  }

  async get(query) {
    if (query === 'count') return this.todos.length;
    return this.todos;
  }

  async post(action, data) {
    switch (action) {
      case 'add':
        this.todos.push({ id: this.nextId++, text: String(data.text ?? '').trim(), done: false });
        break;
      case 'toggle': {
        const t = this.todos.find((x) => x.id === data.id);
        if (t) t.done = !t.done;
        break;
      }
      case 'remove':
        this.todos = this.todos.filter((x) => x.id !== data.id);
        break;
      case 'clear':
        this.todos = [];
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }
    return this.getJson();
  }

  getJson() {
    return { todos: this.todos, nextId: this.nextId };
  }

  read(json) {
    if (!json) return;
    this.todos = Array.isArray(json.todos) ? json.todos : [];
    this.nextId = json.nextId ?? this.todos.length + 1;
  }

  getHTML() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TodoApp</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 560px; margin: 3rem auto; padding: 0 1rem; }
  li { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; }
  li.done span { text-decoration: line-through; opacity: .5; }
  button { cursor: pointer; }
  .row { display: flex; gap: .5rem; }
  input { flex: 1; padding: .5rem; }
</style>
</head>
<body>
  <h1>TodoApp</h1>
  <div class="row">
    <input id="text" placeholder="What needs doing?" />
    <button id="add">Add</button>
  </div>
  <ul id="list"></ul>

  <script>
    async function render(todos) {
      const list = document.getElementById('list');
      list.innerHTML = '';
      (todos || []).forEach((t) => {
        const li = document.createElement('li');
        if (t.done) li.className = 'done';
        const span = document.createElement('span');
        span.textContent = t.text;
        const toggle = document.createElement('button');
        toggle.textContent = t.done ? '↺' : '✓';
        toggle.onclick = async () => render((await App.post('toggle', { id: t.id })).todos);
        const del = document.createElement('button');
        del.textContent = '✕';
        del.onclick = async () => render((await App.post('remove', { id: t.id })).todos);
        li.append(toggle, span, del);
        list.appendChild(li);
      });
    }
    document.getElementById('add').onclick = async () => {
      const input = document.getElementById('text');
      if (!input.value.trim()) return;
      const state = await App.post('add', { text: input.value });
      input.value = '';
      render(state.todos);
    };
    window.addEventListener('app:ready', async () => render(await App.get('todos')));
  </script>
</body>
</html>`;
  }
}

module.exports = TodoApp;
