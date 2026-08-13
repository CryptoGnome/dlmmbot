document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const code = btn.parentElement.querySelector("code");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.innerText);
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 1200);
    } catch {
      btn.textContent = "Select & copy";
    }
  });
});
