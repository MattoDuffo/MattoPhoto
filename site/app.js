/* MattoPhoto: send photos and videos from an iPhone to a laptop, browser to browser.
 *
 * The laptop opens this page in "receive" mode and shows a QR code holding a
 * link with its pairing ID (#send=<id>). The iPhone opens that link in "send"
 * mode. PeerJS's public server is used only to set up the WebRTC connection;
 * the files travel directly between the two browsers.
 *
 * Protocol over one reliable, ordered data channel (strings are JSON, binary
 * frames are file chunks):
 *   phone  -> laptop  {t:'hello', device}
 *   laptop -> phone   {t:'status', folder, ready, mode}
 *   phone  -> laptop  {t:'offer', id, name, size, type, hash, force}
 *   laptop -> phone   {t:'answer', id, action:'send'|'skip'|'error', saveAs, reason}
 *   phone  -> laptop  <binary chunks...> then {t:'done', id}   (or {t:'cancel', id})
 *   laptop -> phone   {t:'saved', id, saveAs} | {t:'failed', id, reason}
 */
'use strict';
(() => {
  const CHUNK = 64 * 1024;              // data channel message size, safe across browsers
  const READ_BLOCK = 1024 * 1024;       // how much of a file to read from disk at a time
  const HIGH_WATER = 4 * 1024 * 1024;   // pause sending while this much is queued
  const STRIP_PIXELS = 4 * 1024 * 1024; // HEIC conversion works in strips this big (well under iOS canvas limits)
  const JPEG_QUALITY = 95;              // visually lossless, no chroma subsampling
  const LOG_LIMIT = 300;

  // ---------- small helpers ----------
  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  function randomHex(bytes) {
    const a = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function formatBytes(n) {
    if (!isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
  }

  function formatWhen(ts) {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function setStatus(node, text, kind) {
    node.textContent = text;
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  function peerOptions() {
    // ?peerServer=host:port points at a self-hosted PeerJS server (used for local testing).
    const custom = new URLSearchParams(location.search).get('peerServer');
    if (!custom) return { debug: 1 };
    const [host, port] = custom.split(':');
    return { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:', debug: 1 };
  }

  const isVideo = (type, name) => (type || '').startsWith('video/') || /\.(mov|mp4|m4v|avi|mkv|webm|3gp)$/i.test(name || '');
  const isJpeg = (type, name) => /^image\/jpe?g$/i.test(type || '') || /\.jpe?g$/i.test(name || '');

  function fileIcon(video) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.innerHTML = video
      ? '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/>'
      : '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>';
    return svg;
  }

  // A file row used on both sides.
  function fileRow({ name, meta, video, thumbUrl, extra }) {
    const thumb = el('div', { class: 'thumb' });
    if (thumbUrl) {
      const img = el('img', { src: thumbUrl, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => { img.remove(); thumb.append(fileIcon(video)); });
      thumb.append(img);
    } else {
      thumb.append(fileIcon(video));
    }
    const nameEl = el('div', { class: 'file-name', text: name, title: name });
    const metaEl = el('div', { class: 'file-meta' });
    const badge = el('span', { class: 'badge', hidden: true });
    const info = el('span', { class: 'badge', hidden: true });
    const bar = el('div', { class: 'bar', hidden: true }, el('span'));
    if (meta) metaEl.append(el('span', { text: meta }));
    metaEl.append(info, badge);
    const li = el('li', { class: 'file' }, thumb, el('div', { class: 'file-main' }, nameEl, metaEl, bar), extra || el('span'));
    return {
      li,
      setName(n) { nameEl.textContent = n; nameEl.title = n; },
      setBadge(text, kind) { badge.textContent = text; badge.className = 'badge' + (kind ? ' ' + kind : ''); badge.hidden = !text; },
      setInfo(text, kind, title) { info.textContent = text; info.className = 'badge' + (kind ? ' ' + kind : ''); info.hidden = !text; info.title = title || ''; },
      setProgress(frac) {
        if (frac == null) { bar.hidden = true; return; }
        bar.hidden = false;
        bar.firstChild.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
        bar.classList.toggle('done', frac >= 1);
      },
    };
  }

  function renderLog(listEl, emptyEl, entries) {
    listEl.replaceChildren(...entries.slice(0, 60).map((e) => el('li', {},
      el('span', { class: 'name', text: e.name, title: e.name }),
      el('span', { class: 'when', text: formatWhen(e.date) }))));
    emptyEl.hidden = entries.length > 0;
  }

  // History is a map of content key -> {name, size, date}. Shown newest first.
  function historyEntries(map) {
    return Object.values(map).sort((a, b) => b.date - a.date);
  }
  function addHistory(storageKey, hash, entry) {
    const map = load(storageKey, {});
    map[hash] = entry;
    const keys = Object.keys(map);
    if (keys.length > LOG_LIMIT) {
      keys.sort((a, b) => map[a].date - map[b].date).slice(0, keys.length - LOG_LIMIT).forEach((k) => delete map[k]);
    }
    save(storageKey, map);
    return map;
  }

  // ---------- IndexedDB (to remember the chosen folder) ----------
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('mattophoto', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch { return undefined; }
  }
  async function idbSet(key, value) {
    try {
      const db = await idb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* not fatal: the folder just won't be remembered */ }
  }

  // =====================================================================
  // Laptop: receive
  // =====================================================================
  const rx = {
    peer: null,
    id: null,
    folderSupported: 'showDirectoryPicker' in window,
    savedHandle: null,  // remembered folder (may still need permission)
    dir: null,          // folder we may write to right now
    senders: new Set(),
    retries: 0,
  };

  async function startReceiver() {
    $('#view-receive').hidden = false;
    $('#role').textContent = 'Receiving';
    $('#copy-link').addEventListener('click', copyLink);
    $('#retry').addEventListener('click', () => { rx.retries = 0; connectReceiver(rx.id); });
    $('#new-code').addEventListener('click', () => {
      if (rx.senders.size && !confirm('Your iPhone is connected. A new code disconnects it and the old link stops working. Continue?')) return;
      rx.retries = 0;
      connectReceiver(newPairingId());
    });
    $('#choose-folder').addEventListener('click', chooseFolder);
    $('#allow-folder').addEventListener('click', allowFolder);
    $('#rx-clear').addEventListener('click', () => {
      if (!confirm('Clear the transfer log? Files already saved stay where they are, but duplicates of them will no longer be detected from the log.')) return;
      save('mp.received', {});
      renderRxLog();
    });
    renderRxLog();
    await initFolder();
    connectReceiver(load('mp.receiverId', null) || newPairingId());
  }

  function newPairingId() { return 'mattophoto-' + randomHex(8); }

  function shareLink(id) {
    return location.origin + location.pathname + location.search + '#send=' + id;
  }

  function connectReceiver(id) {
    if (rx.peer) rx.peer.destroy();
    rx.id = id;
    const status = $('#pair-status');
    setStatus(status, 'Starting…', 'busy');
    $('#retry').hidden = true;
    $('#copy-link').disabled = true;
    $('#qr').replaceChildren(el('span', { class: 'qr-wait', text: 'Creating code…' }));

    const peer = rx.peer = new Peer(id, peerOptions());
    peer.on('open', (pid) => {
      if (peer !== rx.peer) return;
      rx.retries = 0;
      save('mp.receiverId', pid);
      renderQr(shareLink(pid));
      $('#copy-link').disabled = false;
      setStatus(status, 'Ready. Scan the code with your iPhone.', 'ok');
    });
    peer.on('connection', acceptSender);
    peer.on('disconnected', () => {
      if (peer !== rx.peer || peer.destroyed) return;
      setStatus(status, 'Lost the pairing server. Reconnecting…', 'warn');
      setTimeout(() => { if (peer === rx.peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (peer !== rx.peer) return;
      if (err.type === 'unavailable-id') {
        // Right after a reload the server can still hold our old session for a few seconds.
        if (rx.retries++ < 4) {
          setStatus(status, 'Waiting for the previous session to close…', 'busy');
          setTimeout(() => { if (peer === rx.peer) connectReceiver(id); }, 3000);
          return;
        }
        setStatus(status, 'This pairing code is in use. Is MattoPhoto open in another tab? Close it and press Retry, or make a new code.', 'err');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setStatus(status, "Can't reach the pairing server. Check the internet connection and press Retry.", 'err');
      } else if (err.type === 'browser-incompatible') {
        setStatus(status, "This browser can't make direct connections. Use Chrome or Edge.", 'err');
      } else {
        console.warn('PeerJS error', err);
        if (peer.open) return; // connection-level problems are handled per connection
        setStatus(status, 'Something went wrong: ' + err.message, 'err');
      }
      $('#retry').hidden = false;
    });
  }

  function renderQr(url) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('#qr').title = url;
  }

  async function copyLink() {
    const url = shareLink(rx.id);
    try {
      await navigator.clipboard.writeText(url);
      $('#copy-link').textContent = 'Copied';
      setTimeout(() => { $('#copy-link').textContent = 'Copy link'; }, 1500);
    } catch {
      prompt('Copy this link:', url);
    }
  }

  // ----- save folder -----
  async function initFolder() {
    if (rx.folderSupported) {
      rx.savedHandle = await idbGet('folder');
      if (rx.savedHandle) {
        try {
          if (await rx.savedHandle.queryPermission({ mode: 'readwrite' }) === 'granted') rx.dir = rx.savedHandle;
        } catch { rx.savedHandle = null; }
      }
    }
    renderFolder();
  }

  function folderReady() { return !rx.folderSupported || !!rx.dir; }

  function renderFolder() {
    const desc = $('#folder-desc');
    const choose = $('#choose-folder');
    const allow = $('#allow-folder');
    if (!rx.folderSupported) {
      desc.textContent = "Files go to your Downloads folder. (Open this page in Chrome or Edge to save straight into a folder you choose.) If the browser asks whether this site may download multiple files, choose Allow.";
      choose.hidden = allow.hidden = true;
    } else if (rx.dir) {
      desc.replaceChildren('Saving into ', el('strong', { text: rx.dir.name }), '. Files with the same name and size are skipped as duplicates.');
      choose.hidden = false; choose.textContent = 'Change folder'; allow.hidden = true;
    } else if (rx.savedHandle) {
      desc.replaceChildren('The browser needs your OK to keep saving into ', el('strong', { text: rx.savedHandle.name }), '.');
      allow.hidden = false; allow.textContent = 'Allow access to ' + rx.savedHandle.name;
      choose.hidden = false; choose.textContent = 'Choose another folder';
    } else {
      desc.textContent = 'Choose the folder on this computer where your photos should be saved.';
      choose.hidden = false; choose.textContent = 'Choose folder'; allow.hidden = true;
      choose.className = '';
      return;
    }
    choose.className = 'secondary';
  }

  async function chooseFolder() {
    try {
      const handle = await window.showDirectoryPicker({ id: 'mattophoto', mode: 'readwrite', startIn: 'pictures' });
      rx.savedHandle = rx.dir = handle;
      await idbSet('folder', handle);
    } catch (e) {
      if (e.name !== 'AbortError') alert("Couldn't use that folder: " + e.message);
    }
    renderFolder();
    broadcastStatus();
  }

  async function allowFolder() {
    try {
      if (await rx.savedHandle.requestPermission({ mode: 'readwrite' }) === 'granted') rx.dir = rx.savedHandle;
    } catch (e) { alert("Couldn't get access: " + e.message); }
    renderFolder();
    broadcastStatus();
  }

  function statusMessage() {
    return JSON.stringify({
      t: 'status',
      mode: rx.folderSupported ? 'folder' : 'downloads',
      folder: rx.dir ? rx.dir.name : null,
      ready: folderReady(),
    });
  }
  function broadcastStatus() {
    for (const s of rx.senders) if (s.conn.open) s.conn.send(statusMessage());
  }

  // ----- incoming connections -----
  function acceptSender(conn) {
    const s = { conn, device: 'iPhone', current: null, queue: Promise.resolve() };
    conn.on('open', () => {
      rx.senders.add(s);
      conn.send(statusMessage());
      renderDevices();
    });
    conn.on('data', (data) => {
      // Handle messages strictly in order; file writes are async.
      s.queue = s.queue.then(() => handleRx(s, data)).catch((e) => console.error(e));
    });
    const gone = () => {
      if (!rx.senders.delete(s)) return;
      s.queue = s.queue.then(() => abortCurrent(s, 'Connection lost'));
      renderDevices();
    };
    conn.on('close', gone);
    conn.on('error', (e) => { console.warn('Connection error', e); gone(); });
  }

  function renderDevices() {
    const chip = $('#device-chip');
    const n = rx.senders.size;
    chip.textContent = n === 0 ? 'No iPhone connected' : n === 1 ? [...rx.senders][0].device + ' connected' : n + ' devices connected';
    chip.className = 'chip' + (n ? ' ok' : '');
    if (rx.peer && rx.peer.open) {
      setStatus($('#pair-status'), n ? 'Connected. Send from your iPhone.' : 'Ready. Scan the code with your iPhone.', 'ok');
    }
  }

  function sendTo(s, msg) { if (s.conn.open) s.conn.send(JSON.stringify(msg)); }

  async function handleRx(s, data) {
    if (typeof data !== 'string') {
      const f = s.current;
      if (!f) return;
      const buf = data instanceof ArrayBuffer ? data : await new Blob([data]).arrayBuffer();
      if (f.writable) await f.writable.write(buf);
      else f.chunks.push(buf);
      f.received += buf.byteLength;
      const now = performance.now();
      if (now - f.lastPaint > 100) { f.lastPaint = now; f.row.setProgress(f.received / f.size); }
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'hello') { s.device = String(msg.device || 'iPhone').slice(0, 40); renderDevices(); }
    else if (msg.t === 'offer') await handleOffer(s, msg);
    else if (msg.t === 'done') await handleDone(s, msg);
    else if (msg.t === 'cancel') await abortCurrent(s, 'Stopped on iPhone');
  }

  function safeName(name) {
    let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
    if (!n) n = 'photo';
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
    if (n.length > 150) {
      const dot = n.lastIndexOf('.');
      const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
      n = n.slice(0, 150 - ext.length) + ext;
    }
    return n;
  }

  async function existingFile(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); }
    catch { return null; }
  }

  async function uniqueName(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 10000; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!(await existingFile(dir, candidate))) return candidate;
    }
    return `${base} (${randomHex(3)})${ext}`;
  }

  async function handleOffer(s, msg) {
    if (s.current) await abortCurrent(s, 'Interrupted');
    const id = String(msg.id);
    const size = Number(msg.size) || 0;
    let saveAs = safeName(msg.name);
    const hash = String(msg.hash || '');
    const answer = (action, extra) => sendTo(s, { t: 'answer', id, action, ...extra });

    if (!folderReady()) {
      answer('error', { reason: 'Choose a save folder on the laptop first.' });
      return;
    }
    const known = hash && load('mp.received', {})[hash];
    if (known && !msg.force) {
      answer('skip', { reason: 'Already received ' + formatWhen(known.date) });
      return;
    }

    let writable = null;
    try {
      if (rx.dir) {
        const existing = await existingFile(rx.dir, saveAs);
        if (existing) {
          if (existing.size === size && !msg.force) {
            if (hash) addHistory('mp.received', hash, { name: saveAs, size, date: Date.now() });
            renderRxLog();
            answer('skip', { reason: 'Already in the folder' });
            return;
          }
          saveAs = await uniqueName(rx.dir, saveAs);
        }
        const handle = await rx.dir.getFileHandle(saveAs, { create: true });
        writable = await handle.createWritable();
      }
    } catch (e) {
      console.error(e);
      const reason = e.name === 'NotAllowedError' ? 'The laptop lost access to the folder. Click "Allow access" on the laptop.' : "Laptop couldn't create the file: " + e.message;
      if (e.name === 'NotAllowedError') { rx.dir = null; renderFolder(); broadcastStatus(); }
      answer('error', { reason });
      return;
    }

    const row = fileRow({ name: saveAs, meta: formatBytes(size), video: isVideo(msg.type, saveAs) });
    row.setBadge('Receiving', 'busy');
    row.setProgress(0);
    $('#incoming').prepend(row.li);
    $('#incoming-empty').hidden = true;

    s.current = { id, saveAs, size, type: String(msg.type || ''), hash, writable, chunks: [], received: 0, row, lastPaint: 0 };
    answer('send', { saveAs });
  }

  async function handleDone(s, msg) {
    const f = s.current;
    if (!f || f.id !== String(msg.id)) return;
    s.current = null;
    try {
      if (f.received !== f.size) throw new Error(`Only ${formatBytes(f.received)} of ${formatBytes(f.size)} arrived`);
      if (f.writable) {
        await f.writable.close();
      } else {
        const blob = new Blob(f.chunks, { type: f.type || 'application/octet-stream' });
        f.chunks = [];
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: f.saveAs });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      f.row.setProgress(1);
      f.row.setBadge('Saved', 'ok');
      if (f.hash) addHistory('mp.received', f.hash, { name: f.saveAs, size: f.size, date: Date.now() });
      renderRxLog();
      sendTo(s, { t: 'saved', id: f.id, saveAs: f.saveAs });
    } catch (e) {
      console.error(e);
      await discard(f);
      f.row.setBadge('Failed', 'err');
      sendTo(s, { t: 'failed', id: f.id, reason: e.message });
    }
  }

  async function discard(f) {
    if (f.writable) {
      try { await f.writable.abort(); } catch { /* already closed */ }
      try { await rx.dir.removeEntry(f.saveAs); } catch { /* nothing to remove */ }
    }
    f.chunks = [];
  }

  async function abortCurrent(s, reason) {
    const f = s.current;
    if (!f) return;
    s.current = null;
    await discard(f);
    f.row.setBadge(reason, 'warn');
  }

  function renderRxLog() {
    renderLog($('#rx-log'), $('#rx-log-empty'), historyEntries(load('mp.received', {})));
  }

  // =====================================================================
  // iPhone: send
  // =====================================================================
  const tx = {
    target: null,
    peer: null,
    conn: null,
    waiters: [],
    items: [],
    sending: false,
    stopping: false,
    laptop: null,
    wakeLock: null,
  };

  function startSender(target) {
    tx.target = target;
    $('#view-send').hidden = false;
    $('#role').textContent = 'Sending';
    $('#reconnect').addEventListener('click', connectSender);
    $('#file-input').addEventListener('change', onPick);
    $('#send-btn').addEventListener('click', sendAll);
    $('#stop-btn').addEventListener('click', () => {
      tx.stopping = true;
      $('#stop-btn').disabled = true;
      $('#send-detail').textContent = 'Stopping…';
    });
    $('#select-all').addEventListener('click', () => {
      const pending = tx.items.filter((i) => !['sent', 'skipped', 'sending'].includes(i.status));
      const allOn = pending.every((i) => i.selected);
      for (const i of pending) setSelected(i, !allOn);
      updateSendBar();
    });
    $('#clear-list').addEventListener('click', clearList);
    $('#tx-clear').addEventListener('click', () => {
      if (!confirm('Forget which photos were sent from this iPhone? They will no longer be flagged as duplicates here. (The laptop still skips files it already has.)')) return;
      save('mp.sent', {});
      renderTxLog();
      for (const i of tx.items) if (i.sentBefore && i.status === 'ready') { i.sentBefore = null; i.row.setBadge(''); }
    });
    document.addEventListener('visibilitychange', () => {
      // iOS drops connections while Safari is in the background.
      if (document.visibilityState === 'visible' && !tx.sending && !(tx.conn && tx.conn.open)) connectSender();
      if (document.visibilityState === 'visible' && tx.sending) requestWakeLock();
    });
    renderTxLog();
    connectSender();
  }

  function connectSender() {
    const status = $('#tx-status');
    setStatus(status, 'Connecting to your laptop…', 'busy');
    $('#reconnect').hidden = true;
    if (tx.peer) tx.peer.destroy();
    tx.conn = null;
    updateSendBar();

    const peer = tx.peer = new Peer(peerOptions());
    const fail = (text) => {
      if (peer !== tx.peer) return;
      setStatus(status, text, 'err');
      $('#reconnect').hidden = false;
      $('#tx-dest').textContent = '';
      updateSendBar();
    };
    peer.on('open', () => {
      if (peer !== tx.peer) return;
      const conn = peer.connect(tx.target, { reliable: true, serialization: 'raw' });
      const timer = setTimeout(() => {
        if (!conn.open) { conn.close(); fail("Couldn't reach your laptop. Make sure MattoPhoto is open there, then tap Reconnect."); }
      }, 20000);
      conn.on('open', () => {
        clearTimeout(timer);
        if (peer !== tx.peer) return;
        tx.conn = conn;
        conn.send(JSON.stringify({ t: 'hello', device: deviceName() }));
        setStatus(status, 'Connected to your laptop', 'ok');
        updateSendBar();
      });
      conn.on('data', onTxData);
      conn.on('close', () => {
        clearTimeout(timer);
        if (tx.conn !== conn) return;
        tx.conn = null;
        rejectWaiters(new Error('Connection to the laptop was lost'));
        fail('Disconnected from your laptop.');
      });
      conn.on('error', (e) => console.warn('Connection error', e));
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') fail('Your laptop isn\'t ready. Open MattoPhoto on the laptop, then tap Reconnect.');
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) fail("Can't reach the pairing server. Check your internet connection.");
      else if (err.type === 'browser-incompatible') fail("This browser can't make direct connections.");
      else { console.warn('PeerJS error', err); if (!tx.conn) fail('Connection problem: ' + err.message); }
    });
    peer.on('disconnected', () => {
      // Losing the pairing server doesn't affect an open direct connection.
      if (peer === tx.peer && !peer.destroyed && !tx.conn) fail('Lost connection. Tap Reconnect.');
    });
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    return 'Device';
  }

  function onTxData(data) {
    if (typeof data !== 'string') return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'status') {
      tx.laptop = msg;
      const dest = $('#tx-dest');
      if (msg.mode === 'downloads') dest.textContent = "Saving to the laptop's Downloads folder";
      else if (msg.ready) dest.textContent = 'Saving to "' + msg.folder + '" on the laptop';
      else dest.textContent = 'Waiting: choose a save folder on the laptop';
      updateSendBar();
      return;
    }
    for (const w of [...tx.waiters]) {
      if (w.match(msg)) {
        tx.waiters.splice(tx.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
  }

  function waitFor(match, ms = 120000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      w.timer = setTimeout(() => {
        tx.waiters.splice(tx.waiters.indexOf(w), 1);
        reject(new Error('The laptop stopped responding'));
      }, ms);
      tx.waiters.push(w);
    });
  }

  function rejectWaiters(err) {
    const ws = tx.waiters.splice(0);
    for (const w of ws) { clearTimeout(w.timer); w.reject(err); }
  }

  // ----- picking files -----
  async function onPick(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    $('#queue-card').hidden = false;
    const sent = load('mp.sent', {});
    const fresh = files.map((file) => {
      const video = isVideo(file.type, file.name);
      const check = el('input', { type: 'checkbox', class: 'check', 'aria-label': 'Send ' + file.name });
      const thumbUrl = video ? null : URL.createObjectURL(file);
      const row = fileRow({ name: file.name, meta: formatBytes(file.size), video, thumbUrl, extra: check });
      const item = { file, video, thumbUrl, row, check, key: null, status: 'checking', selected: true, sentBefore: null, force: false };
      check.checked = true;
      check.disabled = true;
      check.addEventListener('change', () => { setSelected(item, check.checked); updateSendBar(); });
      row.setBadge('Checking…', 'busy');
      $('#outgoing').append(row.li);
      return item;
    });
    tx.items.push(...fresh);
    updateSendBar();
    for (const item of fresh) {
      try {
        item.key = await fileKey(item.file);
      } catch (err) {
        console.warn(err);
        item.key = 'nokey-' + randomHex(8);
      }
      if (item.status !== 'checking') continue; // removed meanwhile
      const md = describeMetadata(await readMetadata(item.file, item.file.type, item.file.name));
      if (md) item.row.setInfo(md.text, md.kind, md.title);
      if (item.status !== 'checking') continue;
      item.status = 'ready';
      item.check.disabled = false;
      const prev = sent[item.key] || tx.items.find((o) => o !== item && o.key === item.key && o.status !== 'removed');
      if (prev && prev.date) {
        item.sentBefore = prev;
        item.row.setBadge('Sent ' + formatWhen(prev.date), 'warn');
        setSelected(item, false);
      } else if (prev) {
        item.row.setBadge('Picked twice', 'warn');
        setSelected(item, false);
      } else {
        item.row.setBadge('');
      }
      updateSendBar();
    }
  }

  function setSelected(item, on) {
    item.selected = on;
    item.check.checked = on;
    // Ticking a photo that was sent before means "send it again anyway".
    item.force = on && !!item.sentBefore;
  }

  // A quick content fingerprint: size + first and last MB.
  async function fileKey(file) {
    const MB = 1024 * 1024;
    const parts = [new TextEncoder().encode(file.size + ':'), await file.slice(0, MB).arrayBuffer()];
    if (file.size > 2 * MB) parts.push(await file.slice(file.size - MB).arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
    return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function clearList() {
    if (tx.sending) return;
    for (const i of tx.items) { i.status = 'removed'; if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl); }
    tx.items = [];
    $('#outgoing').replaceChildren();
    $('#queue-card').hidden = true;
    updateSendBar();
  }

  function queued() {
    return tx.items.filter((i) => i.selected && (i.status === 'ready' || i.status === 'failed'));
  }

  function updateSendBar() {
    const bar = $('#sendbar');
    bar.hidden = tx.items.length === 0;
    if (tx.sending) return;
    const q = queued();
    const bytes = q.reduce((n, i) => n + i.file.size, 0);
    const connected = !!(tx.conn && tx.conn.open);
    const laptopReady = !tx.laptop || tx.laptop.ready;
    const checking = tx.items.some((i) => i.status === 'checking');
    $('#send-summary').textContent = q.length ? `${q.length} selected` : 'Nothing selected';
    $('#send-detail').textContent = !connected ? 'Not connected to the laptop'
      : !laptopReady ? 'Choose a save folder on the laptop first'
      : checking ? 'Checking for duplicates…'
      : q.length ? formatBytes(bytes) : 'Tick the photos you want to send';
    const btn = $('#send-btn');
    btn.textContent = q.length ? `Send ${q.length}` : 'Send';
    btn.disabled = !q.length || !connected || !laptopReady;
  }

  // ----- sending -----
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) tx.wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* not supported or refused */ }
  }

  async function sendAll() {
    const list = queued();
    if (!list.length || !tx.conn) return;
    tx.sending = true;
    tx.stopping = false;
    $('#send-btn').hidden = true;
    const stop = $('#stop-btn');
    stop.hidden = false;
    stop.disabled = false;
    $('#pick').classList.add('disabled');
    $('#clear-list').disabled = $('#select-all').disabled = true;
    for (const i of tx.items) i.check.disabled = true;
    await requestWakeLock();

    const total = list.reduce((n, i) => n + i.file.size, 0);
    const overall = $('#overall-bar');
    overall.hidden = false;
    let doneBytes = 0;
    let ok = 0, skipped = 0, failed = 0;
    const started = performance.now();
    let sentBytes = 0;

    const paint = (current) => {
      const frac = total ? (doneBytes + current) / total : 1;
      overall.firstChild.style.width = Math.min(1, frac) * 100 + '%';
      const secs = (performance.now() - started) / 1000;
      const rate = secs > 1 ? (sentBytes + current) / secs : 0;
      $('#send-detail').textContent = `${formatBytes(doneBytes + current)} of ${formatBytes(total)}` + (rate ? ` · ${formatBytes(rate)}/s` : '');
    };

    for (let n = 0; n < list.length; n++) {
      const item = list[n];
      if (tx.stopping || !tx.conn) break;
      $('#send-summary').textContent = `Sending ${n + 1} of ${list.length}`;
      try {
        const result = await sendOne(item, (bytes) => paint(bytes));
        if (result === 'skipped') skipped++;
        else { ok++; sentBytes += item.file.size; }
      } catch (e) {
        failed++;
        item.status = 'failed';
        item.row.setProgress(null);
        item.row.setBadge(e.message === 'Stopped' ? 'Stopped' : 'Failed: ' + e.message, e.message === 'Stopped' ? 'warn' : 'err');
        console.error(e);
      }
      doneBytes += item.file.size;
      paint(0);
    }

    try { await tx.wakeLock?.release(); } catch { /* ignore */ }
    tx.wakeLock = null;
    tx.sending = false;
    overall.hidden = true;
    stop.hidden = true;
    $('#send-btn').hidden = false;
    $('#pick').classList.remove('disabled');
    $('#clear-list').disabled = $('#select-all').disabled = false;
    for (const i of tx.items) i.check.disabled = !(i.status === 'ready' || i.status === 'failed');
    renderTxLog();
    updateSendBar();
    const parts = [];
    if (ok) parts.push(`${ok} sent`);
    if (skipped) parts.push(`${skipped} already on laptop`);
    if (failed) parts.push(`${failed} not sent`);
    $('#send-summary').textContent = parts.join(' · ') || 'Done';
  }

  async function sendOne(item, onBytes) {
    const conn = tx.conn;
    if (!conn) throw new Error('Not connected');
    item.status = 'sending';
    item.row.setBadge('Preparing…', 'busy');
    const p = await prepare(item.file, (frac) => item.row.setBadge(`Converting to JPEG ${Math.round(frac * 100)}%`, 'busy'));
    if (p.name !== item.file.name) item.row.setName(p.name);
    const id = randomHex(8);
    conn.send(JSON.stringify({ t: 'offer', id, name: p.name, size: p.blob.size, type: p.type, hash: item.key, force: item.force }));
    const answer = await waitFor((m) => m.t === 'answer' && m.id === id);

    const markDone = (label) => {
      item.status = label === 'skipped' ? 'skipped' : 'sent';
      item.selected = false;
      item.check.checked = false;
      addHistory('mp.sent', item.key, { name: p.name, size: item.file.size, date: Date.now() });
    };

    if (answer.action === 'skip') {
      markDone('skipped');
      item.row.setProgress(null);
      item.row.setBadge(answer.reason || 'Already on laptop', 'ok');
      return 'skipped';
    }
    if (answer.action !== 'send') throw new Error(answer.reason || 'Laptop refused the file');

    item.row.setBadge(p.note ? 'Sending · ' + p.note : 'Sending', 'busy');
    item.row.setProgress(0);
    const size = p.blob.size;
    let offset = 0;
    let lastPaint = 0;
    while (offset < size) {
      const block = await p.blob.slice(offset, Math.min(offset + READ_BLOCK, size)).arrayBuffer();
      for (let i = 0; i < block.byteLength; i += CHUNK) {
        if (tx.stopping) {
          if (tx.conn === conn) conn.send(JSON.stringify({ t: 'cancel', id }));
          throw new Error('Stopped');
        }
        await drain(conn);
        conn.send(block.slice(i, Math.min(i + CHUNK, block.byteLength)));
      }
      offset += block.byteLength;
      const now = performance.now();
      if (now - lastPaint > 120 || offset >= size) {
        lastPaint = now;
        item.row.setProgress(offset / size);
        onBytes(Math.round((offset / size) * item.file.size));
      }
    }
    conn.send(JSON.stringify({ t: 'done', id }));
    const result = await waitFor((m) => (m.t === 'saved' || m.t === 'failed') && m.id === id);
    if (result.t === 'failed') throw new Error(result.reason || 'Laptop could not save it');
    markDone('sent');
    item.row.setProgress(1);
    const label = result.saveAs && result.saveAs !== p.name ? 'Saved as ' + result.saveAs : 'Saved';
    item.row.setBadge(label + (p.note ? ' · ' + p.note : ''), p.note && p.type !== 'image/jpeg' ? 'warn' : 'ok');
    return 'sent';
  }

  // Wait until the data channel has room, so a big video isn't queued in memory all at once.
  function drain(conn) {
    const queuedBytes = () => (conn.dataChannel ? conn.dataChannel.bufferedAmount : 0) + (conn.bufferSize || 0) * CHUNK;
    if (queuedBytes() < HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        if (tx.conn !== conn || !conn.open) { clearInterval(iv); reject(new Error('Connection to the laptop was lost')); }
        else if (queuedBytes() < HIGH_WATER / 2) { clearInterval(iv); resolve(); }
      }, 15);
    });
  }

  // ----- metadata & HEIC conversion -----
  // Only Apple's HEIC/HEIF photos are converted. Everything else (JPEG, PNG,
  // videos, …) is sent byte for byte, so its metadata stays exactly as it was.
  // HEIC photos are re-encoded as full-resolution JPEG (quality 95, no chroma
  // subsampling) and their Exif and XMP metadata are copied across: date and
  // time, location, camera and lens details. The conversion runs in strips so
  // 24 and 48 MP photos fit within iPhone memory and canvas limits.

  const isHeic = (type, name) => /^image\/hei[cf](-sequence)?$/i.test(type || '') || /\.(heic|heif|hif)$/i.test(name || '');
  const isPng = (type, name) => /^image\/png$/i.test(type || '') || /\.png$/i.test(name || '');

  const bytes = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  function indexOfBytes(hay, needle) {
    const first = needle[0];
    outer: for (let i = hay.indexOf(first); i !== -1 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
      for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  // ISO base media boxes (HEIC, MOV, MP4) inside a byte array.
  function boxesIn(b, start, end) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const list = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      list.push({ type: fourcc(b, p + 4), start: p + hdr, end: p + size });
      p += size;
    }
    return list;
  }

  // Top-level boxes of a file, reading only their headers.
  async function topBoxes(file) {
    const list = [];
    let p = 0;
    while (p + 8 <= file.size && list.length < 100) {
      const h = await bytes(file, p, p + 16);
      const dv = new DataView(h.buffer);
      let size = dv.getUint32(0);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = file.size - p;
      if (size < hdr) break;
      list.push({ type: fourcc(h, 4), start: p + hdr, end: Math.min(p + size, file.size) });
      p += size;
    }
    return list;
  }

  // Pull the Exif (TIFF) and XMP blocks out of a HEIC file.
  async function heicMetadata(file) {
    const meta = (await topBoxes(file)).find((b) => b.type === 'meta');
    if (!meta || meta.end - meta.start > 32 * 1024 * 1024) return {};
    const m = await bytes(file, meta.start, meta.end);
    const dv = new DataView(m.buffer);
    const kids = boxesIn(m, 4, m.length); // 'meta' is a full box: skip version/flags
    const items = [];
    const iinf = kids.find((k) => k.type === 'iinf');
    if (iinf) {
      const first = iinf.start + 4 + (m[iinf.start] === 0 ? 2 : 4);
      for (const infe of boxesIn(m, first, iinf.end)) {
        const v = m[infe.start];
        if (infe.type !== 'infe' || v < 2) continue;
        let q = infe.start + 4;
        const id = v === 2 ? dv.getUint16(q) : dv.getUint32(q);
        q += (v === 2 ? 2 : 4) + 2;
        const type = fourcc(m, q);
        q += 4;
        let mime = '';
        if (type === 'mime') {
          while (q < infe.end && m[q]) q++; // item_name
          const s = ++q;
          while (q < infe.end && m[q]) q++;
          mime = new TextDecoder().decode(m.subarray(s, q));
        }
        items.push({ id, type, mime });
      }
    }
    const locs = {};
    const iloc = kids.find((k) => k.type === 'iloc');
    const idat = kids.find((k) => k.type === 'idat');
    if (iloc) {
      const v = m[iloc.start];
      let q = iloc.start + 4;
      const read = (n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + m[q + i]; q += n; return x; };
      const offSize = m[q] >> 4, lenSize = m[q] & 15, baseSize = m[q + 1] >> 4;
      const idxSize = v === 1 || v === 2 ? m[q + 1] & 15 : 0;
      q += 2;
      const count = read(v < 2 ? 2 : 4);
      for (let i = 0; i < count && q < iloc.end; i++) {
        const id = read(v < 2 ? 2 : 4);
        const method = v === 1 || v === 2 ? read(2) & 15 : 0;
        read(2); // data_reference_index
        const base = read(baseSize);
        const extents = [];
        for (let n = read(2); n > 0; n--) {
          if (idxSize) read(idxSize);
          const off = read(offSize);
          extents.push([base + off, read(lenSize)]);
        }
        locs[id] = { method, extents };
      }
    }
    const readItem = async (id) => {
      const loc = locs[id];
      if (!loc) return null;
      const parts = [];
      for (const [off, len] of loc.extents) {
        if (loc.method === 0) parts.push(await bytes(file, off, len ? off + len : file.size));
        else if (loc.method === 1 && idat) parts.push(m.slice(idat.start + off, idat.start + off + len));
        else return null;
      }
      return parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts).arrayBuffer());
    };
    let exif = null, xmp = null;
    for (const it of items) {
      if (it.type === 'Exif' && !exif) {
        const d = await readItem(it.id);
        if (d && d.length > 8) {
          exif = d.subarray(4 + new DataView(d.buffer, d.byteOffset).getUint32(0));
          if (fourcc(exif, 0) === 'Exif') exif = exif.subarray(6);
        }
      } else if (it.type === 'mime' && /rdf\+xml|xmp/i.test(it.mime) && !xmp) {
        xmp = await readItem(it.id);
      }
    }
    return { exif, xmp };
  }

  // Read the parts of a TIFF/Exif block we care about.
  function tiffInfo(t) {
    if (!t || t.length < 8) return null;
    const le = t[0] === 0x49 && t[1] === 0x49;
    if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
    const ifd = (o) => {
      const tags = {};
      if (!o || o + 2 > t.length) return tags;
      const n = u16(o);
      for (let i = 0; i < n; i++) {
        const e = o + 2 + i * 12;
        if (e + 12 > t.length) break;
        tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), value: e + 8 };
      }
      return tags;
    };
    const ascii = (tag) => {
      if (!tag || tag.type !== 2) return null;
      const off = tag.count <= 4 ? tag.value : u32(tag.value);
      if (off + tag.count > t.length) return null;
      return new TextDecoder().decode(t.subarray(off, off + tag.count)).replace(/\0[\s\S]*$/, '').trim() || null;
    };
    const ifd0 = ifd(u32(4));
    const exifIfd = ifd0[0x8769] ? ifd(u32(ifd0[0x8769].value)) : {};
    const gpsIfd = ifd0[0x8825] ? ifd(u32(ifd0[0x8825].value)) : {};
    return {
      le, dv, ifd0, exifIfd,
      date: ascii(exifIfd[0x9003]) || ascii(exifIfd[0x9004]) || ascii(ifd0[0x0132]),
      gps: !!(gpsIfd[0x0002] && gpsIfd[0x0004]),
    };
  }

  async function jpegExif(blob) {
    const b = await bytes(blob, 0, Math.min(blob.size, 512 * 1024));
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      const marker = b[p + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      if (marker === 0xe1 && fourcc(b, p + 4) === 'Exif') return b.subarray(p + 10, Math.min(b.length, p + 2 + len));
      p += 2 + len;
    }
    return null;
  }

  async function pngExif(blob) {
    const b = await bytes(blob, 0, Math.min(blob.size, 4 * 1024 * 1024));
    const dv = new DataView(b.buffer);
    for (let p = 8; p + 8 <= b.length;) {
      const len = dv.getUint32(p);
      const type = fourcc(b, p + 4);
      if (type === 'eXIf') return b.subarray(p + 8, p + 8 + len);
      if (type === 'IEND') break;
      p += 12 + len;
    }
    return null;
  }

  async function videoMetadata(file) {
    const moov = (await topBoxes(file)).find((b) => b.type === 'moov');
    if (!moov || moov.end - moov.start > 32 * 1024 * 1024) return null;
    const m = await bytes(file, moov.start, moov.end);
    const mvhd = boxesIn(m, 0, m.length).find((b) => b.type === 'mvhd');
    let created = false;
    if (mvhd) {
      const dv = new DataView(m.buffer);
      created = m[mvhd.start] === 1 ? dv.getBigUint64(mvhd.start + 4) > 0n : dv.getUint32(mvhd.start + 4) > 0;
    }
    return {
      date: created || indexOfBytes(m, latin1('com.apple.quicktime.creationdate')) >= 0,
      gps: indexOfBytes(m, latin1('com.apple.quicktime.location.ISO6709')) >= 0 || indexOfBytes(m, latin1('©xyz')) >= 0,
    };
  }

  // What metadata a file carries: {date, gps}, or null if we can't tell.
  async function readMetadata(file, type, name) {
    try {
      if (isVideo(type, name)) return await videoMetadata(file);
      let tiff = null;
      if (isHeic(type, name)) tiff = (await heicMetadata(file)).exif;
      else if (isJpeg(type, name)) tiff = await jpegExif(file);
      else if (isPng(type, name)) tiff = await pngExif(file);
      else return null;
      const info = tiffInfo(tiff);
      return { date: !!(info && info.date), gps: !!(info && info.gps) };
    } catch (e) {
      console.warn('Could not read metadata', e);
      return null;
    }
  }

  function describeMetadata(md) {
    if (!md) return null;
    if (md.date && md.gps) return { text: 'Date · Location', kind: 'ok', title: 'Has the date taken and location' };
    if (md.date) return { text: 'Date · no location', kind: 'warn', title: 'Has the date taken, but no location was in the file' };
    if (md.gps) return { text: 'Location · no date', kind: 'warn', title: 'Has a location, but no date taken was in the file' };
    return { text: 'No date or location', kind: 'warn', title: 'No date taken or location was in the file' };
  }

  function app1(header, body) {
    const len = 2 + header.length + body.length;
    if (len > 0xffff) throw new Error('Metadata block too large for JPEG');
    const seg = new Uint8Array(2 + len);
    seg.set([0xff, 0xe1, len >> 8, len & 0xff]);
    seg.set(header, 4);
    seg.set(body, 4 + header.length);
    return seg;
  }

  // The JPEG's pixels are written already upright, so Orientation becomes 1.
  function exifForJpeg(tiff, width, height) {
    const t = tiff.slice();
    const info = tiffInfo(t);
    if (!info) return null;
    const set = (tag, v) => {
      if (!tag) return;
      if (tag.type === 3) info.dv.setUint16(tag.value, v, info.le);
      else if (tag.type === 4) info.dv.setUint32(tag.value, v, info.le);
    };
    set(info.ifd0[0x0112], 1);
    set(info.exifIfd[0xa002], width);
    set(info.exifIfd[0xa003], height);
    return t;
  }

  function xmpForJpeg(xmp) {
    const s = new TextDecoder().decode(xmp)
      .replace(/tiff:Orientation="\d"/g, 'tiff:Orientation="1"')
      .replace(/<tiff:Orientation>\d<\/tiff:Orientation>/g, '<tiff:Orientation>1</tiff:Orientation>');
    return new TextEncoder().encode(s);
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        const bmp = await createImageBitmap(file);
        return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
      } catch { /* fall back to <img> */ }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  }

  async function heicToJpeg(file, onProgress) {
    const meta = await heicMetadata(file);
    const img = await decodeImage(file);
    try {
      const { width: W, height: H } = img;
      if (!W || !H) throw new Error('Could not read the image');
      const segments = [];
      if (meta.exif) {
        const exif = exifForJpeg(meta.exif, W, H);
        if (!exif) throw new Error('Unreadable Exif metadata');
        segments.push(app1(latin1('Exif\0\0'), exif));
      }
      if (meta.xmp) segments.push(app1(latin1('http://ns.adobe.com/xap/1.0/\0'), xmpForJpeg(meta.xmp)));

      const rows = Math.max(8, Math.floor(STRIP_PIXELS / W / 8) * 8);
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = Math.min(rows, H);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const enc = new window.MattoJpegEncoder(JPEG_QUALITY);
      enc.begin(W, H, segments);
      const parts = [];
      for (let y = 0; y < H; y += rows) {
        const h = Math.min(rows, H - y);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, canvas.height);
        ctx.drawImage(img.source, 0, y, W, h, 0, 0, W, h);
        enc.addStrip(ctx.getImageData(0, 0, W, h).data, h);
        parts.push(...enc.take());
        if (onProgress) onProgress((y + h) / H);
        await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      }
      parts.push(...enc.finish());
      canvas.width = canvas.height = 0; // free memory right away on iOS
      return new Blob(parts, { type: 'image/jpeg' });
    } finally {
      img.done();
    }
  }

  async function prepare(file, onProgress) {
    const name = file.name || 'photo';
    const type = file.type || '';
    const original = { blob: file, name, type: type || 'application/octet-stream' };
    if (!isHeic(type, name)) return original;
    try {
      const blob = await heicToJpeg(file, onProgress);
      // Never trade metadata for the conversion: check it all made it across.
      const before = await readMetadata(file, type, name);
      const after = await readMetadata(blob, 'image/jpeg', 'x.jpg');
      if (before && (!after || (before.date && !after.date) || (before.gps && !after.gps))) {
        throw new Error('Metadata did not carry over');
      }
      const dot = name.lastIndexOf('.');
      return { blob, name: (dot > 0 ? name.slice(0, dot) : name) + '.jpg', type: 'image/jpeg', note: 'converted to JPEG' };
    } catch (e) {
      console.warn('HEIC conversion failed, sending the original', e);
      return { ...original, note: "couldn't convert, sent as HEIC" };
    }
  }

  function renderTxLog() {
    renderLog($('#tx-log'), $('#tx-log-empty'), historyEntries(load('mp.sent', {})));
  }

  // =====================================================================
  // Start
  // =====================================================================
  function startHelp() {
    $('#view-help').hidden = false;
    $('#help-url').textContent = location.host + location.pathname;
    $('#receive-here').addEventListener('click', () => {
      $('#view-help').hidden = true;
      startReceiver();
    });
  }

  function main() {
    if (typeof Peer === 'undefined' || typeof qrcode === 'undefined') {
      document.querySelector('main').prepend(el('div', { class: 'card', text: "MattoPhoto couldn't load. Refresh the page." }));
      return;
    }
    const match = location.hash.match(/send=([A-Za-z0-9_-]+)/);
    const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    if (match) startSender(match[1]);
    else if (mobile) startHelp();
    else startReceiver();
  }

  main();
})();
