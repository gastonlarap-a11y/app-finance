// codemap viewer: the "Ask the AI" panel and the diagram buttons. No build
// step and no dependencies; served under a CSP that allows only this file.
'use strict';

(function () {
  const SESSION_KEY = 'codemap-session';

  function getSession() {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
  }
  function setSession(id) {
    try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); } catch { /* storage off: one-shot questions */ }
  }

  async function postJSON(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function errorText(res) {
    try { const j = await res.json(); return j.error || res.statusText; } catch { return res.statusText; }
  }

  // ---------- ask ----------
  const form = document.getElementById('ask-form');
  if (form) {
    const aside = document.getElementById('ask');
    const output = document.getElementById('ask-output');
    const status = document.getElementById('ask-status');
    const send = document.getElementById('ask-send');
    const question = document.getElementById('ask-question');

    document.getElementById('ask-new').addEventListener('click', () => {
      setSession('');
      output.textContent = '';
      status.textContent = 'Conversación nueva.';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = question.value.trim();
      if (!text) return;
      send.disabled = true;
      status.textContent = 'Pensando…';
      const turn = document.createElement('div');
      turn.className = 'turn';
      const q = document.createElement('p');
      q.className = 'q';
      q.textContent = text;
      const a = document.createElement('p');
      a.className = 'a';
      turn.append(q, a);
      output.append(turn);
      try {
        const res = await postJSON('/api/ask', { question: text, symbol: aside.dataset.symbol || '', session: getSession() });
        if (!res.ok || !res.body) {
          status.textContent = await errorText(res);
          return;
        }
        question.value = '';
        await readEvents(res.body, (ev) => {
          switch (ev.kind) {
            case 'session': setSession(ev.session); break;
            case 'text': a.textContent += ev.text; break;
            case 'tool': status.textContent = 'Consultando ' + ev.text.replace(/^mcp__codemap__/, '') + '…'; break;
            case 'done': setSession(ev.session); status.textContent = 'Listo.'; break;
            case 'error': status.textContent = 'Error: ' + ev.text; break;
          }
        });
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
      } finally {
        send.disabled = false;
      }
    });
  }

  // readEvents reads one JSON event per line from a streamed body.
  async function readEvents(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  }

  // ---------- diagrams ----------
  for (const button of document.querySelectorAll('[data-diagram]')) {
    button.addEventListener('click', async () => {
      const status = document.getElementById('diagram-status');
      button.disabled = true;
      status.textContent = 'Generando diagrama…';
      try {
        const res = await postJSON('/api/diagram', { kind: button.dataset.diagram, from: button.dataset.from || '', target: button.dataset.target || '' });
        const body = await res.json();
        if (res.ok && body.view) {
          window.location.href = body.view;
          return;
        }
        status.textContent = body.error || 'No se pudo generar.';
        if (body.report) status.textContent += '\n' + body.report;
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
      } finally {
        button.disabled = false;
      }
    });
  }
})();
