"""The JavaScript that turns a web page into something a model can read.

Both browsers run the same script -- Bom's own through the DevTools protocol,
the user's through Apple Events -- so a page reads the same whichever one it
is in, and a model that learned to act in one can act in the other.

It makes two things. A list of the controls on the page, each with a small
number (`[3]`) the model refers to it by, kept on the page as `window.__bomRefs`
so a click or a keystroke can find the element again. And the page's text, the
way the browser's own "reader" sees it: `innerText`, which already leaves out
what is hidden, trimmed to a budget the caller sets.

Written as an expression that evaluates to a JSON *string*, not an object:
the DevTools protocol can carry either, but `do JavaScript` over Apple Events
only hands back strings.
"""

from __future__ import annotations

import json

#: Elements a person could act on. Order matters only in that document order
#: is kept; the model sees them as they appear on the page.
_SELECTOR = (
    "a[href], button, input, select, textarea, summary, "
    "[role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], "
    "[role=radio], [role=option], [role=combobox], [role=textbox], [role=switch], "
    "[role=searchbox], [contenteditable=''], [contenteditable=true], [onclick], "
    "[tabindex]:not([tabindex='-1'])"
)

_READ = r"""
(function () {
  var MAX_TEXT = %(max_text)d, START = %(start)d, MAX_ELEMENTS = %(max_elements)d;
  var SELECTOR = %(selector)s;

  function visible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function inView(r) {
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function labelOf(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\s+/).map(function (id) {
        var n = document.getElementById(id); return n ? clean(n.innerText || n.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    // A label wrapping a drop-down reads its options too; keep the label.
    function sansOptions(t) {
      if (el.tagName !== 'SELECT') return t;
      for (var oi = 0; oi < el.options.length; oi++) t = t.replace(clean(el.options[oi].text), '');
      return clean(t);
    }
    if (el.labels && el.labels.length) {
      var l = sansOptions(clean(el.labels[0].innerText || el.labels[0].textContent));
      if (l) return l;
    }
    var wrap = el.closest && el.closest('label');
    if (wrap) {
      var w = sansOptions(clean(wrap.innerText || wrap.textContent));
      if (w) return w;
    }
    var own = el.tagName === 'SELECT' ? '' : clean(el.innerText || el.textContent);
    if (own) return own;
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') ||
                 el.getAttribute('alt') || el.getAttribute('name') || el.value || '');
  }

  var refs = [];
  var items = [];
  var total = 0;
  var nodes = document.querySelectorAll(SELECTOR);
  var dedupe = typeof Set === 'function' ? new Set() : null;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (dedupe) { if (dedupe.has(el)) continue; dedupe.add(el); }
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (!visible(el)) continue;
    if (el.closest && el.closest('[aria-hidden="true"]')) continue;
    total++;
    if (items.length >= MAX_ELEMENTS) continue;
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || '';
    var kind = tag;
    if (tag === 'a') kind = 'link';
    else if (tag === 'input') kind = (el.type || 'text').toLowerCase();
    else if (tag === 'textarea' || el.isContentEditable) kind = 'textbox';
    else if (tag === 'button' || tag === 'select') kind = tag;
    else if (role) kind = role;
    else if (tag === 'summary' || el.hasAttribute('onclick') || el.hasAttribute('tabindex')) kind = 'clickable';
    var item = { ref: refs.push(el), kind: kind, name: labelOf(el).slice(0, 120) };
    if (tag === 'a') {
      var href = el.getAttribute('href') || '';
      if (href && !/^javascript:/i.test(href)) item.href = el.href;
    }
    if (tag === 'input' || tag === 'textarea') {
      var ticks = el.type === 'checkbox' || el.type === 'radio';
      if (kind !== 'password' && !ticks && el.value) item.value = String(el.value).slice(0, 80);
      if (el.placeholder && el.placeholder !== item.name) item.placeholder = el.placeholder.slice(0, 80);
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = !!el.checked;
    }
    if (role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'tab') {
      var state = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed');
      if (state !== null) item.checked = state === 'true';
    }
    if (tag === 'select') {
      var opts = [];
      for (var j = 0; j < el.options.length && opts.length < 24; j++) opts.push(clean(el.options[j].text).slice(0, 40));
      item.options = opts;
      if (el.options.length > opts.length) item.more_options = el.options.length - opts.length;
      var chosen = el.options[el.selectedIndex];
      if (chosen) item.value = clean(chosen.text).slice(0, 80);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (!inView(el.getBoundingClientRect())) item.offscreen = true;
    items.push(item);
  }
  window.__bomRefs = refs;

  var root = document.querySelector('main, [role="main"], article') || document.body;
  var text = root ? (root.innerText || root.textContent || '') : '';
  if (text.length < 400 && document.body) text = document.body.innerText || document.body.textContent || '';
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  var length = text.length;

  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    text: text.slice(START, START + MAX_TEXT),
    text_start: START,
    text_total: length,
    elements: items,
    elements_total: total,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }
  });
})()
"""


def read_script(*, max_text: int, max_elements: int, start: int = 0) -> str:
    """The reading script, with its budgets filled in."""
    return _READ % {
        "max_text": max(200, int(max_text)),
        "max_elements": max(10, int(max_elements)),
        "start": max(0, int(start)),
        "selector": json.dumps(_SELECTOR),
    }


#: Finds a referenced element, scrolls it into the middle of the window and
#: reports where it is. Null when the ref is stale -- the page was re-read or
#: navigated since the number was handed out.
LOCATE = r"""
(function (n) {
  var el = window.__bomRefs && window.__bomRefs[n - 1];
  if (!el || !el.isConnected) return null;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { el.scrollIntoView(); }
  var r = el.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
                          tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase() });
})(%(ref)d)
"""

#: A click done by the page itself, for an element with no box to aim a mouse
#: at -- and for the user's browser, where there is no mouse to dispatch.
CLICK = r"""
(function (n) {
  var el = window.__bomRefs && window.__bomRefs[n - 1];
  if (!el || !el.isConnected) return 'stale';
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  if (el.focus) { try { el.focus(); } catch (e) {} }
  el.click();
  return 'ok';
})(%(ref)d)
"""

#: Focuses a field and, when asked, empties it the way a framework notices:
#: through the element's own value setter, then an input event.
FOCUS = r"""
(function (n, clear) {
  var el = window.__bomRefs && window.__bomRefs[n - 1];
  if (!el || !el.isConnected) return 'stale';
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try { el.focus(); } catch (e) {}
  if (clear) {
    if (el.isContentEditable) { el.textContent = ''; }
    else if ('value' in el) {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  return 'ok';
})(%(ref)d, %(clear)s)
"""

#: Typing without a keyboard: for the user's browser, where there is no input
#: channel but the page's own events. Appends to what is there (FOCUS clears).
TYPE = r"""
(function (n, text) {
  var el = window.__bomRefs && window.__bomRefs[n - 1];
  if (!el || !el.isConnected) return 'stale';
  try { el.focus(); } catch (e) {}
  if (el.isContentEditable) {
    if (document.execCommand) document.execCommand('insertText', false, text);
    else el.textContent += text;
    return 'ok';
  }
  if (!('value' in el)) return 'not-a-field';
  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var d = Object.getOwnPropertyDescriptor(proto, 'value');
  var next = (el.value || '') + text;
  if (d && d.set) d.set.call(el, next); else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})(%(ref)d, %(text)s)
"""

#: A key press without a keyboard: the three events, and for Enter in a form
#: the submit the page would have done.
PRESS = r"""
(function (key) {
  var el = document.activeElement || document.body;
  var init = { key: key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true };
  var down = new KeyboardEvent('keydown', init);
  var went = el.dispatchEvent(down);
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (key === 'Enter' && went && el.form && el.tagName !== 'TEXTAREA') {
    if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
  }
  return 'ok';
})(%(key)s)
"""

#: Picks an option in a <select> by its text or its value.
SELECT = r"""
(function (n, wanted) {
  var el = window.__bomRefs && window.__bomRefs[n - 1];
  if (!el || !el.isConnected) return 'stale';
  if (el.tagName !== 'SELECT') return 'not-a-select';
  var w = String(wanted).trim().toLowerCase();
  var hit = -1;
  for (var i = 0; i < el.options.length; i++) {
    var o = el.options[i];
    if (o.value.toLowerCase() === w || (o.text || '').trim().toLowerCase() === w) { hit = i; break; }
  }
  if (hit < 0) for (var k = 0; k < el.options.length; k++) {
    if ((el.options[k].text || '').trim().toLowerCase().indexOf(w) === 0) { hit = k; break; }
  }
  if (hit < 0) return 'no-such-option';
  el.selectedIndex = hit;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})(%(ref)d, %(value)s)
"""

#: Scrolls the window by most of a screen, or a referenced element into view.
SCROLL = r"""
(function (n, dy) {
  if (n > 0) {
    var el = window.__bomRefs && window.__bomRefs[n - 1];
    if (!el || !el.isConnected) return 'stale';
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); }
    return 'ok';
  }
  window.scrollBy(0, dy * Math.round(innerHeight * 0.85));
  return 'ok';
})(%(ref)d, %(dy)d)
"""

READY = "document.readyState"


def js_string(text: str) -> str:
    """A Python string as a JavaScript string literal."""
    return json.dumps(str(text))
