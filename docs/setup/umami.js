/** Load Umami. IP exclusions are applied at the edge (not in this file). */
(() => {
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://cloud.umami.is/script.js";
  s.dataset.websiteId = "3499aa8b-8f9b-4993-8bd5-6b660bebaff6";
  document.head.appendChild(s);
})();
