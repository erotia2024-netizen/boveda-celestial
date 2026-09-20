// ==UserScript==
// @name         Demo del taller
// @namespace    https://perchance.org/cv1pet6fgo
// @version      1.0.0
// @description  Proyecto de ejemplo que recorre el ciclo entero del taller: portada, módulos, red simulada y prueba automática.
// @author       Bóveda Celestial
// @match        https://tienda.example.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/erotia2024-netizen/boveda-celestial
// @downloadURL  https://raw.githubusercontent.com/erotia2024-netizen/boveda-celestial/main/herramientas/demo-taller.user.js
// @updateURL    https://raw.githubusercontent.com/erotia2024-netizen/boveda-celestial/main/herramientas/demo-taller.user.js
// ==/UserScript==

/* ---- comun/puente-cliente.js ---- */
/* Puente de IA (lado del userscript): abre el generador de la Bóveda en un
   iframe oculto y le pide texto con generateText. El generador solo contesta a
   los orígenes que el proyecto declare en `puenteOrigenes`. */
var __TALLER_PUENTE = { url: "https://null.perchance.org/cv1pet6fgo#taller-ai", caja: null, listo: null, id: 0, cola: {} };

function __tallerPuenteMontar() {
  if (__TALLER_PUENTE.listo) return __TALLER_PUENTE.listo;
  __TALLER_PUENTE.listo = new Promise(function (res) {
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.taller !== "ia-respuesta") return;
      var p = __TALLER_PUENTE.cola[d.id];
      if (!p) return;
      delete __TALLER_PUENTE.cola[d.id];
      if (d.error) p.rechazar(new Error(String(d.error)));
      else p.resolver(d.texto == null ? "" : String(d.texto));
    });
    var f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;opacity:0;pointer-events:none";
    f.addEventListener("load", function () { setTimeout(function () { res(f.contentWindow); }, 200); });
    f.src = __TALLER_PUENTE.url;
    document.documentElement.appendChild(f);
    __TALLER_PUENTE.caja = f;
  });
  return __TALLER_PUENTE.listo;
}

async function pedirIA(sistema, usuario, opciones) {
  const o = opciones || {};
  const wd = await __tallerPuenteMontar();
  const id = ++__TALLER_PUENTE.id;
  const espera = new Promise(function (res, rej) {
    __TALLER_PUENTE.cola[id] = { resolver: res, rechazar: rej };
    setTimeout(function () {
      if (__TALLER_PUENTE.cola[id]) { delete __TALLER_PUENTE.cola[id]; rej(new Error("el puente de IA no contestó a tiempo")); }
    }, o.tiempoMax || 90000);
  });
  wd.postMessage({ taller: "ia-peticion", id: id, sistema: String(sistema || ""), usuario: String(usuario || ""), inicio: String(o.inicio || "") }, "*");
  return espera;
}


/* ---- proyectos/demo/modulos/01-nucleo.js ---- */
/* Demo · núcleo: pide los artículos a la tienda y los guarda.
   Los módulos de un proyecto comparten ámbito, así que este `TALLER_DEMO`
   lo ve el módulo de interfaz que va detrás. */
const TALLER_DEMO = { api: "https://tienda.example.com/api/items", items: [] };

async function tallerDemoPedir() {
  const r = await fetch(TALLER_DEMO.api);
  const j = await r.json();
  TALLER_DEMO.items = (j && j.items) || [];
  return TALLER_DEMO.items;
}


/* ---- proyectos/demo/modulos/02-ui.js ---- */
/* Demo · interfaz: un botón flotante que trae y pinta los artículos. */
function tallerDemoPintar() {
  const caja = document.getElementById("lista");
  if (!caja) return;
  caja.innerHTML = "";
  TALLER_DEMO.items.forEach(function (it) {
    const d = document.createElement("div");
    d.className = "it";
    const n = document.createElement("b");
    n.textContent = it.nombre;
    const p = document.createElement("div");
    p.className = "p";
    p.textContent = it.precio + " €";
    d.appendChild(n);
    d.appendChild(p);
    caja.appendChild(d);
  });
}

(function () {
  const b = document.createElement("button");
  b.id = "tallerDemoBtn";
  b.type = "button";
  b.textContent = "Cargar artículos";
  b.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:9;padding:9px 13px;border-radius:9px;border:1px solid #2b2b2b;background:#22252c;color:#f2f2f2;font:600 13px system-ui;cursor:pointer";
  b.addEventListener("click", async function () {
    b.disabled = true;
    b.textContent = "Cargando…";
    try {
      await tallerDemoPedir();
      tallerDemoPintar();
      b.textContent = "Cargados " + TALLER_DEMO.items.length;
    } catch (e) {
      b.textContent = "Error";
      console.error("[demo] no pude traer los artículos:", e);
    } finally {
      b.disabled = false;
    }
  });
  document.body.appendChild(b);
  console.log("[demo] script listo v" + (typeof GM_info !== "undefined" && GM_info.script ? GM_info.script.version : "?"));
})();

