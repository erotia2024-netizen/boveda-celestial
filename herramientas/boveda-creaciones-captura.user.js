// ==UserScript==
// @name         Bóveda Celestial · Captura de Creations
// @namespace    boveda-celestial
// @version      2.1
// @description  Rastrea la galería entera de Creations, baja portadas y capturas de cada mod (con su JSON de datos) y lo empaqueta todo en un ZIP
// @author       Bóveda Celestial
// @homepageURL  https://github.com/erotia2024-netizen/boveda-celestial
// @downloadURL  https://raw.githubusercontent.com/erotia2024-netizen/boveda-celestial/main/herramientas/boveda-creaciones-captura.user.js
// @updateURL    https://raw.githubusercontent.com/erotia2024-netizen/boveda-celestial/main/herramientas/boveda-creaciones-captura.user.js
// @match        *://*.bethesda.net/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      ugcmods.bethesda.net
// @connect      api.bethesda.net
// @connect      bethesda.net
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";
  /* Con un @grant puesto, Tampermonkey me mete en su caja: `window` ya no es
     el de la web. Mis cosas van en el de verdad (unsafeWindow) para que sigan
     siendo alcanzables desde la consola y para el candado de doble carga. */
  const WIN = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : window;
  if (WIN.__bovedaCaptura) return;
  WIN.__bovedaCaptura = true;

  /* ================= 1. escuchar lo que pide la web ================= */

  const PET = [];            /* respuestas de Creations que nos interesan, con su json */
  const MAX_PET = 500;
  const IMGS = [];           /* TODO lo que huele a imagen: url + tipo (para aprender el patrón del CDN) */
  const MAX_IMGS = 800;
  const VISTAS = [];         /* TODAS las peticiones que hace la web: el sondeo */
  const MAX_VISTAS = 900, MUESTRAS = 40;
  let muestras = 0;

  /* La web cambia de endpoint cuando le da la gana (bethesda.net ->
     creations.bethesda.net, y lo que venga). Así que ya no filtramos por URL:
     miramos la FORMA de la respuesta. Si trae una ristra de objetos con pinta
     de mod, es la lista de la galería; si trae uno solo con título y
     categorías, es la ficha. Y de todas formas apuntamos la URL de todo lo que
     se pide, para poder mirar el sondeo cuando algo no cuadre. */
  const URL_CONOCIDA = (url) => /(ugcmods|api\.bethesda|graphql|creations\.bethesda)/i.test(String(url || ""));
  const BASURA = /\.(js|mjs|css|png|jpe?g|webp|gif|svg|woff2?|ttf|mp4|webm|ico|map)(\?|$)/i;
  const PISTAS_MOD = ["hardware_platforms", "categories", "content_id", "required_mods", "release_notes", "author_displayname", "overview", "stats", "preview_image"];
  const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* cuánto se parece un objeto a un mod: 0 = nada, 6 = canta solo */
  function pintaMod(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return 0;
    const titulo = o.title || o.name;
    let p = 0;
    for (const k of PISTAS_MOD) if (k in o) p++;
    let n = (typeof titulo === "string" && titulo.length > 1) ? 1 : 0;
    if (p >= 2) n += 2;
    if (p >= 4) n += 2;
    if (RE_UUID.test(String(o.content_id || ""))) n += 1;
    return n;
  }

  /* el mejor array de mods que haya dentro de un json */
  function hallazgo(json) {
    if (!json || typeof json !== "object") return null;
    let listas = [];
    try { arrays(json, "", listas, 0); } catch (e) { return null; }
    let mejor = null;
    for (const g of listas) {
      if (!g.arr || g.arr.length < 1) continue;
      let puntos = 0, n = 0;
      for (let i = 0; i < Math.min(g.arr.length, 8); i++) {
        const p = pintaMod(g.arr[i]);
        if (p) { puntos += p; n++; }
      }
      if (!n) continue;
      const pinta = puntos / n;
      if (pinta < 2.5) continue;
      const valor = pinta + Math.min(g.arr.length, 200) * 0.02;
      if (!mejor || valor > mejor.valor) mejor = { ruta: g.ruta, n: g.arr.length, pinta: Math.round(pinta * 10) / 10, valor, tipo: g.arr.length > 1 ? "lista" : "ficha" };
    }
    if (mejor) { delete mejor.valor; return mejor; }
    /* algunas fichas vienen como UN solo objeto, sin array: lo cazamos igual */
    const sueltos = [];
    (function camina(o, ruta, prof) {
      if (prof > 4 || !o || typeof o !== "object") return;
      if (Array.isArray(o)) { for (let i = 0; i < Math.min(o.length, 2); i++) camina(o[i], ruta + "[" + i + "]", prof + 1); return; }
      const p = pintaMod(o);
      if (p >= 4) sueltos.push({ ruta: ruta, p: p });
      for (const k of Object.keys(o)) camina(o[k], ruta ? ruta + "." + k : k, prof + 1);
    })(json, "", 0);
    sueltos.sort((a, b) => b.p - a.p || a.ruta.length - b.ruta.length);
    return sueltos.length ? { ruta: sueltos[0].ruta, n: 1, pinta: sueltos[0].p, tipo: "ficha" } : null;
  }

  function cabecerasAObjeto(h) {
    const o = {};
    if (!h) return o;
    try {
      if (typeof h.forEach === "function") h.forEach((v, k) => { o[k] = v; });
      else for (const k of Object.keys(h)) o[k] = h[k];
    } catch (e) {}
    return o;
  }

  function guarda(url, metodo, cuerpo, cabeceras, texto, estado, tipo) {
    const u = String(url || "");
    if (!u || /^(data|blob):/i.test(u) || /boveda-captura/i.test(u)) return;
    try { apuntaImagen(u, tipo, estado); } catch (e) {}
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (e) {}
    const h = json ? hallazgo(json) : null;
    const bytes = texto ? texto.length : 0;
    if (!BASURA.test(u) && VISTAS.length < MAX_VISTAS) {
      const v = { url: u, metodo: metodo || "GET", estado: estado || 0, tipo: String(tipo || "").split(";")[0], kb: Math.round(bytes / 1024) };
      if (h) v.forma = h.tipo + " · " + h.n + " · " + h.ruta + " · pinta " + h.pinta;
      if (!json && !h && bytes > 1500 && muestras < MUESTRAS) { v.muestra = texto.slice(0, 400).replace(/\s+/g, " "); muestras++; }
      VISTAS.push(v);
    }
    if (!json) return;
    if (!h && !URL_CONOCIDA(u)) return;
    if (PET.length >= MAX_PET) return;
    PET.push({ url: u, metodo: metodo || "GET", cuerpo: typeof cuerpo === "string" ? cuerpo : "", cabeceras: cabeceras || {}, json: json, forma: h ? h.ruta + " (" + h.n + " " + h.tipo + ")" : "" });
    try { avisoJson(); } catch (e) {}
  }

  (function enganchar() {
    try {
      const f = window.fetch;
      if (typeof f === "function" && !f.__boveda) {
        const env = function (entrada, init) {
          const u = typeof entrada === "string" ? entrada : (entrada && entrada.url) || "";
          const m = (init && init.method) || (entrada && entrada.method) || "GET";
          const c = init && init.body ? (typeof init.body === "string" ? init.body : "") : "";
          const h = cabecerasAObjeto((init && init.headers) || (entrada && entrada.headers));
          const p = f.apply(this, arguments);
          try {
            p.then((r) => {
              try {
                const tipo = r.headers && r.headers.get ? r.headers.get("content-type") : "";
                const cl = r.headers && r.headers.get ? r.headers.get("content-length") : "";
                if (cl && +cl > 4000000) { guarda(u, m, c, h, "", r.status, tipo); return; }
                r.clone().text().then((t) => guarda(u, m, c, h, t, r.status, tipo)).catch(() => {});
              } catch (e) {}
            }).catch(() => {});
          } catch (e) {}
          return p;
        };
        env.__boveda = true;
        window.fetch = env;
      }
    } catch (e) {}
    try {
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      const setH = XMLHttpRequest.prototype.setRequestHeader;
      if (!open.__boveda) {
        XMLHttpRequest.prototype.open = function (m, u) { this.__bu = u; this.__bm = m; this.__bh = {}; return open.apply(this, arguments); };
        XMLHttpRequest.prototype.open.__boveda = true;
        XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__bh[k] = v; } catch (e) {} return setH.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (data) {
          try {
            const u = this.__bu, m = this.__bm, h = this.__bh, c = typeof data === "string" ? data : "";
            this.addEventListener("load", () => {
              try {
                const tipo = this.getResponseHeader ? this.getResponseHeader("content-type") : "";
                guarda(u, m, c, h, this.responseText, this.status, tipo);
              } catch (e) {}
            });
          } catch (e) {}
          return send.apply(this, arguments);
        };
      }
    } catch (e) {}
  })();

  /* ================= 1b. las imágenes de la web =================
     Las imágenes NO pasan por fetch/XHR (las <img> las pide el navegador
     solo), así que además de mirar en `guarda` escuchamos los recursos de la
     página con PerformanceObserver. Con `buffered` pillamos también todo lo
     que se cargó antes de que el script despertara. Lo que persigo aquí es
     apuntar las URLs reales (las firmadas del CDN, que es lo único que sirve)
     y aprender su patrón, porque el JSON de la ficha solo trae el s3key. */

  const RE_TIPO_IMG = /(image|media|cover|screenshot|ugcmods|cdn|cloudfront|imgix)/i;
  const RE_EXT_IMG = /\.(png|jpe?g|webp|gif|avif|bmp)(\?|$)/i;
  const RE_NO_IMG = /\.(mp4|webm|mov|m4v|js|mjs|css|json|woff2?|ttf|otf|map|ico|svg)(\?|$)/i;

  function apuntaImagen(url, tipo, estado) {
    const u = String(url || "");
    if (!u || /^(data|blob):/i.test(u) || /boveda-captura/i.test(u)) return;
    if (RE_NO_IMG.test(u)) return;
    if (!RE_TIPO_IMG.test(u) && !RE_EXT_IMG.test(u)) return;
    for (const x of IMGS) if (x.url === u) return;
    if (IMGS.length >= MAX_IMGS) IMGS.shift();
    IMGS.push({ url: u, tipo: String(tipo || "").split(";")[0], estado: estado || 0, cuando: Date.now() });
  }

  try {
    const po = new PerformanceObserver((l) => {
      try { for (const e of l.getEntries()) if (e && e.name && e.initiatorType !== "script" && e.initiatorType !== "link") apuntaImagen(e.name, "", 0); } catch (err) {}
    });
    po.observe({ type: "resource", buffered: true });
  } catch (e) {}

  /* ================= 2. utilidades ================= */

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const limpia = (t) =>
    (t || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  let cacheRaices = null, cacheT = 0;
  function raices() {
    const ahora = Date.now();
    if (cacheRaices && ahora - cacheT < 5000) return cacheRaices;
    const out = [document];
    try { for (const el of document.querySelectorAll("*")) if (el.shadowRoot) out.push(el.shadowRoot); } catch (e) {}
    cacheRaices = out; cacheT = ahora;
    return out;
  }

  function buscar(selector) {
    const out = [], vistos = new Set();
    for (const r of raices()) {
      let lista = [];
      try { lista = r.querySelectorAll(selector); } catch (e) { continue; }
      for (const el of lista) { if (vistos.has(el)) continue; vistos.add(el); out.push(el); }
    }
    return out;
  }

  function textoPagina() {
    const t = limpia((document.body && document.body.innerText) || "");
    if (t.length >= 300) return t;
    const partes = [];
    for (const r of raices()) { if (r === document || !r.host) continue; partes.push(limpia(r.host.innerText)); }
    return limpia(partes.join("\n\n")) || t;
  }

  function scroller() {
    const sc = document.scrollingElement || document.documentElement;
    if (sc && sc.scrollHeight > sc.clientHeight + 60) return sc;
    const todos = buscar("div, main, section, ul");
    let mejor = sc, max = 0;
    for (let i = 0; i < todos.length && i < 2500; i++) {
      const el = todos[i];
      const d = el.scrollHeight - el.clientHeight;
      if (d <= max + 40) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") { max = d; mejor = el; }
    }
    return mejor;
  }

  function ponScroll(el, y) { try { el.scrollTo(0, y); } catch (e) { el.scrollTop = y; } }

  function tarjetas() {
    const cand = buscar("div, li, article, section");
    let mejor = null;
    for (let i = 0; i < cand.length && i < 4000; i++) {
      const el = cand[i];
      const n = el.children.length;
      if (n < 4 || n > 80) continue;
      const textos = [];
      let ok = true;
      for (const k of el.children) {
        const t = (k.innerText || "").trim();
        if (!t) { ok = false; break; }
        textos.push(t);
      }
      if (!ok) continue;
      const lens = textos.map((t) => t.length);
      const media = lens.reduce((a, b) => a + b, 0) / lens.length;
      if (media < 14 || media > 420) continue;
      const disp = lens.reduce((a, b) => a + Math.abs(b - media), 0) / lens.length;
      if (disp > media * 0.75) continue;
      const score = n - (disp / media) * 10;
      if (!mejor || score > mejor.score) mejor = { textos, score };
    }
    return mejor;
  }

  /* ================= 3. ficha ================= */

  const CATS = ["Animals", "Armor", "Audio", "Buildings", "Characters", "Cheats", "Clothing", "Collectibles",
    "Crafting", "Creatures", "Environmental", "Foliage", "Followers", "Gameplay", "Gear", "Graphics",
    "Hair and Face", "Homes", "Immersion", "Items and Objects - Player", "Items and Objects - World",
    "Landscape", "Load Order Neutral", "Lore Friendly", "Miscellaneous", "Modder Resources/Tutorials",
    "Models and Textures", "NPCs", "Overhaul", "Patches", "Perks", "Quests", "Races", "Skills and Leveling",
    "Towns", "UI", "Utilities", "Visuals", "Weapons", "Work-In-Progress", "World"];

  const esFicha = () => /\/details\//i.test(location.pathname);

  /* Etiquetas de la ficha, en español e inglés. Se usan igual en la pantalla
     (bloqueFicha) y en el HTML que nos descargamos de cada mod, así que van en
     una tabla: si la web cambia una etiqueta, se toca aquí y ya. */
  const ETIQUETAS_FICHA = [
    ["autor", ["por", "by"]],
    ["likes", ["ME GUSTA", "LIKES"]],
    ["marcados", ["MARCADOS", "BOOKMARKS"]],
    ["vistas", ["VISTAS", "VIEWS"]],
    ["reproducciones", ["REPRODUCCIONES", "PLAYS"]],
    ["version", ["VERSIÓN", "VERSION"]],
    ["tamano", ["TAMAÑO DE LA INSTALACIÓN", "INSTALL SIZE"]],
    ["tamanoDescarga", ["TAMAÑO DE LA DESCARGA", "DOWNLOAD SIZE"]],
    ["actualizado", ["ÚLTIMA ACTUALIZACIÓN", "LAST UPDATED"]],
    ["creado", ["CREADO EL", "CREATED"]],
    ["lanzado", ["LANZADO EL", "RELEASED"]],
    ["idioma", ["IDIOMA", "LANGUAGE"]],
    ["requisitos", ["REQUIERE", "REQUIRES"]],
    ["categorias", ["CATEGORÍA", "CATEGORY"]]
  ];

  /* Busca una etiqueta y devuelve lo que hay justo debajo, en cualquier
     documento (el de la pantalla o uno descargado y parseado). */
  function valorTrasDoc(doc, etiquetas, raiz) {
    const objs = etiquetas.map((e) => String(e).toLowerCase());
    const nodos = (raiz || doc || document).querySelectorAll("*");
    for (const el of nodos) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim().toLowerCase();
      if (objs.indexOf(t) < 0) continue;
      /* 1) en la pantalla hay innerText de verdad: la etiqueta y su valor caen
            en líneas separadas dentro del mismo bloque. */
      let cont = el.parentElement;
      for (let salto = 0; salto < 3 && cont; salto++) {
        const bruto = (cont.innerText != null && cont.innerText) ? cont.innerText : "";
        const lineas = bruto ? limpia(bruto).split("\n").map((s) => s.trim()).filter(Boolean) : [];
        if (lineas.length > 1) {
          const i = lineas.findIndex((l) => l.toLowerCase() === t);
          if (i >= 0 && lineas[i + 1]) return lineas[i + 1];
        }
        cont = cont.parentElement;
      }
      /* 2) HTML descargado y parseado (sin innerText): el valor suele ser el
            hermano siguiente de la etiqueta. */
      let her = el.nextElementSibling;
      while (her && !(her.textContent || "").trim()) her = her.nextElementSibling;
      if (her) {
        const v = limpia(her.textContent).split("\n")[0].trim();
        if (v) return v;
      }
      /* 3) último recurso: lo que venga justo después de la etiqueta. */
      const padre = el.parentElement;
      if (padre) {
        const todo = limpia(padre.textContent || "");
        const i = todo.toLowerCase().indexOf(t);
        if (i >= 0) {
          const resto = todo.slice(i + t.length).replace(/^[\s:·–—-]+/, "").trim();
          if (resto) return resto.split(/\n/)[0].replace(/\s{2,}/g, " ").trim();
        }
      }
      return "";
    }
    return "";
  }

  function valorTras(etiqueta) {
    for (const r of raices()) {
      const v = valorTrasDoc(document, [etiqueta], r);
      if (v) return v;
    }
    return "";
  }

  /* Todos los campos de una ficha, leídos de un documento ya cargado. */
  function camposDeDoc(doc, raiz) {
    const o = {};
    for (const [k, etq] of ETIQUETAS_FICHA) {
      const v = valorTrasDoc(doc, etq, raiz);
      if (v) o[k] = v;
    }
    return o;
  }

  const uuidFicha = () => (location.pathname.match(/details\/([0-9a-f-]{36})/i) || ["", ""])[1];

  function pistasCat() {
    const out = [];
    for (const el of buscar("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (CATS.indexOf(t) < 0) continue;
      const clase = el.className && typeof el.className === "string" ? el.className : "";
      const attrs = [...el.attributes].filter((a) => /^aria-|^data-/.test(a.name)).map((a) => a.name + "=" + a.value).join(" ");
      const p = el.parentElement;
      const pclase = p && typeof p.className === "string" ? p.className : "";
      const hermanos = p ? [...p.children].filter((c) => c !== el).map((c) => (c.textContent || "").trim().slice(0, 24)).filter(Boolean).slice(0, 8).join(" | ") : "";
      out.push("<" + el.tagName.toLowerCase() + ' class="' + clase + '"' + (attrs ? " " + attrs : "") + "> :: padre <" + (p ? p.tagName.toLowerCase() : "-") + ' class="' + pclase + '"> :: hermanos: ' + hermanos);
    }
    return out;
  }

  function imagenes() {
    const out = [];
    for (const el of buscar("img, svg, [aria-label]")) {
      const src = el.getAttribute && (el.getAttribute("src") || el.getAttribute("href") || el.getAttribute("xlink:href") || "");
      const alt = (el.getAttribute && (el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title"))) || "";
      const t = src || alt;
      if (!t || t.length > 200) continue;
      out.push(el.tagName.toLowerCase() + " :: " + t + (alt && alt !== t ? " :: " + alt : ""));
    }
    return out.slice(0, 60);
  }

  function bloqueFicha() {
    const h1 = buscar("h1")[0];
    const campos = [
      ["titulo", (h1 && limpia(h1.textContent)) || (document.title || "").replace(/^Creaciones de Skyrim - /i, "")],
      ["url", location.href],
      ["uuid", uuidFicha()]
    ];
    const leidos = camposDeDoc(document);
    for (const k of Object.keys(leidos)) campos.push([k, leidos[k]]);
    let out = "=== FICHA ===\n";
    for (const [k, v] of campos) out += k + ": " + v + "\n";
    const cat = pistasCat();
    out += "\n=== PISTAS DE CATEGORIA (" + cat.length + ") ===\n" + (cat.length ? cat.join("\n") + "\n" : "(ninguna categoría oficial escrita)\n");
    const im = imagenes();
    out += "\n=== IMAGENES Y ETIQUETAS (" + im.length + ") ===\n" + im.join("\n") + (im.length ? "\n" : "");
    return out;
  }

  /* ================= 4. capturas de pantalla ================= */

  function cabecera() {
    return "=== BOVEDA CAPTURA ===\nurl: " + location.href + "\ntitulo: " + document.title +
      "\nfecha: " + new Date().toISOString() + "\nventana: " + innerWidth + "x" + innerHeight +
      "\npeticiones guardadas: " + PET.length + "\n\n";
  }

  function capturaPantalla() {
    const t = tarjetas();
    let out = cabecera();
    if (esFicha()) out += bloqueFicha() + "\n";
    if (t) {
      out += "=== TARJETAS (" + t.textos.length + ") ===\n";
      t.textos.forEach((txt, i) => { out += "\n# " + (i + 1) + "\n" + limpia(txt) + "\n"; });
      out += "\n=== FIN TARJETAS ===\n\n";
    } else out += "=== TARJETAS ===\n(no reconocí una rejilla de tarjetas)\n\n";
    return out + "=== TEXTO COMPLETO DE LA PAGINA ===\n" + textoPagina() + "\n";
  }

  async function capturaTotal(progreso) {
    const el = scroller();
    const alto = el.clientHeight || innerHeight;
    const paso = Math.max(200, Math.floor(alto * 0.8));
    const vistos = new Map();
    const recoge = () => {
      const t = tarjetas();
      if (!t) return 0;
      let nuevos = 0;
      for (const txt of t.textos) {
        const clave = limpia(txt).replace(/\s+/g, " ").slice(0, 120).toLowerCase();
        if (!clave || vistos.has(clave)) continue;
        vistos.set(clave, limpia(txt)); nuevos++;
      }
      return nuevos;
    };
    recoge();
    let iter = 0, quieto = 0;
    while (iter++ < 500) {
      const total = el.scrollHeight;
      const abajo = el.scrollTop + el.clientHeight >= total - 4;
      if (abajo) {
        const n = recoge();
        progreso && progreso(iter, vistos.size, "final");
        if (n === 0) { if (++quieto >= 3) break; } else quieto = 0;
        await dormir(700); ponScroll(el, total); continue;
      }
      ponScroll(el, el.scrollTop + paso);
      await dormir(450);
      recoge(); quieto = 0;
      progreso && progreso(iter, vistos.size, Math.round((el.scrollTop / Math.max(1, total - alto)) * 100) + "%");
    }
    ponScroll(el, 0);
    if (!vistos.size) return null;
    let out = cabecera() + "=== TARJETAS (" + vistos.size + ") ===\n";
    let i = 0;
    for (const txt of vistos.values()) out += "\n# " + (++i) + "\n" + txt + "\n";
    return out + "\n=== TEXTO COMPLETO DE LA PAGINA (vista final) ===\n" + textoPagina() + "\n";
  }

  /* ================= 5. rastreo de la lista ================= */

  function arrays(o, ruta, out, prof) {
    if (prof > 4 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      if (o.length && typeof o[0] === "object") out.push({ ruta, arr: o });
      for (let i = 0; i < Math.min(o.length, 2); i++) arrays(o[i], ruta + "[" + i + "]", out, prof + 1);
      return;
    }
    for (const k of Object.keys(o)) arrays(o[k], ruta ? ruta + "." + k : k, out, prof + 1);
  }

  function arrayGrande(json) {
    const out = [];
    arrays(json, "", out, 0);
    out.sort((a, b) => b.arr.length - a.arr.length);
    return out[0] || null;
  }

  function claveMod(m) {
    if (!m || typeof m !== "object") return "";
    for (const k of ["content_id", "id", "modId", "uuid", "creationId", "slug", "name", "title"]) {
      const v = m[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number" && v) return String(v);
    }
    return "";
  }

  const PARAM_PAGINA = /^(page|pagina|p|pageNumber|pageNum|offset|start|startIndex|skip|index|from|currentPage)$/i;

  /* Elige la petición de la galería: la última que devolvió una lista de mods.
     Prefiere la que lleve un parámetro de página en la URL; si ninguna lo
     lleva (la web nueva puede paginar de otra forma), devuelve igualmente la
     última lista vista y ya se busca el parámetro a mano. */
  function candidato() {
    let conParam = null, sinParam = null;
    for (let i = PET.length - 1; i >= 0; i--) {
      const r = PET[i];
      if (!r.json) continue;
      const g = hallazgo(r.json);
      if (!g || g.tipo !== "lista" || g.n < 2) continue;
      let u;
      try { u = new URL(r.url); } catch (e) { continue; }
      let param = null;
      for (const [k, v] of u.searchParams) if (PARAM_PAGINA.test(k) && /^\d+$/.test(v)) { param = k; break; }
      const base = { peticion: r, url: r.url, desde: param ? +u.searchParams.get(param) : 1, ruta: g.ruta, n: g.n };
      if (param && !conParam) conParam = Object.assign({ param: param }, base);
      if (!param && !sinParam) sinParam = Object.assign({ param: null }, base);
    }
    return conParam || sinParam || null;
  }

  /* Si la lista no traía parámetro de página, probamos los nombres típicos
     pidiendo la página 2 y viendo si devuelve mods distintos. */
  /* Saca del json el array que hay en la ruta que devolvió hallazgo
     (por ejemplo platform.response.data o algo[0].items). */
  function enRuta(json, ruta) {
    if (!ruta) return json;
    let o = json;
    for (const paso of String(ruta).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
      if (o == null) return null;
      o = o[paso];
    }
    return o || null;
  }

  /* La web nueva puede pedir la lista por POST (con el número de página dentro
     del cuerpo). Repetir eso como GET no devuelve nada, así que repetimos la
     petición TAL CUAL la hizo ella: mismo método, mismas cabeceras y el mismo
     cuerpo, cambiando solo el número de página. */
  const CABECERAS_PROHIBIDAS = /^(content-length|host|connection|accept-encoding|cookie|origin|referer|user-agent|te|trailer|transfer-encoding|upgrade|proxy-|sec-|dnt)$/i;
  const NOMBRE_PAGINA_CUERPO = /^(page|pagina|p|pageNumber|pageNum|page_index|currentPage|pageno|pagenumber|offset|skip|start|from)$/i;

  function esPost(p) {
    if (!p) return false;
    if (String(p.metodo || "GET").toUpperCase() === "POST") return true;
    return !!(p.cuerpo && String(p.cuerpo).trim());
  }

  /* El número de página también puede ir dentro del TEXTO de una consulta
     (GraphQL: {"query":"... page: 1 ...","variables":{}}), no en un campo
     suelto del json. Estos son los nombres que buscamos ahí. */
  const RE_TXT_PAGINA = /((?:"|')?(?:page|pagina|pageNumber|pageNum|currentPage|pageno|pagenumber|offset|skip|start|from)(?:"|')?\s*[:=]\s*"?)(\d+)/;

  /* mete el número de página en el cuerpo (json) y dice en qué campo estaba */
  function cuerpoConPagina(cuerpo, n) {
    if (typeof cuerpo !== "string" || !cuerpo.trim()) return { cuerpo: cuerpo, param: null };
    let param = null;
    try {
      const j = JSON.parse(cuerpo);
      (function camina(o, prof) {
        if (!o || typeof o !== "object" || prof > 8) return;
        if (Array.isArray(o)) { for (const x of o) camina(x, prof + 1); return; }
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (NOMBRE_PAGINA_CUERPO.test(k) && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) {
            o[k] = typeof v === "number" ? n : String(n);
            if (!param) param = k;
          } else camina(v, prof + 1);
        }
      })(j, 0);
      if (param) return { cuerpo: JSON.stringify(j), param: param };
    } catch (e) {}
    const re = new RegExp(RE_TXT_PAGINA.source, "gi");
    let primero = null;
    const salida = cuerpo.replace(re, function (todo, pre, num) {
      const clave = (String(pre).match(/[A-Za-z]+/) || [""])[0];
      if (!primero) primero = clave;
      const cero = /^(offset|skip|start|from)$/i.test(clave);
      return pre + (cero ? Math.max(0, (n - 1) * 20) : n);
    });
    return primero ? { cuerpo: salida, param: primero } : { cuerpo: cuerpo, param: null };
  }

  /* repite la petición capturada con el número de página que le digamos */
  async function pide(c, url, n) {
    const p = (c && c.peticion) || {};
    const cab = {};
    for (const k of Object.keys(p.cabeceras || {})) if (!CABECERAS_PROHIBIDAS.test(k)) cab[k] = p.cabeceras[k];
    const opciones = { credentials: "include", headers: cab };
    if (esPost(p)) {
      opciones.method = "POST";
      opciones.body = cuerpoConPagina(p.cuerpo, n).cuerpo;
    }
    return await fetch(url, opciones);
  }

  const NOMBRES_PAGINA = ["page", "pagina", "p", "pageNumber", "pageNum", "currentPage", "pageno", "pagenumber"];
  async function descubrirParam(c, progreso) {
    const base = new URL(c.url);
    if (base.searchParams.get("page")) return "page";
    /* si fue POST y la página va en el cuerpo, ya lo sabemos sin probar nada */
    if (esPost(c.peticion)) {
      const enCuerpo = cuerpoConPagina(c.peticion.cuerpo, 2);
      if (enCuerpo.param) return enCuerpo.param;
    }
    const g0 = hallazgo(c.peticion.json);
    const arr0 = (g0 ? enRuta(c.peticion.json, g0.ruta) : null) || [];
    const primeros = arr0.slice(0, 3).map((m) => claveMod(m)).join("|");
    for (const nom of NOMBRES_PAGINA) {
      const u = new URL(base.toString());
      u.searchParams.set(nom, "2");
      progreso && progreso(u.toString());
      let j = null;
      try {
        const r = await pide(c, u.toString(), 2);
        if (!r.ok) continue;
        j = await r.json();
      } catch (e) { continue; }
      const g = hallazgo(j);
      if (!g || g.tipo !== "lista" || !g.n) continue;
      const arr = enRuta(j, g.ruta) || [];
      const otros = arr.slice(0, 3).map((m) => claveMod(m)).join("|");
      if (otros && otros !== primeros) return nom;
      await dormir(200);
    }
    return null;
  }

  /* resumen de las peticiones con pinta de lista, para el mensaje de error */
  function pistasLista() {
    const vistas = [];
    for (let i = PET.length - 1; i >= 0 && vistas.length < 3; i--) {
      const r = PET[i];
      const g = hallazgo(r.json);
      if (!g || g.tipo !== "lista") continue;
      const cuerpo = r.cuerpo ? " · cuerpo: " + String(r.cuerpo).replace(/\s+/g, " ").slice(0, 200) : "";
      vistas.push(String(r.metodo || "GET") + " " + String(r.url).slice(0, 120) + " · " + g.n + " mods" + cuerpo);
    }
    return vistas;
  }

  async function rastrear(progreso, control) {
    const c = candidato();
    if (!c) {
      /* sin API a la vista: la galería se lee del DOM scrolleando */
      progreso && progreso(0, 0, 0, "lista (dom)");
      return await rastrearDOM(progreso, control);
    }
    if (!c.param) {
      progreso && progreso(0, 0, 0, "buscando la paginación");
      const nom = await descubrirParam(c, (u) => progreso && progreso(0, 0, 0, "probando " + u.split("?")[1]));
      if (!nom) {
        const pistas = pistasLista();
        return { error: "La lista vino sin parámetro de página (ni en la URL ni en el cuerpo) y no di con él.<br>Últimas listas vistas:<br>" + (pistas.length ? pistas.join("<br>") : "ninguna") + "<br>Pulsa «Ver peticiones (sondeo)» y mándame ese archivo." };
      }
      c.param = nom; c.desde = 1;
    }
    const base = new URL(c.url);
    const desde = control && control.desde ? control.desde : c.desde;
    const vistos = new Map();
    const paginas = [];
    let repetidas = 0;
    for (let n = desde; n < desde + 500; n++) {
      if (control && control.parar) break;
      const u = new URL(base.toString());
      u.searchParams.set(c.param, String(n));
      let j = null, estado = 0;
      try {
        const r = await pide(c, u.toString(), n);
        estado = r.status;
        if (!r.ok) { if (!paginas.length) return { error: "La web contestó " + r.status + " al repetir su petición." }; break; }
        j = await r.json();
      } catch (e) {
        if (!paginas.length) return { error: "No pude repetir la petición: " + (e && e.message) };
        break;
      }
      const g = arrayGrande(j);
      const arr = g ? g.arr : [];
      paginas.push({ pagina: n, url: u.toString(), estado, items: arr.length, json: j });
      let nuevos = 0;
      for (const m of arr) {
        const k = claveMod(m);
        if (!k) continue;
        if (vistos.has(k)) { repetidas++; continue; }
        vistos.set(k, m); nuevos++;
      }
      progreso && progreso(n - desde + 1, vistos.size, arr.length, "lista");
      if (!arr.length) { if (++repetidas >= 3) break; }
      else if (n > desde + 2 && nuevos === 0) break;
      await dormir(400);
    }
    if (!vistos.size) {
      /* La petición se repitió, pero no salió ni un mod. Antes de rendirnos,
         leemos lo que haya en pantalla y lo juntamos. */
      const dom = await rastrearDOM(progreso, control);
      for (const m of dom.mods || []) if (m && m.content_id && !vistos.has(m.content_id)) vistos.set(m.content_id, m);
      if (!vistos.size) {
        return { error: "Repetí la petición de la galería y no salió ni un mod, y en la pantalla tampoco veo tarjetas. Pulsa «Ver peticiones (sondeo)» y mándame lo que descargue: con eso veo qué pide esta pestaña." };
      }
      return {
        info: { fuente: "dom", urlBase: location.href, param: "(scroll)", desde: 1, ruta: "DOM", paginas: 0, mods: vistos.size, repetidas: 0, capturado: new Date().toISOString() },
        mods: [...vistos.values()], paginas: [], crudo: [],
      };
    }
    return {
      info: { urlBase: c.url, param: c.param, desde: desde, ruta: c.ruta, paginas: paginas.length, mods: vistos.size, repetidas, capturado: new Date().toISOString() },
      mods: [...vistos.values()],
      paginas: paginas.map((p) => ({ pagina: p.pagina, url: p.url, estado: p.estado, items: p.items })),
      crudo: paginas.map((p) => ({ pagina: p.pagina, json: p.json })),
    };
  }

  /* ================= 6. ficha de cada mod, en paralelo ================= */

  const ES_UUID = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

  function modeloDetalle() {
    for (let i = PET.length - 1; i >= 0; i--) {
      const r = PET[i];
      if (!r.json) continue;
      const mu = r.url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (mu) return { peticion: r, marca: mu[0], tipo: "uuid", sitio: "url" };
      const mp = r.url.match(/[?&](modId|mod_id|id|creationId)=([\w-]+)/i);
      if (mp) return { peticion: r, marca: mp[2], tipo: mp[1], sitio: "url" };
      if (r.cuerpo) {
        const mc = r.cuerpo.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (mc) return { peticion: r, marca: mc[0], tipo: "uuid", sitio: "cuerpo" };
      }
    }
    return null;
  }

  function idDe(mod, tipo) {
    if (!mod || typeof mod !== "object") return "";
    if (tipo === "uuid") {
      for (const k of Object.keys(mod)) if (ES_UUID(mod[k])) return mod[k];
      for (const k of Object.keys(mod)) if (mod[k] && typeof mod[k] === "object") { for (const k2 of Object.keys(mod[k])) if (ES_UUID(mod[k][k2])) return mod[k][k2]; }
      return "";
    }
    for (const k of [tipo, "modId", "id", "creationId", "uuid"]) if (mod[k]) return String(mod[k]);
    return "";
  }

  function peticionFicha(modelo, mod) {
    const id = idDe(mod, modelo.tipo);
    if (!id) return null;
    if (modelo.sitio === "cuerpo") {
      return { url: modelo.peticion.url, opciones: { method: modelo.peticion.metodo, headers: modelo.peticion.cabeceras, body: modelo.peticion.cuerpo.split(modelo.marca).join(id) } };
    }
    return { url: modelo.peticion.url.split(modelo.marca).join(encodeURIComponent(id)), opciones: { method: modelo.peticion.metodo, headers: modelo.peticion.cabeceras } };
  }

  /* El dueño no siempre ha abierto una ficha antes de lanzar el ZIP, y sin esa
     petición capturada no había plantilla de ficha (y el camino HTML no sirve:
     la web nueva se pinta sola, de ahí el «Fichas descargadas: 0»). Así que, si
     no hay plantilla, pruebo yo las direcciones típicas del detalle derivadas
     de la del listado, con las credenciales de la pestaña. */
  async function tantearFicha(lista, di) {
    const base = String(((lista && lista.info) || {}).urlBase || "").split("?")[0].replace(/\/+$/, "");
    const primero = ((lista && lista.mods) || [])[0] || {};
    const uuid = idDe(primero, "uuid") || primero.content_id || "";
    if (!/^https?:/i.test(base) || !uuid) return null;
    const cands = [
      base + "/" + uuid,
      base + "/" + uuid + "?product=SKYRIM",
      base + "?content_id=" + uuid,
      base + "/detail/" + uuid,
    ];
    for (const u of cands) {
      const corta = u.replace(/^https?:\/\//, "").slice(0, 96);
      if (di) di("Paso 2/4 · probando la ficha en <b>" + corta + "</b>…");
      await dormir(150);
      let j = null;
      try {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) continue;
        j = await r.json();
      } catch (e) { continue; }
      const crudo = (j && j.platform && j.platform.response && j.platform.response.data) || j;
      const dato = Array.isArray(crudo) ? crudo[0] : crudo;
      if (dato && (ES_UUID(dato.content_id || "") || dato.title || (dato.categories || []).length)) {
        if (di) di("Paso 2/4 · ficha localizada en <b>" + corta + "</b>");
        await dormir(700);
        return { peticion: { url: u, metodo: "GET", cabeceras: {} }, marca: uuid, tipo: "uuid", sitio: "url" };
      }
    }
    return null;
  }

  async function bajarFichas(mods, progreso, control, forzado) {
    const modelo = forzado === undefined ? modeloDetalle() : forzado;
    if (!modelo) {
      return {
        modo: "ninguno",
        modelo: { url: "(sin plantilla de ficha)", marca: "", tipo: "", sitio: "ninguno" },
        hechas: [], fallos: [],
        error: "No di con la plantilla de la ficha. No pasa nada: el JSON de la galería ya trae título, autor, categorías, plataformas, likes, descripción, notas y medios de cada mod, y todo eso va en catalogo.json.",
      };
    }
    const hechas = [], fallos = [];
    const CONC = 6;
    for (let i = 0; i < mods.length; i += CONC) {
      if (control && control.parar) break;
      const lote = mods.slice(i, i + CONC);
      await Promise.all(lote.map(async (m) => {
        const p = peticionFicha(modelo, m);
        if (!p) { fallos.push({ mod: claveMod(m), motivo: "sin id" }); return; }
        for (let intento = 0; intento < 2; intento++) {
          try {
            const r = await fetch(p.url, Object.assign({ credentials: "include" }, p.opciones));
            if (!r.ok) { if (intento) fallos.push({ mod: claveMod(m), motivo: "http " + r.status, url: p.url }); continue; }
            const j = await r.json();
            hechas.push({ mod: claveMod(m), url: p.url, json: j });
            return;
          } catch (e) {
            if (intento) fallos.push({ mod: claveMod(m), motivo: String(e && e.message), url: p.url });
            else await dormir(600);
          }
        }
      }));
      progreso && progreso(Math.min(i + CONC, mods.length), mods.length, hechas.length, "fichas");
      await dormir(120);
    }
    return {
      modo: "api",
      modelo: { url: modelo.peticion.url, marca: modelo.marca, tipo: modelo.tipo, sitio: modelo.sitio },
      hechas, fallos,
    };
  }

  /* ======== 6b. camino B: cuando la web no enseña su API ========
     La web nueva pinta las tarjetas en el navegador (a mí me devuelve sólo el
     cascarón), y cada tarjeta lleva su enlace /details/<uuid>/<slug>. Así que
     la lista se lee del DOM scrolleando y cada ficha se descarga como HTML y
     se parsea: las etiquetas de la pantalla y, si hay suerte, el JSON que la
     web lleva incrustado (que suele traer más datos que la propia pantalla). */

  function tarjetasMods() {
    const out = [], vistos = new Set();
    for (const a of buscar('a[href*="/details/"]')) {
      const href = String((a.getAttribute && a.getAttribute("href")) || "");
      const m = href.match(/\/details\/([0-9a-f-]{36})\/?([^/?#]*)/i);
      if (!m || vistos.has(m[1])) continue;
      vistos.add(m[1]);
      const tarjeta = a.closest("div[class*='MuiPaper'], article, li") || a.parentElement || a;
      const txt = limpia(tarjeta.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const titulo = String(a.getAttribute("title") || txt[0] || decodeURIComponent(m[2] || "")).trim();
      const autor = ((txt.find((t) => /^(by|por)\s/i.test(t)) || "").replace(/^(by|por)\s+/i, "")).trim();
      const likes = (txt.find((t) => /^[\d.,]+\s*[KM]?$/i.test(t)) || "").trim();
      const plataformas = [];
      for (const t of tarjeta.querySelectorAll("svg title")) {
        const n = (t.textContent || "").trim();
        if (/^(Xbox|PlayStation|PC Game)$/i.test(n) && plataformas.indexOf(n) < 0) plataformas.push(n);
      }
      let etiqueta = "";
      for (const el of tarjeta.querySelectorAll("div,span")) {
        if (el.children.length) continue;
        const t = (el.textContent || "").trim();
        if (/^(Todos|Xbox|PlayStation|Windows|PC)$/i.test(t)) { etiqueta = t; break; }
      }
      out.push({
        content_id: m[1], legacy_content_id: 0, title: titulo || decodeURIComponent(m[2] || "").replace(/_+/g, " ").trim(),
        author_displayname: autor, likes_texto: likes, plataforma: etiqueta, plataformas: plataformas,
        description: txt.filter((t) => t.length > 80)[0] || "", fuente: "dom",
        url_detalle: href, imagen: imagenDeTarjeta(a) || imagenDeTarjeta(tarjeta),
      });
    }
    return out;
  }

  async function rastrearDOM(progreso, control) {
    const el = scroller();
    const alto = el.clientHeight || innerHeight;
    const paso = Math.max(200, Math.floor(alto * 0.8));
    const mods = new Map();
    const recoge = () => { let n = 0; for (const m of tarjetasMods()) if (!mods.has(m.content_id)) { mods.set(m.content_id, m); n++; } return n; };
    recoge();
    let iter = 0, quieto = 0;
    while (iter++ < 800) {
      if (control && control.parar) break;
      const total = el.scrollHeight;
      const abajo = el.scrollTop + el.clientHeight >= total - 4;
      if (abajo) {
        const n = recoge();
        progreso && progreso(iter, mods.size, 0, "lista (dom)");
        if (n === 0) { if (++quieto >= 4) break; } else quieto = 0;
        await dormir(800); ponScroll(el, total); continue;
      }
      ponScroll(el, el.scrollTop + paso);
      await dormir(420);
      recoge(); quieto = 0;
      progreso && progreso(iter, mods.size, 0, "lista (dom) " + Math.round((el.scrollTop / Math.max(1, total - alto)) * 100) + "%");
    }
    ponScroll(el, 0);
    const lista = [...mods.values()];
    if (!lista.length) {
      return { error: "No veo ninguna lista de mods: ni una petición de la galería (o no la reconozco) ni tarjetas en la pantalla. Pulsa «Ver peticiones (sondeo)» y mándame lo que descargue." };
    }
    return {
      info: { fuente: "dom", urlBase: location.href, param: "(scroll)", desde: 1, ruta: "DOM", paginas: 0, mods: lista.length, repetidas: 0, capturado: new Date().toISOString() },
      mods: lista, paginas: [], crudo: [],
    };
  }

  const localeActual = () => (location.pathname.match(/^\/([a-z]{2}(?:-[A-Za-z]{2})?)\//) || ["", "en"])[1];

  /* El JSON que la web lleva dentro del HTML (__NEXT_DATA__, estado
     precargado...). Muchas veces trae la ficha ENTERA. */
  function jsonIncrustado(html) {
    const trozos = String(html).match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    let mejor = null;
    for (const t of trozos) {
      const cuerpo = t.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
      if (cuerpo.length < 60 || cuerpo.length > 4000000) continue;
      if (cuerpo[0] !== "{" && cuerpo[0] !== "[") continue;
      let j = null;
      try { j = JSON.parse(cuerpo); } catch (e) { continue; }
      const h = hallazgo(j);
      if (!h) continue;
      if (!mejor || h.pinta > mejor.pinta) mejor = { ruta: h.ruta, pinta: h.pinta, tipo: h.tipo, datos: enRuta(j, h.ruta) || j };
    }
    return mejor;
  }

  async function fichaHTML(uuid) {
    const url = location.origin + "/" + localeActual() + "/skyrim/details/" + uuid;
    let html = "";
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return { error: "http " + r.status, url: url };
      html = await r.text();
    } catch (e) { return { error: String((e && e.message) || e), url: url }; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const campos = camposDeDoc(doc);
    const inc = jsonIncrustado(html);
    return { url: url, uuid: uuid, campos: campos, incrustado: inc ? { ruta: inc.ruta, tipo: inc.tipo, datos: inc.datos } : null, html_kb: Math.round(html.length / 1024) };
  }

  /* ================= 6c. las imágenes de cada mod =================
     Tres caminos, de más barato a más caro:
       1) las portadas que la galería ya tiene pintadas (no cuesta nada);
       2) la ficha de cada mod abierta en un iframe oculto (mismo origen, así
          que puedo leer su DOM) para sacar portada + capturas de verdad;
       3) lo que devuelva el CDN al pedir la URL firmada.
     El JSON de la ficha solo trae `s3key` (sin firma), y el CDN contesta 403 a
     las URLs sin firmar, así que la única fuente buena son las URLs que el
     navegador ya cargó (de ahí el PerformanceObserver) o las del iframe. */

  const PESO_REENCODE = 300 * 1024;         /* a partir de aquí se recodifica a JPEG */
  const PESO_MAX_IMG = 12 * 1024 * 1024;    /* ninguna imagen suelta más grande */
  const PESO_MAX_TOTAL = 380 * 1024 * 1024; /* tope del lote entero */
  const MAX_IMG_POR_MOD = 8;                /* portada + hasta 7 capturas */
  const ANCHO_MAX = 1440;                   /* ancho máximo al recodificar */
  const CALIDAD = 0.85;

  function plantillaImg(u) {
    return String(u)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{uuid}")
      .replace(/\b\d{6,}\b/g, "{n}")
      .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Date|X-Amz-Security-Token|Expires|Signature|Policy|Key-Pair-Id|token|sig)=)[^&]*/gi, "$1{v}");
  }

  function plantillasImagen() {
    const m = new Map();
    for (const x of IMGS) { const p = plantillaImg(x.url); m.set(p, (m.get(p) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([p, n]) => n + " × " + p);
  }

  function slugDe(mod, i) {
    const t = (mod && (mod.name || mod.title)) || "mod";
    const s = String(t).replace(/[^\w\s.-]+/g, "").replace(/\s+/g, "_").trim().slice(0, 54).replace(/_+$/, "");
    return String(i + 1).padStart(4, "0") + "-" + (s || "mod");
  }

  function extDe(url, tipo) {
    const t = String(tipo || "").toLowerCase();
    for (const k of ["png", "webp", "gif", "avif"]) if (t.indexOf(k) > -1) return k;
    if (t.indexOf("jpeg") > -1 || t.indexOf("jpg") > -1) return "jpg";
    const m = String(url || "").match(/\.(png|jpe?g|webp|gif|avif)(?=$|\?)/i);
    return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "png";
  }

  /* la imagen que se ve dentro de una tarjeta (portada de la galería) */
  function imagenDeTarjeta(el) {
    let n = el;
    for (let salto = 0; salto < 3 && n; salto++) {
      let ims = [];
      try { ims = n.querySelectorAll ? n.querySelectorAll("img") : []; } catch (e) {}
      for (const img of ims) {
        const src = img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || "";
        if (src && !/^data:/i.test(src)) return src;
      }
      n = n.parentElement;
    }
    return "";
  }

  let marcoImg = null;
  function marcoImagenes() {
    if (marcoImg && marcoImg.isConnected) return marcoImg;
    const f = document.createElement("iframe");
    f.id = "boveda-img-marco";
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;left:-12000px;top:0;width:1400px;height:1000px;border:0;visibility:hidden";
    document.documentElement.appendChild(f);
    marcoImg = f;
    return f;
  }

  function urlDeFicha(mod) {
    if (mod && mod.url_detalle) { try { return new URL(mod.url_detalle, location.origin).toString(); } catch (e) {} }
    const uuid = (mod && (mod.content_id || mod.uuid)) || "";
    if (!uuid) return "";
    const pre = (location.pathname.match(/^\/[a-z]{2}(?:-[A-Za-z]{2})?\//) || [""])[0];
    return location.origin + pre + "details/" + uuid;
  }

  async function imagenesDeFicha(url) {
    if (!url) return [];
    const f = marcoImagenes();
    const cargada = new Promise((res) => {
      let fin = false;
      const ok = () => { if (!fin) { fin = true; res(true); } };
      try { f.addEventListener("load", ok, { once: true }); } catch (e) {}
      setTimeout(() => { if (!fin) { fin = true; res(false); } }, 25000);
    });
    try { f.src = url; } catch (e) { return []; }
    await cargada;
    let out = [];
    for (let i = 0; i < 22; i++) {
      await dormir(340);
      out = [];
      try {
        const d = f.contentDocument;
        if (d) {
          for (const img of d.querySelectorAll("img")) {
            const src = img.currentSrc || img.getAttribute("src") || "";
            if (!src || /^data:|^blob:/i.test(src)) continue;
            if (RE_NO_IMG.test(src)) continue;
            if (img.naturalWidth && img.naturalWidth < 60) continue;   /* iconos de interfaz */
            if (img.complete && !img.naturalWidth) continue;            /* ya falló: rota */
            if (out.indexOf(src) < 0) out.push(src);
          }
        }
      } catch (e) { break; }   /* no me dejan leer el marco: se acabó */
      if (out.length > 1) break;
      if (out.length && i >= 9) break;   /* con una ya vale si el mod no tiene más */
    }
    try { f.src = "about:blank"; } catch (e) {}
    return out;
  }

  /* si la imagen pesa mucho, la recodifico a JPEG (ya tengo los bytes, así
     que no hay problema de lienzo contaminado) */
  async function recortaImagen(blob) {
    try {
      const bm = await createImageBitmap(blob);
      const esc = Math.min(1, ANCHO_MAX / Math.max(1, bm.width));
      const w = Math.max(1, Math.round(bm.width * esc)), h = Math.max(1, Math.round(bm.height * esc));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const cx = cv.getContext("2d");
      cx.imageSmoothingQuality = "high";
      cx.drawImage(bm, 0, 0, w, h);
      const out = await new Promise((res) => { try { cv.toBlob((b) => res(b), "image/jpeg", CALIDAD); } catch (e) { res(null); } });
      if (bm.close) bm.close();
      if (out && out.size && out.size < blob.size) return { blob: out, tipo: "image/jpeg", recortada: true };
    } catch (e) {}
    return { blob: blob, tipo: blob.type || "", recortada: false };
  }

  /* ---- bajar los bytes de una imagen ----
     El CDN de Bethesda NO manda Access-Control-Allow-Origin (comprobado:
     fetch → «Failed to fetch» y un <img crossorigin="anonymous"> → error,
     aunque la imagen se vea perfectamente en la página). Así que el único
     camino de verdad es GM_xmlhttpRequest (Tampermonkey), que no pasa por el
     CORS del navegador. El fetch se queda de reserva por si algún día mandan
     las cabeceras. */
  const HAY_GM = typeof GM_xmlhttpRequest === "function";

  function bytesPorGM(url) {
    return new Promise((res) => {
      try {
        GM_xmlhttpRequest({
          method: "GET", url: url, responseType: "blob", timeout: 60000,
          onload: (r) => {
            if (r.status < 200 || r.status >= 300) return res({ error: "http " + r.status });
            const b = r.response;
            if (!b || !b.size) return res({ error: "vacía" });
            let tipo = String(b.type || "").split(";")[0];
            if (!tipo) {
              const mh = /content-type:\s*([^\r\n;]+)/i.exec(String(r.responseHeaders || ""));
              tipo = mh ? mh[1].trim() : "";
            }
            res({ blob: b, tipo: tipo });
          },
          onerror: () => res({ error: "fallo de red (GM)" }),
          ontimeout: () => res({ error: "se pasó de tiempo (GM)" }),
          onabort: () => res({ error: "abortada (GM)" }),
        });
      } catch (e) { res({ error: String((e && e.message) || e) }); }
    });
  }

  /* cuando ya tengo los bytes: comprobaciones y, si abulta, recodificado */
  async function acabarImagen(blob0, tipo) {
    try {
      if (!blob0 || !blob0.size) return { error: "vacía" };
      if (blob0.size > PESO_MAX_IMG) return { error: "pasa de " + Math.round(PESO_MAX_IMG / 1048576) + " MB" };
      let b = { blob: blob0, tipo: tipo || blob0.type || "", recortada: false };
      if (blob0.size > PESO_REENCODE) b = await recortaImagen(blob0);
      const datos = new Uint8Array(await b.blob.arrayBuffer());
      return { datos: datos, tipo: b.tipo || tipo, kb: Math.round(datos.length / 1024), recortada: !!b.recortada };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  }

  async function bytesDeImagen(url) {
    let fallo = "";
    if (HAY_GM) {
      const g = await bytesPorGM(url);
      if (g.blob) {
        const r = await acabarImagen(g.blob, g.tipo);
        if (!r.error) return r;
        fallo = r.error;
      } else fallo = "GM: " + g.error;
    } else fallo = "sin GM_xmlhttpRequest (mira que Tampermonkey esté activo)";
    for (const opciones of [{}, { credentials: "include" }]) {
      let r = null;
      try { r = await fetch(url, opciones); }
      catch (e) { fallo = String((e && e.message) || e); continue; }
      if (!r.ok) { fallo = "http " + r.status; continue; }
      const tipo = String(r.headers.get("content-type") || "").split(";")[0];
      if (!/^image\//i.test(tipo)) { fallo = "no es imagen (" + (tipo || "?") + ")"; continue; }
      const listo = await acabarImagen(await r.blob(), tipo);
      if (!listo.error) return listo;
      fallo = listo.error;
    }
    return { error: fallo || "no la pude pedir" };
  }

  /* resumen de un medio: lo que dice el JSON (clase, medidas, clave...) */
  function mediaResumen(o, clase) {
    if (!o || typeof o !== "object") return null;
    return {
      clase: String(o.classification || clase || "").replace("CLASSIFICATION_", "") || String(clase || ""),
      filename: o.filename || "", tipo: o.file_type || "", w: o.width || 0, h: o.height || 0,
      bucket: o.s3bucket || "", key: o.s3key || "", color: o.color_sample || "",
    };
  }

  /* ficha cruda -> índice de medios (camino de la ficha; sigue en pie) */
  function indiceMedios(fichas) {
    const out = {};
    for (const f of (fichas && fichas.hechas) || []) {
      const cola = [f.json];
      const vistas = [];
      let raiz = null;
      while (cola.length && vistas.length < 400) {
        const o = cola.shift();
        if (!o || typeof o !== "object" || vistas.indexOf(o) > -1) continue;
        vistas.push(o);
        if (o.cover_image || o.screenshot_images || o.preview_image) { raiz = o; break; }
        for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") cola.push(o[k]);
      }
      if (!raiz) continue;
      const lista = [mediaResumen(raiz.cover_image, "portada"), mediaResumen(raiz.preview_image, "miniatura")]
        .concat((raiz.screenshot_images || []).map((s) => mediaResumen(s, "captura"))).filter(Boolean);
      if (lista.length) out[f.mod] = lista;
    }
    return out;
  }

  /* el mismo índice, pero sacado del JSON de la galería: vale para TODOS los
     mods de la búsqueda y sin entrar en ninguna ficha */
  function indiceMediosDeLista(mods) {
    const out = {};
    for (const m of mods || []) {
      const k = claveMod(m);
      if (!k) continue;
      const lista = [mediaResumen(m.cover_image, "portada"), mediaResumen(m.preview_image, "miniatura")]
        .concat((m.screenshot_images || []).map((s) => mediaResumen(s, "captura"))).filter(Boolean);
      if (lista.length) out[k] = lista;
    }
    return out;
  }

  /* ---- las URLs de las imágenes me las monto yo ----
     Bethesda no firma las del CDN: pedir /public/... a pelo da 403
     SignatureDoesNotMatch. Pero tienen un proxy que traga un JSON en base64
     (bucket + clave + cómo la quieres) y no pide ni firma ni credencial:
        https://ugcmods.bethesda.net/image/<base64({bucket,key,edits,outputFormat})>
     Comprobado a mano: devuelve imagen de verdad, en png/jpeg/webp y a
     cualquier ancho. Y como el JSON de la galería ya trae s3bucket y s3key de
     la portada, la miniatura y TODAS las capturas de cada mod, no dependo de
     lo que la web tenga pintado en pantalla ni de abrir cada ficha. */
  function base64Json(o) {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function urlMedio(med, ancho, fmt) {
    if (!med || typeof med !== "object") return "";
    const bucket = med.s3bucket, key = med.s3key;
    if (!bucket || !key) return String(med.url || "");
    try {
      return "https://" + bucket + "/image/" + base64Json({
        bucket: bucket, key: key,
        edits: ancho ? { resize: { width: ancho } } : {},
        outputFormat: fmt || "jpeg",
      });
    } catch (e) { return ""; }
  }

  function mediosDeMod(m, modo, fmt, anchos) {
    if (!m) return null;
    const portada = urlMedio(m.cover_image, anchos.portada, fmt) || urlMedio(m.preview_image, anchos.portada, fmt);
    if (!portada) return null;
    const mini = urlMedio(m.preview_image, anchos.mini, fmt);
    const capturas = [];
    if (modo >= 2) for (const s of m.screenshot_images || []) {
      const u = urlMedio(s, anchos.captura, fmt);
      if (u) capturas.push(u);
    }
    return { portada: portada, miniatura: mini && mini !== portada ? mini : "", capturas: capturas };
  }

  /* Junta las imágenes de toda la lista. Antes se rascaba la galería pintada y
     se abría un iframe por ficha; ahora las URLs salen del JSON que la web ya
     nos ha dado (rápido, para todos y sin depender de la pantalla). Los bytes
     se piden por GM_xmlhttpRequest porque el CDN no manda CORS. */
  async function juntarImagenes(lista, fichas, modo, control, di) {
    const res = { archivos: [], urls: {}, medios: {}, hechas: 0, soloUrl: 0, fallos: [], kb: 0, recortadas: 0, mods: 0, avisos: [], formato: "" };
    const mods = (lista && lista.mods) || [];
    const cal = calidadImagenes();
    res.formato = cal.fmt + " · portada " + cal.tam.portada + "px · miniatura " + cal.tam.mini + "px · capturas " + cal.tam.captura + "px";
    const conMedios = mods.filter((m) => m && (m.cover_image || m.preview_image));
    if (!conMedios.length) { res.avisos.push("sin-medios"); return res; }
    di("Imágenes · <b>" + conMedios.length + "</b> mods con portada en el JSON de la galería · " + res.formato);

    const usados = new Set();
    let vistos = 0;
    for (const m of mods) {
      if (control && control.parar) break;
      const meds = mediosDeMod(m, modo, cal.fmt, cal.tam);
      if (!meds) continue;
      let base = slugDe(m, usados.size);
      while (usados.has(base)) base = base + "_";
      usados.add(base);
      vistos++;
      res.mods++;
      res.urls[base] = { titulo: m.title || m.name || "", urls: [meds.portada].concat(meds.miniatura ? [meds.miniatura] : []).concat(meds.capturas) };
      res.medios[claveMod(m)] = [mediaResumen(m.cover_image, "portada"), mediaResumen(m.preview_image, "miniatura")]
        .concat((m.screenshot_images || []).map((s) => mediaResumen(s, "captura"))).filter(Boolean);
      const piezas = [["portada", meds.portada], ["miniatura", meds.miniatura]]
        .concat(meds.capturas.slice(0, Math.max(0, MAX_IMG_POR_MOD - 1)).map((u, n) => ["captura-" + String(n + 1).padStart(2, "0"), u]));
      di("Imágenes · <b>" + vistos + "</b>/" + conMedios.length + " mods · <b>" + res.hechas + "</b> bajadas (" + Math.round(res.kb / 1024) + " MB de " + Math.round(PESO_MAX_TOTAL / 1048576) + " MB)");
      for (const [nombre, u] of piezas) {
        if (!u) continue;
        if (res.kb * 1024 > PESO_MAX_TOTAL) { if (res.avisos.indexOf("tope") < 0) res.avisos.push("tope"); break; }
        const b = await bytesDeImagen(u);
        if (b.error) { res.soloUrl++; res.fallos.push({ mod: base, url: u, motivo: b.error }); continue; }
        res.archivos.push({ nombre: "imagenes/" + base + "/" + nombre + "." + extDe(u, b.tipo), datos: b.datos });
        res.hechas++; res.kb += b.kb;
        if (b.recortada) res.recortadas++;
        await dormir(15);
      }
    }
    return res;
  }

  /* catálogo limpio para meterlo directo en la bóveda: del JSON crudo de la
     galería a los campos que usa la app */
  function catalogoDeLista(lista) {
    const out = [];
    for (const m of (lista && lista.mods) || []) {
      const st = (m.stats && m.stats.platforms) || {};
      /* OJO: `ALL` viene muchas veces a cero y lo de verdad está repartido por
         plataforma (PLAYSTATION4/5). Sumo las plataformas y, si `ALL` trae más
         (pasa con las visitas), me quedo con lo mayor. */
      const fuente = {};
      for (const c of ["likes", "downloads", "views", "bookmarks", "subscribes", "enableds"]) {
        let suma = 0;
        for (const pf of Object.keys(st)) if (pf !== "ALL") suma += (st[pf] && st[pf][c]) || 0;
        fuente[c] = Math.max(suma, (st.ALL && st.ALL[c]) || 0);
      }
      out.push({
        id: m.content_id, nombre: m.title, autor: m.author_displayname,
        plataformas: (m.hardware_platforms || []).slice(),
        ps5: Boolean(st.PLAYSTATION5 || (m.hardware_platforms || []).indexOf("PLAYSTATION5") > -1),
        categorias: (m.categories || []).slice(),
        likes: fuente.likes || 0, descargas: fuente.downloads || 0, vistas: fuente.views || 0, favoritos: fuente.bookmarks || 0,
        descripcion: m.overview || "", texto: m.description || "",
        publicado: m.ptime || m.ctime || 0, actualizado: m.utime || 0, beta: !!m.beta, borrado: !!m.deleted,
        requeridos: (m.required_mods || []).map((x) => (x && (x.content_id || x.title)) || x),
        portada: urlMedio(m.cover_image, 512, "webp"), miniatura: urlMedio(m.preview_image, 256, "webp"),
        capturas: (m.screenshot_images || []).map((s) => urlMedio(s, 1280, "webp")),
        ficha: m.legacy_content_id ? "https://bethesda.net/en/mods/skyrim/mod-detail/" + m.legacy_content_id : "",
        medios: indiceMediosDeLista([m])[claveMod(m)] || [],
        notas: (m.release_notes || []).map((n) => ({ plataforma: n.hardware_platform, notas: n.release_notes || [] })),
      });
    }
    return out;
  }

  /* ================= 7. ZIP (sin comprimir, sin dependencias) ================= */

  function crc32(u8) {
    if (!crc32.tabla) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; }
      crc32.tabla = t;
    }
    const t = crc32.tabla;
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function hacerZip(archivos) {
    const enc = new TextEncoder();
    const partes = [], central = [];
    let offset = 0;
    const d = new Date();
    const hora = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const fecha = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    for (const a of archivos) {
      const nombre = enc.encode(a.nombre);
      const datos = typeof a.datos === "string" ? enc.encode(a.datos) : a.datos;
      const crc = crc32(datos);
      const lh = new Uint8Array(30 + nombre.length);
      const v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, hora, true); v.setUint16(12, fecha, true); v.setUint32(14, crc, true);
      v.setUint32(18, datos.length, true); v.setUint32(22, datos.length, true);
      v.setUint16(26, nombre.length, true); v.setUint16(28, 0, true);
      lh.set(nombre, 30);
      partes.push(lh, datos);

      const ch = new Uint8Array(46 + nombre.length);
      const w = new DataView(ch.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true);
      w.setUint16(10, 0, true); w.setUint16(12, hora, true); w.setUint16(14, fecha, true);
      w.setUint32(16, crc, true); w.setUint32(20, datos.length, true); w.setUint32(24, datos.length, true);
      w.setUint16(28, nombre.length, true); w.setUint32(42, offset, true);
      ch.set(nombre, 46);
      central.push(ch);
      offset += lh.length + datos.length;
    }
    let nDatos = 0, nCent = 0;
    for (const t of partes) nDatos += t.length;
    for (const t of central) nCent += t.length;
    const eo = new Uint8Array(22);
    const e = new DataView(eo.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, archivos.length, true); e.setUint16(10, archivos.length, true);
    e.setUint32(12, nCent, true); e.setUint32(16, nDatos, true);
    return new Blob([...partes, ...central, eo], { type: "application/zip" });
  }

  /* ================= 8. entrega ================= */

  function sello() {
    const d = new Date();
    const dos = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + dos(d.getMonth() + 1) + dos(d.getDate()) + "-" + dos(d.getHours()) + dos(d.getMinutes());
  }

  function limpiarTitulo(t, max) {
    return String(t || "mod").replace(/[^\w\s.-]+/g, "").replace(/\s+/g, " ").trim().slice(0, max || 60) || "mod";
  }

  async function copiar(txt) {
    try { await navigator.clipboard.writeText(txt); return true; } catch (e) {}
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.documentElement.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    return ok;
  }

  function descargarBlob(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    a.rel = "noopener";
    a.style.cssText = "position:fixed;left:-9999px;top:0";
    document.documentElement.appendChild(a);
    try { a.click(); } catch (e) {}
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return url;
  }

  /* Deja un enlace visible en el panel para guardar el ZIP a mano. Si el
     navegador se traga la descarga automática, el dueño siempre tiene por
     dónde tirar (y así me dice qué nombre de archivo le sale de verdad). */
  let urlZip = 0;
  function enlaceZip(blob, nombre) {
    const a = panel.querySelector("#bovZip");
    if (!a) return;
    if (urlZip) { try { URL.revokeObjectURL(urlZip); } catch (e) {} }
    urlZip = URL.createObjectURL(blob);
    a.href = urlZip;
    a.download = nombre;
    a.textContent = "Guardar el ZIP a mano: " + nombre + " (" + (Math.round(blob.size / 104857.6) / 10) + " MB)";
    a.hidden = false;
  }

  function descargarTexto(txt, nombre, tipo) {
    descargarBlob(new Blob([txt], { type: tipo || "text/plain;charset=utf-8" }), nombre);
  }

  /* ================= 9. interfaz ================= */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .pill, .panel { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .pill { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; background: #0b1730; color: #e8c877;
      border: 1px solid #8c6f2f; border-radius: 999px; padding: 9px 16px; font-size: 13px; font-weight: 600;
      letter-spacing: .04em; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .pill:hover { background: #14264a; }
    .panel { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: 300px; background: #0b1730;
      color: #dfe7f5; border: 1px solid #8c6f2f; border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.6);
      padding: 12px 13px 11px; font-size: 13px; }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
    .ttl { color: #e8c877; font-weight: 700; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; }
    .x { background: none; border: 0; color: #8fa3c8; font-size: 17px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .x:hover { color: #fff; }
    button.b { display: block; width: 100%; text-align: left; margin-bottom: 7px; cursor: pointer; background: #16264a;
      color: #e6edfa; border: 1px solid #2c4470; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; }
    button.b:hover:not(:disabled) { background: #1d3159; border-color: #3d5c93; }
    button.b:disabled { opacity: .5; }
    button.b.fuerte { background: #3a2d10; border-color: #8c6f2f; color: #f0d99a; }
    button.b.fuerte:hover:not(:disabled) { background: #4a3a14; border-color: #b08c3c; }
    button.b small { display: block; color: #93a6c9; font-size: 11px; margin-top: 2px; }
    button.b.fuerte small { color: #bda86e; }
    .est { margin-top: 7px; color: #8fa3c8; font-size: 11.5px; line-height: 1.45; word-break: break-word; }
    .est b { color: #e8c877; font-weight: 600; }
    .fila { display: flex; align-items: center; gap: 6px; margin: 2px 0 7px; color: #93a6c9; font-size: 11.5px; }
    .fila input { width: 62px; background: #0f1c33; color: #e6edfa; border: 1px solid #2c4470; border-radius: 6px; padding: 3px 6px; font: inherit; }
    .fila select { background: #0f1c33; color: #e6edfa; border: 1px solid #2c4470; border-radius: 6px; padding: 3px 6px; font: inherit; max-width: 178px; }
    .pie { margin-top: 6px; display: flex; justify-content: space-between; align-items: center; }
    .liga { background: none; border: 0; color: #7f93b8; font-size: 11px; cursor: pointer; padding: 0;
      text-decoration: underline; font-family: inherit; }
    .liga:hover { color: #dbe6f8; }
    a.zip { display: block; margin-top: 7px; color: #e8c877; word-break: break-all; line-height: 1.35; }
    .diag { margin-top: 7px; color: #7f93b8; font-size: 10.5px; line-height: 1.35; }
  `;

  const host = document.createElement("div");
  host.id = "boveda-captura-host";
  const root = host.attachShadow({ mode: "open" });
  const st = document.createElement("style");
  st.textContent = CSS;
  root.appendChild(st);

  const pill = document.createElement("button");
  pill.className = "pill";
  pill.type = "button";
  pill.textContent = "Capturar página";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;
  panel.innerHTML =
    '<div class="top"><span class="ttl">Bóveda · Captura</span><button class="x" type="button" title="Cerrar">×</button></div>' +
    '<button class="b fuerte" type="button" data-a="zip">Descargar TODO en un ZIP<small>Galería, ficha e imágenes de cada mod, todo en uno</small></button>' +
    '<button class="b" type="button" data-a="rastrear">Solo rastrear la lista<small>Guarda el JSON con todos los mods de la búsqueda</small></button>' +
    '<button class="b" type="button" data-a="pantalla">Capturar esta pantalla<small>Texto de lo que se ve ahora</small></button>' +
    '<button class="b" type="button" data-a="json">Guardar JSON de la web (0)<small>Todo lo navegado, en un archivo</small></button>' +
    '<button class="b" type="button" data-a="sondeo">Ver peticiones (sondeo)<small>Qué pide la web, por si algo no cuadra</small></button>' +
    '<button class="b" type="button" data-a="copiar">Copiar la última captura<small>Al portapapeles</small></button>' +
    '<div class="fila"><label>empezar en la página <input id="bovDesdePag" type="number" min="1" step="1" value="1"></label></div>' +
    '<div class="fila"><label>imágenes <select id="bovImgs">' +
      '<option value="2" selected>portadas y capturas</option>' +
      '<option value="1">solo las portadas</option>' +
      '<option value="0">ninguna</option>' +
    '</select></label></div>' +
    '<div class="fila"><label>tamaño <select id="bovImgCal">' +
      '<option value="normal" selected>normal · portada 512 · capturas 1280</option>' +
      '<option value="grande">grande · portada 1024 · capturas 1920</option>' +
      '<option value="pequeno">pequeño · portada 256 · capturas 640</option>' +
    '</select></label></div>' +
    '<div class="fila"><label>formato <select id="bovImgFmt">' +
      '<option value="jpeg" selected>jpeg (se abre en todo)</option>' +
      '<option value="webp">webp (pesa menos)</option>' +
      '<option value="png">png (pesa más)</option>' +
    '</select></label></div>' +
    '<div class="est">Abre la galería de mods y pulsa «Descargar TODO en un ZIP».</div>' +
    '<div class="pie"><button class="liga" type="button" data-a="parar" hidden>parar</button><button class="liga" type="button" data-a="vaciar">vaciar JSON</button></div>' +
    '<a id="bovZip" class="liga zip" download hidden></a>' +
    '<div class="diag" id="bovDiag"></div>';

  root.appendChild(pill);
  root.appendChild(panel);

  const est = panel.querySelector(".est");
  const btnParar = panel.querySelector('button[data-a="parar"]');
  const botones = () => [...panel.querySelectorAll("button.b")];
  const di = (html) => { est.innerHTML = html; };

  function paginaInicial() {
    const i = panel.querySelector("#bovDesdePag");
    const n = i ? parseInt(i.value, 10) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function modoImagenes() {
    const s = panel.querySelector("#bovImgs");
    const n = s ? parseInt(s.value, 10) : 2;
    return Number.isFinite(n) ? n : 2;
  }

  /* a qué tamaño y en qué formato pido las imágenes al proxy de Bethesda */
  const TAMANOS = {
    normal: { portada: 512, mini: 256, captura: 1280 },
    grande: { portada: 1024, mini: 512, captura: 1920 },
    pequeno: { portada: 256, mini: 128, captura: 640 },
  };

  function calidadImagenes() {
    const s = panel.querySelector("#bovImgCal"), f = panel.querySelector("#bovImgFmt");
    return { tam: TAMANOS[(s && s.value) || "normal"] || TAMANOS.normal, fmt: (f && f.value) || "jpeg" };
  }

  /* ¿puedo bajar imágenes de verdad? El CDN no manda CORS, así que fetch no
     vale: hace falta GM_xmlhttpRequest (Tampermonkey). Lo digo en el panel. */
  function pintaDiag() {
    const d = panel.querySelector("#bovDiag");
    if (!d) return;
    d.innerHTML = HAY_GM
      ? "bajada de imágenes: <b style='color:#8fd18f'>GM_xmlhttpRequest ✓</b>"
      : "bajada de imágenes: <b style='color:#e8a0a0'>sin GM_xmlhttpRequest</b> · el CDN no manda CORS, así que casi seguro fallará (activa Tampermonkey)";
  }

  function avisoJson() {
    const b = panel.querySelector('button[data-a="json"]');
    if (b && b.firstChild) b.firstChild.textContent = "Guardar JSON de la web (" + VISTAS.length + " peticiones)";
  }

  /* Resumen del sondeo: qué peticiones ha hecho la web y cuáles huelen a mods.
     Sirve para que el dueño me lo mande cuando la web cambia de tripas. */
  function sondeoTexto() {
    const conForma = VISTAS.filter((v) => v.forma);
    const c = candidato();
    const out = ["=== SONDEO BÓVEDA · v1.9 ===", "url: " + location.href, "fecha: " + new Date().toISOString(), ""];
    out.push("PETICIONES VISTAS: " + VISTAS.length + " · con forma de mods: " + conForma.length + " · respuestas guardadas: " + PET.length);
    out.push("Candidata a galería: " + (c ? (c.param ? c.param + "=" + c.desde + " · " : "sin parámetro de página · ") + c.url : "(ninguna)"));
    out.push("", "--- CON FORMA DE MODS (últimas 15) ---");
    conForma.slice(-15).forEach((v) => out.push("[" + v.forma + "] " + v.metodo + " " + v.estado + " · " + v.url));
    out.push("", "--- ÚLTIMAS 30 PETICIONES ---");
    VISTAS.slice(-30).forEach((v) => out.push(v.metodo + " " + v.estado + " " + v.kb + "kB " + (v.tipo || "?") + " · " + v.url));
    const conMuestra = VISTAS.filter((v) => v.muestra).slice(-3);
    if (conMuestra.length) {
      out.push("", "--- MUESTRAS DE TEXTO DEVUELTO (recortadas) ---");
      conMuestra.forEach((v) => out.push(v.url + "\n  " + v.muestra));
    }
    out.push("", "--- IMÁGENES VISTAS: " + IMGS.length + " (patrones del CDN) ---");
    const pl = plantillasImagen();
    pl.forEach((p) => out.push(p));
    out.push("", "--- ÚLTIMAS IMÁGENES (10) ---");
    IMGS.slice(-10).forEach((x) => out.push(x.estado + " " + (x.tipo || "?") + " · " + x.url));
    return out.join("\n");
  }
  avisoJson();
  pintaDiag();

  let ultima = "";
  let ocupado = false;
  let control = { parar: false };

  async function entregar(txt, etiqueta) {
    if (!txt) { di("No encontré nada en esta pantalla."); return; }
    ultima = txt;
    const ok = await copiar(txt);
    const nombre = "creations_vista_" + sello() + ".txt";
    descargarTexto(txt, nombre);
    const n = (txt.match(/^# \d+$/gm) || []).length;
    di("<b>" + txt.length.toLocaleString("es-ES") + "</b> caracteres" + (n ? " · <b>" + n + "</b> tarjetas" : "") + "<br>" +
      (ok ? "Copiado al portapapeles.<br>" : "") + "Descargado: <b>" + nombre + "</b>");
  }

  async function tarea(fn) {
    if (ocupado) { di("Estoy en algo, dame un momento."); return; }
    ocupado = true;
    control = { parar: false, desde: paginaInicial() };
    btnParar.hidden = false;
    botones().forEach((x) => (x.disabled = true));
    try { await fn(); } catch (e) { di("Se cortó: " + (e && e.message ? e.message : "error")); }
    ocupado = false;
    btnParar.hidden = true;
    botones().forEach((x) => (x.disabled = false));
    avisoJson();
  }

  panel.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.classList.contains("x")) { panel.hidden = true; pill.hidden = false; return; }
    const a = b.dataset.a;

    if (a === "parar") { control.parar = true; di("Parando…"); return; }
    if (a === "vaciar") { PET.length = 0; VISTAS.length = 0; muestras = 0; avisoJson(); di("JSON y sondeo vaciados."); return; }
    if (a === "sondeo") {
      if (!VISTAS.length) { di("Todavía no he visto ninguna petición. Recarga la página de Creations con el script puesto y vuelve a probar."); return; }
      const txt = sondeoTexto();
      ultima = txt;
      descargarTexto(txt, "creations_sondeo_" + sello() + ".txt");
      const c = candidato();
      di("<b>" + VISTAS.length + "</b> peticiones vistas · <b>" + VISTAS.filter((v) => v.forma).length + "</b> con forma de mods.<br>" +
        (c ? "Galería: <b>" + (c.param ? c.param + "=" + c.desde : "sin parámetro") + "</b><br>" : "Aún no reconozco la lista.<br>") +
        "Descargado el sondeo: mándamelo tal cual.");
      return;
    }
    if (a === "copiar") {
      if (!ultima) { di("Todavía no has capturado nada."); return; }
      const ok = await copiar(ultima);
      di(ok ? "Copiada otra vez (" + ultima.length.toLocaleString("es-ES") + " caracteres)." : "No pude usar el portapapeles.");
      return;
    }
    if (a === "json") {
      if (!VISTAS.length && !PET.length) { di("Aún no hay nada. Navega por Creations y vuelve a pulsar."); return; }
      const c = candidato();
      const doc = {
        tipo: "sondeo-boveda",
        version: "1.9",
        fecha: new Date().toISOString(),
        pagina: location.href,
        diagnostico: {
          peticiones: VISTAS.length,
          conForma: VISTAS.filter((v) => v.forma).length,
          galeria: c ? { url: c.url, param: c.param, desde: c.desde, ruta: c.ruta, mods: c.n } : null,
        },
        vistas: VISTAS,
        pet: PET,
        dom: tarjetasMods(),
        imagenes: {
          modo: modoImagenes(),
          vistas: IMGS.slice(-300),
          patrones: plantillasImagen(),
        },
      };
      const nombre = "creations_json_" + sello() + ".json";
      descargarTexto(JSON.stringify(doc, null, 1), nombre, "application/json");
      di("<b>" + VISTAS.length + "</b> peticiones y <b>" + PET.length + "</b> respuestas en <b>" + nombre + "</b>");
      return;
    }
    if (a === "pantalla") { di("Capturando…"); await dormir(30); await entregar(capturaPantalla(), "vista"); return; }

    if (a === "rastrear") {
      await tarea(async () => {
        di("Buscando la paginación…");
        await dormir(30);
        const res = await rastrear((p, mods, items) => di("Lista · página <b>" + p + "</b> · <b>" + mods + "</b> mods"));
        if (res.error) { di("<b>No pude rastrear.</b><br>" + res.error); return; }
        if (!res.mods.length) { di("No junté ningún mod. ¿Estás en la galería?"); return; }
        const nombre = "creations_lista_" + sello() + ".json";
        descargarTexto(JSON.stringify({ info: res.info, mods: res.mods, paginas: res.paginas }, null, 1), nombre, "application/json");
        di("<b>" + res.mods.length + "</b> mods en <b>" + res.info.paginas + "</b> páginas.<br>Descargado: <b>" + nombre + "</b>");
      });
      return;
    }

    if (a === "zip") {
      await tarea(async () => {
        di("Paso 1/4 · rastreando la galería…");
        await dormir(30);
        const lista = await rastrear((p, mods) => di("Paso 1/4 · lista <b>" + p + "</b> · <b>" + mods + "</b> mods"));
        if (lista.error) {
          di("<b>Necesito la galería.</b><br>" + lista.error + "<br>Si no sale, pulsa «Ver peticiones (sondeo)» y mándame lo que descargue.");
          return;
        }
        if (!lista.mods.length) { di("La lista vino vacía. ¿Estás en la galería de mods?"); return; }

        if (control.parar) { di("Parado en el paso 1."); return; }

        /* Las fichas: si el dueño no ha abierto ninguna, la plantilla no está
           capturada, así que la busco yo tantenado las direcciones típicas. */
        let modelo = modeloDetalle();
        if (!modelo) {
          di("Paso 2/4 · sin plantilla de ficha: la busco yo…");
          modelo = await tantearFicha(lista, di);
        }
        di("Paso 2/4 · entrando en la ficha de <b>" + lista.mods.length + "</b> mods…");
        const fichas = await bajarFichas(lista.mods, (hechos, total, ok, fase) =>
          di("Paso 2/4 · ficha <b>" + hechos + "</b>/" + total + " · <b>" + ok + "</b> con datos"), control, modelo);

        /* Si las fichas fallan, el ZIP sale igual: este botón nunca debe
           devolver un JSON suelto. Se avisa y se sigue. */
        const avisos = [];
        if (fichas.error) {
          avisos.push(fichas.error);
          di("<b>Sigo sin las fichas.</b> " + fichas.error + "<br>El ZIP sale igual, con la lista, el catálogo y las imágenes. Espera…");
          await dormir(1600);
        }
        if (fichas.fallos.length) avisos.push(fichas.fallos.length + " fichas no se pudieron bajar (están en fichas/_fallos.json).");

        const modoImg = modoImagenes();
        let imagenes = null;
        if (modoImg > 0) {
          try { imagenes = await juntarImagenes(lista, fichas, modoImg, control, di); }
          catch (e) { di("Las imágenes se cortaron: " + ((e && e.message) || e) + " · sigo con el resto."); await dormir(1200); }
          if (control.parar) di("Imágenes paradas por ti.");
        }
        di("Paso 4/4 · empaquetando el ZIP…");
        await dormir(50);
        const archivos = [];
        archivos.push({ nombre: "LEEME.txt", datos: escribirLeeme(lista, fichas, avisos, modoImg) });
        archivos.push({ nombre: "indice.json", datos: JSON.stringify({ info: lista.info, avisos: avisos, fichas: { plantilla: fichas.modelo, ok: fichas.hechas.length, fallos: fichas.fallos.length }, imagenes: { modo: modoImg, ok: imagenes ? imagenes.hechas : 0 }, capturado: new Date().toISOString() }, null, 1) });
        archivos.push({ nombre: "lista/mods.json", datos: JSON.stringify(lista.mods, null, 1) });
        lista.crudo.forEach((p) => archivos.push({ nombre: "lista/pagina-" + String(p.pagina).padStart(4, "0") + ".json", datos: JSON.stringify(p.json, null, 1) }));
        archivos.push({ nombre: "catalogo.json", datos: JSON.stringify(catalogoDeLista(lista), null, 1) });
        const usados = new Set();
        fichas.hechas.forEach((f, i) => {
          const m = hallarMod(lista.mods, f.mod);
          let base = limpiarTitulo((m && (m.name || m.title)) || f.mod, 60);
          if (usados.has(base)) base = base + "_" + i;
          usados.add(base);
          archivos.push({ nombre: "fichas/" + base + ".json", datos: JSON.stringify(f.json, null, 1) });
        });
        if (fichas.fallos.length) archivos.push({ nombre: "fichas/_fallos.json", datos: JSON.stringify(fichas.fallos, null, 1) });
        if (avisos.length) archivos.push({ nombre: "INCIDENCIAS.txt", datos: avisos.join("\n\n") });
        if (imagenes) {
          for (const a of imagenes.archivos) archivos.push(a);
          archivos.push({ nombre: "imagenes/_urls.json", datos: JSON.stringify({ modo: modoImg, formato: imagenes.formato, conImagen: imagenes.mods, bajadas: imagenes.hechas, soloUrl: imagenes.soloUrl, fallos: imagenes.fallos, avisos: imagenes.avisos, mods: imagenes.urls }, null, 1) });
          archivos.push({ nombre: "imagenes/_medios.json", datos: JSON.stringify(imagenes.medios && Object.keys(imagenes.medios).length ? imagenes.medios : indiceMediosDeLista(lista.mods), null, 1) });
        }
        let blob = null;
        try { blob = hacerZip(archivos); }
        catch (e) { di("<b>No pude montar el ZIP</b> (" + ((e && e.message) || e) + ").<br>Pon «imágenes: ninguna» y vuelve a probar: así pesa mucho menos."); return; }
        const nombre = "creations_todo_" + sello() + ".zip";
        descargarBlob(blob, nombre);
        enlaceZip(blob, nombre);
        const mb = Math.round(blob.size / 104857.6) / 10;
        di("<b>" + lista.mods.length + "</b> mods · <b>" + fichas.hechas.length + "</b> fichas · " +
          (fichas.fallos.length ? "<b>" + fichas.fallos.length + "</b> fallos · " : "") +
          (imagenes ? "<b>" + imagenes.hechas + "</b> imágenes (" + Math.round(imagenes.kb / 1024) + " MB" + (imagenes.soloUrl ? ", <b>" + imagenes.soloUrl + "</b> sin poder bajar" : "") + ") · " : "") +
          "<b>" + archivos.length + "</b> archivos en el ZIP · " + mb + " MB<br>Descargado: <b>" + nombre + "</b>" +
          (imagenes && imagenes.soloUrl && !imagenes.hechas && !HAY_GM ? "<br><b style='color:#e8a0a0'>Las imágenes no se pueden bajar sin GM_xmlhttpRequest</b>: el CDN de Bethesda no manda CORS. Instala/activa Tampermonkey y vuelve a lanzarlo." : "") +
          (avisos.length ? "<br><span style='color:#e8a0a0'>Con incidencias:</span> " + avisos.join(" ") : "") +
          (imagenes && imagenes.avisos.indexOf("tope") > -1 ? "<br>Ojo: paré las imágenes al llegar al tope de peso (" + Math.round(PESO_MAX_TOTAL / 1048576) + " MB)." : "") +
          "<br>Si no lo ves en tus descargas, dale al enlace de abajo.");
      });
    }
  });

  function hallarMod(mods, clave) {
    for (const m of mods) if (claveMod(m) === clave) return m;
    return null;
  }

  function escribirLeeme(lista, fichas, avisos, modo) {
    return [
      "BÓVEDA CELESTIAL · volcado de Creations",
      "Fecha: " + new Date().toISOString(),
      "",
      "Origen: " + lista.info.urlBase,
      "Paginación: " + lista.info.param + " (desde " + lista.info.desde + ")",
      "Páginas: " + lista.info.paginas,
      "Mods en la lista: " + lista.info.mods,
      "",
      "Fichas descargadas: " + fichas.hechas.length,
      "Plantilla de ficha: " + fichas.modelo.sitio + " · " + fichas.modelo.url,
      "Fallos: " + fichas.fallos.length,
      "",
      "Contenido:",
      "  indice.json ................ resumen de la operación",
      "  catalogo.json .............. LISTO PARA LA BÓVEDA: un registro por mod (id, nombre, autor,",
      "                              plataformas, categorías, likes, descargas, descripción, notas,",
      "                              portada y capturas)",
      "  lista/mods.json ............ todos los mods de la búsqueda (crudo)",
      "  lista/pagina-NNNN.json ..... respuesta cruda de cada página",
      "  fichas/<nombre>.json ....... respuesta cruda de la ficha de cada mod",
      "  fichas/_fallos.json ........ mods que no se pudieron bajar",
      "  imagenes/<mod>/ ............ portada, miniatura y capturas de cada mod",
      "  imagenes/_urls.json ........ las URLs usadas, y las que solo se pudieron apuntar",
      "  imagenes/_medios.json ...... lo que dice el JSON de cada medio (clase, medidas, clave, color)",
      "  INCIDENCIAS.txt ............ lo que se torció (si se torció algo)",
      "",
      "Imágenes: modo " + (modo == null ? modoImagenes() : modo) + " (0 = ninguna, 1 = solo portadas, 2 = portadas y capturas)",
      "Cómo se bajan: GM_xmlhttpRequest (el CDN de Bethesda no manda CORS, así que fetch no vale).",
      "Las URLs de imagen las monto yo desde el JSON (bucket + clave, con el proxy de Bethesda): no",
      "caducan y se pueden pedir a cualquier tamaño cambiando el ancho.",
    ].concat(avisos && avisos.length ? ["", "INCIDENCIAS:", avisos.join("\n")] : []).join("\n");
  }

  pill.addEventListener("click", () => { pill.hidden = true; panel.hidden = false; });

  function montar() {
    if (document.documentElement && !document.getElementById("boveda-captura-host")) document.documentElement.appendChild(host);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", montar);
    let n = 0;
    const t = setInterval(() => { montar(); if (++n > 40 || document.getElementById("boveda-captura-host")) clearInterval(t); }, 250);
  } else montar();

  WIN.__bovedaCapturaAPI = {
    version: "2.1",
    panel, pill,
    capturar: capturaPantalla,
    capturarTodo: capturaTotal,
    ficha: bloqueFicha,
    rastrear,
    bajarFichas,
    candidato,
    modeloDetalle,
    paginaInicial,
    arrayGrande,
    claveMod,
    zip: hacerZip,
    crc32,
    json: () => PET,
    vistas: () => VISTAS,
    imagenes: () => IMGS,
    plantillasImagen,
    imagenesDeFicha,
    bytesDeImagen,
    juntarImagenes,
    indiceMedios,
    indiceMediosDeLista,
    catalogoDeLista,
    urlMedio,
    mediosDeMod,
    tantearFicha,
    hayGM: () => HAY_GM,
    modoImagenes,
    calidadImagenes,
    urlDeFicha,
    sondeo: sondeoTexto,
    hallazgo,
    pintaMod,
    enRuta,
    tarjetasMods,
    rastrearDOM,
    fichaHTML,
    camposDeDoc,
    jsonIncrustado,
    guarda: (u, m, c, h, t, e, tp) => guarda(u, m, c, h, t, e, tp),
    limpiar: () => host.remove(),
  };
})();
