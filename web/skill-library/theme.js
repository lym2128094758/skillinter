(() => {
  "use strict";
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  let hostTheme = {};
  const colorKeys = new Set([
    "--color-background-primary", "--color-background-secondary", "--color-background-tertiary",
    "--color-text-primary", "--color-text-secondary", "--color-text-tertiary",
    "--color-border-primary", "--color-background-info", "--color-text-info",
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", {willReadFrequently: true});
  const colors = new Map();

  function apply(theme = {}) {
    hostTheme = {...hostTheme, ...theme};
    const scheme = hostTheme.theme === "dark" || hostTheme.theme === "light"
      ? hostTheme.theme : media.matches ? "dark" : "light";
    root.dataset.theme = scheme;
    root.style.colorScheme = scheme;
    const variables = hostTheme.styles?.variables || {};
    for (const key of colorKeys) {
      const value = variables[key];
      if (typeof value === "string" && CSS.supports("color", value)) root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
    const font = variables["--font-sans"];
    if (typeof font === "string" && CSS.supports("font-family", font)) root.style.setProperty("--font", font);
    else root.style.removeProperty("--font");
    colors.clear();
    window.dispatchEvent(new Event("skill-library-theme"));
  }

  function color(token, fallback = "#737373") {
    if (colors.has(token)) return colors.get(token);
    const probe = document.createElement("span");
    probe.style.color = `var(${token}, ${fallback})`;
    probe.style.display = "none";
    document.documentElement.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const channels = context.getImageData(0, 0, 1, 1).data;
    const result = "#" + [...channels].slice(0, 3).map(value => value.toString(16).padStart(2, "0")).join("");
    colors.set(token, result);
    return result;
  }

  window.SkillLibraryTheme = {apply, color};
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "skill-library-theme") return;
    // DSH embeds the local library directly and sends only its public palette.
    if (event.origin === "null" || !/^https?:\/\//.test(event.origin)) return;
    apply(event.data.context);
  });
  media.addEventListener("change", () => apply());
  apply();
})();
