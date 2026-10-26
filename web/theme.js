// Loaded blocking in <head>: applies the chosen theme before the first render.
try {
  const theme = localStorage.getItem("zo-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage unavailable: follow the system theme.
}
