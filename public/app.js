import {
  h, clear, api, ApiError, session, setUnauthorizedHandler, setLocale,
  fmtTime, timeParts, fmtDay, fmtDayLong, fmtDate, dayKey, money, plural,
  addDaysKey, weekdayShort, dayNum, zonedToIso, isoToLocalParts, tz,
} from './lib.js';

const $app = document.getElementById('app');
const $layer = document.getElementById('layer');
const $toasts = document.getElementById('toasts');

const state = { config: null, user: null, route: null, refresh: null, drawer: null, notes: { unread: 0, items: [] }, lastNoteId: 0 };
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// ───────────────────────── toasts, busy buttons ─────────────────────────
function toast(message, kind = 'ok', ms = 4200) {
  const t = h('div', { class: `toast ${kind === 'bad' ? 'bad' : ''}` }, message);
  $toasts.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}
const errText = (e) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** Runs an async action with a spinner on the button; shows errors as a toast unless `onError` handles them. */
async function busy(btn, fn, onError) {
  if (btn) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
  try { return await fn(); }
  catch (e) {
    if (e?.handled) return undefined; // expired session: already handled globally
    if (onError) onError(e); else toast(errText(e), 'bad', 6000);
    return undefined;
  } finally { if (btn) { btn.removeAttribute('aria-busy'); btn.disabled = false; } }
}

// ───────────────────────── layers: dialog, drawer ─────────────────────────
let layerStack = [];
function openLayer(node, { kind, onClose, label }) {
  const opener = document.activeElement;
  const scrim = h('div', { class: 'scrim', onclick: () => close() });
  node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', label || '');
  const entry = { node, scrim, kind, close };
  function close(result) {
    if (!layerStack.includes(entry)) return;
    layerStack = layerStack.filter((l) => l !== entry);
    scrim.remove(); node.remove(); document.removeEventListener('keydown', onKey, true);
    if (state.drawer === entry) state.drawer = null;
    opener?.focus?.();
    onClose?.(result);
  }
  function onKey(e) {
    if (layerStack[layerStack.length - 1] !== entry) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const f = [...node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  layerStack.push(entry);
  $layer.append(scrim, node);
  queueMicrotask(() => (node.querySelector('[autofocus]') || node.querySelector('button, input, select, textarea'))?.focus());
  return entry;
}
const anyLayerOpen = () => layerStack.length > 0;

function confirmDialog({ title, body, confirmLabel, cancelLabel = 'Keep it', danger = false }) {
  return new Promise((resolve) => {
    let entry;
    const yes = h('button', { class: `btn ${danger ? 'solid-danger' : ''}`, onclick: () => entry.close(true) }, confirmLabel);
    const node = h('div', { class: 'dialog' },
      h('h2', null, title), h('p', { class: 'muted' }, body),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => entry.close(false) }, cancelLabel), yes));
    entry = openLayer(node, { kind: 'dialog', label: title, onClose: (r) => resolve(r === true) });
  });
}

function openDrawer(build, { label }) {
  state.drawer?.close();
  const body = h('div');
  const node = h('aside', { class: 'drawer' }, h('button', { class: 'icon-btn x', 'aria-label': 'Close', onclick: () => entry.close() }, '✕'), body);
  const entry = openLayer(node, { kind: 'drawer', label });
  entry.body = body; entry.dirty = false;
  state.drawer = entry;
  entry.render = async () => { try { const content = await build(entry); if (!layerStack.includes(entry)) return; clear(body).append(content); } catch (e) { clear(body).append(h('p', { class: 'form-error' }, errText(e))); } };
  entry.render();
  return entry;
}

// ───────────────────────── seat pips (the signature element) ─────────────────────────
const seenBooked = new Map();
function seatPips(c, { big = false } = {}) {
  const prev = seenBooked.get(c.id);
  const popFrom = prev !== undefined && c.booked > prev ? prev : null;
  queueMicrotask(() => seenBooked.set(c.id, c.booked));

  const label = `${c.booked} of ${c.capacity} places taken${c.waitlistCount ? `, ${c.waitlistCount} waiting` : ''}`;
  if (c.capacity > 30) {
    return h('div', { role: 'img', 'aria-label': label }, h('div', { class: 'bar-seats' }, h('i', { style: `width:${Math.min(100, (c.booked / c.capacity) * 100)}%` })));
  }
  const holding = ['booked', 'attended', 'absent'].includes(c.my?.status);
  const wrap = h('div', { class: `pips ${big ? 'big' : ''}`, role: 'img', 'aria-label': label });
  for (let i = 0; i < c.capacity; i += 1) {
    const taken = i < c.booked;
    const mine = holding && i === c.booked - 1;
    wrap.append(h('span', { class: `pip ${taken ? 'taken' : ''} ${mine ? 'mine' : ''} ${popFrom !== null && i >= popFrom && taken ? 'pop' : ''}` }));
  }
  if (c.waitlistCount > 0) {
    const q = h('span', { class: 'queue', 'aria-hidden': 'true' });
    const shown = Math.min(c.waitlistCount, 8);
    for (let i = 1; i <= shown; i += 1) q.append(h('span', { class: `diamond ${c.my?.status === 'waitlisted' && c.my.position === i ? 'mine' : ''}` }));
    if (c.waitlistCount > shown) q.append(h('span', { class: 'more' }, `+${c.waitlistCount - shown}`));
    wrap.append(q);
  }
  return wrap;
}

function seatsLine(c) {
  const my = c.my;
  if (c.state === 'cancelled') return h('span', { class: 'k-status' }, 'Cancelled');
  if (my?.status === 'waitlisted') return h('span', { class: 'k-status mine' }, `You are ${ordinal(my.position)} of ${c.waitlistCount} on the waitlist`);
  if (my?.status === 'booked') return h('span', { class: 'k-status mine' }, 'Your place is held');
  if (my?.status === 'attended') return h('span', { class: 'k-status mine' }, 'You attended');
  if (my?.status === 'absent') return h('span', { class: 'k-status' }, 'Marked absent');
  if (c.state === 'full' || (c.seatsLeft === 0 && c.state === 'closed')) {
    return h('span', { class: 'k-status' }, h('b', null, 'Full'), c.waitlistCount ? ` · ${c.waitlistCount} waiting` : '');
  }
  return h('span', { class: 'k-status' }, h('b', null, plural(c.seatsLeft, 'place')), ' left', c.waitlistCount ? ` · ${c.waitlistCount} waiting` : '');
}

// ───────────────────────── booking actions (shared by row and drawer) ─────────────────────────
async function reserve(c, btn, done) {
  const r = await busy(btn, () => api(`/classes/${c.id}/book`, { method: 'POST' }));
  if (!r) { done?.(); return; }
  if (r.status === 'booked') toast(`Reserved. ${c.title} at ${fmtTime(c.startsAt)}.`);
  else toast(`${c.title} is full. You are ${ordinal(r.position)} on the waitlist and will be moved in automatically.`);
  done?.();
}
async function release(c, btn, done) {
  const waiting = c.my?.status === 'waitlisted';
  const ok = await confirmDialog(waiting
    ? { title: 'Leave the waitlist?', body: `You will lose your spot in the queue for ${c.title}. Joining again puts you at the back.`, confirmLabel: 'Leave waitlist' }
    : { title: 'Release your place?', body: `${c.title} on ${fmtDay(c.startsAt)} at ${fmtTime(c.startsAt)}. ${c.waitlistCount ? 'The first person on the waitlist is moved in straight away.' : 'It becomes available to other members.'}`, confirmLabel: 'Release place', danger: true });
  if (!ok) return;
  const r = await busy(btn, () => api(`/classes/${c.id}/book`, { method: 'DELETE' }));
  if (r) toast(waiting ? 'You left the waitlist.' : r.promoted?.length ? 'Place released. The first person in line has been moved in.' : 'Place released.');
  done?.();
}

function memberAction(c, done) {
  const my = c.my;
  const hint = (t) => h('span', { class: 'hint' }, t);
  if (c.state === 'cancelled') return [];
  if (my && ['booked'].includes(my.status)) {
    if (c.state === 'open' || c.state === 'full') {
      const b = h('button', { class: 'btn ghost', onclick: () => release(c, b, done) }, 'Cancel place');
      return [b, hint(`Free to cancel until ${fmtTime(c.cutoffAt)}`)];
    }
    return [hint(c.state === 'closed' ? 'Cancellation closed' : '')];
  }
  if (my?.status === 'waitlisted') {
    if (['open', 'full', 'closed'].includes(c.state)) {
      const b = h('button', { class: 'btn ghost', onclick: () => release(c, b, done) }, 'Leave waitlist');
      return [b];
    }
    return [];
  }
  if (my) return [];
  if (c.state === 'open') { const b = h('button', { class: 'btn', onclick: () => reserve(c, b, done) }, 'Reserve'); return [b]; }
  if (c.state === 'full') { const b = h('button', { class: 'btn brass', onclick: () => reserve(c, b, done) }, 'Join waitlist'); return [b, hint('Moved in automatically')]; }
  if (c.state === 'closed') return [h('button', { class: 'btn ghost', disabled: true }, 'Booking closed'), hint(`Closed at ${fmtTime(c.cutoffAt)}`)];
  if (c.state === 'in_progress') return [hint('In progress')];
  return [];
}

// ───────────────────────── class row ─────────────────────────
function classRow(c, { done, showDay = false } = {}) {
  const t = timeParts(c.startsAt);
  const role = state.user.role;
  let actions;
  if (role === 'member') actions = memberAction(c, done);
  else {
    const started = ['in_progress', 'finished'].includes(c.state);
    const label = role === 'trainer' && c.trainer.id === state.user.id && started ? 'Mark attendance' : 'Roster';
    actions = c.state === 'cancelled' ? [] : [h('button', { class: 'btn ghost', onclick: () => openClassDrawer(c.id, done) }, label)];
  }
  return h('article', { class: `klass ${c.state === 'cancelled' ? 'cancelled' : ''}`, 'data-class-id': c.id },
    h('div', null, h('div', { class: 'when' }, t.clock, h('small', null, t.meridiem)),
      h('div', { class: 'when-sub' }, showDay ? `${fmtDay(c.startsAt)} · ` : '', `${c.durationMin} min`)),
    h('div', { class: 'k-main' },
      h('h3', { class: 'k-title' }, h('button', { onclick: () => openClassDrawer(c.id, done) }, c.title)),
      h('p', { class: 'k-meta' }, `${c.trainer.name}, ${c.category}`),
      h('div', { class: 'k-seats' }, seatPips(c), seatsLine(c))),
    h('div', { class: 'k-act' }, actions));
}

// ───────────────────────── class drawer (detail, roster, attendance, admin tools) ─────────────────────────
function openClassDrawer(classId, onChange) {
  const isStaff = state.user.role !== 'member';
  return openDrawer(async (entry) => {
    const { class: c } = await api(`/classes/${classId}`);
    let roster = null, rosterDenied = false;
    if (isStaff) { try { roster = await api(`/classes/${classId}/roster`); } catch (e) { if (e.status === 403) rosterDenied = true; else throw e; } }
    const refreshAll = () => { entry.dirty = false; entry.render(); onChange?.(); };
    const t = timeParts(c.startsAt);

    const root = h('div', null,
      h('p', { class: 'muted' }, `${fmtDayLong(c.startsAt)}, ${t.clock} ${t.meridiem}, ${c.durationMin} minutes`),
      h('h2', null, c.title),
      h('p', { class: 'muted', style: 'margin-top:6px' }, `${c.trainer.name}, ${c.category}`),
      c.description ? h('p', { style: 'margin-top:16px;max-width:52ch' }, c.description) : null,
      h('div', { class: 'block' }, seatPips(c, { big: true }), h('p', { style: 'margin-top:12px' }, seatsLine(c)),
        h('p', { class: 'muted small', style: 'margin-top:4px' }, ['open', 'full', 'closed'].includes(c.state) ? `${c.capacity} places. Booking and cancelling close at ${fmtTime(c.cutoffAt)}.` : `${c.capacity} places.`)));

    if (state.user.role === 'member') {
      const acts = memberAction(c, refreshAll);
      if (acts.length) root.append(h('div', { class: 'block cluster' }, acts));
    }

    if (isStaff) {
      if (rosterDenied) {
        root.append(h('div', { class: 'block' }, h('p', { class: 'muted' }, 'The roster is visible to the trainer leading this class and to the front desk.')));
      } else {
        const started = ['in_progress', 'finished'].includes(c.state);
        const canMark = started && c.state !== 'cancelled' && (state.user.role === 'admin' || c.trainer.id === state.user.id);
        root.append(attendeeBlock(c, roster, { canMark, entry, refreshAll }), waitlistBlock(c, roster, refreshAll));
      }
      if (state.user.role === 'admin' && c.state !== 'cancelled' && c.state !== 'finished' && c.state !== 'in_progress') {
        const edit = h('button', { class: 'btn ghost', onclick: () => classForm(c, refreshAll) }, 'Edit class');
        const cancel = h('button', { class: 'btn danger', onclick: async () => {
          const ok = await confirmDialog({ title: 'Cancel this class?', body: `${plural(c.booked + c.waitlistCount, 'member')} will be released and notified. This cannot be undone.`, confirmLabel: 'Cancel class', cancelLabel: 'Keep class', danger: true });
          if (!ok) return;
          const r = await busy(cancel, () => api(`/classes/${c.id}/cancel`, { method: 'POST' }));
          if (r) { toast(`Class cancelled. ${plural(r.released, 'member')} notified.`); entry.close(); onChange?.(); }
        } }, 'Cancel class');
        root.append(h('div', { class: 'block cluster' }, edit, cancel));
      }
    }
    return root;
  }, { label: 'Class details' });
}

function attendeeBlock(c, roster, { canMark, entry, refreshAll }) {
  const people = roster.attendees;
  const marks = new Map(people.map((p) => [p.userId, p.status === 'attended' || p.status === 'absent' ? p.status : null]));
  const block = h('div', { class: 'block' }, h('h3', null, `Attending (${people.length})`));
  if (!people.length) { block.append(h('p', { class: 'muted' }, 'No one holds a place yet.')); return block; }

  const saveBtn = h('button', { class: 'btn', disabled: true }, 'Save attendance');
  const segs = new Map();
  const sync = () => { saveBtn.disabled = ![...marks.values()].some(Boolean); };
  const paint = (id) => {
    const seg = segs.get(id); if (!seg) return;
    const [yes, no] = seg.querySelectorAll('button');
    yes.setAttribute('aria-pressed', String(marks.get(id) === 'attended')); no.setAttribute('aria-pressed', String(marks.get(id) === 'absent'));
  };
  for (const p of people) {
    let right;
    if (canMark) {
      const set = (v) => { marks.set(p.userId, marks.get(p.userId) === v ? null : v); entry.dirty = true; paint(p.userId); sync(); };
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': `Attendance for ${p.name}` },
        h('button', { class: 'yes', onclick: () => set('attended'), 'aria-pressed': 'false' }, 'Present'),
        h('button', { class: 'no', onclick: () => set('absent'), 'aria-pressed': 'false' }, 'Absent'));
      segs.set(p.userId, seg); right = seg;
    } else {
      const tag = p.status === 'attended' ? h('span', { class: 'tag moss' }, 'Attended') : p.status === 'absent' ? h('span', { class: 'tag ox' }, 'Absent') : h('span', { class: 'tag' }, 'Booked');
      const canRelease = state.user.role === 'admin' && p.status === 'booked' && ['open', 'full', 'closed'].includes(c.state);
      let rel = null;
      if (canRelease) {
        rel = h('button', { class: 'btn ghost small', onclick: async () => {
          const next = roster.waitlist[0];
          const ok = await confirmDialog({ title: `Release ${p.name}'s place?`, body: next ? `${next.name} is moved in from the waitlist.` : 'The place becomes available to other members.', confirmLabel: 'Release place', danger: true });
          if (!ok) return;
          const r = await busy(rel, () => api(`/classes/${c.id}/bookings/${p.userId}`, { method: 'DELETE' }));
          if (r) { toast(r.promoted?.length ? 'Place released. The first in line was moved in.' : 'Place released.'); refreshAll(); }
        } }, 'Release');
      }
      right = h('div', { class: 'cluster' }, tag, rel);
    }
    const row = h('div', { class: 'person' }, h('div', null, h('div', null, p.name), p.promotedAt ? h('div', { class: 'muted small' }, 'Moved in from the waitlist') : null), right);
    block.append(row); paint(p.userId);
  }
  if (canMark) {
    const all = h('button', { class: 'btn ghost', onclick: () => { for (const p of people) marks.set(p.userId, 'attended'); entry.dirty = true; people.forEach((p) => paint(p.userId)); sync(); } }, 'Mark everyone present');
    saveBtn.addEventListener('click', async () => {
      const records = [...marks].filter(([, v]) => v).map(([userId, status]) => ({ userId, status }));
      const r = await busy(saveBtn, () => api(`/classes/${c.id}/attendance`, { method: 'POST', body: { records } }));
      if (r) { toast(`Attendance saved for ${plural(r.updated, 'member')}.`); refreshAll(); }
    });
    block.append(h('div', { class: 'cluster', style: 'margin-top:16px' }, all, saveBtn));
    sync();
  } else if (c.state === 'open' || c.state === 'full' || c.state === 'closed') {
    block.append(h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Attendance can be marked once the class begins.'));
  }
  return block;
}

function waitlistBlock(c, roster, refreshAll) {
  const block = h('div', { class: 'block' }, h('h3', null, `Waitlist (${roster.waitlist.length})`));
  if (!roster.waitlist.length) { block.append(h('p', { class: 'muted' }, 'Nobody is waiting.')); return block; }
  for (const p of roster.waitlist) {
    let remove = null;
    if (state.user.role === 'admin') {
      remove = h('button', { class: 'btn ghost small', onclick: async () => {
        const ok = await confirmDialog({ title: `Remove ${p.name}?`, body: 'They leave the queue and everyone behind moves up one place.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        const r = await busy(remove, () => api(`/classes/${c.id}/bookings/${p.userId}`, { method: 'DELETE' }));
        if (r) { toast(`${p.name} removed.`); refreshAll(); }
      } }, 'Remove');
    }
    block.append(h('div', { class: 'person' }, h('div', null, h('span', { class: 'pos' }, ordinal(p.position)), p.name), remove));
  }
  block.append(h('p', { class: 'muted small', style: 'margin-top:10px' }, 'When a place opens, the first person in this list is moved in automatically.'));
  return block;
}

// ───────────────────────── class form (admin create / edit) ─────────────────────────
async function classForm(existing, done) {
  const { trainers } = await api('/admin/trainers');
  const today = dayKey(new Date().toISOString());
  const init = existing ? isoToLocalParts(existing.startsAt) : { date: addDaysKey(today, 1), time: '07:00' };
  const v = {
    title: existing?.title ?? '', category: existing?.category ?? '', trainerId: existing?.trainer.id ?? trainers[0]?.id ?? '',
    date: init.date, time: init.time, durationMin: existing?.durationMin ?? 60, capacity: existing?.capacity ?? 12, description: existing?.description ?? '',
  };
  const errBox = h('div');
  const fields = {};
  const field = (key, label, input) => {
    const err = h('div', { class: 'err', role: 'alert' });
    const wrap = h('div', { class: 'field' }, h('label', { for: `f-${key}` }, label), input, err);
    input.id = `f-${key}`; fields[key] = { wrap, err };
    return wrap;
  };
  const inp = (key, type, extra = {}) => h('input', { type, value: v[key], ...extra, oninput: (e) => { v[key] = e.target.value; } });
  const trainerSel = h('select', { onchange: (e) => { v.trainerId = e.target.value; } }, trainers.map((t) => h('option', { value: t.id, selected: t.id === v.trainerId }, t.name)));
  const desc = h('textarea', { maxlength: 500, oninput: (e) => { v.description = e.target.value; } }, v.description);
  const submit = h('button', { class: 'btn', type: 'submit' }, existing ? 'Save changes' : 'Add to schedule');
  let entry;
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    Object.values(fields).forEach((f) => { f.wrap.classList.remove('bad'); f.err.textContent = ''; }); clear(errBox);
    const local = {};
    if (!v.date) local.startsAt = 'Choose a date.'; else if (!v.time) local.startsAt = 'Choose a start time.';
    if (Object.keys(local).length) { showFieldErrors(local); return; }
    const body = { title: v.title, category: v.category, trainerId: v.trainerId, startsAt: zonedToIso(v.date, v.time), durationMin: v.durationMin, capacity: v.capacity, description: v.description };
    const r = await busy(submit, () => (existing ? api(`/classes/${existing.id}`, { method: 'PATCH', body }) : api('/classes', { method: 'POST', body })), (err) => {
      if (err.fields && Object.keys(err.fields).length) showFieldErrors(err.fields); else errBox.append(h('div', { class: 'form-error' }, errText(err)));
    });
    if (r) {
      const promoted = r.promoted ? ` ${plural(r.promoted, 'waitlisted member')} moved in.` : '';
      toast(existing ? `Class updated.${promoted}` : 'Class added to the schedule.'); entry.close(); done?.();
    }
  } },
    errBox,
    field('title', 'Title', inp('title', 'text', { maxlength: 80, autofocus: true })),
    h('div', { class: 'row2' },
      field('category', 'Category', Object.assign(inp('category', 'text', { maxlength: 40, list: 'cats' }))),
      field('trainerId', 'Trainer', trainerSel)),
    h('datalist', { id: 'cats' }, ['Yoga', 'HIIT', 'Pilates', 'Strength', 'Boxing'].map((x) => h('option', { value: x }))),
    h('div', { class: 'row2' },
      field('startsAt', `Date (${tz().split('/').pop().replace('_', ' ')} time)`, inp('date', 'date', { min: today })),
      field('time', 'Start time', inp('time', 'time'))),
    h('div', { class: 'row2' },
      field('durationMin', 'Duration in minutes', inp('durationMin', 'number', { min: 15, max: 240, step: 5, inputMode: 'numeric' })),
      field('capacity', 'Places', inp('capacity', 'number', { min: 1, max: 200, inputMode: 'numeric' }))),
    field('description', 'Description (optional)', desc),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => entry.close() }, 'Cancel'), submit));
  function showFieldErrors(map) {
    let any = false;
    for (const [k, msg] of Object.entries(map)) {
      const f = fields[k] || (k === 'startsAt' ? fields.startsAt : null);
      if (f) { f.wrap.classList.add('bad'); f.err.textContent = msg; any = true; }
    }
    if (!any) errBox.append(h('div', { class: 'form-error' }, Object.values(map)[0]));
  }
  entry = openLayer(h('div', { class: 'dialog' }, h('h2', null, existing ? 'Edit class' : 'New class'), form), { kind: 'dialog', label: existing ? 'Edit class' : 'New class' });
}

// ───────────────────────── views ─────────────────────────
const pageHead = (title, sub, ...right) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null), right.length ? h('div', null, right) : null);
const empty = (title, body, action) => h('div', { class: 'empty' }, h('h3', null, title), h('p', null, body), action ? h('div', { style: 'margin-top:16px' }, action) : null);

// Schedule -------------------------------------------------------
const scheduleState = { day: null, category: 'All' };
async function viewSchedule(root) {
  const cfg = state.config;
  const today = dayKey(new Date().toISOString());
  const days = Array.from({ length: 14 }, (_, i) => addDaysKey(today, i));
  if (!scheduleState.day || !days.includes(scheduleState.day)) scheduleState.day = today;

  const head = h('div'); const notice = h('div'); const ribbon = h('div', { class: 'ribbon', role: 'tablist', 'aria-label': 'Choose a day' });
  const chips = h('div', { class: 'chips', style: 'margin-bottom:8px' }); const list = h('div', { class: 'classes' });
  const addBtn = state.user.role === 'admin' ? h('button', { class: 'btn', onclick: () => classForm(null, load) }, 'New class') : null;
  root.append(pageHead('Schedule', state.user.role === 'member' ? `Reserve up to ${cfg.cutoffMinutes / 60} hours before a class begins. Full classes keep a waitlist.` : 'Every class, with live seats and queue.', addBtn), notice, ribbon, chips, list);

  let classes = []; let lastSig = '';
  async function load() {
    const [{ classes: rows }, mem] = await Promise.all([
      api(`/classes?from=${days[0]}&to=${days[days.length - 1]}`),
      state.user.role === 'member' ? api('/me/memberships') : Promise.resolve(null),
    ]);
    const sig = JSON.stringify([rows, mem?.memberships]);
    if (sig === lastSig) return;
    lastSig = sig; classes = rows; paint(); paintNotice(mem);
  }
  function paintNotice(mem) {
    clear(notice);
    if (!mem) return;
    const active = mem.memberships.find((m) => m.status === 'active');
    if (!active) {
      notice.append(h('div', { class: 'notice' }, h('span', null, 'You need an active membership to reserve classes.'), h('a', { class: 'btn small', href: '#/membership' }, 'Choose a plan')));
    }
  }
  function paint() {
    const byDay = new Map(days.map((d) => [d, 0]));
    classes.forEach((c) => byDay.set(dayKey(c.startsAt), (byDay.get(dayKey(c.startsAt)) || 0) + 1));
    clear(ribbon);
    days.forEach((d, i) => {
      const b = h('button', { class: 'day', role: 'tab', 'aria-selected': String(d === scheduleState.day), tabindex: d === scheduleState.day ? 0 : -1,
        onclick: () => { scheduleState.day = d; paint(); },
        onkeydown: (e) => { const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (step && days[i + step]) { e.preventDefault(); scheduleState.day = days[i + step]; paint(); ribbon.querySelector('[aria-selected="true"]').focus(); } } },
        h('span', null, i === 0 ? 'Today' : weekdayShort(d)), h('b', null, dayNum(d)), byDay.get(d) ? h('i', { class: 'has' }) : null);
      ribbon.append(b);
    });
    ribbon.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });

    const todays = classes.filter((c) => dayKey(c.startsAt) === scheduleState.day);
    const cats = ['All', ...new Set(todays.map((c) => c.category))];
    if (!cats.includes(scheduleState.category)) scheduleState.category = 'All';
    clear(chips);
    if (cats.length > 2) cats.forEach((cat) => chips.append(h('button', { class: 'chip', 'aria-pressed': String(cat === scheduleState.category), onclick: () => { scheduleState.category = cat; paint(); } }, cat)));
    const shown = todays.filter((c) => scheduleState.category === 'All' || c.category === scheduleState.category);
    clear(list);
    if (!shown.length) list.append(empty('Nothing scheduled', scheduleState.day === today ? 'No more classes today. Tomorrow has plenty.' : 'No classes on this day. Pick another from the ribbon.', state.user.role === 'admin' ? h('button', { class: 'btn', onclick: () => classForm(null, load) }, 'Add a class') : null));
    else shown.forEach((c) => list.append(classRow(c, { done: load })));
  }
  await load();
  root.refreshFn = load;
}

// My bookings ----------------------------------------------------
async function viewBookings(root) {
  const upcoming = h('div', { class: 'list' }); const past = h('div', { class: 'list' });
  root.append(pageHead('My bookings', 'Places you hold and queues you are waiting in.'), h('div', { class: 'section', style: 'margin-top:0' }, upcoming), h('div', { class: 'section' }, h('h2', null, 'Past classes'), past));
  async function load() {
    const data = await api('/me/bookings');
    clear(upcoming); clear(past);
    if (!data.upcoming.length) upcoming.append(empty('Nothing booked', 'Your calendar is open. Find a class that suits you.', h('a', { class: 'btn', href: '#/schedule' }, 'See the schedule')));
    for (const b of data.upcoming) {
      const waiting = b.status === 'waitlisted';
      const btn = h('button', { class: 'btn ghost small', disabled: !b.canCancel, onclick: () => release({ id: b.classId, title: b.title, startsAt: b.startsAt, waitlistCount: waiting ? 0 : 1, my: { status: b.status } }, btn, load) }, waiting ? 'Leave waitlist' : 'Cancel place');
      upcoming.append(h('div', { class: 'li' },
        h('div', null, h('h3', null, b.title), h('div', { class: 'sub' }, `${fmtDay(b.startsAt)}, ${fmtTime(b.startsAt)} with ${b.trainerName}`)),
        h('div', { class: 'cluster' }, waiting ? h('span', { class: 'tag brass' }, `${ordinal(b.position)} in line`) : h('span', { class: 'tag moss' }, 'Place held'),
          b.canCancel ? btn : h('span', { class: 'muted small' }, 'Cancellation closed'))));
    }
    if (!data.past.length) past.append(empty('No history yet', 'Attended classes will appear here.'));
    for (const b of data.past.slice(0, 15)) {
      past.append(h('div', { class: 'li' }, h('div', null, h('h3', null, b.title), h('div', { class: 'sub' }, `${fmtDay(b.startsAt)}, ${fmtTime(b.startsAt)} with ${b.trainerName}`)),
        b.status === 'attended' ? h('span', { class: 'tag moss' }, 'Attended') : b.status === 'absent' ? h('span', { class: 'tag ox' }, 'Absent') : h('span', { class: 'tag' }, b.status === 'waitlisted' ? 'Not reached' : 'Not marked')));
    }
  }
  await load(); root.refreshFn = load;
}

// Membership -----------------------------------------------------
async function viewMembership(root) {
  const holder = h('div'); root.append(pageHead('Membership', 'Active members can reserve any class. Renewals queue behind your current plan.'), holder);
  async function load() {
    const [{ plans }, { memberships }] = await Promise.all([api('/plans'), api('/me/memberships')]);
    clear(holder);
    const active = memberships.find((m) => m.status === 'active');
    const upcoming = memberships.filter((m) => m.status === 'upcoming');
    if (active) {
      const total = (Date.parse(active.endDate) - Date.parse(active.startDate)) / 86400000 + 1;
      const left = Math.max(0, Math.round((Date.parse(active.endDate) - Date.parse(dayKey(new Date().toISOString()))) / 86400000));
      holder.append(h('div', { class: 'crest' }, h('p', { class: 'muted' }, 'Current plan'), h('h2', null, active.planName),
        h('div', { class: 'progress' }, h('i', { style: `width:${Math.min(100, ((total - left) / total) * 100)}%` })),
        h('p', { class: 'muted small' }, `${fmtDate(active.startDate)} to ${fmtDate(active.endDate)}. ${left === 0 ? 'Ends today.' : `${plural(left, 'day')} remaining.`}`)));
    } else holder.append(h('div', { class: 'crest' }, h('h2', null, 'No active plan'), h('p', { class: 'muted' }, 'Choose a plan below to start reserving classes.')));
    for (const u of upcoming) holder.append(h('p', { class: 'muted small', style: 'margin-top:10px' }, `${u.planName} renewal begins ${fmtDate(u.startDate)}.`));

    const grid = h('div', { class: 'plans' });
    for (const p of plans) {
      const label = active ? `Renew with ${p.name}` : `Start ${p.name}`;
      const blocked = upcoming.length > 0;
      const b = h('button', { class: 'btn', disabled: blocked, onclick: async () => {
        const ok = await confirmDialog({ title: `${p.name} plan`, body: `${money(p.priceCents)} for ${plural(p.months, 'month')}. ${active ? 'It begins the day after your current plan ends.' : 'It begins today.'}`, confirmLabel: 'Confirm', cancelLabel: 'Not now' });
        if (!ok) return;
        const r = await busy(b, () => api('/me/memberships', { method: 'POST', body: { planId: p.id } }));
        if (r) { toast(`${p.name} plan confirmed. ${r.membership.status === 'active' ? 'You can reserve classes now.' : `It begins ${fmtDate(r.membership.startDate)}.`}`); load(); }
      } }, label);
      grid.append(h('div', { class: 'plan' }, h('h3', null, p.name), h('div', { class: 'price' }, money(p.priceCents)), h('p', { class: 'muted' }, p.blurb), b, blocked ? h('p', { class: 'muted small' }, 'A renewal is already scheduled.') : null));
    }
    holder.append(h('div', { class: 'section' }, h('h2', null, 'Plans'), grid));
    if (memberships.length) holder.append(h('div', { class: 'section' }, h('h2', null, 'History'), h('div', { class: 'list' },
      memberships.map((m) => h('div', { class: 'li' }, h('div', null, h('h3', null, m.planName), h('div', { class: 'sub' }, `${fmtDate(m.startDate)} to ${fmtDate(m.endDate)}`)),
        h('span', { class: `tag ${m.status === 'active' ? 'moss' : m.status === 'upcoming' ? 'brass' : ''}` }, m.status))))));
  }
  await load();
}

// Attendance record (member) --------------------------------------
async function viewRecord(root) {
  const data = await api('/me/attendance');
  root.append(pageHead('Attendance', 'Your last ninety days, as marked by your trainers.'));
  root.append(statsRow(data.summary), sessionList(data.sessions));
}
const statsRow = (s) => h('div', { class: 'stats' },
  stat(s.attended, 'attended'), stat(s.absent, 'absent'), stat(s.rate === null ? '—' : `${s.rate}%`, 'attendance rate'), stat(s.upcoming, 'upcoming'));
const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, label));
const sessionList = (sessions) => sessions.length
  ? h('div', { class: 'list' }, sessions.map((s) => h('div', { class: 'li' }, h('div', null, h('h3', null, s.title), h('div', { class: 'sub' }, `${fmtDay(s.startsAt)}, ${fmtTime(s.startsAt)} with ${s.trainerName}`)),
      h('span', { class: `tag ${s.status === 'attended' ? 'moss' : s.status === 'absent' ? 'ox' : ''}` }, s.status === 'unmarked' ? 'not marked' : s.status))))
  : empty('No sessions yet', 'Classes you hold a place in will be listed here.');

// Trainer: my classes ---------------------------------------------
async function viewTrainer(root) {
  const up = h('div', { class: 'classes' }); const pastEl = h('div', { class: 'classes' });
  root.append(pageHead('My classes', 'Open a class to see its roster and mark attendance once it begins.'), up, h('div', { class: 'section' }, h('h2', null, 'Recently taught'), pastEl));
  async function load() {
    const { classes } = await api('/trainer/classes');
    const live = classes.filter((c) => !['finished'].includes(c.state) && c.state !== 'cancelled');
    const done = classes.filter((c) => c.state === 'finished').reverse().slice(0, 12);
    clear(up); clear(pastEl);
    if (!live.length) up.append(empty('No upcoming classes', 'The front desk has not scheduled you yet.'));
    live.forEach((c) => up.append(classRow(c, { done: load, showDay: true })));
    if (!done.length) pastEl.append(empty('Nothing yet', 'Finished classes appear here so you can complete attendance.'));
    done.forEach((c) => pastEl.append(classRow(c, { done: load, showDay: true })));
  }
  await load(); root.refreshFn = load;
}

// Admin: members --------------------------------------------------
async function viewMembers(root) {
  const expiring = h('div'); const table = h('div', { class: 'scroll-x' });
  root.append(pageHead('Members', 'Memberships, renewals and who needs a reminder.'), expiring, h('div', { class: 'section' }, h('h2', null, 'Everyone'), table));
  async function load() {
    const [{ members }, { expiring: soon }, { plans }] = await Promise.all([api('/admin/members'), api('/admin/expiring'), api('/plans')]);
    clear(expiring);
    const run = h('button', { class: 'btn ghost small', onclick: async () => { const r = await busy(run, () => api('/admin/reminders/run', { method: 'POST' })); if (r) toast(r.sent ? `${plural(r.sent, 'reminder')} sent.` : 'Everyone due has already been reminded.'); } }, 'Send reminders now');
    expiring.append(h('div', { class: 'section', style: 'margin-top:0' }, h('div', { class: 'cluster', style: 'justify-content:space-between;margin-bottom:10px' }, h('h2', { style: 'font-size:1.9rem' }, 'Ending within two weeks'), run),
      soon.length ? h('div', { class: 'list' }, soon.map((m) => h('div', { class: 'li' }, h('div', null, h('h3', null, m.name), h('div', { class: 'sub' }, `${m.planName} ends ${fmtDate(m.endDate)}`)), m.renewed ? h('span', { class: 'tag moss' }, 'renewal scheduled') : h('span', { class: 'tag brass' }, 'needs renewal')))) : h('p', { class: 'muted' }, 'No memberships end in the next two weeks.')));
    clear(table);
    table.append(h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Member', 'Status', 'Plan', 'Ends', ''].map((x) => h('th', null, x)))),
      h('tbody', null, members.map((m) => {
        const grant = h('button', { class: 'btn ghost small', onclick: () => grantForm(m, plans, load) }, 'Add plan');
        const activeM = m.memberships.find((x) => x.status === 'active');
        const end = activeM ? h('button', { class: 'btn danger small', onclick: async () => {
          const ok = await confirmDialog({ title: `End ${m.name}'s plan?`, body: 'They will no longer be able to reserve classes. Existing waitlist spots are dropped when a place opens.', confirmLabel: 'End plan', danger: true });
          if (!ok) return; const r = await busy(end, () => api(`/admin/memberships/${activeM.id}`, { method: 'DELETE' })); if (r) { toast('Plan ended.'); load(); }
        } }, 'End plan') : null;
        return h('tr', null, h('td', null, h('div', null, m.name), h('div', { class: 'muted small' }, m.email)),
          h('td', null, h('span', { class: `tag ${m.status === 'active' ? 'moss' : m.status === 'upcoming' ? 'brass' : 'ox'}` }, m.status)),
          h('td', null, m.planName ?? '—'), h('td', null, m.endDate ? fmtDate(m.endDate) : '—'), h('td', null, h('div', { class: 'cluster' }, grant, end)));
      }))));
  }
  await load(); root.refreshFn = load;
}
function grantForm(member, plans, done) {
  let planId = plans[0].id, start = '';
  const errBox = h('div'); let entry;
  const sel = h('select', { id: 'g-plan', onchange: (e) => { planId = e.target.value; } }, plans.map((p) => h('option', { value: p.id }, `${p.name}, ${money(p.priceCents)}`)));
  const date = h('input', { id: 'g-start', type: 'date', oninput: (e) => { start = e.target.value; } });
  const ok = h('button', { class: 'btn', type: 'submit' }, 'Add plan');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); clear(errBox);
    const r = await busy(ok, () => api('/admin/memberships', { method: 'POST', body: { userId: member.id, planId, ...(start ? { startDate: start } : {}) } }), (err) => errBox.append(h('div', { class: 'form-error' }, err.fields?.startDate || errText(err))));
    if (r) { toast(`Plan added for ${member.name}.`); entry.close(); done(); }
  } }, errBox,
    h('div', { class: 'field' }, h('label', { for: 'g-plan' }, 'Plan'), sel),
    h('div', { class: 'field' }, h('label', { for: 'g-start' }, 'Start date (leave empty to start today or after the current plan)'), date),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => entry.close() }, 'Cancel'), ok));
  entry = openLayer(h('div', { class: 'dialog' }, h('h2', null, `Add a plan for ${member.name}`), form), { kind: 'dialog', label: 'Add plan' });
}

// Admin: reports ---------------------------------------------------
async function viewReports(root) {
  const today = dayKey(new Date().toISOString());
  const range = { from: addDaysKey(today, -90), to: today };
  const out = h('div', { class: 'scroll-x' });
  const f = h('input', { id: 'r-from', type: 'date', value: range.from, onchange: (e) => { range.from = e.target.value; } });
  const t = h('input', { id: 'r-to', type: 'date', value: range.to, onchange: (e) => { range.to = e.target.value; } });
  const apply = h('button', { class: 'btn', onclick: () => load() }, 'Update');
  root.append(pageHead('Attendance reports', 'How often each member turns up after reserving. Select a member for their full record.'),
    h('div', { class: 'cluster', style: 'align-items:flex-end;margin-bottom:22px' }, h('div', { class: 'field', style: 'margin:0' }, h('label', { for: 'r-from' }, 'From'), f), h('div', { class: 'field', style: 'margin:0' }, h('label', { for: 'r-to' }, 'To'), t), apply), out);
  async function load() {
    const r = await busy(apply, () => api(`/admin/reports/attendance?from=${range.from}&to=${range.to}`));
    if (!r) return;
    clear(out);
    if (!r.rows.some((x) => x.held)) { out.append(empty('No attendance in this range', 'Try a wider range, or wait for trainers to mark their classes.')); return; }
    out.append(h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Member', 'Attended', 'Absent', 'Not marked', 'Rate'].map((x) => h('th', null, x)))),
      h('tbody', null, r.rows.map((m) => {
        const open = () => openDrawer(async () => {
          const rec = await api(`/admin/reports/members/${m.id}?from=${range.from}&to=${range.to}`);
          return h('div', null, h('p', { class: 'muted' }, rec.member.email), h('h2', null, rec.member.name), h('div', { style: 'margin-top:24px' }, statsRow(rec.summary), sessionList(rec.sessions)));
        }, { label: 'Member record' });
        return h('tr', { class: 'click', tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
          h('td', null, h('div', null, m.name), h('div', { class: 'muted small' }, m.email)), h('td', null, m.attended), h('td', null, m.absent), h('td', null, m.unmarked),
          h('td', null, m.rate === null ? h('span', { class: 'muted' }, '—') : h('div', { class: 'cluster', style: 'flex-wrap:nowrap' }, h('div', { class: 'meter' }, h('i', { style: `width:${m.rate}%` })), `${m.rate}%`)));
      }))));
  }
  await load();
}

// ───────────────────────── notifications ─────────────────────────
async function pollNotifications(initial = false) {
  try {
    const data = await api('/me/notifications');
    const maxId = data.items.reduce((m, n) => Math.max(m, n.id), 0);
    if (!initial) for (const n of data.items.filter((x) => x.id > state.lastNoteId && !x.readAt).reverse()) toast(n.message, 'ok', 7000);
    state.lastNoteId = Math.max(state.lastNoteId, maxId); state.notes = data; paintBell();
  } catch { /* ignore transient errors */ }
}
function paintBell() {
  const dot = document.getElementById('bell-dot');
  if (!dot) return;
  dot.textContent = state.notes.unread > 9 ? '9+' : String(state.notes.unread);
  dot.hidden = state.notes.unread === 0;
  document.getElementById('bell').setAttribute('aria-label', state.notes.unread ? `Notifications, ${state.notes.unread} unread` : 'Notifications');
}
function toggleNotes() {
  const existing = document.getElementById('notes-panel');
  if (existing) { existing.remove(); return; }
  const items = state.notes.items;
  const unreadIds = new Set(items.filter((n) => !n.readAt).map((n) => n.id));
  const panel = h('div', { class: 'panel', id: 'notes-panel', role: 'region', 'aria-label': 'Notifications' }, h('h3', null, 'Notifications'),
    items.length ? items.map((n) => h('div', { class: `note ${unreadIds.has(n.id) ? 'unread' : ''}` }, n.message, h('time', null, `${fmtDay(n.createdAt)}, ${fmtTime(n.createdAt)}`)))
      : h('div', { class: 'note muted' }, 'Nothing yet. Waitlist moves and membership reminders appear here.'));
  document.body.append(panel);
  const away = (e) => { if (!panel.contains(e.target) && !e.target.closest('#bell')) { panel.remove(); document.removeEventListener('click', away, true); } };
  document.addEventListener('click', away, true);
  if (state.notes.unread) api('/me/notifications/read', { method: 'POST' }).then(() => { state.notes.unread = 0; paintBell(); });
}

// ───────────────────────── shell + router ─────────────────────────
const NAV = {
  member: [['schedule', 'Schedule'], ['bookings', 'My bookings'], ['membership', 'Membership'], ['attendance', 'Attendance']],
  trainer: [['classes', 'My classes'], ['schedule', 'Schedule']],
  admin: [['schedule', 'Schedule'], ['members', 'Members'], ['reports', 'Reports']],
};
const VIEWS = { schedule: viewSchedule, bookings: viewBookings, membership: viewMembership, attendance: viewRecord, classes: viewTrainer, members: viewMembers, reports: viewReports };

function renderShell() {
  clear($app);
  const links = NAV[state.user.role];
  $app.append(
    h('header', { class: 'bar' }, h('div', { class: 'bar-in' },
      h('a', { class: 'brand', href: `#/${links[0][0]}` }, h('i'), state.config.gymName),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, links.map(([k, label]) => h('a', { href: `#/${k}`, 'data-route': k }, label))),
      h('div', { class: 'who' }, h('span', { class: 'name' }, state.user.name),
        h('button', { class: 'icon-btn', id: 'bell', 'aria-label': 'Notifications', onclick: toggleNotes },
          h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'aria-hidden': 'true' }, h('path', { d: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 19a2 2 0 0 0 4 0' })),
          h('span', { class: 'dot', id: 'bell-dot', hidden: true })),
        h('button', { class: 'btn ghost small', onclick: signOut }, 'Sign out')))),
    h('main', { id: 'main', tabindex: -1 }));
}

let routeToken = 0;
async function route() {
  if (!state.user) return;
  const key = (location.hash.replace(/^#\//, '') || NAV[state.user.role][0][0]).split('?')[0];
  const allowed = NAV[state.user.role].map(([k]) => k);
  if (!allowed.includes(key)) { location.hash = `#/${allowed[0]}`; return; }
  document.querySelectorAll('.nav a').forEach((a) => (a.dataset.route === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const main = document.getElementById('main'); if (!main) return;
  const token = ++routeToken; state.refresh = null; state.route = key;
  const root = h('div'); clear(main).append(root);
  document.title = `${NAV[state.user.role].find(([k]) => k === key)[1]} · ${state.config.gymName}`;
  try { await VIEWS[key](root); } catch (e) { if (token === routeToken) root.append(h('p', { class: 'form-error' }, errText(e))); }
  // only the view that is still current may register its live-refresh function
  if (token === routeToken) state.refresh = root.refreshFn ?? null;
}

function signOut() {
  session.clear(); state.user = null; state.refresh = null; layerStack.slice().forEach((l) => l.close()); document.getElementById('notes-panel')?.remove();
  location.hash = ''; renderGate();
}
setUnauthorizedHandler(() => { if (state.user) { toast('Your session has ended. Please sign in again.', 'bad', 6000); signOut(); } });

async function enter(user) {
  state.user = user; state.lastNoteId = 0; renderShell();
  await pollNotifications(true);
  await route();
}
window.addEventListener('hashchange', () => { layerStack.slice().forEach((l) => l.close()); route(); });

// Live updates: refresh the visible view and listen for waitlist moves.
setInterval(() => {
  if (!state.user || document.hidden) return;
  pollNotifications(false);
  if (!anyLayerOpen() && state.refresh) Promise.resolve(state.refresh()).catch(() => {});
  else if (state.drawer && !state.drawer.dirty) state.drawer.render();
}, 8000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) { pollNotifications(false); if (!anyLayerOpen()) state.refresh?.(); } });

// ───────────────────────── sign-in ─────────────────────────
const DEMOS = [['Member', 'priti@aurelian.club'], ['Trainer', 'sebastian@aurelian.club'], ['Admin', 'admin@aurelian.club']];
function renderGate() {
  clear($app);
  const SEATS = 10; let queue = 3; let seats = Array(SEATS).fill(true);
  const caption = h('p', { class: 'caption', 'aria-live': 'polite' }, 'Ten places, three waiting. Release one.');
  const pipsEl = h('div', { class: 'pips', role: 'group', 'aria-label': 'Interactive demonstration of seats and the waitlist' });
  const paint = (popIdx = -1) => {
    clear(pipsEl);
    seats.forEach((taken, i) => pipsEl.append(h('button', { class: `pip ${taken ? 'taken' : ''} ${i === popIdx ? 'pop' : ''}`, 'aria-label': taken ? `Place ${i + 1}, taken. Release it.` : `Place ${i + 1}, free. Reserve it.`, onclick: () => click(i) })));
    if (queue) { const q = h('span', { class: 'queue', style: 'border-color:#4f6a5c;gap:10px;margin-left:6px;padding-left:16px', 'aria-hidden': 'true' }); for (let i = 0; i < queue; i += 1) q.append(h('span', { class: 'diamond', style: 'border-color:#c9a85c;width:12px;height:12px' })); pipsEl.append(q); }
  };
  function click(i) {
    if (seats[i]) {
      if (queue > 0) { queue -= 1; caption.textContent = queue ? `A place opened and the first in line moved in. ${queue} still waiting.` : 'A place opened and the first in line moved in. No one clicked anything.'; paint(i); }
      else { seats[i] = false; caption.textContent = 'A place is free. Anyone with a membership can take it.'; paint(); }
    } else { seats[i] = true; caption.textContent = seats.every(Boolean) ? 'Full. The next person to ask joins the waitlist.' : 'Reserved.'; paint(i); }
  }
  paint();

  let mode = 'in';
  const formHost = h('div');
  const drawForm = () => {
    clear(formHost);
    const errBox = h('div'); const fe = {};
    const mk = (key, label, type, extra = {}) => { const err = h('div', { class: 'err', role: 'alert' }); fe[key] = err; return h('div', { class: 'field', 'data-f': key }, h('label', { for: `a-${key}` }, label), h('input', { id: `a-${key}`, name: key, type, required: true, ...extra }), err); };
    const submit = h('button', { class: 'btn', type: 'submit', style: 'width:100%' }, mode === 'in' ? 'Sign in' : 'Create account');
    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); clear(errBox); Object.values(fe).forEach((x) => { x.textContent = ''; x.parentElement.classList.remove('bad'); });
      const data = Object.fromEntries(new FormData(form));
      const r = await busy(submit, () => api(mode === 'in' ? '/auth/login' : '/auth/register', { method: 'POST', body: data }), (err) => {
        const f = err.fields || {}; let shown = false;
        for (const [k, msg] of Object.entries(f)) if (fe[k]) { fe[k].textContent = msg; fe[k].parentElement.classList.add('bad'); shown = true; }
        if (!shown) errBox.append(h('div', { class: 'form-error' }, errText(err)));
      });
      if (r) { session.set(r.token); await enter(r.user); }
    } }, errBox, mode === 'up' ? mk('name', 'Full name', 'text', { autocomplete: 'name', maxlength: 80 }) : null,
      mk('email', 'Email', 'email', { autocomplete: 'email', autofocus: mode === 'in' }),
      mk('password', 'Password', 'password', { autocomplete: mode === 'in' ? 'current-password' : 'new-password' }),
      mode === 'up' ? h('p', { class: 'muted small', style: 'margin:-8px 0 16px' }, 'At least 8 characters, with a letter and a number.') : null, submit);
    formHost.append(form);
    if (mode === 'in') formHost.append(h('div', { class: 'demo' }, h('p', { class: 'muted small' }, 'Try a demo account. They all use the password Aurelian2026.'),
      h('div', { class: 'chips' }, DEMOS.map(([label, email]) => h('button', { class: 'chip', type: 'button', onclick: () => { form.email.value = email; form.password.value = 'Aurelian2026'; form.requestSubmit(); } }, label)))));
  };
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    ...[['in', 'Sign in'], ['up', 'Join']].map(([m, label]) => h('button', { role: 'tab', 'aria-selected': String(m === mode), onclick: (e) => { mode = m; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', 'false')); e.currentTarget.setAttribute('aria-selected', 'true'); drawForm(); } }, label)));
  drawForm();
  $app.append(h('div', { class: 'gate' },
    h('section', { class: 'gate-art' }, h('div', null, h('h1', null, state.config.gymName.split(' ')[0], h('br'), h('em', null, state.config.gymName.split(' ').slice(1).join(' '))), h('p', null, 'Reserve your place. When a class is full, you join the queue and are moved in the moment someone lets go.')),
      h('div', null, pipsEl, caption)),
    h('section', { class: 'gate-form' }, h('h2', null, 'Welcome'), tabs, formHost)));
  document.title = state.config.gymName;
}

// ───────────────────────── boot ─────────────────────────
(async function boot() {
  try {
    state.config = await api('/config');
    setLocale(state.config);
  } catch (e) { $app.append(h('main', null, h('p', { class: 'form-error' }, errText(e)))); return; }
  if (session.get()) {
    try { const { user } = await api('/auth/me'); await enter(user); return; } catch { session.clear(); }
  }
  renderGate();
})();
