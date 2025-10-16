/* ITRAVELBYMYOWN — v1 UI (Base + Home)
   Interacciones de UI (loader, menú responsive, helpers)
*/

(function () {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  // Año dinámico footer
  const y = $("#y");
  if (y) y.textContent = new Date().getFullYear();

  // Loader simple (muestra en navegación)
  const loader = $("#app-loader");
  function showLoader() {
    if (loader) {
      loader.classList.remove("hidden");
      loader.setAttribute("aria-hidden", "false");
    }
  }
  function hideLoader() {
    if (loader) {
      loader.classList.add("hidden");
      loader.setAttribute("aria-hidden", "true");
    }
  }

  // Mostrar loader al hacer click en enlaces de navegación internos
  $$(".btn[href], .nav-menu a, a[data-nav]").forEach(a => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href") || "";
      const isHash = href.startsWith("#");
      const isExternal = /^https?:\/\//i.test(href);
      if (!isHash && !isExternal) {
        showLoader();
        // Pequeño delay por si el host está ultra rápido
        setTimeout(() => { /* no-op */ }, 60);
      }
    });
  });

  // Loader al iniciar y al terminar de cargar
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive") showLoader();
    if (document.readyState === "complete") hideLoader();
  });
  window.addEventListener("load", hideLoader);

  // Menú responsive
  const navToggle = $(".nav-toggle");
  const navMenu = $("#nav-menu");
  if (navToggle && navMenu) {
    navToggle.addEventListener("click", () => {
      const open = navMenu.style.display === "flex";
      navMenu.style.display = open ? "none" : "flex";
      navToggle.setAttribute("aria-expanded", String(!open));
    });

    // Cerrar al seleccionar un link (móvil)
    $$("#nav-menu a").forEach(link => {
      link.addEventListener("click", () => {
        if (getComputedStyle(navToggle).display !== "none") {
          navMenu.style.display = "none";
          navToggle.setAttribute("aria-expanded", "false");
        }
      });
    });

    // Cerrar si se hace click fuera (móvil)
    document.addEventListener("click", (e) => {
      const within = navMenu.contains(e.target) || navToggle.contains(e.target);
      if (!within && getComputedStyle(navToggle).display !== "none") {
        navMenu.style.display = "none";
        navToggle.setAttribute("aria-expanded", "false");
      }
    });

    // Asegurar reset al cambiar tamaño de pantalla
    window.addEventListener("resize", () => {
      if (window.innerWidth > 720) {
        navMenu.style.display = "flex";
        navToggle.setAttribute("aria-expanded", "false");
      } else {
        navMenu.style.display = "none";
      }
    });
  }

  // Helper para activar <img> reales cuando se provean URLs
  function activateImages() {
    $$("img[src='']").forEach(img => {
      // Si no hay src, dejamos visible el placeholder (siguiente hermano .img-placeholder)
      const placeholder = img.nextElementSibling;
      if (placeholder && placeholder.classList.contains("img-placeholder")) {
        // nada: el placeholder ya está visible
      }
    });
    // Si se setea un src más adelante, ocultamos el placeholder
    $$("img").forEach(img => {
      img.addEventListener("load", () => {
        if (img.getAttribute("src")) {
          const ph = img.nextElementSibling;
          if (ph && ph.classList.contains("img-placeholder")) {
            ph.style.display = "none";
            img.style.display = "block";
          }
        }
      });
    });
  }
  activateImages();

  // Accesibilidad: focus visible en teclado
  function handleFirstTab(e) {
    if (e.key === "Tab") {
      document.body.classList.add("user-is-tabbing");
      window.removeEventListener("keydown", handleFirstTab);
    }
  }
  window.addEventListener("keydown", handleFirstTab);

})();

