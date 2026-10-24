// apply a saved scheme before styles paint; the main registry owns later changes
(() => {
  try {
    const preference = localStorage.getItem("supervisor-color-scheme");
    if (preference === "light" || preference === "dark") {
      document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", preference);
    }
  } catch { /* System appearance remains usable when storage is blocked */ }
})();
