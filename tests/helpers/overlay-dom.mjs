function createStyle() {
  const props = new Map();
  const priorities = new Map();
  return {
    overflow: '',
    getPropertyValue(name) {
      return props.get(name) || '';
    },
    getPropertyPriority(name) {
      return priorities.get(name) || '';
    },
    setProperty(name, value, priority = '') {
      props.set(name, String(value ?? ''));
      priorities.set(name, priority || '');
      if (name === 'overflow') this.overflow = String(value ?? '');
    },
    removeProperty(name) {
      const previous = props.get(name) || '';
      props.delete(name);
      priorities.delete(name);
      if (name === 'overflow') this.overflow = '';
      return previous;
    },
  };
}

function tokenList(el) {
  return String(el.className || '').split(/\s+/).filter(Boolean);
}

function matchesSelector(el, selector) {
  const trimmed = selector.trim();
  if (trimmed.startsWith('#')) return el.id === trimmed.slice(1);
  if (trimmed.startsWith('.')) return tokenList(el).includes(trimmed.slice(1));
  const attrEq = trimmed.match(/^\[([^\]]+?)="([^"]*)"\]$/);
  if (attrEq) return el.getAttribute(attrEq[1]) === attrEq[2];
  const attr = trimmed.match(/^\[([^\]]+)\]$/);
  if (attr) return el.getAttribute(attr[1]) !== null;
  return el.tagName === trimmed.toUpperCase();
}

function walk(el, visit) {
  for (const child of el.children) {
    if (visit(child) === true) return true;
    if (walk(child, visit)) return true;
  }
  return false;
}

function applyAttributes(el, raw) {
  const pattern = /([^\s=]+)(?:="([^"]*)")?/g;
  let match;
  while ((match = pattern.exec(raw))) {
    el.setAttribute(match[1], match[2] ?? '');
  }
}

function parseFragment(html, createElement) {
  const nodes = [];
  const pattern = /<([a-zA-Z][\w-]*)([^>]*)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = pattern.exec(html))) {
    const el = createElement(match[1]);
    applyAttributes(el, match[2]);
    el.textContent = match[3].replace(/^\s+|\s+$/g, '');
    nodes.push(el);
  }
  return nodes;
}

export function createOverlayDocument() {
  const listeners = new Map();

  function createElement(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      id: '',
      className: '',
      htmlFor: '',
      placeholder: '',
      type: '',
      name: '',
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      maxLength: 0,
      parentNode: null,
      isConnected: false,
      offsetParent: {},
      children: [],
      shadowRoot: null,
      __shadow: null,
      style: createStyle(),
      _attrs: {},
      _listeners: {},
      _text: '',
    };

    el.classList = {
      add(...names) {
        el.className = [...new Set([...tokenList(el), ...names])].join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        el.className = tokenList(el).filter((name) => !drop.has(name)).join(' ');
      },
      toggle(name, force) {
        const has = tokenList(el).includes(name);
        const on = force === undefined ? !has : Boolean(force);
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
      contains(name) {
        return tokenList(el).includes(name);
      },
    };

    el.setAttribute = (name, value) => {
      const stringValue = String(value);
      el._attrs[name] = stringValue;
      if (name === 'id') el.id = stringValue;
      if (name === 'class') el.className = stringValue;
      if (name === 'for') el.htmlFor = stringValue;
    };
    el.getAttribute = (name) => {
      if (name === 'id' && el.id) return el.id;
      if (name === 'class' && el.className) return el.className;
      return Object.prototype.hasOwnProperty.call(el._attrs, name) ? el._attrs[name] : null;
    };
    el.removeAttribute = (name) => {
      delete el._attrs[name];
      if (name === 'id') el.id = '';
      if (name === 'class') el.className = '';
    };
    el.addEventListener = (type, handler) => {
      (el._listeners[type] ||= []).push(handler);
    };
    el.removeEventListener = (type, handler) => {
      el._listeners[type] = (el._listeners[type] || []).filter((fn) => fn !== handler);
    };
    el.dispatchEvent = (event) => {
      for (const handler of el._listeners[event.type] || []) handler(event);
      return true;
    };
    el.click = () => {
      if (el.disabled) return;
      el.dispatchEvent({ type: 'click', target: el, preventDefault() {} });
    };
    el.focus = () => {
      document.activeElement = el;
    };
    el.appendChild = (child) => {
      if (child.parentNode?.children) {
        child.parentNode.children = child.parentNode.children.filter((node) => node !== child);
      }
      child.parentNode = el;
      child.isConnected = el.isConnected;
      el.children.push(child);
      return child;
    };
    el.append = (...nodes) => {
      nodes.forEach((node) => {
        if (typeof node === 'string') {
          const text = createElement('#text');
          text.textContent = node;
          el.appendChild(text);
          return;
        }
        el.appendChild(node);
      });
    };
    el.querySelector = (selector) => {
      let found = null;
      walk(el, (child) => {
        if (matchesSelector(child, selector)) {
          found = child;
          return true;
        }
        return false;
      });
      return found;
    };
    el.querySelectorAll = (selector) => {
      const found = [];
      const groups = selector.split(',').map((part) => part.trim());
      walk(el, (child) => {
        if (groups.some((part) => matchesSelector(child, part))) found.push(child);
        return false;
      });
      return found;
    };
    el.attachShadow = ({ mode }) => {
      const shadow = createElement('#shadow-root');
      shadow.host = el;
      shadow.isConnected = true;
      el.__shadow = shadow;
      el.shadowRoot = mode === 'open' ? shadow : null;
      return shadow;
    };

    Object.defineProperty(el, 'textContent', {
      get() {
        if (el.children.length === 0) return el._text;
        return el.children.map((child) => child.textContent).join('');
      },
      set(value) {
        el._text = String(value ?? '');
        el.children = [];
      },
    });
    Object.defineProperty(el, 'innerHTML', {
      get() {
        return el._text;
      },
      set(value) {
        el.children = [];
        parseFragment(String(value ?? ''), createElement).forEach((node) => el.appendChild(node));
      },
    });

    return el;
  }

  const documentElement = createElement('html');
  documentElement.isConnected = true;
  const body = createElement('body');
  body.isConnected = true;
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    activeElement: null,
    createElement,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    getElementById(id) {
      let found = null;
      const visit = (node) => {
        if (node.id === id) {
          found = node;
          return true;
        }
        return walk(node, visit);
      };
      visit(documentElement);
      return found;
    },
  };

  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  function matchMedia(query) {
    return {
      matches: String(query).includes('prefers-reduced-motion'),
      addEventListener() {},
      removeEventListener() {},
    };
  }

  return { document, MutationObserver, matchMedia };
}
